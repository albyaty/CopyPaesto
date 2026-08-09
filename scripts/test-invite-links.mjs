import assert from "node:assert/strict";

const browserLocation = {
  href: "https://send.example/app/?source=test#keep=1&invite=48291",
  hash: "#keep=1&invite=48291",
  pathname: "/app/",
  search: "?source=test",
};

const browserHistory = {
  replaceState(_state, _unused, next) {
    const url = new URL(next, browserLocation.href);
    browserLocation.href = url.toString();
    browserLocation.hash = url.hash;
    browserLocation.pathname = url.pathname;
    browserLocation.search = url.search;
  },
};

globalThis.window = {
  location: browserLocation,
  history: browserHistory,
};

const {
  clearPairingInviteFromHash,
  pairingInviteUrl,
  readPairingInviteFromHash,
} = await import("../apps/web/src/lib/session.ts");

assert.equal(readPairingInviteFromHash(), "48291");
assert.equal(
  pairingInviteUrl("13579"),
  "https://send.example/app/?source=test#keep=1&invite=13579",
);
assert.throws(() => pairingInviteUrl("123"), /Invalid pairing code/);

clearPairingInviteFromHash();
assert.equal(browserLocation.hash, "#keep=1");
assert.equal(readPairingInviteFromHash(), "");

browserLocation.hash = "#invite=12-345";
assert.equal(readPairingInviteFromHash(), "12345");

console.log("Invitation links passed: fragment parsing, URL creation, validation, and cleanup.");
