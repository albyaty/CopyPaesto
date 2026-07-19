import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = (process.env.RELAY_URL ?? "ws://127.0.0.1:8787").replace(/\/$/, "");
const roomId = randomBytes(32).toString("base64url");
const verifier = randomBytes(32).toString("base64url");

function connect(clientId) {
  const socket = new WebSocket(`${origin}/rooms/${roomId}/connect?clientId=${clientId}`);
  const queued = [];
  const waiters = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
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

const first = connect("integration-a");
await first.opened;
first.socket.send(JSON.stringify({ type: "authenticate", verifier, name: "Test A" }));
assert.equal((await first.next((message) => message.type === "authenticated")).type, "authenticated");
assert.deepEqual((await first.next((message) => message.type === "snapshot")).slots, []);

const rejected = connect("integration-rejected");
await rejected.opened;
rejected.socket.send(JSON.stringify({
  type: "authenticate",
  verifier: randomBytes(32).toString("base64url"),
  name: "Wrong PIN",
}));
const rejection = await rejected.closed;
assert.equal(rejection.code, 4003);

const second = connect("integration-b");
await second.opened;
second.socket.send(JSON.stringify({ type: "authenticate", verifier, name: "Test B" }));
await second.next((message) => message.type === "authenticated");
await second.next((message) => message.type === "snapshot");
const presence = await second.next((message) => message.type === "presence" && message.peers.length === 2);
assert.deepEqual(new Set(presence.peers.map((peer) => peer.id)), new Set(["integration-a", "integration-b"]));

const envelope = { v: 1, iv: "test-iv", data: "encrypted-test-payload" };
first.socket.send(JSON.stringify({ type: "slot:update", slot: 1, envelope }));
const update = await second.next((message) => message.type === "slot:update" && message.slot === 1);
assert.equal(update.sequence, 1);
assert.deepEqual(update.envelope, envelope);

first.socket.send(JSON.stringify({ type: "signal", to: "integration-b", envelope }));
const signal = await second.next((message) => message.type === "signal");
assert.equal(signal.from, "integration-a");
assert.deepEqual(signal.envelope, envelope);

first.socket.close(1000, "Test complete");
second.socket.close(1000, "Test complete");

console.log("Relay integration passed: PIN gate, presence, encrypted state, and signaling.");
