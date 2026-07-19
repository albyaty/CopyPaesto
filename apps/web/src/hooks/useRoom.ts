import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decryptValue, deriveSessionCredentials, encryptValue } from "../lib/crypto";
import { RoomRelay } from "../lib/relay";
import { normalizeSessionCode } from "../lib/session";
import type {
  ConnectionStatus,
  Peer,
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
  const relayRef = useRef<RoomRelay | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const pendingSlotsRef = useRef(new Map<number, string>());
  const timersRef = useRef(new Map<number, number>());
  const sendChainsRef = useRef([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
  const signalChainRef = useRef(Promise.resolve());
  const signalListenersRef = useRef(new Set<(from: string, signal: SignalPayload) => void>());
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
    keyRef.current = null;
    readyRef.current = false;

    const handleMessage = async (message: ServerMessage) => {
      const key = keyRef.current;
      if (!key || stopped) return;

      if (message.type === "authenticated") {
        readyRef.current = true;
        reconnectAttempt = 0;
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
        if (payload.authorId === clientId && pendingSlotsRef.current.get(message.slot) === payload.text) {
          pendingSlotsRef.current.delete(message.slot);
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

      if (message.type === "error") setStatusDetail(message.message);
    };

    const connect = async () => {
      try {
        if (!keyRef.current) {
          const credentials = await deriveSessionCredentials(normalizedCode, pin);
          if (stopped) return;
          keyRef.current = credentials.encryptionKey;
          const relay = new RoomRelay({
            onOpen: () => {
              if (stopped) return;
              setStatus("authenticating");
              setStatusDetail("Checking the session PIN…");
            },
            onMessage: (message) => {
              void handleMessage(message).catch(() => {
                setStatusDetail("A protected message could not be opened");
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

  return useMemo(() => ({
    status,
    statusDetail,
    slots,
    peers,
    lastSyncedAt,
    updateSlot,
    sendSignal,
    subscribeToSignals,
  }), [
    lastSyncedAt,
    peers,
    sendSignal,
    slots,
    status,
    statusDetail,
    subscribeToSignals,
    updateSlot,
  ]);
}
