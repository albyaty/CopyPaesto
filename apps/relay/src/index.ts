import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<ClipboardRoom>;
  PAIRINGS: DurableObjectNamespace<PairingDirectory>;
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

interface PairingPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

interface PairingRecord {
  id: string;
  code: string;
  hostId: string;
  hostName: string;
  hostPublicKey: PairingPublicKey;
  hostTokenHash: string;
  createdAt: number;
  expiresAt: number;
}

interface PairingRequest {
  id: string;
  pairingId: string;
  joinerId: string;
  joinerName: string;
  joinerPublicKey: PairingPublicKey;
  joinTokenHash: string;
  status: "pending" | "approved" | "rejected";
  envelope?: CipherEnvelope;
  createdAt: number;
  updatedAt: number;
}

interface PairingCodePointer {
  pairingId: string;
  expiresAt: number;
}

const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const MAX_MESSAGE_BYTES = 320_000;
const MAX_PAIRING_BODY_BYTES = 16_000;
const roomIdPattern = /^[A-Za-z0-9_-]{40,48}$/;
const pairingIdPattern = /^[A-Za-z0-9_-]{32,64}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{20,48}$/;

function json(data: unknown, init: ResponseInit = {}, origin = "*") {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function addCors(response: Response, origin: string) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("cache-control", "no-store");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

function isPairingPublicKey(value: unknown): value is PairingPublicKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PairingPublicKey>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    typeof candidate.x === "string" &&
    candidate.x.length >= 40 &&
    candidate.x.length <= 60 &&
    typeof candidate.y === "string" &&
    candidate.y.length >= 40 &&
    candidate.y.length <= 60
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

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(bytes = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomInt(max: number) {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value);
  while (value[0] >= limit);
  return value[0] % max;
}

async function hashToken(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bearerToken(request: Request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/i);
  return match?.[1] ?? "";
}

async function parseBody(request: Request) {
  const text = await request.text();
  if (text.length > MAX_PAIRING_BODY_BYTES) throw new Error("Request is too large");
  return JSON.parse(text) as Record<string, unknown>;
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
  const browserSafeServers = result.iceServers?.map((server) => ({
    ...server,
    urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => !/:53(?:\?|$)/.test(url)),
  })).filter((server) => server.urls.length);
  return {
    iceServers: browserSafeServers ?? stunOnly.iceServers,
    relayAvailable: Boolean(browserSafeServers?.some((server) =>
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
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "copypaesto-relay" }, {}, origin);
    }

    if (url.pathname === "/turn" && request.method === "GET") {
      return json({
        iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
        relayAvailable: false,
      }, { headers: { "cache-control": "private, max-age=3600" } }, origin);
    }

    if (url.pathname === "/pairings" || url.pathname.startsWith("/pairings/")) {
      const directory = env.PAIRINGS.getByName("global-v1");
      return addCors(await directory.fetch(request), origin);
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

    const roomTurnMatch = url.pathname.match(/^\/rooms\/([^/]+)\/turn$/);
    if (roomTurnMatch && request.method === "POST") {
      const roomId = roomTurnMatch[1];
      if (!roomIdPattern.test(roomId)) {
        return json({ error: "Invalid room" }, { status: 400 }, origin);
      }
      const room = env.ROOMS.getByName(roomId);
      const authorization = await room.fetch(request);
      if (!authorization.ok) {
        return json({ error: "Private room authorization required" }, { status: 403 }, origin);
      }
      return json(await turnServers(env), {
        headers: { "cache-control": "private, max-age=3600" },
      }, origin);
    }

    return json({ error: "Not found" }, { status: 404 }, origin);
  },
} satisfies ExportedHandler<Env>;

export class PairingDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async rateAllowed(request: Request, action: string, limit: number) {
    const address = request.headers.get("CF-Connecting-IP")
      ?? request.headers.get("x-forwarded-for")
      ?? "unknown";
    const addressHash = await hashToken(`${action}:${address}`);
    const minute = Math.floor(Date.now() / 60_000);
    const key = `rate:${minute}:${addressHash}`;
    const allowed = await this.ctx.storage.transaction(async (txn) => {
      const count = ((await txn.get<number>(key)) ?? 0) + 1;
      await txn.put(key, count);
      return count <= limit;
    });
    await this.scheduleCleanup((minute + 6) * 60_000);
    return allowed;
  }

  private async authorized(expectedHash: string, request: Request) {
    const token = bearerToken(request);
    if (!token) return false;
    return sameVerifier(expectedHash, await hashToken(token));
  }

  private async scheduleCleanup(expiresAt: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt < current) await this.ctx.storage.setAlarm(expiresAt);
  }

  private async pairing(pairingId: string) {
    const record = await this.ctx.storage.get<PairingRecord>(`pairing:${pairingId}`);
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  private async create(request: Request) {
    if (!(await this.rateAllowed(request, "create", 10))) {
      return json({ error: "Too many pairing attempts. Try again in a minute." }, { status: 429 });
    }

    let body: Record<string, unknown>;
    try {
      body = await parseBody(request);
    } catch {
      return json({ error: "Invalid pairing request" }, { status: 400 });
    }

    const hostId = typeof body.hostId === "string" ? body.hostId.trim().slice(0, 80) : "";
    const hostName = typeof body.hostName === "string" ? body.hostName.trim().slice(0, 40) : "";
    if (!hostId || !isPairingPublicKey(body.hostPublicKey)) {
      return json({ error: "Invalid pairing request" }, { status: 400 });
    }

    const hostToken = randomToken();
    const now = Date.now();
    const hostTokenHash = await hashToken(hostToken);
    const pairing = await this.ctx.storage.transaction(async (txn) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const code = String(10_000 + randomInt(90_000));
        const pointer = await txn.get<PairingCodePointer>(`code:${code}`);
        if (pointer && pointer.expiresAt > now) continue;

        const record: PairingRecord = {
          id: randomToken(),
          code,
          hostId,
          hostName: hostName || "First computer",
          hostPublicKey: body.hostPublicKey as PairingPublicKey,
          hostTokenHash,
          createdAt: now,
          expiresAt: now + PAIRING_LIFETIME_MS,
        };
        await txn.put({
          [`pairing:${record.id}`]: record,
          [`code:${record.code}`]: {
            pairingId: record.id,
            expiresAt: record.expiresAt,
          } satisfies PairingCodePointer,
        });
        return record;
      }
      return null;
    });
    if (!pairing) return json({ error: "Pairing is busy. Try again." }, { status: 503 });
    await this.scheduleCleanup(pairing.expiresAt);

    return json({
      pairingId: pairing.id,
      code: pairing.code,
      hostToken,
      expiresAt: pairing.expiresAt,
    }, { status: 201 });
  }

  private async join(request: Request) {
    if (!(await this.rateAllowed(request, "join", 15))) {
      return json({ error: "Too many pairing attempts. Try again in a minute." }, { status: 429 });
    }

    let body: Record<string, unknown>;
    try {
      body = await parseBody(request);
    } catch {
      return json({ error: "Invalid pairing request" }, { status: 400 });
    }

    const code = typeof body.code === "string" ? body.code.replace(/\D/g, "").slice(0, 5) : "";
    const joinerId = typeof body.joinerId === "string" ? body.joinerId.trim().slice(0, 80) : "";
    const joinerName = typeof body.joinerName === "string" ? body.joinerName.trim().slice(0, 40) : "";
    if (!/^\d{5}$/.test(code) || !joinerId || !isPairingPublicKey(body.joinerPublicKey)) {
      return json({ error: "Enter a valid 5-digit pairing code" }, { status: 400 });
    }

    const pointer = await this.ctx.storage.get<PairingCodePointer>(`code:${code}`);
    if (!pointer || pointer.expiresAt <= Date.now()) {
      return json({ error: "That pairing code is not active" }, { status: 404 });
    }
    const pairing = await this.pairing(pointer.pairingId);
    if (!pairing) return json({ error: "That pairing code is not active" }, { status: 404 });

    const joinToken = randomToken();
    const now = Date.now();
    const pairingRequest: PairingRequest = {
      id: randomToken(18),
      pairingId: pairing.id,
      joinerId,
      joinerName: joinerName || "Second computer",
      joinerPublicKey: body.joinerPublicKey,
      joinTokenHash: await hashToken(joinToken),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const accepted = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.list<PairingRequest>({ prefix: `request:${pairing.id}:` });
      const activeRequests = [...existing.values()].filter((item) => item.status === "pending");
      if (activeRequests.length >= 5) return false;
      await txn.put(`request:${pairing.id}:${pairingRequest.id}`, pairingRequest);
      return true;
    });
    if (!accepted) {
      return json({ error: "This pairing already has several requests" }, { status: 429 });
    }

    return json({
      pairingId: pairing.id,
      requestId: pairingRequest.id,
      joinToken,
      hostPublicKey: pairing.hostPublicKey,
      hostName: pairing.hostName,
      expiresAt: pairing.expiresAt,
    }, { status: 201 });
  }

  private async listRequests(pairing: PairingRecord) {
    const requests = await this.ctx.storage.list<PairingRequest>({
      prefix: `request:${pairing.id}:`,
    });
    return [...requests.values()]
      .filter((item) => item.status === "pending")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((item) => ({
        requestId: item.id,
        deviceName: item.joinerName,
        publicKey: item.joinerPublicKey,
        createdAt: item.createdAt,
      }));
  }

  private async requestStatus(pairing: PairingRecord, requestId: string, request: Request) {
    const pairingRequest = await this.ctx.storage.get<PairingRequest>(
      `request:${pairing.id}:${requestId}`,
    );
    if (!pairingRequest || !(await this.authorized(pairingRequest.joinTokenHash, request))) {
      return json({ error: "Pairing request not found" }, { status: 404 });
    }
    return json({
      status: pairingRequest.status,
      envelope: pairingRequest.status === "approved" ? pairingRequest.envelope : undefined,
      expiresAt: pairing.expiresAt,
    });
  }

  private async resolveRequest(
    pairing: PairingRecord,
    requestId: string,
    request: Request,
    status: "approved" | "rejected",
  ) {
    if (!(await this.authorized(pairing.hostTokenHash, request))) {
      return json({ error: "Pairing host authorization failed" }, { status: 403 });
    }
    const key = `request:${pairing.id}:${requestId}`;
    const pairingRequest = await this.ctx.storage.get<PairingRequest>(key);
    if (!pairingRequest || pairingRequest.status !== "pending") {
      return json({ error: "Pairing request is no longer pending" }, { status: 409 });
    }

    let envelope: CipherEnvelope | undefined;
    if (status === "approved") {
      let body: Record<string, unknown>;
      try {
        body = await parseBody(request);
      } catch {
        return json({ error: "Invalid approval" }, { status: 400 });
      }
      if (!isEnvelope(body.envelope) || body.envelope.data.length > 8_000) {
        return json({ error: "Invalid approval" }, { status: 400 });
      }
      envelope = body.envelope;
    }

    await this.ctx.storage.put(key, {
      ...pairingRequest,
      status,
      envelope,
      updatedAt: Date.now(),
    } satisfies PairingRequest);
    return json({ ok: true, status });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/pairings") return this.create(request);
    if (request.method === "POST" && url.pathname === "/pairings/join") return this.join(request);

    const requestListMatch = url.pathname.match(/^\/pairings\/([^/]+)\/requests$/);
    if (requestListMatch && request.method === "GET") {
      const pairingId = requestListMatch[1];
      if (!pairingIdPattern.test(pairingId)) return json({ error: "Pairing not found" }, { status: 404 });
      const pairing = await this.pairing(pairingId);
      if (!pairing) return json({ error: "Pairing expired" }, { status: 410 });
      if (!(await this.authorized(pairing.hostTokenHash, request))) {
        return json({ error: "Pairing host authorization failed" }, { status: 403 });
      }
      return json({ requests: await this.listRequests(pairing), expiresAt: pairing.expiresAt });
    }

    const requestMatch = url.pathname.match(/^\/pairings\/([^/]+)\/requests\/([^/]+)(?:\/(approve|reject))?$/);
    if (requestMatch) {
      const [, pairingId, requestId, action] = requestMatch;
      if (!pairingIdPattern.test(pairingId) || !requestIdPattern.test(requestId)) {
        return json({ error: "Pairing request not found" }, { status: 404 });
      }
      const pairing = await this.pairing(pairingId);
      if (!pairing) return json({ error: "Pairing expired" }, { status: 410 });
      if (!action && request.method === "GET") return this.requestStatus(pairing, requestId, request);
      if (action === "approve" && request.method === "POST") {
        return this.resolveRequest(pairing, requestId, request, "approved");
      }
      if (action === "reject" && request.method === "POST") {
        return this.resolveRequest(pairing, requestId, request, "rejected");
      }
    }

    return json({ error: "Not found" }, { status: 404 });
  }

  async alarm() {
    const now = Date.now();
    const pairings = await this.ctx.storage.list<PairingRecord>({ prefix: "pairing:" });
    let nextAlarm: number | null = null;

    for (const [key, pairing] of pairings) {
      if (pairing.expiresAt <= now) {
        await this.ctx.storage.delete([key, `code:${pairing.code}`]);
        const requests = await this.ctx.storage.list({ prefix: `request:${pairing.id}:` });
        if (requests.size) await this.ctx.storage.delete([...requests.keys()]);
      } else if (nextAlarm === null || pairing.expiresAt < nextAlarm) {
        nextAlarm = pairing.expiresAt;
      }
    }

    const rateEntries = await this.ctx.storage.list<number>({ prefix: "rate:" });
    const oldestMinute = Math.floor((now - 5 * 60_000) / 60_000);
    const staleRateKeys = [...rateEntries.keys()].filter((key) => {
      const minute = Number(key.split(":")[1]);
      return Number.isFinite(minute) && minute < oldestMinute;
    });
    if (staleRateKeys.length) await this.ctx.storage.delete(staleRateKeys);

    if (nextAlarm !== null) await this.ctx.storage.setAlarm(nextAlarm);
  }
}

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
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/turn")) {
      const verifier = bearerToken(request);
      const registeredVerifier = await this.ctx.storage.get<string>("auth:verifier");
      return new Response(null, {
        status: verifier && registeredVerifier && sameVerifier(registeredVerifier, verifier) ? 204 : 403,
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

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
      return;
    }

    if (data.type === "file:relay") {
      const to = typeof data.to === "string" ? data.to.slice(0, 80) : "";
      if (!to || !isEnvelope(data.envelope)) return;

      for (const peer of this.ctx.getWebSockets()) {
        if (this.attachment(peer)?.clientId === to) {
          peer.send(JSON.stringify({
            type: "file:relay",
            from: sender.clientId,
            envelope: data.envelope,
          }));
          break;
        }
      }
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
