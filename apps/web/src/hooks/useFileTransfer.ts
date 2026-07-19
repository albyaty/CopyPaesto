import { useCallback, useEffect, useRef, useState } from "react";
import { fetchIceServers } from "../lib/relay";
import type { Peer, SignalPayload, TransferItem } from "../types";

const CHUNK_SIZE = 32 * 1024;
const MAX_IN_FLIGHT = 4 * 1024 * 1024;
const MAX_CHANNEL_BUFFER = 1024 * 1024;
const ACK_INTERVAL = 512 * 1024;
const MEMORY_FALLBACK_LIMIT = 128 * 1024 * 1024;

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
  peerId: string;
  peerName: string;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  file?: File;
  offer?: FileOffer;
  writable?: WritableTarget;
  chunks?: ArrayBuffer[];
  sent: number;
  acked: number;
  received: number;
  lastAck: number;
  paused: boolean;
  started: boolean;
  closed: boolean;
  writeQueue: Promise<void>;
  flowWaiters: Set<() => void>;
}

interface FileTransferOptions {
  peers: Peer[];
  sendSignal: (to: string, signal: SignalPayload) => Promise<void>;
  subscribeToSignals: (
    listener: (from: string, signal: SignalPayload) => void,
  ) => () => void;
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

export function useFileTransfer({ peers, sendSignal, subscribeToSignals }: FileTransferOptions) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const sessionsRef = useRef(new Map<string, TransferSession>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const signalChainsRef = useRef(new Map<string, Promise<void>>());
  const peersRef = useRef(peers);
  const iceConfigRef = useRef<Promise<RTCConfiguration> | null>(null);

  peersRef.current = peers;

  const updateTransfer = useCallback((id: string, patch: Partial<TransferItem>) => {
    setTransfers((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const failSession = useCallback((session: TransferSession, error: string) => {
    if (session.closed) return;
    session.closed = true;
    updateTransfer(session.id, { status: "failed", error });
    try {
      control(session.channel, { type: "transfer-error", message: error });
      session.channel?.close();
      session.pc.close();
      void session.writable?.abort?.(error);
    } catch {
      // The connection is already gone.
    }
    for (const resolve of session.flowWaiters) resolve();
    session.flowWaiters.clear();
  }, [updateTransfer]);

  const iceConfiguration = useCallback(async () => {
    if (!iceConfigRef.current) {
      iceConfigRef.current = fetchIceServers().then((result) => {
        setRelayAvailable(result.relayAvailable);
        return { iceServers: result.iceServers };
      });
    }
    return iceConfigRef.current;
  }, []);

  useEffect(() => {
    void iceConfiguration();
  }, [iceConfiguration]);

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

  const finishReceiver = useCallback(async (session: TransferSession) => {
    try {
      await session.writeQueue;
      if (!session.offer) throw new Error("Missing file details");
      if (session.received !== session.offer.size) {
        throw new Error(`Transfer ended at ${session.received} of ${session.offer.size} bytes`);
      }
      if (session.writable) await session.writable.close();
      if (session.chunks) {
        triggerMemoryDownload(session.offer.name, session.offer.mime, session.chunks);
      }
      control(session.channel, { type: "complete" });
      updateTransfer(session.id, {
        transferred: session.received,
        status: "complete",
      });
      session.closed = true;
      window.setTimeout(() => {
        session.channel?.close();
        session.pc.close();
      }, 800);
    } catch (error) {
      failSession(session, error instanceof Error ? error.message : "Could not finish the file");
    }
  }, [failSession, updateTransfer]);

  const receiveChunk = useCallback((session: TransferSession, chunk: ArrayBuffer) => {
    if (session.direction !== "receive" || session.closed) return;
    session.writeQueue = session.writeQueue.then(async () => {
      if (session.writable) await session.writable.write(chunk);
      else if (session.chunks) session.chunks.push(chunk);
      else throw new Error("The file has not been accepted");

      session.received += chunk.byteLength;
      updateTransfer(session.id, {
        transferred: session.received,
        status: session.paused ? "paused" : "transferring",
      });
      if (
        session.received - session.lastAck >= ACK_INTERVAL ||
        session.received === session.offer?.size
      ) {
        session.lastAck = session.received;
        control(session.channel, { type: "ack", received: session.received });
      }
    }).catch((error) => {
      failSession(session, error instanceof Error ? error.message : "Could not write the file");
    });
  }, [failSession, updateTransfer]);

  const sendFileData = useCallback(async (session: TransferSession) => {
    if (!session.file || !session.channel || session.started) return;
    session.started = true;
    const { file, channel } = session;
    try {
      while (session.sent < file.size) {
        if (session.closed || channel.readyState !== "open") {
          throw new Error("The other machine disconnected");
        }
        if (
          session.paused ||
          session.sent - session.acked >= MAX_IN_FLIGHT ||
          channel.bufferedAmount >= MAX_CHANNEL_BUFFER
        ) {
          await waitForFlow(session);
          continue;
        }

        const end = Math.min(file.size, session.sent + CHUNK_SIZE);
        const chunk = await file.slice(session.sent, end).arrayBuffer();
        channel.send(chunk);
        session.sent = end;
      }
      updateTransfer(session.id, { status: "finishing" });
      control(channel, { type: "eof" });
    } catch (error) {
      failSession(session, error instanceof Error ? error.message : "The file transfer stopped");
    }
  }, [failSession, updateTransfer, waitForFlow]);

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
        }, ...current];
      });
      return;
    }

    if (message.type === "accept" && session.direction === "send") {
      updateTransfer(session.id, { status: "transferring" });
      void sendFileData(session);
      return;
    }

    if (message.type === "decline") {
      updateTransfer(session.id, { status: "declined" });
      session.closed = true;
      session.pc.close();
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
      window.setTimeout(() => session.pc.close(), 800);
      return;
    }

    if (message.type === "transfer-error") failSession(session, message.message);
  }, [failSession, finishReceiver, notifyFlow, sendFileData, updateTransfer]);

  const attachChannel = useCallback((session: TransferSession, channel: RTCDataChannel) => {
    session.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = MAX_CHANNEL_BUFFER / 2;
    channel.addEventListener("bufferedamountlow", () => notifyFlow(session));
    channel.addEventListener("open", () => {
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
      if (typeof event.data === "string") {
        try {
          handleControl(session, JSON.parse(event.data) as ControlMessage);
        } catch {
          failSession(session, "The other machine sent an invalid transfer message");
        }
      } else if (event.data instanceof ArrayBuffer) {
        receiveChunk(session, event.data);
      }
    });
    channel.addEventListener("close", () => {
      if (!session.closed) failSession(session, "The transfer connection closed early");
    });
  }, [failSession, handleControl, notifyFlow, receiveChunk, updateTransfer]);

  const createSession = useCallback(async (
    id: string,
    direction: "send" | "receive",
    peerId: string,
    file?: File,
  ) => {
    const pc = new RTCPeerConnection(await iceConfiguration());
    const peerName = peersRef.current.find((peer) => peer.id === peerId)?.name ?? "Other machine";
    const session: TransferSession = {
      id,
      direction,
      peerId,
      peerName,
      pc,
      file,
      sent: 0,
      acked: 0,
      received: 0,
      lastAck: 0,
      paused: false,
      started: false,
      closed: false,
      writeQueue: Promise.resolve(),
      flowWaiters: new Set(),
    };
    sessionsRef.current.set(id, session);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        void sendSignal(peerId, {
          kind: "ice",
          transferId: id,
          candidate: event.candidate.toJSON(),
        }).catch(() => failSession(session, "Could not negotiate the file connection"));
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") failSession(session, "A direct route between the machines could not be made");
    });
    return session;
  }, [failSession, iceConfiguration, sendSignal]);

  const addPendingCandidates = useCallback(async (session: TransferSession) => {
    const pending = pendingCandidatesRef.current.get(session.id) ?? [];
    pendingCandidatesRef.current.delete(session.id);
    for (const candidate of pending) await session.pc.addIceCandidate(candidate);
  }, []);

  const processSignal = useCallback(async (from: string, signal: SignalPayload) => {
    if (signal.kind === "offer") {
      if (sessionsRef.current.has(signal.transferId)) return;
      const session = await createSession(signal.transferId, "receive", from);
      session.pc.addEventListener("datachannel", (event) => attachChannel(session, event.channel));
      await session.pc.setRemoteDescription(signal.description);
      await addPendingCandidates(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await sendSignal(from, {
        kind: "answer",
        transferId: signal.transferId,
        description: answer,
      });
      return;
    }

    const session = sessionsRef.current.get(signal.transferId);
    if (signal.kind === "answer") {
      if (!session) return;
      await session.pc.setRemoteDescription(signal.description);
      await addPendingCandidates(session);
      return;
    }

    if (!session || !session.pc.remoteDescription) {
      const pending = pendingCandidatesRef.current.get(signal.transferId) ?? [];
      pending.push(signal.candidate);
      pendingCandidatesRef.current.set(signal.transferId, pending);
      return;
    }
    await session.pc.addIceCandidate(signal.candidate);
  }, [addPendingCandidates, attachChannel, createSession, sendSignal]);

  useEffect(() => subscribeToSignals((from, signal) => {
    const previous = signalChainsRef.current.get(signal.transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => processSignal(from, signal))
      .catch(() => {
        const session = sessionsRef.current.get(signal.transferId);
        if (session) failSession(session, "Could not set up the file connection");
      });
    signalChainsRef.current.set(signal.transferId, next);
  }), [failSession, processSignal, subscribeToSignals]);

  useEffect(() => () => {
    for (const session of sessionsRef.current.values()) {
      session.closed = true;
      session.channel?.close();
      session.pc.close();
      void session.writable?.abort?.("Session closed");
    }
    sessionsRef.current.clear();
  }, []);

  const sendFiles = useCallback(async (files: File[]) => {
    const peer = peersRef.current[0];
    if (!peer) {
      setNotice("Connect the second machine before sending a file.");
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
        const session = await createSession(id, "send", peer.id, file);
        const channel = session.pc.createDataChannel(`copypaesto:${id}`, { ordered: true });
        attachChannel(session, channel);
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        await sendSignal(peer.id, { kind: "offer", transferId: id, description: offer });
      } catch (error) {
        const session = sessionsRef.current.get(id);
        if (session) failSession(session, error instanceof Error ? error.message : "Could not start the transfer");
      }
    }
  }, [attachChannel, createSession, failSession, sendSignal]);

  const acceptTransfer = useCallback(async (id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session?.offer || !session.channel) return;
    try {
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
      updateTransfer(id, { status: "transferring" });
      control(session.channel, { type: "accept" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      failSession(session, error instanceof Error ? error.message : "Could not create the destination file");
    }
  }, [failSession, updateTransfer]);

  const declineTransfer = useCallback((id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session) return;
    control(session.channel, { type: "decline" });
    session.closed = true;
    updateTransfer(id, { status: "declined" });
    session.pc.close();
  }, [updateTransfer]);

  const togglePause = useCallback((id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session?.channel || session.closed) return;
    session.paused = !session.paused;
    control(session.channel, { type: session.paused ? "pause" : "resume" });
    updateTransfer(id, { status: session.paused ? "paused" : "transferring" });
    if (!session.paused) notifyFlow(session);
  }, [notifyFlow, updateTransfer]);

  return {
    transfers,
    relayAvailable,
    notice,
    setNotice,
    sendFiles,
    acceptTransfer,
    declineTransfer,
    togglePause,
  };
}
