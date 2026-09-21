import assert from "node:assert/strict";
import {
  classifyIncomingChunk,
  combineTransferChunks,
  isValidResumePosition,
} from "../apps/web/src/lib/transferFlow.ts";

assert.equal(classifyIncomingChunk(2_097_152, 2_097_152, 2_097_152, 524_288), "append");
assert.equal(classifyIncomingChunk(2_621_440, 2_097_152, 1_572_864, 524_288), "duplicate");
assert.equal(classifyIncomingChunk(2_621_440, 2_097_152, 2_097_152, 524_288), "invalid");
assert.equal(classifyIncomingChunk(2_097_152, 2_097_152, 2_621_440, 524_288), "invalid");

assert.equal(isValidResumePosition(2_097_152, 33_554_432, 2_147_483_648, 2_097_152), true);
assert.equal(isValidResumePosition(2_097_152, 33_554_432, 2_147_483_648, 16_777_216), true);
assert.equal(isValidResumePosition(2_097_152, 33_554_432, 2_147_483_648, 1_572_864), false);
assert.equal(isValidResumePosition(2_097_152, 33_554_432, 2_147_483_648, 34_078_720), false);

const chunks = [
  Uint8Array.from([1, 2]).buffer,
  Uint8Array.from([3]).buffer,
  Uint8Array.from([4, 5, 6]).buffer,
];
assert.deepEqual(new Uint8Array(combineTransferChunks(chunks, 6)), Uint8Array.from([1, 2, 3, 4, 5, 6]));

console.log("Transfer flow passed: batching, written checkpoints, duplicate replay, gaps, and resume bounds.");
