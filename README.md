# CopyPaesto

CopyPaesto is a private shared clipboard and direct file bridge for two machines. It gives both devices three live text slots and sends files over an encrypted WebRTC data channel without loading an entire large file into browser memory.

This repository contains:

- a React web app that can be hosted on GitHub Pages;
- a Cloudflare Worker and Durable Object relay for room coordination, clipboard state, and WebRTC signaling;
- a GitHub Actions workflow for publishing the web app.

## Current MVP

- Three text slots update as you type.
- Each session gets a random 12-character code and random 5-digit PIN.
- The PIN is not written to the URL, local storage, relay logs, or source code.
- The relay sends no clipboard history or peer presence until the PIN-derived proof matches.
- Clipboard payloads and WebRTC signaling are AES-GCM encrypted in the browser.
- Files transfer directly between connected devices with pause/resume, bounded buffering, and transfer progress.
- On Chrome and Edge, incoming large files stream directly to a user-selected file on disk.
- A managed TURN relay can be enabled for networks where a direct peer-to-peer route is blocked.

## Why GitHub is only one part of the hosting

GitHub Pages is static hosting. It can serve the interface, but it cannot keep WebSocket rooms alive. The intended deployment is:

```text
GitHub repository
  ├─ GitHub Pages → web interface
  └─ Cloudflare Worker + Durable Object → live room relay
                                 └─ optional Cloudflare TURN → restrictive networks
```

The relay never receives raw file contents. Clipboard text is stored only as encrypted ciphertext and rooms delete their state after 24 hours.

## Handling a 1 GB file

The browser divides a file into 32 KiB messages and keeps at most about 4 MiB unacknowledged. The receiver acknowledges progress as chunks are written. This prevents a 1 GB transfer from becoming a 1 GB memory allocation.

The current path requires both machines to stay online:

1. The real-time relay exchanges encrypted WebRTC connection details.
2. WebRTC tries a direct route with STUN.
3. If TURN credentials are configured, it can fall back to an encrypted relay route.
4. The receiver chooses a destination and chunks are written incrementally to disk.

Chrome or Edge is currently recommended for files over 128 MB because the browser file-save streaming API is not available everywhere. Other browsers use a memory-backed download for files up to 128 MB.

For resumable transfers when the machines are not online together, the next storage phase should use client-side encrypted R2 multipart uploads with 8–16 MiB parts, limited parallelism, per-part retry, and a short deletion lifecycle. File bytes should upload directly to object storage using temporary signed operations rather than pass through the Worker.

## Local development

Requirements: Node.js 22 or newer and a Cloudflare account for deployment. Local Durable Objects do not require a deployed account.

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in two browser windows. Each tab gets a distinct device identity, so the two-device flow can be tested on one computer.

Other commands:

```bash
npm run check
npm run build
npm run dev:web
npm run dev:relay
```

## Deploy the relay

1. Sign in to Cloudflare from the terminal:

   ```bash
   npx wrangler login
   ```

2. Deploy the Worker and Durable Object:

   ```bash
   npm run deploy:relay
   ```

3. Record the resulting `https://...workers.dev` address and change its scheme to `wss://` for the frontend setting.

4. For production, restrict browser origins. Add an `ALLOWED_ORIGINS` variable or secret containing a comma-separated list such as `https://YOUR_NAME.github.io`.

### Optional TURN fallback

Direct WebRTC can fail behind restrictive firewalls or symmetric NAT. Create a Cloudflare Realtime TURN key, then add its values to the Worker without putting them in Git:

```bash
npx wrangler secret put TURN_KEY_ID --config apps/relay/wrangler.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN --config apps/relay/wrangler.jsonc
```

The browser receives short-lived TURN credentials from `/turn`; the long-lived API token remains in the Worker.

## Publish the interface on GitHub Pages

1. Push this directory to a GitHub repository with `main` as the default branch.
2. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the source.
3. Under **Settings → Secrets and variables → Actions → Variables**, create:

   ```text
   VITE_RELAY_URL = wss://YOUR_WORKER.workers.dev
   ```

4. Push to `main`. The workflow in `.github/workflows/pages.yml` builds and publishes the interface.

The session code is placed in the URL fragment so an invite link can prefill it; URL fragments are not sent in HTTP requests. The PIN must still be shared separately.

## Browser clipboard limitation

A normal website cannot silently watch and overwrite the operating-system clipboard on every browser. Clipboard read/write usually needs a click or explicit permission, which is why the MVP has **Paste from this device** and **Copy text** actions.

To become a true system-wide copy/paste replacement, a later phase should add a small signed desktop tray app or browser extension that:

- observes clipboard changes with explicit user permission;
- provides a global shortcut;
- uses the same encrypted session protocol;
- excludes sensitive applications and offers a pause switch.

## Security notes

See [SECURITY.md](SECURITY.md) for the protection model and current limitations.

## License

MIT
