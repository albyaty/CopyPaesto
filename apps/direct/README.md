# CopyPaesto Direct

CopyPaesto Direct is the no-account, no-hosting edition. It is a single HTML
file that can be sent through an existing channel such as WeChat, QQ, email,
AirDrop, or a USB drive and opened locally in a browser.

The ready-to-share artifact is
[`release/CopyPaesto-Direct.html`](release/CopyPaesto-Direct.html).

## How a transfer works

1. Both people open `CopyPaesto-Direct.html`. Alternatively, the sender can
   send the generated invitation HTML file, which already contains the app.
2. The sender chooses a file first. The app creates a private invitation that
   remains valid for six hours.
3. The recipient opens the invitation, compares the verification code, and
   chooses where to save the incoming file.
4. The recipient sends the generated answer code or `.txt` file back.
5. The sender pastes that answer and confirms **Send now**.

Opening an invitation is passive: it does not connect, consume, or invalidate
anything. A sender accepts one recipient answer deliberately. Invitation and
answer codes contain connection details but never contain file bytes.

## What “direct” means

The file travels over an encrypted WebRTC data channel. There is no signaling
API, file-storage service, Cloudflare Worker, GitHub request, account, or paid
subscription in this edition. Offer and answer codes are the signaling
channel.

The app uses two no-account STUN discovery endpoints to improve direct NAT
traversal:

- `stunserver2025.stunprotocol.org`, advertised as a public STUN service by
  the [STUNTMAN project](https://www.stunprotocol.org/)
- `stun.cloudflare.com`, which Cloudflare documents as
  [free and unlimited STUN](https://developers.cloudflare.com/realtime/turn/faq/)

STUN only reports possible network routes; it never carries the file. If both
STUN endpoints are blocked, same-network host candidates can still work.

There is intentionally no TURN relay. Devices behind symmetric NAT, carrier
NAT, or a restrictive firewall may not find a direct route. Trying another
network or putting both devices on the same Wi-Fi is the only fallback in this
zero-infrastructure edition.

## Platform notes

| Platform | Support | Notes |
| --- | --- | --- |
| Windows, macOS, Linux with Chrome or Edge | Recommended | Can stream incoming large files to a user-chosen disk location when the browser exposes its save picker. |
| macOS Safari or Firefox | Supported for smaller files | Uses a memory-backed download when a streaming save picker is unavailable; capped at 256 MB. |
| Android Chrome-family browsers | Supported, network-dependent | Open the HTML explicitly in the browser and keep it foregrounded. Smaller transfers are more reliable. |
| iPhone and iPad | Best effort without hosting | Safari supports WebRTC, but iOS does not reliably launch arbitrary local HTML from the Files app. A reachable HTTPS copy is the dependable iOS distribution path. Memory-backed receiving is capped at 256 MB. |

Phones may suspend WebRTC when the browser is backgrounded. After sharing the
answer, return to CopyPaesto and keep the page visible until the transfer ends.

## Security and privacy

- WebRTC protects the data channel with DTLS.
- A random 256-bit invitation secret authenticates the returned answer with
  HMAC-SHA-256.
- Both devices display the same short verification code for an out-of-band
  comparison.
- Invitations encode a six-hour expiration. Because there is no trusted
  server clock, expiration is enforced by the browsers' clocks.
- Direct peers necessarily learn network-address information about each other,
  and STUN operators can observe the public IP and time of a discovery request.
- Transfers do not survive refresh, sleep, or a closed page and do not resume.

## Development

From the repository root:

```bash
npm install
npm run dev:direct
npm run test:direct
npm run build:direct
```

`npm run build:direct` type-checks and bundles all JavaScript and CSS into
`release/CopyPaesto-Direct.html`. The release file has no external script,
stylesheet, font, image, or runtime hosting dependency.
