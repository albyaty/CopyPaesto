export const INVITATION_LIFETIME_MS = 6 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 15 * 60 * 1000;
const MAX_EXCHANGE_BYTES = 200_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SharedFileDescription {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface OfferPayload {
  v: 1;
  kind: "offer";
  transferId: string;
  issuedAt: number;
  expiresAt: number;
  secret: string;
  file: SharedFileDescription;
  description: RTCSessionDescriptionInit;
}

export interface AnswerPayload {
  v: 1;
  kind: "answer";
  transferId: string;
  expiresAt: number;
  description: RTCSessionDescriptionInit;
  proof: string;
}

export type ExchangePayload = OfferPayload | AnswerPayload;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const windowSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += windowSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + windowSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("This exchange code contains invalid characters.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function compress(bytes: Uint8Array) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(bytes: Uint8Array) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot open compressed exchange codes. Try a current Chrome, Edge, Firefox, or Safari release.");
  }
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_EXCHANGE_BYTES) {
      await reader.cancel();
      throw new Error("This exchange code expands beyond the safety limit.");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function encodeExchange(payload: ExchangePayload) {
  const plain = encoder.encode(JSON.stringify(payload));
  const compressed = await compress(plain);
  if (compressed && compressed.length < plain.length) return `cp1g.${bytesToBase64Url(compressed)}`;
  return `cp1j.${bytesToBase64Url(plain)}`;
}

export async function decodeExchange(value: string): Promise<ExchangePayload> {
  let normalized = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    try {
      const params = new URLSearchParams(new URL(normalized).hash.replace(/^#/, ""));
      normalized = params.get("offer") ?? params.get("answer") ?? normalized;
    } catch {
      // The regular exchange-code validation below provides a clearer error.
    }
  }
  normalized = normalized.replace(/^#?(?:offer|answer)=/i, "");
  if (normalized.length > MAX_EXCHANGE_BYTES) throw new Error("This exchange code is too large.");
  const separator = normalized.indexOf(".");
  if (separator < 0) throw new Error("This is not a CopyPaesto exchange code.");
  const prefix = normalized.slice(0, separator);
  const encoded = normalized.slice(separator + 1);
  const packed = base64UrlToBytes(encoded);
  const bytes = prefix === "cp1g" ? await decompress(packed) : prefix === "cp1j" ? packed : null;
  if (!bytes) throw new Error("This exchange code uses an unsupported version.");
  if (bytes.length > MAX_EXCHANGE_BYTES) throw new Error("This exchange code expands beyond the safety limit.");

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("This exchange code is damaged or incomplete.");
  }
  assertExchangePayload(payload);
  return payload;
}

function isDescription(value: unknown): value is RTCSessionDescriptionInit {
  if (!value || typeof value !== "object") return false;
  const candidate = value as RTCSessionDescriptionInit;
  return (
    (candidate.type === "offer" || candidate.type === "answer") &&
    typeof candidate.sdp === "string" &&
    candidate.sdp.length > 0 &&
    candidate.sdp.length < 100_000
  );
}

function isSafeFile(value: unknown): value is SharedFileDescription {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedFileDescription>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    candidate.name.length <= 255 &&
    typeof candidate.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    typeof candidate.type === "string" &&
    candidate.type.length <= 200 &&
    typeof candidate.lastModified === "number" &&
    Number.isFinite(candidate.lastModified)
  );
}

function assertExchangePayload(value: unknown): asserts value is ExchangePayload {
  if (!value || typeof value !== "object") throw new Error("This exchange code has no usable payload.");
  const candidate = value as Partial<ExchangePayload>;
  if (
    candidate.v !== 1 ||
    (candidate.kind !== "offer" && candidate.kind !== "answer") ||
    typeof candidate.transferId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(candidate.transferId) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt) ||
    !isDescription(candidate.description)
  ) {
    throw new Error("This exchange code has an invalid payload.");
  }
  if (candidate.kind === "offer") {
    const offer = candidate as Partial<OfferPayload>;
    if (
      typeof offer.issuedAt !== "number" ||
      !Number.isFinite(offer.issuedAt) ||
      offer.expiresAt !== offer.issuedAt + INVITATION_LIFETIME_MS ||
      typeof offer.secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(offer.secret) ||
      !isSafeFile(offer.file) ||
      offer.description?.type !== "offer"
    ) {
      throw new Error("This invitation has an invalid payload.");
    }
  } else {
    const answer = candidate as Partial<AnswerPayload>;
    if (
      typeof answer.proof !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(answer.proof) ||
      answer.description?.type !== "answer"
    ) {
      throw new Error("This answer has an invalid payload.");
    }
  }
}

export function assertOfferTime(offer: OfferPayload, now = Date.now()) {
  if (offer.issuedAt > now + CLOCK_SKEW_MS) throw new Error("This invitation was created by a device whose clock is too far ahead.");
  if (offer.expiresAt <= now - CLOCK_SKEW_MS) throw new Error("This invitation expired. Ask the sender to create a new one.");
}

export function randomSecret() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function canonicalAnswer(answer: Pick<AnswerPayload, "transferId" | "expiresAt" | "description">) {
  return JSON.stringify({
    transferId: answer.transferId,
    expiresAt: answer.expiresAt,
    type: answer.description.type,
    sdp: answer.description.sdp,
  });
}

export async function signAnswer(
  secret: string,
  answer: Pick<AnswerPayload, "transferId" | "expiresAt" | "description">,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalAnswer(answer)));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyAnswer(secret: string, answer: AnswerPayload) {
  const expected = await signAnswer(secret, answer);
  const left = encoder.encode(expected);
  const right = encoder.encode(answer.proof);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verificationWords(secret: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", base64UrlToBytes(secret)));
  return [...digest.slice(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("")
    .match(/.{1,4}/g)!
    .join(" ");
}
