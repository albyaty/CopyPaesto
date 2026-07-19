import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decryptValue, deriveSessionCredentials, encryptValue } from "../lib/crypto";
import { openRelayChunk, sealRelayChunk } from "../lib/fileRelay";
import { RoomRelay, type TurnAccess } from "../lib/relay";
import { normalizeSessionCode } from "../lib/session";
import type {
  ConnectionStatus,
  Peer,
  RelayFilePayload,
  ServerMessage,
  SignalPayload,
  SlotPayload,
} from "../types";

export interface ClipboardSlot extends SlotPayload {
  sequence: number;
}

const emptySlots: ClipboardSlot[] = [0, 1, 2].map(() => ({
  text: "",
  author: "",
  authorId: "",
  updatedAt: 0,
  sequence: 0,
}));

interface UseRoomOptions {
  sessionCode: string;
  pin: string;
  clientId: string;
  deviceName: string;
}

export function useRoom({ sessionCode, pin, clientId, deviceName }: UseRoomOptions) {
  const [status, setStatus] = useState<ConnectionStatus>("deriving");
  const [statusDetail, setStatusDetail] = useState("Preparing your private session…");
  const [slots, setSlots] = useState<ClipboardSlot[]>(emptySlots);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [turnAccess, setTurnAccess] = useState<TurnAccess | null>(null);
  const relayRef = useRef<RoomRelay | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const turnAccessRef = useRef<TurnAccess | null>(null);
  const pendingSlotsRef = useRef(new Map<number, string>());
  const timersRef = useRef(new Map<number, number>());
  const sendChainsRef = useRef([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
  const signalChainRef = useRef(Promise.resolve());
  const signalListenersRef = useRef(new Set<(from: string, signal: SignalPayload) => void>());
  const relayFileSendChainsRef = useRef(new Map<string, Promise<void>>());
  const relayFileReceiveChainRef = useRef(Promise.resolve());
  const relayFileListenersRef = useRef(new Set<(from: string, payload: RelayFilePayload) => void>());
  const relayChunkListenersRef = useRef(new Set<(
    from: string,
    transferId: string,
    offset: number,
    chunk: ArrayBuffer,
  ) => void>());
  const readyRef = useRef(false);

  const flushSlot = useCallback((slot: number, text: string) => {
    const key = keyRef.current;
    if (!key || !readyRef.current) return;

    sendChainsRef.current[slot] = sendChainsRef.current[slot]
      .catch(() => undefined)
      .then(async () => {
        const envelope = await encryptValue(key, {
          text,
          author: deviceName,
          authorId: clientId,
          updatedAt: Date.now(),
        } satisfies SlotPayload, `slot:${slot}:v1`);
        relayRef.current?.send({ type: "slot:update", slot, envelope });
      });
  }, [clientId, deviceName]);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    const normalizedCode = normalizeSessionCode(sessionCode);

    setStatus("deriving");
    setStatusDetail("Deriving session keys locally…");
    setPeers([]);
    setSlots(emptySlots);
    setTurnAccess(null);
    keyRef.current = null;
    turnAccessRef.current = null;
    readyRef.current = false;
    relayFileReceiveChainRef.current = Promise.resolve();

    const handleMessage = async (message: ServerMessage) => {
      const key = keyRef.current;
      if (!key || stopped) return;

      if (message.type === "authenticated") {
        readyRef.current = true;
        reconnectAttempt = 0;
        setTurnAccess(turnAccessRef.current);
        setStatus("connected");
        setStatusDetail("Private session connected");
        for (const [slot, text] of pendingSlotsRef.current) flushSlot(slot, text);
        return;
      }

      if (message.type === "presence") {
        setPeers(message.peers.filter((peer) => peer.id !== clientId));
        return;
      }

      if (message.type === "snapshot") {
        const decoded = await Promise.all(message.slots.map(async (stored) => ({
          stored,
          payload: await decryptValue<SlotPayload>(
            key,
            stored.envelope,
            `slot:${stored.slot}:v1`,
          ),
        })));
        if (stopped) return;
        setSlots((current) => {
          const next = [...current];
          for (const { stored, payload } of decoded) {
            if (stored.slot < 0 || stored.slot > 2) continue;
            if (pendingSlotsRef.current.has(stored.slot)) continue;
            next[stored.slot] = { ...payload, sequence: stored.sequence };
          }
          return next;
        });
        setLastSyncedAt(Date.now());
        return;
      }

      if (message.type === "slot:update") {
        const payload = await decryptValue<SlotPayload>(
          key,
          message.envelope,
          `slot:${message.slot}:v1`,
        );
        if (payload.authorId === clientId) {
          const pendingText = pendingSlotsRef.current.get(message.slot);
          if (pendingText === payload.text) pendingSlotsRef.current.delete(message.slot);

          // An echoed update can arrive after the user has already typed more.
          // Keep the local text authoritative and only advance its server sequence.
          setSlots((current) => {
            if (message.sequence <= current[message.slot].sequence) return current;
            const next = [...current];
            next[message.slot] = { ...current[message.slot], sequence: message.sequence };
            return next;
          });
          setLastSyncedAt(Date.now());
          return;
        }
        setSlots((current) => {
          if (message.sequence <= current[message.slot].sequence) return current;
          const next = [...current];
          next[message.slot] = { ...payload, sequence: message.sequence };
          return next;
        });
        setLastSyncedAt(Date.now());
        return;
      }

      if (message.type === "signal") {
        const signal = await decryptValue<SignalPayload>(key, message.envelope, "signal:v1");
        for (const listener of signalListenersRef.current) listener(message.from, signal);
        return;
      }

      if (message.type === "file:relay") {
        const payload = await decryptValue<RelayFilePayload>(key, message.envelope, "file-relay:v1");
        for (const listener of relayFileListenersRef.current) listener(message.from, payload);
        return;
      }

      if (message.type === "error") setStatusDetail(message.message);
    };

    const connect = async () => {
      try {
        if (!keyRef.current) {
          const credentials = await deriveSessionCredentials(normalizedCode, pin);
          if (stopped) return;
          keyRef.current = credentials.encryptionKey;
          turnAccessRef.current = {
            roomId: credentials.roomId,
            authVerifier: credentials.authVerifier,
          };
          const relay = new RoomRelay({
            onOpen: () => {
              if (stopped) return;
              setStatus("authenticating");
              setStatusDetail("Checking the session PIN…");
            },
            onMessage: (message) => {
              if (message.type === "file:relay") {
                relayFileReceiveChainRef.current = relayFileReceiveChainRef.current
                  .catch(() => undefined)
                  .then(() => handleMessage(message))
                  .catch(() => {
                    setStatusDetail("A protected file chunk could not be opened");
                  });
              } else {
                void handleMessage(message).catch(() => {
                  setStatusDetail("A protected message could not be opened");
                });
              }
            },
            onBinary: (frame) => {
              relayFileReceiveChainRef.current = relayFileReceiveChainRef.current
                .catch(() => undefined)
                .then(async () => {
                  const key = keyRef.current;
                  if (!key || stopped) return;
                  const opened = await openRelayChunk(key, frame);
                  for (const listener of relayChunkListenersRef.current) {
                    listener(opened.from, opened.transferId, opened.offset, opened.chunk);
                  }
                })
                .catch(() => {
                  setStatusDetail("A protected file chunk could not be opened");
                });
            },
            onClose: (event) => {
              readyRef.current = false;
              if (stopped) return;
              if (event.code === 4003) {
                setStatus("denied");
                setStatusDetail("That PIN does not unlock this session");
                return;
              }
              reconnectAttempt += 1;
              const delay = Math.min(10_000, 600 * 2 ** Math.min(reconnectAttempt, 4));
              setStatus("reconnecting");
              setStatusDetail("Connection paused — reconnecting…");
              reconnectTimer = window.setTimeout(connect, delay);
            },
            onError: () => {
              if (!stopped) setStatusDetail("The relay is not reachable yet");
            },
          });
          relayRef.current = relay;
          setStatus(reconnectAttempt ? "reconnecting" : "connecting");
          setStatusDetail(reconnectAttempt ? "Reconnecting…" : "Connecting both machines…");
          relay.connect(credentials.roomId, clientId, credentials.authVerifier, deviceName);
          return;
        }

        const credentials = await deriveSessionCredentials(normalizedCode, pin);
        keyRef.current = credentials.encryptionKey;
        turnAccessRef.current = {
          roomId: credentials.roomId,
          authVerifier: credentials.authVerifier,
        };
        relayRef.current?.connect(credentials.roomId, clientId, credentials.authVerifier, deviceName);
      } catch {
        if (!stopped) {
          setStatus("offline");
          setStatusDetail("This browser could not prepare the encrypted session");
        }
      }
    };

    void connect();
    return () => {
      stopped = true;
      readyRef.current = false;
      window.clearTimeout(reconnectTimer);
      relayRef.current?.close();
      relayRef.current = null;
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      relayFileSendChainsRef.current.clear();
    };
  }, [clientId, deviceName, flushSlot, pin, sessionCode]);

  const updateSlot = useCallback((slot: number, text: string) => {
    if (slot < 0 || slot > 2) return;
    pendingSlotsRef.current.set(slot, text);
    setSlots((current) => {
      const next = [...current];
      next[slot] = {
        text,
        author: deviceName,
        authorId: clientId,
        updatedAt: Date.now(),
        sequence: current[slot].sequence,
      };
      return next;
    });

    const existing = timersRef.current.get(slot);
    if (existing) window.clearTimeout(existing);
    timersRef.current.set(slot, window.setTimeout(() => {
      timersRef.current.delete(slot);
      flushSlot(slot, text);
    }, 90));
  }, [clientId, deviceName, flushSlot]);

  const sendSignal = useCallback((to: string, signal: SignalPayload) => {
    signalChainRef.current = signalChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const key = keyRef.current;
        if (!key || !readyRef.current) throw new Error("Session is not connected");
        const envelope = await encryptValue(key, signal, "signal:v1");
        if (!relayRef.current?.send({ type: "signal", to, envelope })) {
          throw new Error("Session is not connected");
        }
      });
    return signalChainRef.current;
  }, []);

  const subscribeToSignals = useCallback((listener: (from: string, signal: SignalPayload) => void) => {
    signalListenersRef.current.add(listener);
    return () => signalListenersRef.current.delete(listener);
  }, []);

  const sendRelayFile = useCallback((to: string, payload: RelayFilePayload) => {
    const previous = relayFileSendChainsRef.current.get(payload.transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const key = keyRef.current;
        if (!key || !readyRef.current) throw new Error("Session is not connected");
        const envelope = await encryptValue(key, payload, "file-relay:v1");
        if (!relayRef.current?.send({ type: "file:relay", to, envelope })) {
          throw new Error("Session is not connected");
        }
      });
    relayFileSendChainsRef.current.set(payload.transferId, next);
    void next.finally(() => {
      if (relayFileSendChainsRef.current.get(payload.transferId) === next) {
        relayFileSendChainsRef.current.delete(payload.transferId);
      }
    }).catch(() => undefined);
    return next;
  }, []);

  const sendRelayChunk = useCallback((
    to: string,
    transferId: string,
    offset: number,
    chunk: ArrayBuffer,
  ) => {
    const previous = relayFileSendChainsRef.current.get(transferId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const key = keyRef.current;
        if (!key || !readyRef.current) throw new Error("Session is not connected");
        const frame = await sealRelayChunk(key, to, transferId, offset, chunk);
        if (!relayRef.current?.sendBinary(frame)) throw new Error("Session is not connected");
      });
    relayFileSendChainsRef.current.set(transferId, next);
    void next.finally(() => {
      if (relayFileSendChainsRef.current.get(transferId) === next) {
        relayFileSendChainsRef.current.delete(transferId);
      }
    }).catch(() => undefined);
    return next;
  }, []);

  const subscribeToRelayFiles = useCallback((listener: (from: string, payload: RelayFilePayload) => void) => {
    relayFileListenersRef.current.add(listener);
    return () => relayFileListenersRef.current.delete(listener);
  }, []);

  const subscribeToRelayChunks = useCallback((listener: (
    from: string,
    transferId: string,
    offset: number,
    chunk: ArrayBuffer,
  ) => void) => {
    relayChunkListenersRef.current.add(listener);
    return () => relayChunkListenersRef.current.delete(listener);
  }, []);

  return useMemo(() => ({
    status,
    statusDetail,
    slots,
    peers,
    turnAccess,
    lastSyncedAt,
    updateSlot,
    sendSignal,
    subscribeToSignals,
    sendRelayFile,
    sendRelayChunk,
    subscribeToRelayFiles,
    subscribeToRelayChunks,
  }), [
    lastSyncedAt,
    peers,
    sendSignal,
    sendRelayFile,
    sendRelayChunk,
    slots,
    status,
    statusDetail,
    subscribeToSignals,
    subscribeToRelayFiles,
    subscribeToRelayChunks,
    turnAccess,
    updateSlot,
  ]);
}
