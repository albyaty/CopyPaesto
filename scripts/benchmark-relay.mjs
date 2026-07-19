import { randomBytes } from "node:crypto";

const origin = (process.env.RELAY_URL ?? "ws://127.0.0.1:8787").replace(/\/$/, "");
const totalBytes = Number(process.env.BENCHMARK_MIB ?? 64) * 1024 * 1024;
const chunkBytes = Number(process.env.BENCHMARK_CHUNK_MIB ?? 0.5) * 1024 * 1024;
const maxBufferedBytes = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const additionalData = encoder.encode("file-relay-binary:v1");

if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error("BENCHMARK_MIB is invalid");
if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("BENCHMARK_CHUNK_MIB is invalid");

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

const roomId = randomBytes(32).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const senderId = "benchmark-sender";
const receiverId = "benchmark-receiver";
const transferId = "benchmark-transfer";
const sender = await connect(roomId, senderId, verifier);
const receiver = await connect(roomId, receiverId, verifier);

let receivedBytes = 0;
let receiveChain = Promise.resolve();
let finish;
let fail;
const completed = new Promise((resolve, reject) => {
  finish = resolve;
  fail = reject;
});

receiver.addEventListener("message", (event) => {
  if (!(event.data instanceof ArrayBuffer)) return;
  receiveChain = receiveChain.then(async () => {
    const frame = new Uint8Array(event.data);
    const sourceLength = frame[1];
    const encryptedOffset = 2 + sourceLength;
    const iv = frame.slice(encryptedOffset, encryptedOffset + 12);
    const ciphertext = frame.slice(encryptedOffset + 12);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    ));
    const transferLength = plaintext[0];
    const chunkOffset = 1 + transferLength + 8;
    receivedBytes += plaintext.length - chunkOffset;
    if (receivedBytes === totalBytes) finish();
  }).catch(fail);
});

const started = performance.now();
for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
  while (sender.bufferedAmount >= maxBufferedBytes) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const byteLength = Math.min(chunkBytes, totalBytes - offset);
  sender.send(await sealChunk(key, receiverId, transferId, offset, byteLength));
}
await completed;
const seconds = (performance.now() - started) / 1000;
const mib = totalBytes / 1024 / 1024;

console.log(JSON.stringify({
  relay: origin,
  encrypted: true,
  chunkMiB: chunkBytes / 1024 / 1024,
  transferredMiB: mib,
  messages: Math.ceil(totalBytes / chunkBytes),
  seconds: Number(seconds.toFixed(2)),
  mibPerSecond: Number((mib / seconds).toFixed(2)),
  mbitPerSecond: Number((mib * 8 / seconds).toFixed(1)),
}));

sender.close(1000, "Benchmark complete");
receiver.close(1000, "Benchmark complete");
