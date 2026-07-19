import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RELAY_CHUNK_BYTES } from "../lib/fileRelay";
import { fetchIceServers, type TurnAccess } from "../lib/relay";
import type { AutoSaveWritableTarget } from "./useAutoSaveFolder";
import type {
  Peer,
  RelayChunkProtection,
  RelayFilePayload,
  SignalPayload,
  TransferItem,
} from "../types";

const DIRECT_CHUNK_SIZE = 32 * 1024;
const LEGACY_RELAY_CHUNK_SIZE = 32 * 1024;
const BINARY_RELAY_CHUNK_SIZE = MAX_RELAY_CHUNK_BYTES;
const DIRECT_MAX_IN_FLIGHT = 4 * 1024 * 1024;
const BINARY_RELAY_MAX_IN_FLIGHT = 32 * 1024 * 1024;
const MAX_CHANNEL_BUFFER = 1024 * 1024;
const DIRECT_ACK_INTERVAL = 512 * 1024;
const BINARY_RELAY_ACK_INTERVAL = 8 * 1024 * 1024;
const MEMORY_FALLBACK_LIMIT = 128 * 1024 * 1024;
const DIRECT_ROUTE_TIMEOUT = 12_000;

interface FileOffer {
  type: "file-offer";
  name: string;
  size: number;
  mime: string;
  lastModified: number;
}

type ControlMessage =
  | FileOffer
  | { type: "accept" }
  | { type: "decline" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "ack"; received: number }
  | { type: "eof" }
  | { type: "complete" }
  | { type: "transfer-error"; message: string };

interface WritableTarget {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface TransferSession {
  id: string;
  direction: "send" | "receive";
  transport: "webrtc" | "relay";
  binaryRelay: boolean;
  relayProtection: RelayChunkProtection;
  peerId: string;
  peerName: string;
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  fallbackTimer?: number;
  file?: File;
  offer?: FileOffer;
  writable?: WritableTarget;
  chunks?: ArrayBuffer[];
  sent: number;
  acked: number;
  received: number;
  nextOffset: number;
  lastAck: number;
  lastProgressAt: number;
  paused: boolean;
  started: boolean;
  closed: boolean;
  writeQueue: Promise<void>;
  flowWaiters: Set<() => void>;
}

interface FileTransferOptions {
  peers: Peer[];
  turnAccess: TurnAccess | null;
  sendSignal: (to: string, signal: SignalPayload) => Promise<void>;
  subscribeToSignals: (
    listener: (from: string, signal: SignalPayload) => void,
  ) => () => void;
  sendRelayFile: (to: string, payload: RelayFilePayload) => Promise<void>;
  sendRelayChunk: (
    to: string,
    transferId: string,
    offset: number,
    chunk: ArrayBuffer,
    protection: RelayChunkProtection,
  ) => Promise<void>;
  subscribeToRelayFiles: (
    listener: (from: string, payload: RelayFilePayload) => void,
  ) => () => void;
  subscribeToRelayChunks: (
    listener: (
      from: string,
      transferId: string,
      offset: number,
      chunk: ArrayBuffer,
      protection: RelayChunkProtection,
    ) => void,
  ) => () => void;
  createAutoSaveTarget?: (suggestedName: string) => Promise<AutoSaveWritableTarget>;
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<WritableTarget>;
  }>;
};

function control(channel: RTCDataChannel | undefined, message: ControlMessage) {
  if (channel?.readyState === "open") channel.send(JSON.stringify(message));
}

function triggerMemoryDownload(name: string, mime: string, chunks: ArrayBuffer[]) {
  const url = URL.createObjectURL(new Blob(chunks, { type: mime || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function arrayBufferToBase64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const windowSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += windowSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + windowSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToArrayBuffer(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function relayControl(session: TransferSession, message: ControlMessage): RelayFilePayload {
  if (message.type === "file-offer") {
    return {
      kind: "offer",
      transferId: session.id,
      name: message.name,
      size: message.size,
      mime: message.mime,
      lastModified: message.lastModified,
      binary: true,
      protection: session.relayProtection,
    };
  }
  if (message.type === "accept") {
    return {
      kind: "accept",
      transferId: session.id,
      ...(session.binaryRelay ? { binary: true as const } : {}),
      ...(session.binaryRelay ? { protection: session.relayProtection } : {}),
    };
  }
  if (message.type === "transfer-error") {
    return { kind: "error", transferId: session.id, message: message.message };
  }
  if (message.type === "ack") {
    return { kind: "ack", transferId: session.id, received: message.received };
  }
  return { kind: message.type, transferId: session.id } as RelayFilePayload;
}

export function useFileTransfer({
  peers,
  turnAccess,
  sendSignal,
  subscribeToSignals,
  sendRelayFile,
  sendRelayChunk,
  subscribeToRelayFiles,
  subscribeToRelayChunks,
  createAutoSaveTarget,
}: FileTransferOptions) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [notice, setNotice] = useState("");
  const sessionsRef = useRef(new Map<string, TransferSession>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const signalChainsRef = useRef(new Map<string, Promise<void>>());
  const relayChainsRef = useRef(new Map<string, Promise<void>>());
  const relayPreferredPeersRef = useRef(new Set<string>());
  const peersRef = useRef(peers);
  const iceConfigRef = useRef<{ key: string; promise: Promise<RTCConfiguration> } | null>(null);

  peersRef.current = peers;

  const updateTransfer = useCallback((id: string, patch: Partial<TransferItem>) => {
    setTransfers((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const iceConfiguration = useCallback(async () => {
    if (!turnAccess) return { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
    const key = `${turnAccess.roomId}:${turnAccess.authVerifier}`;
    if (iceConfigRef.current?.key !== key) {
      iceConfigRef.current = {
        key,
        promise: fetchIceServers(turnAccess).then((result) => ({ iceServers: result.iceServers })),
      };
    }
    return iceConfigRef.current.promise;
  }, [turnAccess]);

  useEffect(() => {
    if (turnAccess) void iceConfiguration();
  }, [iceConfiguration, turnAccess]);

  const notifyFlow = useCallback((session: TransferSession) => {
    for (const resolve of session.flowWaiters) resolve();
    session.flowWaiters.clear();
  }, []);

  const waitForFlow = useCallback((session: TransferSession) => new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timeout);
      session.flowWaiters.delete(done);
      resolve();
    };
    const timeout = window.setTimeout(done, 300);
    session.flowWaiters.add(done);
  }), []);

  const sendSessionControl = useCallback(async (session: TransferSession, message: ControlMessage) => {
    if (session.transport === "relay") {
      await sendRelayFile(session.peerId, relayControl(session, message));
      return;
    }
    if (session.channel?.readyState !== "open") throw new Error("The direct connection is not open");
    control(session.channel, message);
  }, [sendRelayFile]);

  const failSession = useCallback((session: TransferSession, error: string, notifyPeer = true) => {
    if (session.closed) return;
    session.closed = true;
    window.clearTimeout(session.fallbackTimer);
    updateTransfer(session.id, { status: "failed", error });
    if (notifyPeer) {
      void sendSessionControl(session, { type: "transfer-error", message: error }).catch(() => undefined);
    }
    try {
      session.channel?.close();
      session.pc?.close();
      void session.writable?.abort?.(error);
    } catch {
      // The connection is already gone.
    }
    notifyFlow(session);
  }, [notifyFlow, sendSessionControl, updateTransfer]);

  const acceptSession = useCallback(async (session: TransferSession, automatic: boolean) => {
    if (!session.offer || session.closed) return;
    try {
      if (automatic) {
        if (!createAutoSaveTarget) return;
        const target = await createAutoSaveTarget(session.offer.name);
        session.writable = target.writable;
        updateTransfer(session.id, { name: target.savedName, autoSaved: true });
      } else {
        const picker = (window as SavePickerWindow).showSaveFilePicker;
        if (picker) {
          const handle = await picker.call(window, { suggestedName: session.offer.name });
          session.writable = await handle.createWritable();
        } else if (session.offer.size <= MEMORY_FALLBACK_LIMIT) {
          session.chunks = [];
        } else {
          setNotice("Files over 128 MB need Chrome or Edge so CopyPaesto can stream directly to disk.");
          return;
        }
      }
      updateTransfer(session.id, { status: "transferring", error: undefined });
      await sendSessionControl(session, { type: "accept" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (automatic) {
        await session.writable?.abort?.(error).catch(() => undefined);
        session.writable = undefined;
        updateTransfer(session.id, { status: "offered", autoSaved: false });
        setNotice("Trusted auto-save needs attention. You can still click Save for this file.");
        return;
      }
      failSession(session, error instanceof Error ? error.message : "Could not create the destination file");
    }
  }, [createAutoSaveTarget, failSession, sendSessionControl, updateTransfer]);

  const finishReceiver = useCallback(async (session: TransferSession) => {
    try {
      await session.writeQueue;
      if (!session.offer) throw new Error("Missing file details");
      if (session.received !== session.offer.size) {
        throw new Error(`Transfer ended at ${session.received} of ${session.offer.size} bytes`);
      }
      if (session.writable) await session.writable.close();
      if (session.chunks) triggerMemoryDownload(session.offer.name, session.offer.mime, session.chunks);
      await sendSessionControl(session, { type: "complete" });
      updateTransfer(session.id, { transferred: session.received, status: "complete" });
      session.closed = true;
      window.setTimeout(() => {
        session.channel?.close();
        session.pc?.close();
      }, 800);
    } catch (error) {
      failSession(session, error instanceof Error ? error.message : "Could not finish the file");
    }
  }, [failSession, sendSessionControl, updateTransfer]);

  const receiveChunk = useCallback((session: TransferSession, chunk: ArrayBuffer) => {
    if (session.direction !== "receive" || session.closed) return;
    session.writeQueue = session.writeQueue.then(async () => {
      if (session.writable) await session.writable.write(chunk);
      else if (session.chunks) session.chunks.push(chunk);
      else throw new Error("The file has not been accepted");

      session.received += chunk.byteLength;
      const now = performance.now();
      if (session.received === session.offer?.size || now - session.lastProgressAt >= 100) {
        session.lastProgressAt = now;
        updateTransfer(session.id, {
          transferred: session.received,
          status: session.paused ? "paused" : "transferring",
        });
      }
      const ackInterval = session.transport === "relay" && session.binaryRelay
        ? BINARY_RELAY_ACK_INTERVAL
        : DIRECT_ACK_INTERVAL;
      if (
        session.received - session.lastAck >= ackInterval ||
        session.received === session.offer?.size
      ) {
        session.lastAck = session.received;
        await sendSessionControl(session, { type: "ack", received: session.received });
      }
    }).catch((error) => {
      failSession(session, error instanceof Error ? error.message : "Could not write the file");
    });
  }, [failSession, sendSessionControl, updateTransfer]);

  const sendFileData = useCallback(async (session: TransferSession) => {
    if (!session.file || session.started) return;
    session.started = true;
    const { file } = session;
    try {
      while (session.sent < file.size) {
        if (session.closed) throw new Error("The other device disconnected");
        if (session.transport === "webrtc" && session.channel?.readyState !== "open") {
          throw new Error("The direct connection closed");
        }
        const maxInFlight = session.transport === "relay" && session.binaryRelay
          ? BINARY_RELAY_MAX_IN_FLIGHT
          : DIRECT_MAX_IN_FLIGHT;
        if (
          session.paused ||
          session.sent - session.acked >= maxInFlight ||
          (session.transport === "webrtc" && (session.channel?.bufferedAmount ?? 0) >= MAX_CHANNEL_BUFFER)
        ) {
          await waitForFlow(session);
          continue;
        }

        const offset = session.sent;
        const chunkSize = session.transport === "webrtc"
          ? DIRECT_CHUNK_SIZE
          : session.binaryRelay
            ? BINARY_RELAY_CHUNK_SIZE
            : LEGACY_RELAY_CHUNK_SIZE;
        const end = Math.min(file.size, offset + chunkSize);
        const chunk = await file.slice(offset, end).arrayBuffer();
        if (session.transport === "relay") {
          if (session.binaryRelay) {
            await sendRelayChunk(
              session.peerId,
              session.id,
              offset,
              chunk,
              session.relayProtection,
            );
          } else {
            await sendRelayFile(session.peerId, {
              kind: "chunk",
              transferId: session.id,
              offset,
              data: arrayBufferToBase64Url(chunk),
            });
          }
        } else {
          session.channel?.send(chunk);
        }
        session.sent = end;
      }
      updateTransfer(session.id, { status: "finishing" });
      await sendSessionControl(session, { type: "eof" });
    } catch (error) {
      failSession(session, error instanceof Error ? error.message : "The file transfer stopped");
    }
  }, [failSession, sendRelayChunk, sendRelayFile, sendSessionControl, updateTransfer, waitForFlow]);

  const handleControl = useCallback((session: TransferSession, message: ControlMessage) => {
    if (message.type === "file-offer" && session.direction === "receive") {
      session.offer = message;
      setTransfers((current) => {
        if (current.some((item) => item.id === session.id)) return current;
        return [{
          id: session.id,
          direction: "receive",
          name: message.name,
          size: message.size,
          transferred: 0,
          status: "offered",
          peerName: session.peerName,
          ...(session.transport === "relay" ? { relayProtection: session.relayProtection } : {}),
        }, ...current];
      });
      if (createAutoSaveTarget) void acceptSession(session, true);
      return;
    }

    if (message.type === "accept" && session.direction === "send") {
      updateTransfer(session.id, { status: "transferring", error: undefined });
      void sendFileData(session);
      return;
    }

    if (message.type === "decline") {
      updateTransfer(session.id, { status: "declined" });
      session.closed = true;
      session.pc?.close();
      notifyFlow(session);
      return;
    }

    if (message.type === "pause") {
      session.paused = true;
      updateTransfer(session.id, { status: "paused" });
      return;
    }

    if (message.type === "resume") {
      session.paused = false;
      updateTransfer(session.id, { status: "transferring" });
      notifyFlow(session);
      return;
    }

    if (message.type === "ack" && session.direction === "send") {
      session.acked = Math.max(session.acked, message.received);
      updateTransfer(session.id, { transferred: session.acked });
      notifyFlow(session);
      return;
    }

    if (message.type === "eof" && session.direction === "receive") {
      updateTransfer(session.id, { status: "finishing" });
      void finishReceiver(session);
      return;
    }

    if (message.type === "complete" && session.direction === "send") {
      updateTransfer(session.id, { transferred: session.file?.size ?? session.acked, status: "complete" });
      session.closed = true;
      window.setTimeout(() => session.pc?.close(), 800);
      return;
    }

    if (message.type === "transfer-error") failSession(session, message.message, false);
  }, [acceptSession, createAutoSaveTarget, failSession, finishReceiver, notifyFlow, sendFileData, updateTransfer]);

  const fallbackToRelay = useCallback(async (session: TransferSession) => {
    if (session.closed || session.transport === "relay" || session.direction !== "send" || !session.file) return;
    relayPreferredPeersRef.current.add(session.peerId);
    window.clearTimeout(session.fallbackTimer);
    session.transport = "relay";
    session.channel?.close();
    session.pc?.close();
    session.channel = undefined;
    session.pc = undefined;
    session.started = false;
    session.sent = 0;
    session.acked = 0;
    session.received = 0;
    session.nextOffset = 0;
    session.lastAck = 0;
    session.lastProgressAt = 0;
    updateTransfer(session.id, {
      status: "connecting",
      transferred: 0,
      relayProtection: session.relayProtection,
      error: undefined,
    });
    setNotice(session.relayProtection === "transport"
      ? "The direct route was blocked, so this file is using the faster Turbo relay."
      : "The direct route was blocked, so this file is using the end-to-end encrypted relay.");
    try {
      await sendSessionControl(session, {
        type: "file-offer",
        name: session.file.name,
        size: session.file.size,
        mime: session.file.type,
        lastModified: session.file.lastModified,
      });
      updateTransfer(session.id, { status: "waiting" });
    } catch (error) {
      failSession(session, error instanceof Error ? error.message : "The file relay could not start");
    }
  }, [failSession, sendSessionControl, updateTransfer]);

  const attachChannel = useCallback((session: TransferSession, channel: RTCDataChannel) => {
    session.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = MAX_CHANNEL_BUFFER / 2;
    channel.addEventListener("bufferedamountlow", () => notifyFlow(session));
    channel.addEventListener("open", () => {
      window.clearTimeout(session.fallbackTimer);
      if (session.transport !== "webrtc") return;
      if (session.direction === "send" && session.file) {
        control(channel, {
          type: "file-offer",
          name: session.file.name,
          size: session.file.size,
          mime: session.file.type,
          lastModified: session.file.lastModified,
        });
        updateTransfer(session.id, { status: "waiting" });
      }
    });
    channel.addEventListener("message", (event) => {
      if (session.transport !== "webrtc") return;
      if (typeof event.data === "string") {
        try {
          handleControl(session, JSON.parse(event.data) as ControlMessage);
        } catch {
          failSession(session, "The other device sent an invalid transfer message");
        }
      } else if (event.data instanceof ArrayBuffer) {
        session.nextOffset += event.data.byteLength;
        receiveChunk(session, event.data);
      }
    });
    channel.addEventListener("close", () => {
      if (session.closed || session.transport !== "webrtc") return;
      if (session.direction === "send" && session.sent === 0) void fallbackToRelay(session);
      else if (session.received > 0 || session.started) failSession(session, "The transfer connection closed early");
    });
  }, [failSession, fallbackToRelay, handleControl, notifyFlow, receiveChunk, updateTransfer]);

  const createDirectSession = useCallback(async (
    id: string,
    direction: "send" | "receive",
    peerId: string,
    file?: File,
    relayProtection: RelayChunkProtection = "e2e",
  ) => {
    const peerName = peersRef.current.find((peer) => peer.id === peerId)?.name ?? "Other device";
    const session: TransferSession = {
      id,
      direction,
      transport: "webrtc",
      binaryRelay: false,
      relayProtection,
      peerId,
      peerName,
      file,
      sent: 0,
      acked: 0,
      received: 0,
      nextOffset: 0,
      lastAck: 0,
      lastProgressAt: 0,
      paused: false,
      started: false,
      closed: false,
      writeQueue: Promise.resolve(),
      flowWaiters: new Set(),
    };
    sessionsRef.current.set(id, session);
    const pc = new RTCPeerConnection(await iceConfiguration());
    session.pc = pc;

    if (direction === "send") {
      session.fallbackTimer = window.setTimeout(() => void fallbackToRelay(session), DIRECT_ROUTE_TIMEOUT);
    }
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate && session.transport === "webrtc") {
        void sendSignal(peerId, {
          kind: "ice",
          transferId: id,
          candidate: event.candidate.toJSON(),
        }).catch(() => {
          if (session.direction === "send" && session.sent === 0) void fallbackToRelay(session);
          else failSession(session, "Could not negotiate the file connection");
        });
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "failed" || session.transport !== "webrtc" || session.closed) return;
      if (session.direction === "send" && session.sent === 0) void fallbackToRelay(session);
      else if (session.received > 0 || session.started) failSession(session, "A file route between the devices could not be made");
    });
    return session;
  }, [failSession, fallbackToRelay, iceConfiguration, sendSignal]);

  const addPendingCandidates = useCallback(async (session: TransferSession) => {
    const pending = pendingCandidatesRef.current.get(session.id) ?? [];
    pendingCandidatesRef.current.delete(session.id);
    if (!session.pc || session.transport !== "webrtc") return;
    for (const candidate of pending) await session.pc.addIceCandidate(candidate);
  }, []);

  const processSignal = useCallback(async (from: string, signal: SignalPayload) => {
    if (signal.kind === "offer") {
      if (sessionsRef.current.has(signal.transferId)) return;
      const session = await createDirectSession(signal.transferId, "receive", from);
      session.pc?.addEventListener("datachannel", (event) => attachChannel(session, event.channel));
      await session.pc?.setRemoteDescription(signal.description);
      await addPendingCandidates(session);
      if (!session.pc) return;
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await sendSignal(from, { kind: "answer", transferId: signal.transferId, description: answer });
      return;
    }

    const session = sessionsRef.current.get(signal.transferId);
    if (!session || session.transport !== "webrtc" || !session.pc) return;
    if (signal.kind === "answer") {
      await session.pc.setRemoteDescription(signal.description);
      await addPendingCandidates(session);
      return;
    }

    if (!session.pc.remoteDescription) {
      const pending = pendingCandidatesRef.current.get(signal.transferId) ?? [];
      pending.push(signal.candidate);
      pendingCandidatesRef.current.set(signal.transferId, pending);
      return;
    }
    await session.pc.addIceCandidate(signal.candidate);
  }, [addPendingCandidates, attachChannel, createDirectSession, sendSignal]);

  const processRelayFile = useCallback(async (from: string, payload: RelayFilePayload) => {
    if (payload.kind === "offer") {
      const existing = sessionsRef.current.get(payload.transferId);
      if (existing?.transport === "relay" && !existing.closed) return;
      if (existing) {
        existing.closed = true;
        window.clearTimeout(existing.fallbackTimer);
        existing.channel?.close();
        existing.pc?.close();
        void existing.writable?.abort?.("Switching to file relay");
      }
      const peerName = peersRef.current.find((peer) => peer.id === from)?.name ?? "Other device";
      const relayProtection: RelayChunkProtection = payload.protection === "transport"
        ? "transport"
        : "e2e";
      const offer: FileOffer = {
        type: "file-offer",
        name: payload.name,
        size: payload.size,
        mime: payload.mime,
        lastModified: payload.lastModified,
      };
      const session: TransferSession = {
        id: payload.transferId,
        direction: "receive",
        transport: "relay",
        binaryRelay: payload.binary === true,
        relayProtection,
        peerId: from,
        peerName,
        offer,
        sent: 0,
        acked: 0,
        received: 0,
        nextOffset: 0,
        lastAck: 0,
        lastProgressAt: 0,
        paused: false,
        started: false,
        closed: false,
        writeQueue: Promise.resolve(),
        flowWaiters: new Set(),
      };
      sessionsRef.current.set(session.id, session);
      setTransfers((current) => {
        const item: TransferItem = {
          id: session.id,
          direction: "receive",
          name: offer.name,
          size: offer.size,
          transferred: 0,
          status: "offered",
          peerName,
          relayProtection,
        };
        return current.some((currentItem) => currentItem.id === session.id)
          ? current.map((currentItem) => currentItem.id === session.id ? item : currentItem)
          : [item, ...current];
      });
      setNotice(relayProtection === "transport"
        ? "Incoming file is using Turbo relay: protected by the web connection, not end-to-end chunk encryption."
        : "Incoming file is using the end-to-end encrypted relay.");
      if (createAutoSaveTarget) void acceptSession(session, true);
      return;
    }

    const session = sessionsRef.current.get(payload.transferId);
    if (!session || session.transport !== "relay" || session.peerId !== from || session.closed) return;
    if (payload.kind === "chunk") {
      let chunk: ArrayBuffer;
      try {
        chunk = base64UrlToArrayBuffer(payload.data);
      } catch {
        failSession(session, "An encrypted file chunk was invalid");
        return;
      }
      if (payload.offset !== session.nextOffset) {
        failSession(session, "File chunks arrived out of order");
        return;
      }
      session.nextOffset += chunk.byteLength;
      receiveChunk(session, chunk);
      return;
    }

    const controls: Partial<Record<RelayFilePayload["kind"], ControlMessage>> = {
      accept: { type: "accept" },
      decline: { type: "decline" },
      pause: { type: "pause" },
      resume: { type: "resume" },
      eof: { type: "eof" },
      complete: { type: "complete" },
    };
    if (payload.kind === "accept") {
      session.binaryRelay = payload.binary === true;
      session.relayProtection = session.binaryRelay
        && session.relayProtection === "transport"
        && payload.protection === "transport"
        ? "transport"
        : "e2e";
      updateTransfer(session.id, { relayProtection: session.relayProtection });
      handleControl(session, { type: "accept" });
    } else if (payload.kind === "ack") handleControl(session, { type: "ack", received: payload.received });
    else if (payload.kind === "error") failSession(session, payload.message, false);
    else {
      const message = controls[payload.kind];
      if (message) handleControl(session, message);
    }
  }, [acceptSession, createAutoSaveTarget, failSession, handleControl, receiveChunk, updateTransfer]);

  const processRelayChunk = useCallback((
    from: string,
    transferId: string,
    offset: number,
    chunk: ArrayBuffer,
    protection: RelayChunkProtection,
  ) => {
    const session = sessionsRef.current.get(transferId);
    if (
      !session ||
      session.transport !== "relay" ||
      !session.binaryRelay ||
      session.peerId !== from ||
      session.closed
    ) return;
    if (session.relayProtection !== protection) {
      failSession(session, "File protection changed unexpectedly");
      return;
    }
    if (offset !== session.nextOffset) {
      failSession(session, "File chunks arrived out of order");
      return;
    }
    session.nextOffset += chunk.byteLength;
    receiveChunk(session, chunk);
  }, [failSession, receiveChunk]);

  useEffect(() => subscribeToSignals((from, signal) => {
    const previous = signalChainsRef.current.get(signal.transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => processSignal(from, signal))
      .catch(() => {
        const session = sessionsRef.current.get(signal.transferId);
        if (!session) return;
        if (session.direction === "send" && session.sent === 0) void fallbackToRelay(session);
        else if (session.received > 0 || session.started) failSession(session, "Could not set up the file connection");
      });
    signalChainsRef.current.set(signal.transferId, next);
  }), [failSession, fallbackToRelay, processSignal, subscribeToSignals]);

  useEffect(() => subscribeToRelayFiles((from, payload) => {
    const previous = relayChainsRef.current.get(payload.transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => processRelayFile(from, payload))
      .catch(() => {
        const session = sessionsRef.current.get(payload.transferId);
        if (session) failSession(session, "The file relay stopped");
      });
    relayChainsRef.current.set(payload.transferId, next);
  }), [failSession, processRelayFile, subscribeToRelayFiles]);

  useEffect(() => subscribeToRelayChunks((from, transferId, offset, chunk, protection) => {
    const previous = relayChainsRef.current.get(transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => processRelayChunk(from, transferId, offset, chunk, protection))
      .catch(() => {
        const session = sessionsRef.current.get(transferId);
        if (session) failSession(session, "The file relay stopped");
      });
    relayChainsRef.current.set(transferId, next);
  }), [failSession, processRelayChunk, subscribeToRelayChunks]);

  useEffect(() => () => {
    for (const session of sessionsRef.current.values()) {
      session.closed = true;
      window.clearTimeout(session.fallbackTimer);
      session.channel?.close();
      session.pc?.close();
      void session.writable?.abort?.("Session closed");
    }
    sessionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    signalChainsRef.current.clear();
    relayChainsRef.current.clear();
    relayPreferredPeersRef.current.clear();
  }, []);

  const sendFiles = useCallback(async (
    files: File[],
    peerId: string,
    relayProtection: RelayChunkProtection = "e2e",
  ) => {
    const peer = peersRef.current.find((candidate) => candidate.id === peerId);
    if (!peer) {
      setNotice("Choose a connected device before sending a file.");
      return;
    }
    setNotice("");

    for (const file of files) {
      const id = crypto.randomUUID();
      setTransfers((current) => [{
        id,
        direction: "send",
        name: file.name,
        size: file.size,
        transferred: 0,
        status: "connecting",
        peerName: peer.name,
      }, ...current]);
      try {
        const session = await createDirectSession(id, "send", peer.id, file, relayProtection);
        if (relayPreferredPeersRef.current.has(peer.id)) {
          await fallbackToRelay(session);
          continue;
        }
        if (!session.pc) throw new Error("Direct transfer is unavailable");
        const channel = session.pc.createDataChannel(`copypaesto:${id}`, { ordered: true });
        attachChannel(session, channel);
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        await sendSignal(peer.id, { kind: "offer", transferId: id, description: offer });
      } catch {
        const session = sessionsRef.current.get(id);
        if (session) await fallbackToRelay(session);
      }
    }
  }, [attachChannel, createDirectSession, fallbackToRelay, sendSignal]);

  const acceptTransfer = useCallback(async (id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session?.offer) return;
    await acceptSession(session, false);
  }, [acceptSession]);

  const declineTransfer = useCallback((id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session) return;
    void sendSessionControl(session, { type: "decline" }).catch(() => undefined);
    session.closed = true;
    updateTransfer(id, { status: "declined" });
    session.channel?.close();
    session.pc?.close();
  }, [sendSessionControl, updateTransfer]);

  const togglePause = useCallback((id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session || session.closed) return;
    session.paused = !session.paused;
    void sendSessionControl(session, { type: session.paused ? "pause" : "resume" }).catch(() => undefined);
    updateTransfer(id, { status: session.paused ? "paused" : "transferring" });
    if (!session.paused) notifyFlow(session);
  }, [notifyFlow, sendSessionControl, updateTransfer]);

  return {
    transfers,
    relayAvailable: true,
    notice,
    setNotice,
    sendFiles,
    acceptTransfer,
    declineTransfer,
    togglePause,
  };
}
