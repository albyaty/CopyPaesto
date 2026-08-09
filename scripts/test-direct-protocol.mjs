import assert from "node:assert/strict";
import {
  INVITATION_LIFETIME_MS,
  assertOfferTime,
  decodeExchange,
  encodeExchange,
  randomSecret,
  signAnswer,
  verificationWords,
  verifyAnswer,
} from "../apps/direct/src/protocol.ts";

const issuedAt = Date.now();
const secret = randomSecret();
const offer = {
  v: 1,
  kind: "offer",
  transferId: crypto.randomUUID(),
  issuedAt,
  expiresAt: issuedAt + INVITATION_LIFETIME_MS,
  secret,
  file: {
    name: "china-transfer-test.txt",
    size: 1234,
    type: "text/plain",
    lastModified: issuedAt,
  },
  description: { type: "offer", sdp: "v=0\r\na=test-offer\r\n" },
};

const encodedOffer = await encodeExchange(offer);
assert.match(encodedOffer, /^cp1[gj]\.[A-Za-z0-9_-]+$/);
assert.deepEqual(await decodeExchange(encodedOffer), offer);
assert.deepEqual(await decodeExchange(`https://transfer.example/#offer=${encodedOffer}`), offer);
assert.doesNotThrow(() => assertOfferTime(offer, issuedAt));
assert.throws(
  () => assertOfferTime(offer, offer.expiresAt + 16 * 60_000),
  /expired/i,
);

const unsignedAnswer = {
  v: 1,
  kind: "answer",
  transferId: offer.transferId,
  expiresAt: offer.expiresAt,
  description: { type: "answer", sdp: "v=0\r\na=test-answer\r\n" },
};
const answer = { ...unsignedAnswer, proof: await signAnswer(secret, unsignedAnswer) };
const encodedAnswer = await encodeExchange(answer);
assert.deepEqual(await decodeExchange(encodedAnswer), answer);
assert.equal(await verifyAnswer(secret, answer), true);
assert.equal(await verifyAnswer(randomSecret(), answer), false);

const changedAnswer = {
  ...answer,
  description: { ...answer.description, sdp: `${answer.description.sdp}a=changed\r\n` },
};
assert.equal(await verifyAnswer(secret, changedAnswer), false);

const verification = await verificationWords(secret);
assert.match(verification, /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);

const damaged = `${encodedOffer.slice(0, -4)}!${encodedOffer.slice(-3)}`;
await assert.rejects(() => decodeExchange(damaged));

console.log("Direct-transfer invitation protocol tests passed");
