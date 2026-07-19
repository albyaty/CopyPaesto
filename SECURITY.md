# CopyPaesto security model

CopyPaesto uses a short human pairing code for convenience and a separate high-entropy room secret for security.

## Pairing protection

- The first computer receives a random 5-digit code that expires after 10 minutes.
- The code only allows another computer to submit a connection request. It does not grant room access.
- The first computer must explicitly approve the requesting device.
- Pairing creation and joining are rate-limited by the relay.
- Both browsers generate ephemeral P-256 ECDH key pairs.
- On approval, the first browser derives a shared key with the second browser, encrypts the high-entropy room credentials with AES-GCM, and sends only that envelope through the pairing directory.
- Pairing host and join tokens are random 256-bit bearer values kept in browser memory for the short pairing window.
- Pairing records and requests are deleted after expiration.

An attacker who guesses an active 5-digit code can create a visible approval request, but cannot decrypt or enter the room unless the first computer approves that request.

## Room and content protection

- The hidden room code contains roughly 60 bits of randomness and is combined with a separate random 5-digit secret generated in the first browser.
- PBKDF2-SHA-256 with 250,000 iterations derives 512 bits from those hidden values.
- One half becomes the AES-GCM content key; the other becomes the room authentication verifier.
- The relay stores the verifier but cannot derive the separate encryption key from it.
- Clipboard text, WebRTC signaling, and Worker-relayed file messages are encrypted before leaving the browser.
- Direct WebRTC file data is protected by DTLS.
- The relay does not enumerate private rooms and deletes room state after 24 hours.

## File fallback protection

- Direct WebRTC is attempted first.
- If it cannot connect, the transfer restarts over the authenticated room WebSocket.
- Fallback file names, control messages, and 32 KiB chunks are AES-GCM encrypted end to end.
- The Worker forwards encrypted envelopes without storing file chunks.
- Sender acknowledgements cap outstanding fallback data at about 4 MiB.
- Optional TURN credentials are available only through a room-authenticated endpoint; the long-lived TURN key remains a Worker secret.

## What Cloudflare can observe

This is not an anonymity system. Cloudflare may observe client IP metadata, connection times, encrypted message sizes, transfer volume, and which authenticated sockets exchange envelopes. The Worker receives device display names for presence and pairing approval. It does not receive plaintext clipboard content, plaintext file metadata, file bytes, or room encryption keys.

## Current limitations

- A user can mistakenly approve an impostor that guessed the active short code. Approve only the computer you are pairing at that moment.
- Device names are user-provided labels, not cryptographic device identities.
- The first authenticated connection registers the verifier for a newly created hidden room. The approved host connects immediately and the room locator is unguessable, but a mature service should add server-issued creation tickets.
- Transfers do not yet resume across a browser refresh, computer sleep, or lost network. They restart from the beginning.
- Incoming files over 128 MB require a browser with the streaming file-save API, currently Chrome or Edge.
- Browser clipboard APIs require user interaction or permission. Automatic system-wide monitoring requires an extension or native companion.
- A larger public deployment should add stronger abuse monitoring, security headers, and operational alerting.

## Reporting a vulnerability

Do not include secrets, pairing tokens, or personal clipboard contents in a public GitHub issue. Open a minimal issue requesting a private contact route.
