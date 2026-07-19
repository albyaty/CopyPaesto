# CopyPaesto

CopyPaesto is a shared clipboard and large-file bridge for up to eight trusted devices.

- Live app: <https://albyaty.github.io/CopyPaesto/>
- Relay health: <https://copypaesto-relay.albyaty.workers.dev/health>

The interface is published on GitHub Pages. A Cloudflare Worker and two SQLite-backed Durable Objects handle temporary pairing, encrypted clipboard state, signaling, and file fallback routing.

## Current MVP

- Pair devices with a random 5-digit invitation and an approval on an already-connected device.
- Keep up to eight devices in one live room; clipboard changes reach all of them and file sends have an explicit recipient.
- The high-entropy room identifier and encryption secret never appear in the interface.
- Pairing codes expire after 10 minutes and join attempts are rate-limited.
- The private room credentials are handed to the approved computer through an ephemeral ECDH-encrypted exchange.
- Three text slots update as you type.
- Clipboard payloads, signaling, file names, and transfer controls are always AES-GCM encrypted in the browser.
- Files try a direct WebRTC data channel first, then automatically switch to a Worker relay when the networks cannot connect directly.
- The fallback can use **Private** end-to-end encrypted chunks or explicit **Turbo** chunks protected only by WSS/TLS for higher throughput.
- Direct transfers use 32 KiB data-channel chunks. Both fallback modes use 512 KiB binary WebSocket frames, pause/resume, and a bounded 32 MiB relay window.
- Chrome and Edge stream incoming large files directly to disk. A trusted device can authorize one auto-save folder and receive later files there without clicking Save.
- Rooms delete their encrypted state after 24 hours.

## Architecture

```text
GitHub Pages
  └─ React interface
       ├─ 5-digit pairing + host approval ── Cloudflare PairingDirectory
       ├─ encrypted clipboard + signaling ── Cloudflare ClipboardRoom
       └─ file transfer
            ├─ preferred: direct WebRTC
            └─ fallback through ClipboardRoom
                 ├─ Private: E2E-encrypted WebSocket chunks
                 └─ Turbo: TLS-protected WebSocket chunks
```

The relay cannot read clipboard text, room secrets, file names, or transfer controls. In Private mode it also cannot read file bytes. Turbo intentionally lets the Worker see bulk file bytes to avoid browser encryption overhead; a corporate TLS-inspecting proxy may see them too.

## Handling a 1 GB file

CopyPaesto does not load a 1 GB file into memory. On the fallback route, the sender reads 512 KiB at a time and stops when roughly 32 MiB is waiting for acknowledgement. The receiver writes chunks to the selected destination as they arrive. Direct WebRTC transfers retain smaller 32 KiB data-channel chunks and a 4 MiB window.

The route is selected automatically:

1. WebRTC attempts a direct connection.
2. If it has not connected within 12 seconds, CopyPaesto closes that attempt.
3. The transfer is offered again over the authenticated Worker WebSocket.
4. File names and every fallback control message remain end-to-end encrypted. Binary chunks use the selected Private or Turbo protection, and file bytes are never converted to Base64.

The sending and receiving devices must remain online until the transfer completes. Chrome or Edge is recommended for files over 128 MB because other browsers may not expose the streaming file-save API. Without that API, the memory-backed fallback is limited to 128 MB.

Trusted auto-save still requires one deliberate browser action: choose a destination folder and grant write permission on each receiving device. CopyPaesto stores the folder handle in that browser. If the browser drops permission after a restart, click **Turn on** once to reconnect it. Incoming name collisions receive a numbered name instead of overwriting an existing file.

Interrupted transfers currently restart from the beginning. A future offline/resumable mode can use client-encrypted R2 multipart uploads with expiring objects.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two or more browser profiles/windows. Each tab receives a distinct session-only device identity, so the multi-device flow can be tested on one machine.

Useful commands:

```bash
npm run check
npm run build
npm run test:protocol
npm run test:relay
npm run benchmark:relay
npm run dev:web
npm run dev:relay
```

`npm run test:protocol` verifies Private AES-GCM integrity and Turbo frame parsing. `npm run test:relay` covers multiple devices joining through short-code approval, ECDH credential handoff, room authentication, three-device clipboard routing, signaling, and Private/Turbo binary file routing. `npm run benchmark:relay` measures the production 512 KiB path; set `BENCHMARK_PROTECTION=e2e` or `BENCHMARK_PROTECTION=transport` to compare Private and Turbo.

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
