# CopyPaesto

CopyPaesto is a shared clipboard and large-file bridge for up to eight trusted devices.

- Live app: <https://albyaty.github.io/CopyPaesto/>
- Offline direct edition: [`apps/direct/release/CopyPaesto-Direct.html`](apps/direct/release/CopyPaesto-Direct.html)
- Relay health: <https://copypaesto-relay.albyaty.workers.dev/health>

The interface is published on GitHub Pages. A Cloudflare Worker and two SQLite-backed Durable Objects handle temporary pairing, encrypted clipboard state, signaling, and file fallback routing.

## Offline direct edition

`apps/direct` is a separate, self-contained transfer app for users who cannot
reliably reach GitHub or Cloudflare and do not want a hosting account. The
sender distributes one 47 KB HTML file through a channel the recipients
already use. It runs locally and never contacts GitHub, the CopyPaesto Worker,
or a file-storage service.

The sender chooses a file before the recipient arrives, shares a six-hour
invitation, and pastes the recipient's answer. Opening an invitation does not
consume it. File bytes travel directly over encrypted WebRTC; only free STUN
discovery is used. Because this edition has no TURN or WebSocket relay, some
remote NAT/firewall combinations cannot connect. Same-Wi-Fi transfers are the
most reliable.

See [`apps/direct/README.md`](apps/direct/README.md) for the exact workflow,
mobile/macOS support, privacy model, and network limitations.

## Current MVP

- Pair devices with a random 5-digit invitation and an approval on an already-connected device.
- After approval, that browser profile remembers the room across closed tabs and browser or device restarts until **Leave** is confirmed.
- Keep up to eight devices in one live room; clipboard changes reach all of them and files can target one device or every other connected device.
- The high-entropy room identifier and encryption secret never appear in the interface.
- Pairing codes expire after 10 minutes and join attempts are rate-limited.
- The private room credentials are handed to the approved computer through an ephemeral ECDH-encrypted exchange.
- Three text slots update as you type.
- Clipboard payloads, signaling, file names, and transfer controls are always AES-GCM encrypted in the browser.
- Files try a direct WebRTC data channel first, then automatically switch to a Worker relay when the networks cannot connect directly.
- If direct WebRTC is blocked, files automatically use the faster **Turbo** fallback protected by WSS/TLS.
- An **All devices** send creates an independent transfer for each recipient, so everyone gets Save/Decline and one slow device cannot block the others.
- Direct transfers use 32 KiB data-channel chunks. Both fallback modes use 512 KiB binary WebSocket frames, pause/resume, a bounded 32 MiB acknowledgement window, and a bounded 4 MiB browser WebSocket queue.
- Chrome and Edge stream incoming large files directly to disk. A trusted device can authorize one auto-save folder and receive later files there without clicking Save.
- Rooms delete their encrypted relay state after 24 hours. A remembered browser can reconnect to the same empty room without pairing again.

## Architecture

```text
GitHub Pages
  └─ React interface
       ├─ 5-digit pairing + host approval ── Cloudflare PairingDirectory
       ├─ encrypted clipboard + signaling ── Cloudflare ClipboardRoom
       └─ file transfer
            ├─ preferred: direct WebRTC
            └─ fallback: TLS-protected Turbo chunks through ClipboardRoom
```

The relay cannot read clipboard text, room secrets, file names, or transfer controls. Turbo intentionally lets the Worker see bulk file bytes to avoid browser encryption overhead; a corporate TLS-inspecting proxy may see them too. The older end-to-end encrypted chunk protocol remains supported invisibly so open tabs from an earlier release still work during upgrades.

## Handling multi-gigabyte files

CopyPaesto does not load a multi-gigabyte file into memory. On the fallback route, the sender reads 512 KiB at a time, keeps the browser's outgoing WebSocket queue near 4 MiB, and stops when roughly 32 MiB is waiting for acknowledgement. The receiver combines incoming frames into writes of up to 2 MiB and acknowledges only bytes successfully written to the selected destination. Direct WebRTC transfers retain smaller 32 KiB data-channel chunks and a 4 MiB window.

The route is selected automatically:

1. WebRTC attempts a direct connection.
2. If it has not connected within 12 seconds, CopyPaesto closes that attempt.
3. The transfer is offered again over the authenticated Worker WebSocket.
4. File names and every fallback control message remain end-to-end encrypted. Bulk binary chunks use Turbo transport protection and are never converted to Base64.

The sending and receiving devices must remain online until the transfer completes. Chrome or Edge is recommended for files over 128 MB because other browsers may not expose the streaming file-save API. Without that API, the memory-backed fallback is limited to 128 MB.

Sending to all devices opens a separate direct or Turbo route to each recipient. Transfers run in parallel for responsiveness and failure isolation, which means the sender uploads one copy per receiving device.

Trusted auto-save still requires one deliberate browser action: choose a destination folder and grant write permission on each receiving device. CopyPaesto stores the folder handle in that browser. If the browser drops permission after a restart, click **Turn on** once to reconnect it. Incoming name collisions receive a numbered name instead of overwriting an existing file.

A transient Turbo disconnection resumes from the receiver's last successfully written byte while both tabs remain open. Closing or refreshing either tab still restarts the transfer from the beginning. A future offline-resumable mode can use client-encrypted R2 multipart uploads with expiring objects.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two or more browser profiles or isolated browser contexts. Each tab receives a transient connection identity, while an approved browser profile remembers its room until **Leave**; use separate profiles when testing multiple devices on one machine.

Useful commands:

```bash
npm run check
npm run build
npm run test:protocol
npm run test:relay
npm run benchmark:relay
npm run dev:web
npm run dev:relay
npm run dev:direct
npm run test:direct
npm run build:direct
```

`npm run test:protocol` verifies legacy AES-GCM integrity, Turbo frame parsing, resume checkpoint bounds, duplicate replay handling, batched writes, and WebSocket backpressure. `npm run test:relay` covers multiple devices joining through short-code approval, ECDH credential handoff, room authentication, three-device clipboard routing, signaling, both binary protocol versions, and routing after a forced disconnect. `npm run benchmark:relay` measures the production 512 KiB path with the browser's queue and acknowledgement limits; set `BENCHMARK_PROTECTION=e2e` or `BENCHMARK_PROTECTION=transport` to compare encryption overhead with Turbo, and `BENCHMARK_WRITE=true` to include temporary 2 MiB batched disk writes.

## Deploy the relay

```bash
npx wrangler login
npx wrangler whoami
npx wrangler deploy --config apps/relay/wrangler.jsonc --dry-run
npm run deploy:relay
```

For production, restrict browser origins with `ALLOWED_ORIGINS`, for example:

```text
https://YOUR_NAME.github.io,http://localhost:5173
```

### Optional managed TURN

The built-in encrypted WebSocket fallback works without TURN. A Cloudflare Realtime TURN key can still improve WebRTC performance on restrictive networks. Store its ID and secret as Worker secrets, never as GitHub variables or frontend values:

```bash
npx wrangler secret put TURN_KEY_ID --config apps/relay/wrangler.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN --config apps/relay/wrangler.jsonc
```

Short-lived TURN credentials are issued only after the client proves it belongs to an authenticated private room.

## Publish the interface on GitHub Pages

1. Enable GitHub Pages with **GitHub Actions** as the source.
2. Under **Settings → Secrets and variables → Actions → Variables**, set:

   ```text
   VITE_RELAY_URL = wss://YOUR_WORKER.workers.dev
   ```

3. Push to `main`. `.github/workflows/pages.yml` builds and deploys the interface.

## Browser clipboard limitation

A normal website cannot silently monitor or replace the operating-system clipboard. Clipboard reads and writes usually require a click or browser permission, which is why CopyPaesto provides **Paste from this device** and **Copy text**.

A later signed desktop companion or browser extension could add system-wide clipboard observation, a global shortcut, per-application exclusions, and a pause switch while reusing the same encrypted room protocol.

## Security

See [SECURITY.md](SECURITY.md) for the protection model and current limitations.

## License

MIT
