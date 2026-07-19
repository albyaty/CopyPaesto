const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const additionalData = encoder.encode("file-relay-binary:v1");

const PROTOCOL_VERSION = 1;
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

export async function sealRelayChunk(
  key: CryptoKey,
  to: string,
  transferId: string,
  offset: number,
  chunk: ArrayBuffer,
) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("File offset is invalid");
  if (!chunk.byteLength || chunk.byteLength > MAX_RELAY_CHUNK_BYTES) {
    throw new Error("File chunk is invalid");
  }

  const target = identifierBytes(to, "Target device");
  const transfer = identifierBytes(transferId, "Transfer ID");
  const plaintext = new Uint8Array(1 + transfer.length + OFFSET_BYTES + chunk.byteLength);
  plaintext[0] = transfer.length;
  plaintext.set(transfer, 1);
  new DataView(plaintext.buffer).setBigUint64(1 + transfer.length, BigInt(offset));
  plaintext.set(new Uint8Array(chunk), 1 + transfer.length + OFFSET_BYTES);

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  ));
  const frame = new Uint8Array(2 + target.length + IV_BYTES + ciphertext.length);
  frame[0] = PROTOCOL_VERSION;
  frame[1] = target.length;
  frame.set(target, 2);
  frame.set(iv, 2 + target.length);
  frame.set(ciphertext, 2 + target.length + IV_BYTES);
  return frame.buffer;
}

export async function openRelayChunk(key: CryptoKey, frame: ArrayBuffer): Promise<OpenedRelayChunk> {
  const bytes = new Uint8Array(frame);
  if (bytes.length < 2 + 1 + IV_BYTES + AUTH_TAG_BYTES + 1 + 1 + OFFSET_BYTES) {
    throw new Error("File relay frame is too short");
  }
  if (bytes[0] !== PROTOCOL_VERSION) throw new Error("File relay version is unsupported");

  const sourceLength = bytes[1];
  const encryptedOffset = 2 + sourceLength;
  if (!sourceLength || sourceLength > MAX_IDENTIFIER_BYTES) {
    throw new Error("Source device is invalid");
  }
  if (encryptedOffset + IV_BYTES + AUTH_TAG_BYTES >= bytes.length) {
    throw new Error("File relay frame is malformed");
  }

  const from = decodeIdentifier(bytes.subarray(2, encryptedOffset), "Source device");
  const iv = bytes.slice(encryptedOffset, encryptedOffset + IV_BYTES);
  const ciphertext = bytes.slice(encryptedOffset + IV_BYTES);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    ciphertext,
  ));
  const transferLength = plaintext[0];
  const offsetPosition = 1 + transferLength;
  const chunkPosition = offsetPosition + OFFSET_BYTES;
  if (
    !transferLength ||
    transferLength > MAX_IDENTIFIER_BYTES ||
    chunkPosition >= plaintext.length
  ) {
    throw new Error("File relay payload is malformed");
  }

  const transferId = decodeIdentifier(
    plaintext.subarray(1, offsetPosition),
    "Transfer ID",
  );
  const encodedOffset = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + offsetPosition,
    OFFSET_BYTES,
  ).getBigUint64(0);
  if (encodedOffset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("File offset is too large");

  const chunk = plaintext.slice(chunkPosition);
  if (!chunk.length || chunk.length > MAX_RELAY_CHUNK_BYTES) {
    throw new Error("File chunk is invalid");
  }
  return {
    from,
    transferId,
    offset: Number(encodedOffset),
    chunk: chunk.buffer,
  };
}
