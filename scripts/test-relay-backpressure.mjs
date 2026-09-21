import assert from "node:assert/strict";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  listeners = new Map();
  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(value) {
    this.sent.push(value);
    if (value instanceof ArrayBuffer) this.bufferedAmount += value.byteLength;
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.window = globalThis;
globalThis.location = { hostname: "localhost", protocol: "http:", host: "localhost:8787" };

const { RoomRelay } = await import("../apps/web/src/lib/relay.ts");
const relay = new RoomRelay({
  onOpen() {},
  onMessage() {},
  onBinary() {},
  onClose() {},
  onError() {},
});
relay.connect("room", "client", "a".repeat(43), "Browser");
const socket = FakeWebSocket.instances[0];
socket.open();

socket.bufferedAmount = 4 * 1024 * 1024 - 256 * 1024;
const first = relay.sendBinary(new ArrayBuffer(512 * 1024));
const second = relay.sendBinary(new ArrayBuffer(512 * 1024));
const firstResult = await first;
assert.ok(firstResult);
assert.equal(socket.sent.filter((value) => value instanceof ArrayBuffer).length, 1);

await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(socket.sent.filter((value) => value instanceof ArrayBuffer).length, 1);
socket.bufferedAmount = 512 * 1024;
const secondResult = await second;
assert.ok(secondResult);
assert.equal(socket.sent.filter((value) => value instanceof ArrayBuffer).length, 2);

relay.close();
console.log("Relay backpressure passed: concurrent file sends stay behind the bounded WebSocket queue.");
