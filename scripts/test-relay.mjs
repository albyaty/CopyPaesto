import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = (process.env.RELAY_URL ?? "ws://127.0.0.1:8787").replace(/\/$/, "");
const httpOrigin = origin.replace(/^ws/, "http");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value) {
  return Buffer.from(value, "base64url");
}

async function jsonRequest(path, { token, ...init } = {}) {
  const response = await fetch(`${httpOrigin}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function identity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return { keyPair, publicKey: await crypto.subtle.exportKey("jwk", keyPair.publicKey) };
}

async function pairingKey(privateKey, peerPublicKey, requestId) {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    peerPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
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

async function seal(privateKey, peerPublicKey, requestId, value) {
  const key = await pairingKey(privateKey, peerPublicKey, requestId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`pairing:${requestId}:v1`),
    },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { v: 1, iv: bytesToBase64Url(iv), data: bytesToBase64Url(data) };
}

async function open(privateKey, peerPublicKey, requestId, envelope) {
  const key = await pairingKey(privateKey, peerPublicKey, requestId);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.iv),
      additionalData: encoder.encode(`pairing:${requestId}:v1`),
    },
    key,
    base64UrlToBytes(envelope.data),
  );
  return JSON.parse(decoder.decode(plaintext));
}

async function testPairing() {
  const host = await identity();
  const joiner = await identity();
  const thirdDevice = await identity();
  const created = await jsonRequest("/pairings", {
    method: "POST",
    body: JSON.stringify({ hostId: "pair-host", hostName: "Host laptop", hostPublicKey: host.publicKey }),
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.code, /^\d{5}$/);
  assert.ok(created.body.pairingId);
  assert.ok(created.body.hostToken);

  const invalid = await jsonRequest("/pairings/join", {
    method: "POST",
    body: JSON.stringify({ code: "00000", joinerId: "invalid", joinerName: "Invalid", joinerPublicKey: joiner.publicKey }),
  });
  assert.equal(invalid.response.status, 404);

  const joined = await jsonRequest("/pairings/join", {
    method: "POST",
    body: JSON.stringify({
      code: created.body.code,
      joinerId: "pair-joiner",
      joinerName: "Second laptop",
      joinerPublicKey: joiner.publicKey,
    }),
  });
  assert.equal(joined.response.status, 201);
  assert.deepEqual(joined.body.hostPublicKey.x, host.publicKey.x);

  const thirdJoined = await jsonRequest("/pairings/join", {
    method: "POST",
    body: JSON.stringify({
      code: created.body.code,
      joinerId: "pair-third",
      joinerName: "Work VM",
      joinerPublicKey: thirdDevice.publicKey,
    }),
  });
  assert.equal(thirdJoined.response.status, 201);
  assert.deepEqual(thirdJoined.body.hostPublicKey.x, host.publicKey.x);

  const unauthorized = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests`,
    { token: randomBytes(32).toString("base64url") },
  );
  assert.equal(unauthorized.response.status, 403);

  const requests = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests`,
    { token: created.body.hostToken },
  );
  assert.equal(requests.response.status, 200);
  assert.equal(requests.body.requests.length, 2);
  const secondRequest = requests.body.requests.find((request) => request.requestId === joined.body.requestId);
  const thirdRequest = requests.body.requests.find((request) => request.requestId === thirdJoined.body.requestId);
  assert.ok(secondRequest);
  assert.ok(thirdRequest);
  assert.equal(secondRequest.deviceName, "Second laptop");
  assert.equal(thirdRequest.deviceName, "Work VM");

  const hiddenSession = {
    code: randomBytes(9).toString("base64url").slice(0, 12).toUpperCase(),
    pin: String(10_000 + Math.floor(Math.random() * 90_000)),
  };
  const envelope = await seal(
    host.keyPair.privateKey,
    secondRequest.publicKey,
    joined.body.requestId,
    hiddenSession,
  );
  const approved = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests/${joined.body.requestId}/approve`,
    {
      method: "POST",
      token: created.body.hostToken,
      body: JSON.stringify({ envelope }),
    },
  );
  assert.equal(approved.response.status, 200);

  const status = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests/${joined.body.requestId}`,
    { token: joined.body.joinToken },
  );
  assert.equal(status.body.status, "approved");
  const opened = await open(
    joiner.keyPair.privateKey,
    joined.body.hostPublicKey,
    joined.body.requestId,
    status.body.envelope,
  );
  assert.deepEqual(opened, hiddenSession);

  const thirdEnvelope = await seal(
    host.keyPair.privateKey,
    thirdRequest.publicKey,
    thirdJoined.body.requestId,
    hiddenSession,
  );
  const thirdApproved = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests/${thirdJoined.body.requestId}/approve`,
    {
      method: "POST",
      token: created.body.hostToken,
      body: JSON.stringify({ envelope: thirdEnvelope }),
    },
  );
  assert.equal(thirdApproved.response.status, 200);

  const thirdStatus = await jsonRequest(
    `/pairings/${created.body.pairingId}/requests/${thirdJoined.body.requestId}`,
    { token: thirdJoined.body.joinToken },
  );
  const thirdOpened = await open(
    thirdDevice.keyPair.privateKey,
    thirdJoined.body.hostPublicKey,
    thirdJoined.body.requestId,
    thirdStatus.body.envelope,
  );
  assert.deepEqual(thirdOpened, hiddenSession);
}

function connect(roomId, clientId) {
  const socket = new WebSocket(`${origin}/rooms/${roomId}/connect?clientId=${clientId}`);
  socket.binaryType = "arraybuffer";
  const queued = [];
  const waiters = [];

  socket.addEventListener("message", (event) => {
    const message = typeof event.data === "string"
      ? JSON.parse(event.data)
      : { type: "binary", data: event.data };
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });

  return {
    socket,
    opened: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    next(predicate, timeoutMs = 4_000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error("Timed out waiting for relay message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    closed: new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    }),
  };
}

async function testRoom() {
  const roomId = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const first = connect(roomId, "integration-a");
  await first.opened;
  first.socket.send(JSON.stringify({ type: "authenticate", verifier, name: "Test A" }));
  assert.equal((await first.next((message) => message.type === "authenticated")).type, "authenticated");
  assert.deepEqual((await first.next((message) => message.type === "snapshot")).slots, []);

  const unauthorizedTurn = await jsonRequest(`/rooms/${roomId}/turn`, {
    method: "POST",
    token: randomBytes(32).toString("base64url"),
  });
  assert.equal(unauthorizedTurn.response.status, 403);
  const authorizedTurn = await jsonRequest(`/rooms/${roomId}/turn`, {
    method: "POST",
    token: verifier,
  });
  assert.equal(authorizedTurn.response.status, 200);
  assert.ok(Array.isArray(authorizedTurn.body.iceServers));

  const rejected = connect(roomId, "integration-rejected");
  await rejected.opened;
  rejected.socket.send(JSON.stringify({
    type: "authenticate",
    verifier: randomBytes(32).toString("base64url"),
    name: "Wrong key",
  }));
  const rejection = await rejected.closed;
  assert.equal(rejection.code, 4003);

  const second = connect(roomId, "integration-b");
  await second.opened;
  second.socket.send(JSON.stringify({ type: "authenticate", verifier, name: "Test B" }));
  await second.next((message) => message.type === "authenticated");
  await second.next((message) => message.type === "snapshot");
  const presence = await second.next((message) => message.type === "presence" && message.peers.length === 2);
  assert.deepEqual(new Set(presence.peers.map((peer) => peer.id)), new Set(["integration-a", "integration-b"]));

  const third = connect(roomId, "integration-c");
  await third.opened;
  third.socket.send(JSON.stringify({ type: "authenticate", verifier, name: "Test C" }));
  await third.next((message) => message.type === "authenticated");
  await third.next((message) => message.type === "snapshot");
  const threeDevicePresence = await third.next((message) => message.type === "presence" && message.peers.length === 3);
  assert.deepEqual(
    new Set(threeDevicePresence.peers.map((peer) => peer.id)),
    new Set(["integration-a", "integration-b", "integration-c"]),
  );

  const envelope = { v: 1, iv: "test-iv", data: "encrypted-test-payload" };
  first.socket.send(JSON.stringify({ type: "slot:update", slot: 1, envelope }));
  const update = await second.next((message) => message.type === "slot:update" && message.slot === 1);
  const thirdUpdate = await third.next((message) => message.type === "slot:update" && message.slot === 1);
  assert.equal(update.sequence, 1);
  assert.deepEqual(update.envelope, envelope);
  assert.equal(thirdUpdate.sequence, 1);
  assert.deepEqual(thirdUpdate.envelope, envelope);

  first.socket.send(JSON.stringify({ type: "signal", to: "integration-b", envelope }));
  const signal = await second.next((message) => message.type === "signal");
  assert.equal(signal.from, "integration-a");
  assert.deepEqual(signal.envelope, envelope);

  first.socket.send(JSON.stringify({ type: "file:relay", to: "integration-b", envelope }));
  const fileRelay = await second.next((message) => message.type === "file:relay");
  assert.equal(fileRelay.from, "integration-a");
  assert.deepEqual(fileRelay.envelope, envelope);

  const chunkEnvelope = { v: 1, iv: "chunk-iv", data: "x".repeat(60_000) };
  first.socket.send(JSON.stringify({ type: "file:relay", to: "integration-b", envelope: chunkEnvelope }));
  const chunkRelay = await second.next((message) => message.type === "file:relay" && message.envelope.data.length === 60_000);
  assert.deepEqual(chunkRelay.envelope, chunkEnvelope);

  const target = encoder.encode("integration-b");
  const opaqueEncryptedPayload = randomBytes(2 * 1024 * 1024);
  const binaryFrame = new Uint8Array(2 + target.length + opaqueEncryptedPayload.length);
  binaryFrame[0] = 1;
  binaryFrame[1] = target.length;
  binaryFrame.set(target, 2);
  binaryFrame.set(opaqueEncryptedPayload, 2 + target.length);
  first.socket.send(binaryFrame.buffer);

  const binaryRelay = await second.next((message) => message.type === "binary");
  assert.ok(binaryRelay.data instanceof ArrayBuffer);
  const forwarded = new Uint8Array(binaryRelay.data);
  const sourceLength = forwarded[1];
  assert.equal(decoder.decode(forwarded.subarray(2, 2 + sourceLength)), "integration-a");
  assert.deepEqual(
    Buffer.from(forwarded.subarray(2 + sourceLength)),
    Buffer.from(opaqueEncryptedPayload),
  );

  const turboTarget = encoder.encode("integration-c");
  const turboTransfer = encoder.encode("turbo-transfer");
  const turboChunk = randomBytes(128 * 1024);
  const turboPayload = new Uint8Array(1 + turboTransfer.length + 8 + turboChunk.length);
  turboPayload[0] = turboTransfer.length;
  turboPayload.set(turboTransfer, 1);
  new DataView(turboPayload.buffer).setBigUint64(1 + turboTransfer.length, 0n);
  turboPayload.set(turboChunk, 1 + turboTransfer.length + 8);
  const turboFrame = new Uint8Array(2 + turboTarget.length + turboPayload.length);
  turboFrame[0] = 2;
  turboFrame[1] = turboTarget.length;
  turboFrame.set(turboTarget, 2);
  turboFrame.set(turboPayload, 2 + turboTarget.length);
  first.socket.send(turboFrame.buffer);

  const turboRelay = await third.next((message) => message.type === "binary");
  const turboForwarded = new Uint8Array(turboRelay.data);
  assert.equal(turboForwarded[0], 2);
  const turboSourceLength = turboForwarded[1];
  assert.equal(decoder.decode(turboForwarded.subarray(2, 2 + turboSourceLength)), "integration-a");
  assert.deepEqual(
    Buffer.from(turboForwarded.subarray(2 + turboSourceLength)),
    Buffer.from(turboPayload),
  );

  first.socket.close(1000, "Test complete");
  second.socket.close(1000, "Test complete");
  third.socket.close(1000, "Test complete");
}

await testPairing();
await testRoom();

console.log("Relay integration passed: multi-device 5-digit approval, E2E handoff, PIN gate, three-device clipboard sync, signaling, and private/Turbo file routing.");
