export interface CipherEnvelope {
  v: 1;
  iv: string;
  data: string;
}

export interface Peer {
  id: string;
  name: string;
}

export interface SlotPayload {
  text: string;
  author: string;
  authorId: string;
  updatedAt: number;
}

export interface StoredSlot {
  slot: number;
  envelope: CipherEnvelope;
  sequence: number;
}

export type SignalPayload =
  | { kind: "offer"; transferId: string; description: RTCSessionDescriptionInit }
  | { kind: "answer"; transferId: string; description: RTCSessionDescriptionInit }
  | { kind: "ice"; transferId: string; candidate: RTCIceCandidateInit };

export type RelayChunkProtection = "e2e" | "transport";

export type RelayFilePayload =
  | { kind: "offer"; transferId: string; name: string; size: number; mime: string; lastModified: number; binary?: true; protection?: RelayChunkProtection }
  | { kind: "accept"; transferId: string; binary?: true; protection?: RelayChunkProtection }
  | { kind: "decline"; transferId: string }
  | { kind: "chunk"; transferId: string; offset: number; data: string }
  | { kind: "ack"; transferId: string; received: number }
  | { kind: "pause"; transferId: string }
  | { kind: "resume"; transferId: string }
  | { kind: "eof"; transferId: string }
  | { kind: "complete"; transferId: string }
  | { kind: "error"; transferId: string; message: string };

export type ServerMessage =
  | { type: "authenticated" }
  | { type: "snapshot"; slots: StoredSlot[] }
  | ({ type: "slot:update" } & StoredSlot)
  | { type: "presence"; peers: Peer[] }
  | { type: "signal"; from: string; envelope: CipherEnvelope }
  | { type: "file:relay"; from: string; envelope: CipherEnvelope }
  | { type: "pong"; at: number }
  | { type: "error"; message: string };

export type ConnectionStatus =
  | "deriving"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "denied"
  | "offline";

export type TransferStatus =
  | "connecting"
  | "offered"
  | "waiting"
  | "transferring"
  | "paused"
  | "finishing"
  | "complete"
  | "declined"
  | "failed";

export interface TransferItem {
  id: string;
  direction: "send" | "receive";
  name: string;
  size: number;
  transferred: number;
  status: TransferStatus;
  peerName: string;
  relayProtection?: RelayChunkProtection;
  autoSaved?: boolean;
  error?: string;
}
