import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<ClipboardRoom>;
  ALLOWED_ORIGINS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

interface ClientAttachment {
  clientId: string;
  name: string;
  authenticated: boolean;
}

interface CipherEnvelope {
  v: 1;
  iv: string;
  data: string;
}

interface StoredSlot {
  slot: number;
  envelope: CipherEnvelope;
  sequence: number;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 320_000;
const roomIdPattern = /^[A-Za-z0-9_-]{40,48}$/;

function json(data: unknown, init: ResponseInit = {}, origin = "*") {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get("Origin") ?? "*";
  const allowed = env.ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!allowed?.length || origin === "*") return origin;
  return allowed.includes(origin) ? origin : null;
}

function isEnvelope(value: unknown): value is CipherEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CipherEnvelope>;
  return (
    candidate.v === 1 &&
    typeof candidate.iv === "string" &&
    candidate.iv.length < 64 &&
    typeof candidate.data === "string" &&
    candidate.data.length < MAX_MESSAGE_BYTES
  );
}

function sameVerifier(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function turnServers(env: Env) {
  const stunOnly = {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    relayAvailable: false,
  };

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stunOnly;

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: 86_400 }),
    },
  );

  if (!response.ok) {
    console.error("TURN credential generation failed", response.status);
    return stunOnly;
  }

  const result = (await response.json()) as { iceServers?: IceServer[] };
  return {
    iceServers: result.iceServers ?? stunOnly.iceServers,
    relayAvailable: Boolean(result.iceServers?.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
        url?.startsWith("turn"),
      ),
    )),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (!origin) return json({ error: "Origin not allowed" }, { status: 403 });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
          vary: "Origin",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "copypaesto-relay" }, {}, origin);
    }

    if (url.pathname === "/turn" && request.method === "GET") {
      return json(await turnServers(env), {
        headers: { "cache-control": "private, max-age=3600" },
      }, origin);
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)\/connect$/);
    if (roomMatch && request.headers.get("Upgrade") === "websocket") {
      const roomId = roomMatch[1];
      if (!roomIdPattern.test(roomId)) {
        return json({ error: "Invalid room" }, { status: 400 }, origin);
      }

      const room = env.ROOMS.getByName(roomId);
      return room.fetch(request);
    }

    return json({ error: "Not found" }, { status: 404 }, origin);
  },
} satisfies ExportedHandler<Env>;

export class ClipboardRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private attachment(socket: WebSocket): ClientAttachment | null {
    try {
      return socket.deserializeAttachment() as ClientAttachment | null;
    } catch {
      return null;
    }
  }

  private peers() {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = this.attachment(socket);
      return attachment?.authenticated && socket.readyState === WebSocket.OPEN
        ? [{ id: attachment.clientId, name: attachment.name }]
        : [];
    });
  }

  private broadcast(message: unknown, except?: WebSocket) {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      if (!this.attachment(socket)?.authenticated) continue;
      try {
        socket.send(encoded);
      } catch {
        // Stale sockets are removed by the runtime.
      }
    }
  }

  private broadcastPresence() {
    this.broadcast({ type: "presence", peers: this.peers() });
  }

  private async keepAlive() {
    await this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const clientId = (url.searchParams.get("clientId") ?? "").slice(0, 80);
    if (!clientId) return new Response("Missing client", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      clientId,
      name: "Device",
      authenticated: false,
    } satisfies ClientAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) {
      socket.send(JSON.stringify({ type: "error", message: "Message is too large" }));
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message) as Record<string, unknown>;
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      return;
    }

    const sender = this.attachment(socket);
    if (!sender) return;

    if (!sender.authenticated) {
      const verifier = typeof data.verifier === "string" ? data.verifier : "";
      const name = typeof data.name === "string" ? data.name.trim().slice(0, 40) : "Device";
      if (data.type !== "authenticate" || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
        socket.close(4003, "Authentication required");
        return;
      }

      const verifierAccepted = await this.ctx.storage.transaction(async (txn) => {
        const registeredVerifier = await txn.get<string>("auth:verifier");
        if (registeredVerifier) return sameVerifier(registeredVerifier, verifier);
        await txn.put("auth:verifier", verifier);
        return true;
      });
      if (!verifierAccepted) {
        socket.close(4003, "Incorrect PIN");
        return;
      }

      if (this.peers().length >= 8) {
        socket.close(4008, "Room is full");
        return;
      }
      socket.serializeAttachment({
        ...sender,
        name: name || "Device",
        authenticated: true,
      } satisfies ClientAttachment);

      const stored = await this.ctx.storage.list<StoredSlot>({ prefix: "slot:" });
      socket.send(JSON.stringify({ type: "authenticated" }));
      socket.send(JSON.stringify({
        type: "snapshot",
        slots: [...stored.values()].sort((a, b) => a.slot - b.slot),
      }));
      await this.keepAlive();
      this.broadcastPresence();
      return;
    }

    if (data.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }

    if (data.type === "slot:update") {
      const slot = Number(data.slot);
      if (![0, 1, 2].includes(slot) || !isEnvelope(data.envelope)) return;

      const stored = await this.ctx.storage.transaction(async (txn) => {
        const sequence = ((await txn.get<number>("sequence")) ?? 0) + 1;
        const next: StoredSlot = { slot, envelope: data.envelope as CipherEnvelope, sequence };
        await txn.put("sequence", sequence);
        await txn.put(`slot:${slot}`, next);
        return next;
      });

      this.broadcast({ type: "slot:update", ...stored });
      await this.keepAlive();
      return;
    }

    if (data.type === "signal") {
      const to = typeof data.to === "string" ? data.to.slice(0, 80) : "";
      if (!to || !isEnvelope(data.envelope)) return;

      for (const peer of this.ctx.getWebSockets()) {
        if (this.attachment(peer)?.clientId === to) {
          peer.send(JSON.stringify({
            type: "signal",
            from: sender.clientId,
            envelope: data.envelope,
          }));
          break;
        }
      }
      await this.keepAlive();
    }
  }

  webSocketClose(socket: WebSocket) {
    try {
      socket.close(1000, "Closed");
    } finally {
      this.broadcastPresence();
    }
  }

  webSocketError() {
    this.broadcastPresence();
  }

  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1001, "Room expired");
      } catch {
        // The room is being discarded regardless.
      }
    }
    await this.ctx.storage.deleteAll();
  }
}
