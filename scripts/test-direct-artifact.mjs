import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const artifactUrl = new URL("../apps/direct/release/CopyPaesto-Direct.html", import.meta.url);
const html = await readFile(artifactUrl, "utf8");

assert.ok(html.length > 20_000, "release should contain the bundled app");
assert.match(html, /<meta name="copypaesto-build" content="single-file"/);
assert.match(html, /<script data-copypaesto-app>/);
assert.match(html, /<style data-copypaesto-style>/);
assert.doesNotMatch(html, /<script[^>]+\ssrc=/i);
assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
assert.doesNotMatch(html, /url\(["']?https?:/i);
assert.match(html, /stun:stunserver2025\.stunprotocol\.org:3478/);
assert.match(html, /stun:stun\.cloudflare\.com:3478/);

console.log("Self-contained direct-transfer artifact tests passed");
