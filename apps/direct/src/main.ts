import "./styles.css";
import {
  CLOCK_SKEW_MS,
  INVITATION_LIFETIME_MS,
  assertOfferTime,
  decodeExchange,
  encodeExchange,
  randomSecret,
  signAnswer,
  verificationWords,
  verifyAnswer,
  type AnswerPayload,
  type OfferPayload,
  type SharedFileDescription,
} from "./protocol";

const appNode = document.querySelector<HTMLDivElement>("#app");
if (!appNode) throw new Error("App root is missing");
const app = appNode;

const CHUNK_BYTES = 32 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MEMORY_RECEIVE_LIMIT = 256 * 1024 * 1024;
const EXCHANGE_FILE_LIMIT = 2 * 1024 * 1024;

const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [{
    urls: [
      "stun:stunserver2025.stunprotocol.org:3478",
      "stun:stun.cloudflare.com:3478",
    ],
  }],
  iceCandidatePoolSize: 1,
};

type View = "home" | "sender" | "receiver";
type SenderPhase = "gathering" | "sharing" | "connecting" | "ready" | "sending" | "finishing" | "complete";
type ReceiverPhase = "invited" | "preparing" | "answer" | "connecting" | "receiving" | "complete";

interface SenderSession {
  file: File;
  offer: OfferPayload;
  offerCode: string;
  verification: string;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  phase: SenderPhase;
  sent: number;
  answerInput: string;
  started: boolean;
}

interface WritableTarget {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface ReceiverSession {
  offer: OfferPayload;
  offerCode: string;
  verification: string;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  answerCode: string;
  phase: ReceiverPhase;
  received: number;
  writable?: WritableTarget;
  chunks: ArrayBuffer[];
  writeChain: Promise<void>;
  readySent: boolean;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable(): Promise<WritableTarget> }>;
}

let view: View = "home";
let sender: SenderSession | null = null;
let receiver: ReceiverSession | null = null;
let errorMessage = "";
let noticeMessage = "";
let connectionTimer = 0;
let expiryTimer = 0;
let initialInvitationIgnored = false;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${unit === 0 || value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatRemaining(expiresAt: number) {
  const remaining = Math.max(0, expiresAt - Date.now());
  const totalMinutes = Math.max(0, Math.ceil(remaining / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function fileDescription(file: File): SharedFileDescription {
  return {
    name: file.name.slice(0, 255) || "file",
    size: file.size,
    type: file.type.slice(0, 200),
    lastModified: file.lastModified,
  };
}

function brand() {
  return `
    <div class="brand" aria-label="CopyPaesto Direct">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
      <span>CopyPaesto</span><em>Direct</em>
    </div>`;
}

function lockIcon() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="8" width="14" height="9" rx="3"></rect><path d="M6.5 8V6.5a3.5 3.5 0 0 1 7 0V8"></path></svg>`;
}

function fileIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h7l5 5v14H6z"></path><path d="M13 2.5v5h5"></path></svg>`;
}

function arrowIcon() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 5l5 5-5 5"></path></svg>`;
}

function progressMarkup(transferred: number, size: number, label: string) {
  const percent = size ? Math.min(100, (transferred / size) * 100) : 100;
  return `
    <div class="transfer-progress" aria-live="polite">
      <div><strong id="progress-label">${escapeHtml(label)}</strong><span id="progress-size">${formatBytes(transferred)} / ${formatBytes(size)}</span></div>
      <div class="progress-track"><i id="progress-bar" style="width:${percent}%"></i></div>
      <small id="progress-percent">${Math.round(percent)}%</small>
    </div>`;
}

function shell(content: string, modeClass = "") {
  app.innerHTML = `
    <main class="direct-app ${modeClass}">
      <header class="site-header">
        ${brand()}
        <div class="header-promise">${lockIcon()} No account · no file server</div>
      </header>
      ${content}
      <footer class="site-footer">
        <span>WebRTC encrypted</span>
        <span>Free STUN discovery · direct bytes only</span>
        <span>Keep both pages open</span>
      </footer>
    </main>`;
}

function homeMarkup() {
  return `
    <section class="home-stage">
      <div class="home-copy">
        <p class="eyebrow">Browser to browser · nothing stored</p>
        <h1>Pass the file.<br><i>Skip the cloud.</i></h1>
        <p class="lede">Choose a file before the other device arrives. Exchange two private codes, then the bytes travel directly between your browsers.</p>
        <ol class="flow-line" aria-label="How it works">
          <li><b>01</b><span>Choose</span></li>
          <li><b>02</b><span>Invite</span></li>
          <li><b>03</b><span>Connect</span></li>
        </ol>
      </div>
      <div class="action-column">
        <section class="send-action">
          <span class="action-index">SEND / 01</span>
          <h2>Choose the file first</h2>
          <p>The invitation remains reusable for six hours. Merely opening it never consumes it.</p>
          <label class="file-pick" for="send-file">
            <span>${fileIcon()}</span>
            <strong>Select a file</strong>
            <small>Any type · direct stream</small>
          </label>
          <input id="send-file" type="file" hidden>
        </section>
        <section class="receive-action">
          <span class="action-index">RECEIVE / 02</span>
          <h2>Open an invitation</h2>
          <p>Paste the invitation code, or choose an invitation HTML file someone sent you.</p>
          <textarea id="offer-input" rows="3" spellcheck="false" placeholder="Paste invitation code"></textarea>
          <div class="receive-actions">
            <button id="open-offer" class="light-button">Open invitation ${arrowIcon()}</button>
            <label class="file-button" for="offer-file">Choose invitation file</label>
            <input id="offer-file" type="file" accept=".html,.htm,.txt" hidden>
          </div>
        </section>
        ${errorMessage ? `<div class="inline-error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
      </div>
    </section>`;
}

function senderMarkup(session: SenderSession) {
  const sharing = Boolean(session.offerCode);
  const connected = ["ready", "sending", "finishing", "complete"].includes(session.phase);
  const status = session.phase === "gathering" ? "Preparing a direct route…"
    : session.phase === "sharing" ? "Waiting for the recipient’s answer"
      : session.phase === "connecting" ? "Trying the direct route…"
        : session.phase === "ready" ? "Recipient is ready"
          : session.phase === "sending" ? "Sending directly"
            : session.phase === "finishing" ? "Confirming the file…"
              : "Transfer complete";
  return `
    <section class="transfer-stage">
      <aside class="transfer-rail">
        <button id="start-over" class="back-button">← Start over</button>
        <span class="action-index">SENDER</span>
        <h1>Your file is<br><i>standing by.</i></h1>
        <div class="selected-file">
          <span>${fileIcon()}</span>
          <div><strong>${escapeHtml(session.file.name)}</strong><small>${formatBytes(session.file.size)}</small></div>
        </div>
        <div class="verification-block">
          <span>VERIFY ON BOTH DEVICES</span>
          <strong>${session.verification || "—"}</strong>
        </div>
        <div class="privacy-fact"><i></i><span>The invitation may reveal network addresses to its recipient. Share it privately.</span></div>
      </aside>
      <section class="transfer-work">
        <div class="connection-heading">
          <div class="status-pulse ${connected ? "live" : ""}"><i></i><span>${escapeHtml(status)}</span></div>
          <span class="expiry" data-expires="${session.offer.expiresAt}">Expires in ${formatRemaining(session.offer.expiresAt)}</span>
        </div>

        ${sharing ? `
          <section class="step-block ${session.phase === "sharing" ? "active" : "done"}">
            <div class="step-heading"><b>1</b><div><span>SHARE</span><h2>Send the invitation</h2></div></div>
            <p>For an offline handoff, send the invitation HTML file. If both devices already have this app, copy only the code.</p>
            <div class="share-buttons">
              <button id="share-invitation" class="primary-button">Share invitation ${arrowIcon()}</button>
              <button id="download-invitation" class="outline-button">Download HTML</button>
              <button id="copy-offer" class="text-button">Copy code</button>
            </div>
            <details>
              <summary>Show invitation code</summary>
              <textarea readonly rows="4" id="offer-code">${escapeHtml(session.offerCode)}</textarea>
            </details>
          </section>

          <section class="step-block ${session.phase === "sharing" ? "active" : connected ? "done" : "active"}">
            <div class="step-heading"><b>2</b><div><span>ANSWER</span><h2>Paste their reply</h2></div></div>
            ${session.phase === "sharing" ? `
              <p>The recipient creates a short answer code. Opening your invitation alone does not connect or consume it.</p>
              <textarea id="answer-input" rows="4" spellcheck="false" placeholder="Paste answer code">${escapeHtml(session.answerInput)}</textarea>
              <div class="answer-actions">
                <button id="apply-answer" class="primary-button">Connect devices ${arrowIcon()}</button>
                <label class="file-button dark" for="answer-file">Choose answer file</label>
                <input id="answer-file" type="file" accept=".txt" hidden>
              </div>
            ` : `<p class="completed-step">Answer accepted · the browsers are negotiating directly.</p>`}
          </section>
        ` : `
          <section class="gathering-panel">
            <div class="orbit" aria-hidden="true"><i></i><i></i><i></i></div>
            <span>BUILDING INVITATION</span>
            <h2>Finding a route from this device</h2>
            <p>This can take a few seconds when a discovery server is unreachable.</p>
          </section>`}

        ${session.phase === "ready" ? `
          <section class="send-confirm">
            <span>CONNECTED</span>
            <h2>The recipient is ready.</h2>
            <p>The file will travel directly to the device displaying verification code <strong>${session.verification}</strong>.</p>
            <button id="send-now" class="primary-button large">Send ${formatBytes(session.file.size)} now ${arrowIcon()}</button>
          </section>` : ""}
        ${session.phase === "sending" || session.phase === "finishing" || session.phase === "complete"
          ? progressMarkup(session.sent, session.file.size, session.phase === "complete" ? "Delivered" : session.phase === "finishing" ? "Waiting for confirmation" : "Sending")
          : ""}
        ${noticeMessage ? `<div class="inline-notice">${escapeHtml(noticeMessage)}</div>` : ""}
        ${errorMessage ? `<div class="inline-error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
      </section>
    </section>`;
}

function receiverMarkup(session: ReceiverSession) {
  const file = session.offer.file;
  const connected = ["connecting", "receiving", "complete"].includes(session.phase);
  const status = session.phase === "invited" ? "Invitation opened · no connection yet"
    : session.phase === "preparing" ? "Preparing your answer…"
      : session.phase === "answer" ? "Waiting for the sender"
        : session.phase === "connecting" ? "Direct route connected"
          : session.phase === "receiving" ? "Receiving directly"
            : "Transfer complete";
  return `
    <section class="transfer-stage receiver-mode">
      <aside class="transfer-rail">
        <button id="start-over" class="back-button">← Close invitation</button>
        <span class="action-index">RECIPIENT</span>
        <h1>A file is<br><i>waiting.</i></h1>
        <div class="selected-file">
          <span>${fileIcon()}</span>
          <div><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></div>
        </div>
        <div class="verification-block">
          <span>COMPARE WITH SENDER</span>
          <strong>${session.verification}</strong>
        </div>
        <div class="privacy-fact"><i></i><span>Continue only if you expected this file and the verification code matches.</span></div>
      </aside>
      <section class="transfer-work">
        <div class="connection-heading">
          <div class="status-pulse ${connected ? "live" : ""}"><i></i><span>${escapeHtml(status)}</span></div>
          <span class="expiry" data-expires="${session.offer.expiresAt}">Expires in ${formatRemaining(session.offer.expiresAt)}</span>
        </div>

        ${session.phase === "invited" ? `
          <section class="receive-consent">
            <span>NOTHING HAS CONNECTED YET</span>
            <h2>Receive “${escapeHtml(file.name)}”?</h2>
            <dl>
              <div><dt>Size</dt><dd>${formatBytes(file.size)}</dd></div>
              <div><dt>Type</dt><dd>${escapeHtml(file.type || "Unknown")}</dd></div>
              <div><dt>Expires</dt><dd>${new Date(session.offer.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd></div>
            </dl>
            <p>Preparing an answer does not consume this invitation. You will send the answer back, then keep this page open.</p>
            <button id="prepare-answer" class="primary-button large">${typeof (window as SavePickerWindow).showSaveFilePicker === "function" ? "Choose save location" : "Prepare to receive"} ${arrowIcon()}</button>
            ${typeof (window as SavePickerWindow).showSaveFilePicker === "function" && file.size <= MEMORY_RECEIVE_LIMIT
              ? `<button id="prepare-memory" class="memory-button">Use browser download instead</button>`
              : ""}
          </section>` : ""}

        ${session.phase === "preparing" ? `
          <section class="gathering-panel">
            <div class="orbit" aria-hidden="true"><i></i><i></i><i></i></div>
            <span>BUILDING ANSWER</span>
            <h2>Preparing this device</h2>
            <p>Keep the page open while the browser discovers a direct route.</p>
          </section>` : ""}

        ${session.answerCode && (session.phase === "answer" || session.phase === "connecting") ? `
          <section class="step-block active">
            <div class="step-heading"><b>1</b><div><span>RETURN</span><h2>Send the answer back</h2></div></div>
            <p>Share this answer with the sender, then return here. The answer contains connection details, never file data.</p>
            <div class="share-buttons">
              <button id="share-answer" class="primary-button">Share answer ${arrowIcon()}</button>
              <button id="copy-answer" class="outline-button">Copy answer</button>
              <button id="download-answer" class="text-button">Download .txt</button>
            </div>
            <details>
              <summary>Show answer code</summary>
              <textarea readonly rows="5" id="answer-code">${escapeHtml(session.answerCode)}</textarea>
            </details>
            <div class="waiting-line"><i></i><span>Waiting for the sender to paste it…</span></div>
          </section>` : ""}

        ${session.phase === "receiving" || session.phase === "complete"
          ? progressMarkup(session.received, file.size, session.phase === "complete" ? "Saved" : "Receiving")
          : ""}
        ${noticeMessage ? `<div class="inline-notice">${escapeHtml(noticeMessage)}</div>` : ""}
        ${errorMessage ? `<div class="inline-error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
      </section>
    </section>`;
}

function render() {
  if (view === "sender" && sender) shell(senderMarkup(sender), "session-view");
  else if (view === "receiver" && receiver) shell(receiverMarkup(receiver), "session-view");
  else shell(homeMarkup(), "home-view");
  bindEvents();
  updateExpiryLabels();
}

function element<T extends HTMLElement>(id: string) {
  return document.querySelector<T>(`#${id}`);
}

function bindEvents() {
  element<HTMLInputElement>("send-file")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void beginSending(file);
  });
  element<HTMLButtonElement>("open-offer")?.addEventListener("click", () => {
    const value = element<HTMLTextAreaElement>("offer-input")?.value ?? "";
    void openInvitation(value);
  });
  element<HTMLInputElement>("offer-file")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void readExchangeFile(file).then(openInvitation).catch(showError);
  });
  element<HTMLButtonElement>("start-over")?.addEventListener("click", () => void startOver());
  element<HTMLButtonElement>("copy-offer")?.addEventListener("click", () => sender && void copyText(sender.offerCode, "Invitation code copied"));
  element<HTMLButtonElement>("download-invitation")?.addEventListener("click", () => sender && downloadInvitation(sender.offerCode));
  element<HTMLButtonElement>("share-invitation")?.addEventListener("click", () => sender && void shareInvitation(sender.offerCode));
  element<HTMLButtonElement>("apply-answer")?.addEventListener("click", () => {
    if (!sender) return;
    sender.answerInput = element<HTMLTextAreaElement>("answer-input")?.value.trim() ?? "";
    void applyAnswer(sender.answerInput);
  });
  element<HTMLInputElement>("answer-file")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    void readExchangeFile(file).then((value) => {
      if (sender) sender.answerInput = value;
      return applyAnswer(value);
    }).catch(showError);
  });
  element<HTMLButtonElement>("send-now")?.addEventListener("click", () => void sendSelectedFile());
  element<HTMLButtonElement>("prepare-answer")?.addEventListener("click", () => void prepareReceiver());
  element<HTMLButtonElement>("prepare-memory")?.addEventListener("click", () => void prepareReceiver(true));
  element<HTMLButtonElement>("copy-answer")?.addEventListener("click", () => receiver && void copyText(receiver.answerCode, "Answer copied"));
  element<HTMLButtonElement>("download-answer")?.addEventListener("click", () => receiver && downloadText("CopyPaesto-answer.txt", receiver.answerCode));
  element<HTMLButtonElement>("share-answer")?.addEventListener("click", () => receiver && void shareAnswer(receiver.answerCode));
}

function updateExpiryLabels() {
  document.querySelectorAll<HTMLElement>("[data-expires]").forEach((node) => {
    const expiresAt = Number(node.dataset.expires);
    if (Number.isFinite(expiresAt)) node.textContent = `Expires in ${formatRemaining(expiresAt)}`;
  });
}

function updateProgress(transferred: number, size: number, label: string) {
  const percent = size ? Math.min(100, (transferred / size) * 100) : 100;
  const bar = element<HTMLElement>("progress-bar");
  const percentNode = element<HTMLElement>("progress-percent");
  const sizeNode = element<HTMLElement>("progress-size");
  const labelNode = element<HTMLElement>("progress-label");
  if (bar) bar.style.width = `${percent}%`;
  if (percentNode) percentNode.textContent = `${Math.round(percent)}%`;
  if (sizeNode) sizeNode.textContent = `${formatBytes(transferred)} / ${formatBytes(size)}`;
  if (labelNode) labelNode.textContent = label;
}

function showError(cause: unknown) {
  errorMessage = cause instanceof Error ? cause.message : String(cause || "Something went wrong");
  render();
}

function clearMessages() {
  errorMessage = "";
  noticeMessage = "";
}

async function waitForIce(peer: RTCPeerConnection, timeoutMs = 9_000) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    const onState = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onState);
  });
}

function watchPeer(peer: RTCPeerConnection, role: "sender" | "receiver") {
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") {
      window.clearTimeout(connectionTimer);
      if (role === "receiver" && receiver && receiver.phase === "answer") {
        receiver.phase = "connecting";
        render();
      }
      return;
    }
    if (peer.connectionState === "failed") {
      errorMessage = "The browsers could not find a direct route. Try another network or put both devices on the same Wi‑Fi; this offline edition has no TURN relay.";
      render();
    }
  });
}

async function beginSending(file: File) {
  clearMessages();
  await cleanupSessions();
  const peer = new RTCPeerConnection(ICE_CONFIGURATION);
  const channel = peer.createDataChannel("copypaesto-direct", { ordered: true });
  channel.binaryType = "arraybuffer";
  const issuedAt = Date.now();
  const offer: OfferPayload = {
    v: 1,
    kind: "offer",
    transferId: crypto.randomUUID(),
    issuedAt,
    expiresAt: issuedAt + INVITATION_LIFETIME_MS,
    secret: randomSecret(),
    file: fileDescription(file),
    description: { type: "offer", sdp: "pending" },
  };
  sender = {
    file,
    offer,
    offerCode: "",
    verification: await verificationWords(offer.secret),
    peer,
    channel,
    phase: "gathering",
    sent: 0,
    answerInput: "",
    started: false,
  };
  view = "sender";
  attachSenderChannel(channel);
  watchPeer(peer, "sender");
  render();

  try {
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    await waitForIce(peer);
    if (!sender || sender.peer !== peer || !peer.localDescription) return;
    sender.offer.description = peer.localDescription.toJSON();
    sender.offerCode = await encodeExchange(sender.offer);
    sender.phase = "sharing";
    render();
  } catch (cause) {
    showError(cause);
  }
}

function attachSenderChannel(channel: RTCDataChannel) {
  channel.addEventListener("open", () => {
    if (!sender || sender.channel !== channel) return;
    sender.phase = "connecting";
    render();
  });
  channel.addEventListener("message", (event) => {
    if (!sender || sender.channel !== channel || typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    if (message.cp !== 1) return;
    if (message.type === "ready" && !sender.started) {
      sender.phase = "ready";
      render();
    }
    if (message.type === "complete") {
      sender.sent = sender.file.size;
      sender.phase = "complete";
      render();
    }
    if (message.type === "error" && typeof message.message === "string") {
      errorMessage = message.message;
      render();
    }
  });
  channel.addEventListener("close", () => {
    if (!sender || sender.phase === "complete") return;
    errorMessage = "The recipient closed the direct connection before the transfer finished.";
    render();
  });
}

async function applyAnswer(value: string) {
  if (!sender) return;
  clearMessages();
  try {
    const payload = await decodeExchange(value);
    if (payload.kind !== "answer") throw new Error("Paste the recipient’s answer code, not an invitation code.");
    if (payload.transferId !== sender.offer.transferId || payload.expiresAt !== sender.offer.expiresAt) {
      throw new Error("This answer belongs to a different invitation.");
    }
    if (Date.now() > sender.offer.expiresAt + CLOCK_SKEW_MS) throw new Error("This invitation expired. Start over to create a new one.");
    if (!(await verifyAnswer(sender.offer.secret, payload))) throw new Error("The answer could not be authenticated.");
    if (sender.peer.remoteDescription) throw new Error("An answer has already been accepted for this connection.");
    await sender.peer.setRemoteDescription(payload.description);
    sender.phase = "connecting";
    connectionTimer = window.setTimeout(() => {
      if (!sender || sender.phase === "complete" || sender.peer.connectionState === "connected") return;
      errorMessage = "No direct route appeared. Try another network or connect both devices to the same Wi‑Fi.";
      render();
    }, 45_000);
    render();
  } catch (cause) {
    showError(cause);
  }
}

async function waitForChannelBuffer(channel: RTCDataChannel) {
  if (channel.bufferedAmount <= MAX_BUFFERED_BYTES) return;
  channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The direct connection stopped accepting file data."));
    }, 30_000);
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("The direct connection closed.")); };
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
}

async function sendSelectedFile() {
  if (!sender || sender.started || sender.channel.readyState !== "open") return;
  sender.started = true;
  sender.phase = "sending";
  render();
  const { channel, file, offer } = sender;
  try {
    channel.send(JSON.stringify({ cp: 1, type: "metadata", transferId: offer.transferId, file: offer.file }));
    let lastPaint = 0;
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      if (!sender || channel.readyState !== "open") throw new Error("The recipient disconnected.");
      await waitForChannelBuffer(channel);
      const chunk = await file.slice(offset, Math.min(file.size, offset + CHUNK_BYTES)).arrayBuffer();
      channel.send(chunk);
      sender.sent += chunk.byteLength;
      if (performance.now() - lastPaint > 100 || sender.sent === file.size) {
        updateProgress(sender.sent, file.size, "Sending");
        lastPaint = performance.now();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }
    channel.send(JSON.stringify({ cp: 1, type: "eof", transferId: offer.transferId, size: file.size }));
    sender.phase = "finishing";
    render();
  } catch (cause) {
    showError(cause);
  }
}

async function openInvitation(value: string) {
  clearMessages();
  try {
    const payload = await decodeExchange(value);
    if (payload.kind !== "offer") throw new Error("This is an answer code. Open the original invitation instead.");
    assertOfferTime(payload);
    await cleanupSessions();
    receiver = {
      offer: payload,
      offerCode: value.trim(),
      verification: await verificationWords(payload.secret),
      answerCode: "",
      phase: "invited",
      received: 0,
      chunks: [],
      writeChain: Promise.resolve(),
      readySent: false,
    };
    view = "receiver";
    render();
  } catch (cause) {
    showError(cause);
  }
}

async function prepareSaveTarget(session: ReceiverSession, forceMemory = false) {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker && !forceMemory) {
    try {
      const extension = session.offer.file.name.match(/\.[A-Za-z0-9]{1,12}$/)?.[0];
      const handle = await picker({
        suggestedName: session.offer.file.name,
        ...(session.offer.file.type && extension ? {
          types: [{ description: "Received file", accept: { [session.offer.file.type]: [extension] } }],
        } : {}),
      });
      session.writable = await handle.createWritable();
      return;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("Choose a save location to prepare the answer.");
      // Some browsers expose the picker but reject a MIME/extension combination. Fall through only for manageable files.
    }
  }
  if (session.offer.file.size > MEMORY_RECEIVE_LIMIT) {
    throw new Error(`This browser cannot stream ${formatBytes(session.offer.file.size)} directly to disk. Use desktop Chrome or Edge, or choose a file under ${formatBytes(MEMORY_RECEIVE_LIMIT)}.`);
  }
}

async function prepareReceiver(forceMemory = false) {
  if (!receiver || receiver.peer) return;
  clearMessages();
  try {
    assertOfferTime(receiver.offer);
    await prepareSaveTarget(receiver, forceMemory);
    receiver.phase = "preparing";
    render();
    const peer = new RTCPeerConnection(ICE_CONFIGURATION);
    receiver.peer = peer;
    watchPeer(peer, "receiver");
    peer.addEventListener("datachannel", (event) => attachReceiverChannel(event.channel));
    await peer.setRemoteDescription(receiver.offer.description);
    const description = await peer.createAnswer();
    await peer.setLocalDescription(description);
    await waitForIce(peer);
    if (!receiver || receiver.peer !== peer || !peer.localDescription) return;
    const unsigned: Omit<AnswerPayload, "proof"> = {
      v: 1,
      kind: "answer",
      transferId: receiver.offer.transferId,
      expiresAt: receiver.offer.expiresAt,
      description: peer.localDescription.toJSON(),
    };
    const answer: AnswerPayload = {
      ...unsigned,
      proof: await signAnswer(receiver.offer.secret, unsigned),
    };
    receiver.answerCode = await encodeExchange(answer);
    receiver.phase = "answer";
    render();
  } catch (cause) {
    if (receiver?.writable?.abort) void receiver.writable.abort(cause).catch(() => undefined);
    if (receiver) {
      receiver.writable = undefined;
      receiver.peer?.close();
      receiver.peer = undefined;
      receiver.phase = "invited";
    }
    showError(cause);
  }
}

function attachReceiverChannel(channel: RTCDataChannel) {
  if (!receiver) return;
  receiver.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    if (!receiver || receiver.channel !== channel || receiver.readySent) return;
    receiver.readySent = true;
    receiver.phase = "connecting";
    channel.send(JSON.stringify({ cp: 1, type: "ready", transferId: receiver.offer.transferId }));
    render();
  });
  channel.addEventListener("message", (event) => void receiveMessage(event.data));
  channel.addEventListener("close", () => {
    if (!receiver || receiver.phase === "complete") return;
    errorMessage = "The sender closed the direct connection before the file finished.";
    render();
  });
}

async function receiveMessage(data: unknown) {
  if (!receiver) return;
  if (typeof data === "string") {
    let message: Record<string, unknown>;
    try { message = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (message.cp !== 1 || message.transferId !== receiver.offer.transferId) return;
    if (message.type === "metadata") {
      receiver.phase = "receiving";
      render();
      return;
    }
    if (message.type === "eof") {
      await finishReceiving();
    }
    return;
  }

  const buffer = data instanceof ArrayBuffer ? data : data instanceof Blob ? await data.arrayBuffer() : null;
  if (!buffer || !receiver || receiver.phase === "complete") return;
  const session = receiver;
  if (session.received + buffer.byteLength > session.offer.file.size) {
    const message = "The sender tried to exceed the file size declared in the invitation.";
    if (session.channel?.readyState === "open") {
      session.channel.send(JSON.stringify({ cp: 1, type: "error", message }));
      session.channel.close();
    }
    if (session.writable?.abort) void session.writable.abort(message).catch(() => undefined);
    errorMessage = message;
    render();
    return;
  }
  session.writeChain = session.writeChain.then(async () => {
    if (session.writable) await session.writable.write(buffer);
    else session.chunks.push(buffer);
    session.received += buffer.byteLength;
    updateProgress(session.received, session.offer.file.size, "Receiving");
  });
  await session.writeChain.catch((cause) => {
    if (session.channel?.readyState === "open") {
      session.channel.send(JSON.stringify({ cp: 1, type: "error", message: "The recipient could not save the incoming file." }));
    }
    throw cause;
  });
}

async function finishReceiving() {
  if (!receiver) return;
  const session = receiver;
  try {
    await session.writeChain;
    if (session.received !== session.offer.file.size) {
      throw new Error(`The file ended at ${formatBytes(session.received)} instead of ${formatBytes(session.offer.file.size)}.`);
    }
    if (session.writable) await session.writable.close();
    else triggerDownload(session.offer.file, session.chunks);
    session.phase = "complete";
    session.channel?.send(JSON.stringify({ cp: 1, type: "complete", transferId: session.offer.transferId }));
    render();
  } catch (cause) {
    if (session.writable?.abort) void session.writable.abort(cause).catch(() => undefined);
    showError(cause);
  }
}

function triggerDownload(file: SharedFileDescription, chunks: ArrayBuffer[]) {
  const url = URL.createObjectURL(new Blob(chunks, { type: file.type || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function copyText(value: string, success: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  noticeMessage = success;
  render();
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadText(name: string, value: string) {
  downloadBlob(name, new Blob([value], { type: "text/plain;charset=utf-8" }));
}

function invitationHtml(code: string) {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const meta = clone.querySelector<HTMLMetaElement>('meta[name="copypaesto-invitation"]');
  if (!meta) throw new Error("This build cannot create a portable invitation file.");
  meta.content = code;
  clone.querySelectorAll("script:not([data-copypaesto-app])").forEach((node) => node.remove());
  clone.querySelectorAll("style:not([data-copypaesto-style])").forEach((node) => node.remove());
  clone.querySelectorAll('link[rel="stylesheet"]').forEach((node) => node.remove());
  const root = clone.querySelector("#app");
  if (root) root.innerHTML = "";
  return `<!doctype html>\n${clone.outerHTML}`;
}

function portableInvitation(code: string) {
  const isSingleFile = document.querySelector('meta[name="copypaesto-build"][content="single-file"]');
  if (!isSingleFile) throw new Error("Portable invitation files are available in the built CopyPaesto-Direct.html release.");
  return new File([invitationHtml(code)], "CopyPaesto-invitation.html", { type: "text/html" });
}

function downloadInvitation(code: string) {
  try {
    downloadBlob("CopyPaesto-invitation.html", portableInvitation(code));
  } catch (cause) {
    showError(cause);
  }
}

async function shareInvitation(code: string) {
  try {
    const file = portableInvitation(code);
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: "CopyPaesto file invitation", text: "Open this invitation to receive a file directly from me.", files: [file] });
      return;
    }
    if (location.protocol === "https:" || location.protocol === "http:") {
      const url = new URL(location.href);
      url.hash = new URLSearchParams({ offer: code }).toString();
      if (navigator.share) await navigator.share({ title: "CopyPaesto file invitation", url: url.toString() });
      else await copyText(url.toString(), "Invitation link copied");
      return;
    }
    downloadBlob(file.name, file);
    noticeMessage = "Invitation downloaded · send that HTML file to the recipient";
    render();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    showError(cause);
  }
}

async function shareAnswer(code: string) {
  try {
    const file = new File([code], "CopyPaesto-answer.txt", { type: "text/plain" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: "CopyPaesto connection answer", text: "Paste this answer into the sending device, then return here.", files: [file] });
    } else if (navigator.share) {
      await navigator.share({ title: "CopyPaesto connection answer", text: code });
    } else {
      await copyText(code, "Answer copied");
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    showError(cause);
  }
}

async function readExchangeFile(file: File) {
  if (file.size > EXCHANGE_FILE_LIMIT) throw new Error("That file is too large to be a CopyPaesto invitation or answer.");
  const text = await file.text();
  if (/\.html?$/i.test(file.name) || /<html[\s>]/i.test(text)) {
    const documentValue = new DOMParser().parseFromString(text, "text/html");
    const code = documentValue.querySelector<HTMLMetaElement>('meta[name="copypaesto-invitation"]')?.content ?? "";
    if (!code) throw new Error("This HTML file does not contain a CopyPaesto invitation.");
    return code;
  }
  return text.trim();
}

async function cleanupSessions() {
  window.clearTimeout(connectionTimer);
  if (receiver?.writable?.abort && receiver.phase !== "complete") {
    await receiver.writable.abort("Transfer closed").catch(() => undefined);
  }
  sender?.channel.close();
  sender?.peer.close();
  receiver?.channel?.close();
  receiver?.peer?.close();
  sender = null;
  receiver = null;
}

async function startOver() {
  await cleanupSessions();
  initialInvitationIgnored = true;
  clearMessages();
  view = "home";
  try {
    if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  } catch {
    // file:// history behavior differs across mobile browsers.
  }
  render();
}

function initialInvitation() {
  if (initialInvitationIgnored) return "";
  const embedded = document.querySelector<HTMLMetaElement>('meta[name="copypaesto-invitation"]')?.content.trim();
  if (embedded) return embedded;
  try {
    return new URLSearchParams(location.hash.replace(/^#/, "")).get("offer")?.trim() ?? "";
  } catch {
    return "";
  }
}

window.addEventListener("beforeunload", (event) => {
  const active = sender && !["sharing", "complete"].includes(sender.phase)
    || receiver && !["invited", "complete"].includes(receiver.phase);
  if (!active) return;
  event.preventDefault();
});

expiryTimer = window.setInterval(() => {
  updateExpiryLabels();
  const expiresAt = sender?.offer.expiresAt ?? receiver?.offer.expiresAt;
  if (expiresAt && Date.now() > expiresAt + CLOCK_SKEW_MS && !errorMessage) {
    errorMessage = "This invitation expired. Start over to create a fresh six-hour invitation.";
    render();
  }
}, 30_000);
void expiryTimer;

render();
const embeddedOffer = initialInvitation();
if (embeddedOffer) void openInvitation(embeddedOffer);
