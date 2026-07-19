# CopyPaesto security model

CopyPaesto's current PIN is intentionally light session protection, backed by an unguessable session code and browser-side encryption.

## What is protected

- The session code contains roughly 60 bits of randomness and is generated with the Web Crypto API.
- The 5-digit PIN is generated at runtime and kept in React memory only. It is not committed, persisted, or added to the invite URL.
- The room locator sent to the relay is a SHA-256 digest of the session code, not the code itself.
- PBKDF2-SHA-256 with 250,000 iterations derives 512 bits from the session code and PIN. One half becomes the AES-GCM key; the other becomes the authentication verifier.
- The relay stores the verifier but cannot derive the separate encryption key from it.
- Clipboard text and WebRTC signaling are encrypted before leaving the browser.
- WebRTC file data is protected in transit by DTLS. The application relay coordinates the route but does not handle file bytes.
- The relay does not enumerate rooms and deletes a room's state after 24 hours.

## What the relay can observe

This is not an anonymity system. The relay can observe connection IP metadata supplied by its platform, connection times, message sizes, slot numbers, device display names, and which authenticated peers exchange signaling. A configured TURN service can observe encrypted traffic volume.

## Limitations

- Five digits provide only 90,000 possible generated PINs. The high-entropy session code is an essential second factor. Do not treat the PIN alone as strong authentication.
- Anyone who receives both the session code and PIN can join the room while it is active.
- The first authenticated connection registers the verifier for a newly created room. Because room locators are unguessable and the creator connects immediately, opportunistic takeover is unlikely, but a production service should add server-issued room-creation tickets.
- A production public deployment should add connection rate limits, abuse controls, CSP/security headers, and monitoring.
- Large direct transfers do not yet resume after a browser or network restart. An encrypted multipart object-storage fallback is planned for that case.
- Browser clipboard APIs require user interaction or permissions. Automatic system clipboard monitoring requires an extension or native companion.

## Reporting a vulnerability

Until a private disclosure channel is configured, do not include secrets or personal clipboard contents in a public GitHub issue. Open a minimal issue requesting a private contact route.
