import assert from "node:assert/strict";
import {
  MAX_RELAY_CHUNK_BYTES,
  openRelayChunk,
  sealRelayChunk,
} from "../apps/web/src/lib/fileRelay.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const key = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);
const otherKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);
const chunk = encoder.encode("CopyPaesto binary relay round trip").buffer;

const privateFrame = await sealRelayChunk(
  key,
  "receiving-device",
  "private-transfer",
  524_288,
  chunk,
  "e2e",
);
assert.equal(new Uint8Array(privateFrame)[0], 1);
const privateOpened = await openRelayChunk(key, privateFrame);
assert.equal(privateOpened.from, "receiving-device");
assert.equal(privateOpened.transferId, "private-transfer");
assert.equal(privateOpened.offset, 524_288);
assert.equal(privateOpened.protection, "e2e");
assert.equal(decoder.decode(privateOpened.chunk), decoder.decode(chunk));
await assert.rejects(() => openRelayChunk(otherKey, privateFrame));

const tamperedPrivateFrame = privateFrame.slice(0);
const tamperedBytes = new Uint8Array(tamperedPrivateFrame);
tamperedBytes[tamperedBytes.length - 1] ^= 1;
await assert.rejects(() => openRelayChunk(key, tamperedPrivateFrame));

const turboFrame = await sealRelayChunk(
  key,
  "receiving-device",
  "turbo-transfer",
  1_048_576,
  chunk,
  "transport",
);
assert.equal(new Uint8Array(turboFrame)[0], 2);
const turboOpened = await openRelayChunk(otherKey, turboFrame);
assert.equal(turboOpened.from, "receiving-device");
assert.equal(turboOpened.transferId, "turbo-transfer");
assert.equal(turboOpened.offset, 1_048_576);
assert.equal(turboOpened.protection, "transport");
assert.equal(decoder.decode(turboOpened.chunk), decoder.decode(chunk));

const unsupportedFrame = turboFrame.slice(0);
new Uint8Array(unsupportedFrame)[0] = 9;
await assert.rejects(() => openRelayChunk(key, unsupportedFrame));
await assert.rejects(() => sealRelayChunk(
  key,
  "receiving-device",
  "too-large",
  0,
  new ArrayBuffer(MAX_RELAY_CHUNK_BYTES + 1),
  "e2e",
));

console.log("File protocol passed: Private AES-GCM integrity, Turbo transport frames, offsets, limits, and version rejection.");
