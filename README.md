# CopyPaesto

CopyPaesto is a private shared clipboard and large-file bridge for two computers.

- Live app: <https://albyaty.github.io/CopyPaesto/>
- Relay health: <https://copypaesto-relay.albyaty.workers.dev/health>

The interface is published on GitHub Pages. A Cloudflare Worker and two SQLite-backed Durable Objects handle temporary pairing, encrypted clipboard state, signaling, and the encrypted file fallback.

## Current MVP

- Pair two computers with one random 5-digit code and an approval on the first computer.
- The high-entropy room identifier and encryption secret never appear in the interface.
- Pairing codes expire after 10 minutes and join attempts are rate-limited.
- The private room credentials are handed to the approved computer through an ephemeral ECDH-encrypted exchange.
- Three text slots update as you type.
- Clipboard payloads, signaling, and relayed file chunks are AES-GCM encrypted in the browser.
- Files try a direct WebRTC data channel first, then automatically switch to the encrypted Worker relay when the networks cannot connect directly.
- Direct transfers use 32 KiB data-channel chunks. The fallback uses encrypted 512 KiB binary WebSocket frames, pause/resume, and a bounded 32 MiB relay window.
- Chrome and Edge stream incoming large files directly to a user-selected destination on disk.
- Rooms delete their encrypted state after 24 hours.

## Architecture

```text
GitHub Pages
  └─ React interface
       ├─ 5-digit pairing + host approval ── Cloudflare PairingDirectory
       ├─ encrypted clipboard + signaling ── Cloudflare ClipboardRoom
       └─ file transfer
            ├─ preferred: direct WebRTC
            └─ fallback: E2E-encrypted WebSocket chunks through ClipboardRoom
```

The relay can observe connection metadata and encrypted traffic sizes, but not clipboard text, room secrets, file names, or file bytes.

## Handling a 1 GB file

CopyPaesto does not load a 1 GB file into memory. On the fallback route, the sender reads 512 KiB at a time and stops when roughly 32 MiB is waiting for acknowledgement. The receiver writes chunks to the selected destination as they arrive. Direct WebRTC transfers retain smaller 32 KiB data-channel chunks and a 4 MiB window.

The route is selected automatically:

1. WebRTC attempts a direct connection.
2. If it has not connected within 12 seconds, CopyPaesto closes that attempt.
3. The transfer is offered again over the authenticated Worker WebSocket.
4. Every fallback control message and binary chunk is encrypted in the browser before the Worker forwards it; file bytes are never converted to Base64.

Both computers must remain online until the transfer completes. Chrome or Edge is recommended for files over 128 MB because other browsers may not expose the streaming file-save API. Without that API, the memory-backed fallback is limited to 128 MB.

Interrupted transfers currently restart from the beginning. A future offline/resumable mode can use client-encrypted R2 multipart uploads with expiring objects.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two browser windows. Each tab receives a distinct session-only device identity, so the full two-computer flow can be tested on one machine.

Useful commands:

```bash
npm run check
npm run build
npm run test:relay
npm run benchmark:relay
npm run dev:web
npm run dev:relay
```

`npm run test:relay` covers short-code pairing, host authorization, ECDH credential handoff, room authentication, encrypted-state routing, signaling, and JSON/binary file-fallback routing. `npm run benchmark:relay` measures encrypted binary relay throughput with the production 512 KiB chunk size.

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
