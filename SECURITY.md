# CopyPaesto security model

CopyPaesto uses a short human pairing code for convenience and a separate high-entropy room secret for security.

## Pairing protection

- The first computer receives a random 5-digit code that expires after 10 minutes.
- The code only allows another device to submit a connection request. It does not grant room access.
- The first computer must explicitly approve the requesting device.
- Pairing creation and joining are rate-limited by the relay.
- Both browsers generate ephemeral P-256 ECDH key pairs.
- On approval, the inviting browser derives a shared key with the joining browser, encrypts the high-entropy room credentials with AES-GCM, and sends only that envelope through the pairing directory.
- Pairing host and join tokens are random 256-bit bearer values kept in browser memory for the short pairing window.
- Pairing records and requests are deleted after expiration.
- An existing room member can open a fresh invitation to approve another device; rooms currently allow up to eight authenticated devices.

An attacker who guesses an active 5-digit code can create a visible approval request, but cannot decrypt or enter the room unless the first computer approves that request.

## Room and content protection

- The hidden room code contains roughly 60 bits of randomness and is combined with a separate random 5-digit secret generated in the first browser.
- PBKDF2-SHA-256 with 250,000 iterations derives 512 bits from those hidden values.
- One half becomes the AES-GCM content key; the other becomes the room authentication verifier.
- The relay stores the verifier but cannot derive the separate encryption key from it.
- Clipboard text, WebRTC signaling, file names, and Worker-relayed transfer controls are encrypted before leaving the browser.
- Direct WebRTC file data is protected by DTLS.
- The relay does not enumerate private rooms and deletes room state after 24 hours.

## Remembered browser sessions

- After a device is approved, CopyPaesto stores its hidden room code, room PIN, and device label in that browser profile's local site storage.
- Closing a tab or restarting Chrome, the computer, or the phone does not require another pairing. Visiting CopyPaesto from the same browser profile reconnects automatically.
- **Leave** asks for confirmation and then deletes the remembered room from that browser. Clearing site data also forgets it; private/incognito storage normally disappears with the private browsing session.
- The saved credentials are not placed in GitHub or copied into Cloudflare storage by this feature. They remain accessible to JavaScript running on the CopyPaesto origin.
- This is a trusted-device convenience, not hardware-backed credential storage. Someone who can use the unlocked browser profile, inspect its site storage, or execute script on the app origin could recover the room credentials. Use **Leave** on shared or untrusted devices.
- When Cloudflare's 24-hour room state has expired, a remembered device can recreate the same empty authenticated room. Expired clipboard state is not restored.

## File transfer protection

- Direct WebRTC is attempted first.
- If it cannot connect, the transfer restarts over the authenticated room WebSocket.
- Fallback file names and control messages are always AES-GCM encrypted end to end.
- The current interface automatically uses **Turbo fallback** when direct WebRTC is blocked. Bulk chunks are protected in transit by WSS/TLS, but are not encrypted end to end by CopyPaesto. Cloudflare—and a work network that performs trusted TLS inspection—can inspect or alter those file bytes. The five-digit code, room PIN, and approval gate access; they do not make Turbo bytes confidential from infrastructure carrying the connection.
- The earlier AES-GCM chunk format remains accepted for rolling compatibility with open tabs from older releases, but it is no longer exposed as a transfer choice.
- The Worker forwards file frames without storing chunks or converting them to Base64.
- Sender acknowledgements cap outstanding fallback data at about 32 MiB.
- Optional TURN credentials are available only through a room-authenticated endpoint; the long-lived TURN key remains a Worker secret.

Direct WebRTC remains DTLS-protected regardless of which fallback mode is selected.

## Trusted auto-save

- Auto-save is disabled by default and configured separately on each receiving device.
- A user must choose a folder and grant browser write permission before CopyPaesto can save there.
- Once that permission is active, any approved device in the same room can send a file that starts writing without another Save/Decline prompt. Enable it only in rooms whose devices you trust.
- CopyPaesto chooses a numbered name when a file already exists and does not silently overwrite it.
- The saved directory handle stays in that browser's IndexedDB. Browsers may require the user to reconnect permission after all app tabs close or after a restart.

## What Cloudflare can observe

This is not an anonymity system. Cloudflare may observe client IP metadata, connection times, encrypted message sizes, transfer volume, and which authenticated sockets exchange envelopes. The Worker receives device display names for presence and pairing approval. It does not receive plaintext clipboard content, plaintext file names, transfer controls, or room encryption keys. When direct WebRTC is blocked and a file uses Turbo fallback, it can receive plaintext bulk file bytes and transfer identifiers.

## Current limitations

- A user can mistakenly approve an impostor that guessed the active short code. Approve only the computer you are pairing at that moment.
- Device names are user-provided labels, not cryptographic device identities.
- The first authenticated connection registers the verifier for a newly created hidden room. The approved host connects immediately and the room locator is unguessable, but a mature service should add server-issued creation tickets.
- Transfers do not yet resume across a browser refresh, computer sleep, or lost network. They restart from the beginning.
- Incoming files over 128 MB require a browser with the streaming file-save API, currently Chrome or Edge.
- Trusted auto-save relies on the same Chromium file-system API and cannot bypass a browser permission prompt when permission has expired.
- Remembered sessions rely on browser local site storage and disappear if the user or browser clears that storage.
- Browser clipboard APIs require user interaction or permission. Automatic system-wide monitoring requires an extension or native companion.
- A larger public deployment should add stronger abuse monitoring, security headers, and operational alerting.

## Reporting a vulnerability

Do not include secrets, pairing tokens, or personal clipboard contents in a public GitHub issue. Open a minimal issue requesting a private contact route.
