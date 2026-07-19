import type { CipherEnvelope, ServerMessage } from "../types";

function relayOrigin() {
  const configured = (import.meta.env.VITE_RELAY_URL as string | undefined)?.trim();
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
  onClose: (event: CloseEvent) => void;
  onError: () => void;
}

export class RoomRelay {
  private socket: WebSocket | null = null;

  constructor(private callbacks: RelayCallbacks) {}

  connect(roomId: string, clientId: string, authVerifier: string, name: string) {
    this.close();
    const url = new URL(`${relayOrigin()}/rooms/${encodeURIComponent(roomId)}/connect`);
    url.searchParams.set("clientId", clientId);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "authenticate", verifier: authVerifier, name }));
      this.callbacks.onOpen();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") return;
      try {
        this.callbacks.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        // Ignore malformed relay messages.
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
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

  close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.close(1000, "Client left");
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
