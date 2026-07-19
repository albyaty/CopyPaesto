import type { CipherEnvelope } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const windowSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += windowSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + windowSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export interface SessionCredentials {
  roomId: string;
  authVerifier: string;
  encryptionKey: CryptoKey;
}

export async function deriveSessionCredentials(
  normalizedSessionCode: string,
  pin: string,
): Promise<SessionCredentials> {
  const roomDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`copypaesto:room:v1:${normalizedSessionCode}`),
  );

  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${normalizedSessionCode}:${pin}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode("copypaesto:session-keys:v1"),
      iterations: 250_000,
    },
    material,
    512,
  ));

  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    roomId: bytesToBase64Url(new Uint8Array(roomDigest)),
    authVerifier: bytesToBase64Url(derived.slice(32)),
    encryptionKey,
  };
}

export async function encryptValue(
  key: CryptoKey,
  value: unknown,
  context: string,
): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    plaintext,
  );
  return {
    v: 1,
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function decryptValue<T>(
  key: CryptoKey,
  envelope: CipherEnvelope,
  context: string,
): Promise<T> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.iv),
      additionalData: encoder.encode(context),
    },
    key,
    base64UrlToBytes(envelope.data),
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}
