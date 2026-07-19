import type { RelayChunkProtection } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const additionalData = encoder.encode("file-relay-binary:v1");

const ENCRYPTED_PROTOCOL_VERSION = 1;
const TRANSPORT_PROTOCOL_VERSION = 2;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const OFFSET_BYTES = 8;
const MAX_IDENTIFIER_BYTES = 80;
export const MAX_RELAY_CHUNK_BYTES = 512 * 1024;

export interface OpenedRelayChunk {
  from: string;
  transferId: string;
  offset: number;
  chunk: ArrayBuffer;
  protection: RelayChunkProtection;
}

function identifierBytes(value: string, label: string) {
  const bytes = encoder.encode(value);
  if (!bytes.length || bytes.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return bytes;
}

function decodeIdentifier(bytes: Uint8Array, label: string) {
  if (!bytes.length || bytes.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return decoder.decode(bytes);
}

function createPayload(transferId: string, offset: number, chunk: ArrayBuffer) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("File offset is invalid");
  if (!chunk.byteLength || chunk.byteLength > MAX_RELAY_CHUNK_BYTES) {
    throw new Error("File chunk is invalid");
  }

  const transfer = identifierBytes(transferId, "Transfer ID");
  const payload = new Uint8Array(1 + transfer.length + OFFSET_BYTES + chunk.byteLength);
  payload[0] = transfer.length;
  payload.set(transfer, 1);
  new DataView(payload.buffer).setBigUint64(1 + transfer.length, BigInt(offset));
  payload.set(new Uint8Array(chunk), 1 + transfer.length + OFFSET_BYTES);
  return payload;
}

function openPayload(payload: Uint8Array) {
  const transferLength = payload[0] ?? 0;
  const offsetPosition = 1 + transferLength;
  const chunkPosition = offsetPosition + OFFSET_BYTES;
  if (
    !transferLength ||
    transferLength > MAX_IDENTIFIER_BYTES ||
    chunkPosition >= payload.length
  ) {
    throw new Error("File relay payload is malformed");
  }

  const transferId = decodeIdentifier(payload.subarray(1, offsetPosition), "Transfer ID");
  const encodedOffset = new DataView(
    payload.buffer,
    payload.byteOffset + offsetPosition,
    OFFSET_BYTES,
  ).getBigUint64(0);
  if (encodedOffset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("File offset is too large");

  const chunk = payload.slice(chunkPosition);
  if (!chunk.length || chunk.length > MAX_RELAY_CHUNK_BYTES) {
    throw new Error("File chunk is invalid");
  }
  return { transferId, offset: Number(encodedOffset), chunk: chunk.buffer as ArrayBuffer };
}

export async function sealRelayChunk(
  key: CryptoKey,
  to: string,
  transferId: string,
  offset: number,
  chunk: ArrayBuffer,
  protection: RelayChunkProtection = "e2e",
) {
  const target = identifierBytes(to, "Target device");
  const payload = createPayload(transferId, offset, chunk);

  if (protection === "transport") {
    const frame = new Uint8Array(2 + target.length + payload.length);
    frame[0] = TRANSPORT_PROTOCOL_VERSION;
    frame[1] = target.length;
    frame.set(target, 2);
    frame.set(payload, 2 + target.length);
    return frame.buffer;
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    payload,
  ));
  const frame = new Uint8Array(2 + target.length + IV_BYTES + ciphertext.length);
  frame[0] = ENCRYPTED_PROTOCOL_VERSION;
  frame[1] = target.length;
  frame.set(target, 2);
  frame.set(iv, 2 + target.length);
  frame.set(ciphertext, 2 + target.length + IV_BYTES);
  return frame.buffer;
}

export async function openRelayChunk(key: CryptoKey, frame: ArrayBuffer): Promise<OpenedRelayChunk> {
  const bytes = new Uint8Array(frame);
  if (bytes.length < 2 + 1 + 1 + 1 + OFFSET_BYTES + 1) throw new Error("File relay frame is too short");
  const version = bytes[0];
  if (version !== ENCRYPTED_PROTOCOL_VERSION && version !== TRANSPORT_PROTOCOL_VERSION) {
    throw new Error("File relay version is unsupported");
  }

  const sourceLength = bytes[1];
  const payloadOffset = 2 + sourceLength;
  if (!sourceLength || sourceLength > MAX_IDENTIFIER_BYTES) {
    throw new Error("Source device is invalid");
  }
  if (payloadOffset >= bytes.length) {
    throw new Error("File relay frame is malformed");
  }

  const from = decodeIdentifier(bytes.subarray(2, payloadOffset), "Source device");
  let protection: RelayChunkProtection;
  let payload: Uint8Array;
  if (version === TRANSPORT_PROTOCOL_VERSION) {
    protection = "transport";
    payload = bytes.slice(payloadOffset);
  } else {
    protection = "e2e";
    if (payloadOffset + IV_BYTES + AUTH_TAG_BYTES >= bytes.length) {
      throw new Error("File relay frame is malformed");
    }
    const iv = bytes.slice(payloadOffset, payloadOffset + IV_BYTES);
    const ciphertext = bytes.slice(payloadOffset + IV_BYTES);
    payload = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    ));
  }

  const opened = openPayload(payload);
  return {
    from,
    ...opened,
    protection,
  };
}
