import { randomBytes } from "node:crypto";
import { mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = (process.env.RELAY_URL ?? "ws://127.0.0.1:8787").replace(/\/$/, "");
const totalBytes = Number(process.env.BENCHMARK_MIB ?? 64) * 1024 * 1024;
const chunkBytes = Number(process.env.BENCHMARK_CHUNK_MIB ?? 0.5) * 1024 * 1024;
const protection = process.env.BENCHMARK_PROTECTION
  ?? (process.env.BENCHMARK_ENCRYPTED === "false" ? "transport" : "e2e");
const encrypted = protection === "e2e";
const writeToDisk = process.env.BENCHMARK_WRITE === "true";
const maxInFlightBytes = 32 * 1024 * 1024;
const maxSocketBufferedBytes = 4 * 1024 * 1024;
const writeBatchBytes = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const additionalData = encoder.encode("file-relay-binary:v1");

if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error("BENCHMARK_MIB is invalid");
if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("BENCHMARK_CHUNK_MIB is invalid");
if (!["e2e", "transport"].includes(protection)) {
  throw new Error("BENCHMARK_PROTECTION must be e2e or transport");
}

function connect(roomId, clientId, verifier) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin}/rooms/${roomId}/connect?clientId=${clientId}`);
    socket.binaryType = "arraybuffer";
    const timeout = setTimeout(() => reject(new Error(`Timed out connecting ${clientId}`)), 15_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "authenticate", verifier, name: clientId }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type !== "authenticated") return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function sealChunk(key, targetId, transferId, offset, byteLength) {
  const target = encoder.encode(targetId);
  const transfer = encoder.encode(transferId);
  const plaintext = new Uint8Array(1 + transfer.length + 8 + byteLength);
  plaintext[0] = transfer.length;
  plaintext.set(transfer, 1);
  new DataView(plaintext.buffer).setBigUint64(1 + transfer.length, BigInt(offset));

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  ));
  const frame = new Uint8Array(2 + target.length + iv.length + ciphertext.length);
  frame[0] = 1;
  frame[1] = target.length;
  frame.set(target, 2);
  frame.set(iv, 2 + target.length);
  frame.set(ciphertext, 2 + target.length + iv.length);
  return frame.buffer;
}

function transportChunk(targetId, transferId, offset, byteLength) {
  const target = encoder.encode(targetId);
  const transfer = encoder.encode(transferId);
  const payload = new Uint8Array(1 + transfer.length + 8 + byteLength);
  payload[0] = transfer.length;
  payload.set(transfer, 1);
  new DataView(payload.buffer).setBigUint64(1 + transfer.length, BigInt(offset));
  const frame = new Uint8Array(2 + target.length + payload.length);
  frame[0] = 2;
  frame[1] = target.length;
  frame.set(target, 2);
  frame.set(payload, 2 + target.length);
  return frame.buffer;
}

const roomId = randomBytes(32).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const key = encrypted
  ? await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
  : null;
const senderId = "benchmark-sender";
const receiverId = "benchmark-receiver";
const transferId = "benchmark-transfer";
const sender = await connect(roomId, senderId, verifier);
const receiver = await connect(roomId, receiverId, verifier);

let temporaryDirectory;
let sinkPath;
let sink;
if (writeToDisk) {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "copypaesto-benchmark-"));
  sinkPath = join(temporaryDirectory, "received.bin");
  sink = await open(sinkPath, "w");
}

let receivedBytes = 0;
let decodedBytes = 0;
let pendingBytes = 0;
let pendingChunks = [];
let receiveChain = Promise.resolve();
let finish;
let fail;
const completed = new Promise((resolve, reject) => {
  finish = resolve;
  fail = reject;
});

async function consumeChunk(chunk) {
  if (decodedBytes + chunk.byteLength > totalBytes) throw new Error("Relay delivered too many bytes");
  decodedBytes += chunk.byteLength;
  pendingBytes += chunk.byteLength;
  pendingChunks.push(chunk);
  if (pendingBytes < writeBatchBytes && decodedBytes !== totalBytes) return;

  const batchBytes = pendingBytes;
  const batch = new Uint8Array(batchBytes);
  let batchOffset = 0;
  for (const pending of pendingChunks) {
    batch.set(pending, batchOffset);
    batchOffset += pending.byteLength;
  }
  pendingBytes = 0;
  pendingChunks = [];
  if (sink) await sink.write(batch);
  receivedBytes += batchBytes;
  if (receivedBytes === totalBytes) finish();
}

receiver.addEventListener("message", (event) => {
  if (!(event.data instanceof ArrayBuffer)) return;
  receiveChain = receiveChain.then(async () => {
    const frame = new Uint8Array(event.data);
    const sourceLength = frame[1];
    const payloadOffset = 2 + sourceLength;
    if (!encrypted) {
      const payload = frame.subarray(payloadOffset);
      const transferLength = payload[0];
      const chunkOffset = 1 + transferLength + 8;
      await consumeChunk(payload.subarray(chunkOffset));
      return;
    }
    const iv = frame.slice(payloadOffset, payloadOffset + 12);
    const ciphertext = frame.slice(payloadOffset + 12);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    ));
    const transferLength = plaintext[0];
    const chunkOffset = 1 + transferLength + 8;
    await consumeChunk(plaintext.subarray(chunkOffset));
  }).catch(fail);
});

try {
  const started = performance.now();
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    while (
      sender.bufferedAmount >= maxSocketBufferedBytes ||
      offset - receivedBytes >= maxInFlightBytes
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const byteLength = Math.min(chunkBytes, totalBytes - offset);
    const frame = encrypted
      ? await sealChunk(key, receiverId, transferId, offset, byteLength)
      : transportChunk(receiverId, transferId, offset, byteLength);
    sender.send(frame);
  }
  await completed;
  await receiveChain;
  if (sink) {
    const info = await sink.stat();
    if (info.size !== totalBytes) throw new Error(`Disk sink ended at ${info.size} bytes`);
    await sink.close();
    sink = undefined;
  }
  const seconds = (performance.now() - started) / 1000;
  const mib = totalBytes / 1024 / 1024;

  console.log(JSON.stringify({
    relay: origin,
    protection,
    chunkMiB: chunkBytes / 1024 / 1024,
    transferredMiB: mib,
    messages: Math.ceil(totalBytes / chunkBytes),
    diskSink: writeToDisk,
    seconds: Number(seconds.toFixed(2)),
    mibPerSecond: Number((mib / seconds).toFixed(2)),
    mbitPerSecond: Number((mib * 8 / seconds).toFixed(1)),
  }));
} finally {
  sender.close(1000, "Benchmark complete");
  receiver.close(1000, "Benchmark complete");
  if (sink) await sink.close().catch(() => undefined);
  if (sinkPath) await unlink(sinkPath).catch(() => undefined);
  if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => undefined);
}
