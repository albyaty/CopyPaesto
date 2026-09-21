import type { CipherEnvelope, ServerMessage } from "../types";

function relayOrigin() {
  const configured = (import.meta.env?.VITE_RELAY_URL as string | undefined)?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "ws://localhost:8787";
  }
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

export function relayHttpOrigin() {
  return relayOrigin().replace(/^ws/, "http");
}

interface RelayCallbacks {
  onOpen: () => void;
  onMessage: (message: ServerMessage) => void;
  onBinary: (message: ArrayBuffer) => void;
  onClose: (event: CloseEvent) => void;
  onError: () => void;
}

const MAX_BINARY_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_BINARY_BUFFERED_BYTES = 1024 * 1024;
const BINARY_BUFFER_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface RelaySendResult {
  bufferedAmount: number;
  waitMs: number;
}

export class RoomRelay {
  private socket: WebSocket | null = null;
  private binarySendChain: Promise<void> = Promise.resolve();
  private heartbeatTimer = 0;
  private pendingPingAt = 0;
  private callbacks: RelayCallbacks;

  constructor(callbacks: RelayCallbacks) {
    this.callbacks = callbacks;
  }

  connect(roomId: string, clientId: string, authVerifier: string, name: string) {
    this.close();
    const url = new URL(`${relayOrigin()}/rooms/${encodeURIComponent(roomId)}/connect`);
    url.searchParams.set("clientId", clientId);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.pendingPingAt = 0;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "authenticate", verifier: authVerifier, name }));
      this.callbacks.onOpen();
      this.startHeartbeat(socket);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.pendingPingAt = 0;
      if (typeof event.data === "string") {
        try {
          this.callbacks.onMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // Ignore malformed relay messages.
        }
      } else if (event.data instanceof ArrayBuffer) {
        this.callbacks.onBinary(event.data);
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.socket = null;
      this.callbacks.onClose(event);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.callbacks.onError();
    });
  }

  send(message: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  sendBinary(message: ArrayBuffer) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve<RelaySendResult | null>(null);
    const send = this.binarySendChain
      .catch(() => undefined)
      .then(async () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return null;
        const waitMs = await this.waitForBinaryCapacity(socket);
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return null;
        socket.send(message);
        return { bufferedAmount: socket.bufferedAmount, waitMs };
      });
    this.binarySendChain = send.then(() => undefined, () => undefined);
    return send;
  }

  restart() {
    const socket = this.socket;
    if (!socket) return false;
    try {
      socket.close(4000, "Reconnecting stalled relay");
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    socket.close(1000, "Client left");
  }

  private waitForBinaryCapacity(socket: WebSocket) {
    if (socket.bufferedAmount <= MAX_BINARY_BUFFERED_BYTES) return Promise.resolve(0);
    const startedAt = performance.now();
    return new Promise<number>((resolve, reject) => {
      const check = () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
          reject(new Error("Relay disconnected while waiting to send"));
          return;
        }
        if (socket.bufferedAmount <= RESUME_BINARY_BUFFERED_BYTES) {
          resolve(performance.now() - startedAt);
          return;
        }
        if (performance.now() - startedAt >= BINARY_BUFFER_TIMEOUT_MS) {
          reject(new Error("Relay outgoing queue stopped draining"));
          return;
        }
        window.setTimeout(check, 25);
      };
      window.setTimeout(check, 25);
    });
  }

  private startHeartbeat(socket: WebSocket) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.pendingPingAt && Date.now() - this.pendingPingAt >= HEARTBEAT_TIMEOUT_MS) {
        socket.close(4000, "Relay heartbeat timed out");
        return;
      }
      if (this.pendingPingAt) return;
      socket.send(JSON.stringify({ type: "ping" }));
      this.pendingPingAt = Date.now();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = 0;
    this.pendingPingAt = 0;
  }
}

export interface TurnAccess {
  roomId: string;
  authVerifier: string;
}

export async function fetchIceServers(access: TurnAccess): Promise<{
  iceServers: RTCIceServer[];
  relayAvailable: boolean;
}> {
  try {
    const response = await fetch(
      `${relayHttpOrigin()}/rooms/${encodeURIComponent(access.roomId)}/turn`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${access.authVerifier}` },
      },
    );
    if (!response.ok) throw new Error("TURN configuration unavailable");
    return await response.json() as { iceServers: RTCIceServer[]; relayAvailable: boolean };
  } catch {
    return {
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      relayAvailable: false,
    };
  }
}

export interface EncryptedSignalMessage {
  type: "signal";
  to: string;
  envelope: CipherEnvelope;
}
