import { relayHttpOrigin } from "./relay";
import type { CipherEnvelope } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PairingIdentity {
  keyPair: CryptoKeyPair;
  publicKey: JsonWebKey;
}

export interface CreatedPairing {
  pairingId: string;
  code: string;
  hostToken: string;
  expiresAt: number;
}

export interface PendingPairingRequest {
  requestId: string;
  deviceName: string;
  publicKey: JsonWebKey;
  createdAt: number;
}

export interface JoinedPairing {
  pairingId: string;
  requestId: string;
  joinToken: string;
  hostPublicKey: JsonWebKey;
  hostName: string;
  expiresAt: number;
}

export interface PairingSessionPayload {
  code: string;
  pin: string;
}

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

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${relayHttpOrigin()}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Pairing could not be completed");
  return result;
}

async function derivePairingKey(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  requestId: string,
) {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    peerPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("copypaesto:pairing:v1"),
      info: encoder.encode(requestId),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createPairingIdentity(): Promise<PairingIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { keyPair, publicKey };
}

export async function sealPairingSession(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  requestId: string,
  payload: PairingSessionPayload,
): Promise<CipherEnvelope> {
  const key = await derivePairingKey(privateKey, peerPublicKey, requestId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`pairing:${requestId}:v1`),
    },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    v: 1,
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function openPairingSession(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  requestId: string,
  envelope: CipherEnvelope,
): Promise<PairingSessionPayload> {
  const key = await derivePairingKey(privateKey, peerPublicKey, requestId);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.iv),
      additionalData: encoder.encode(`pairing:${requestId}:v1`),
    },
    key,
    base64UrlToBytes(envelope.data),
  );
  return JSON.parse(decoder.decode(decrypted)) as PairingSessionPayload;
}

export function createPairing(
  hostId: string,
  hostName: string,
  hostPublicKey: JsonWebKey,
) {
  return api<CreatedPairing>("/pairings", {
    method: "POST",
    body: JSON.stringify({ hostId, hostName, hostPublicKey }),
  });
}

export async function listPairingRequests(pairingId: string, hostToken: string) {
  const result = await api<{ requests: PendingPairingRequest[]; expiresAt: number }>(
    `/pairings/${encodeURIComponent(pairingId)}/requests`,
    { headers: { authorization: `Bearer ${hostToken}` } },
  );
  return result.requests;
}

export function joinPairing(
  code: string,
  joinerId: string,
  joinerName: string,
  joinerPublicKey: JsonWebKey,
) {
  return api<JoinedPairing>("/pairings/join", {
    method: "POST",
    body: JSON.stringify({ code, joinerId, joinerName, joinerPublicKey }),
  });
}

export function approvePairing(
  pairingId: string,
  requestId: string,
  hostToken: string,
  envelope: CipherEnvelope,
) {
  return api<{ ok: true; status: "approved" }>(
    `/pairings/${encodeURIComponent(pairingId)}/requests/${encodeURIComponent(requestId)}/approve`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ envelope }),
    },
  );
}

export function rejectPairing(pairingId: string, requestId: string, hostToken: string) {
  return api<{ ok: true; status: "rejected" }>(
    `/pairings/${encodeURIComponent(pairingId)}/requests/${encodeURIComponent(requestId)}/reject`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({}),
    },
  );
}

export function pairingRequestStatus(pairingId: string, requestId: string, joinToken: string) {
  return api<{
    status: "pending" | "approved" | "rejected";
    envelope?: CipherEnvelope;
    expiresAt: number;
  }>(`/pairings/${encodeURIComponent(pairingId)}/requests/${encodeURIComponent(requestId)}`, {
    headers: { authorization: `Bearer ${joinToken}` },
  });
}
