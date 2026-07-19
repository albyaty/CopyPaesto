import { useEffect, useMemo, useRef, useState } from "react";
import { useFileTransfer } from "./hooks/useFileTransfer";
import { useRoom } from "./hooks/useRoom";
import {
  clearSessionHash,
  formatSessionCode,
  generatePin,
  generateSessionCode,
  isValidPin,
  isValidSessionCode,
  normalizePin,
  readSessionFromHash,
  writeSessionToHash,
} from "./lib/session";
import type { ConnectionStatus, TransferItem } from "./types";

interface SessionState {
  code: string;
  pin: string;
  createdHere: boolean;
}

function getClientId() {
  const key = "copypaesto:device-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const value = crypto.randomUUID();
  sessionStorage.setItem(key, value);
  return value;
}

function getDeviceName() {
  return localStorage.getItem("copypaesto:device-name") || "My computer";
}

function copyText(value: string) {
  return navigator.clipboard.writeText(value);
}

function BrandMark() {
  return (
    <div className="brand" aria-label="CopyPaesto">
      <span className="brand-mark" aria-hidden="true"><i /><i /></span>
      <span>CopyPaesto</span>
    </div>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="6" width="9" height="10" rx="2" /><path d="M13 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="8" width="14" height="9" rx="3" /><path d="M6.5 8V6.5a3.5 3.5 0 0 1 7 0V8" /></svg>;
}

function FileIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5z" /><path d="M11 2.5v4h4" /></svg>;
}

function Onboarding({ onEnter }: { onEnter: (session: SessionState, deviceName: string) => void }) {
  const hashSession = useMemo(readSessionFromHash, []);
  const [mode, setMode] = useState<"choice" | "join">(hashSession ? "join" : "choice");
  const [sessionCode, setSessionCode] = useState(hashSession);
  const [pin, setPin] = useState("");
  const [deviceName, setDeviceName] = useState(getDeviceName);
  const [error, setError] = useState("");

  const persistDeviceName = () => {
    const clean = deviceName.trim() || "My computer";
    localStorage.setItem("copypaesto:device-name", clean);
    return clean;
  };

  const createSession = () => {
    const code = generateSessionCode();
    const generatedPin = generatePin();
    writeSessionToHash(code);
    onEnter({ code, pin: generatedPin, createdHere: true }, persistDeviceName());
  };

  const joinSession = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isValidSessionCode(sessionCode)) {
      setError("Enter the 12-character session code.");
      return;
    }
    if (!isValidPin(pin)) {
      setError("Enter the 5-digit PIN.");
      return;
    }
    const formatted = formatSessionCode(sessionCode);
    writeSessionToHash(formatted);
    onEnter({ code: formatted, pin, createdHere: false }, persistDeviceName());
  };

  return (
    <main className="onboarding">
      <header className="onboarding-header">
        <BrandMark />
        <div className="privacy-note"><LockIcon /> Private by design</div>
      </header>

      <section className="onboarding-stage">
        <div className="intro-copy">
          <p className="eyebrow">One clipboard · two machines</p>
          <h1>Move thought<br />at typing speed.</h1>
          <p className="intro-body">
            Three live text slots and direct file transfer, joined by a temporary session only your devices can unlock.
          </p>
          <div className="connection-sketch" aria-hidden="true">
            <span className="machine-dot"><i /></span>
            <span className="signal-line"><i /></span>
            <span className="machine-dot second"><i /></span>
          </div>
        </div>

        <div className="entry-panel">
          {mode === "choice" ? (
            <div className="entry-content enter-animation">
              <span className="step-number">01 / START</span>
              <h2>Open a private session</h2>
              <p>A random room code and one-time 5-digit PIN are made on this device.</p>

              <label className="field-label" htmlFor="device-name">This device is called</label>
              <input
                id="device-name"
                className="line-input"
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
                autoComplete="off"
              />

              <button className="primary-action" onClick={createSession}>
                Create session <ArrowIcon />
              </button>
              <button className="text-action" onClick={() => setMode("join")}>
                I have a session code
              </button>
            </div>
          ) : (
            <form className="entry-content enter-animation" onSubmit={joinSession}>
              <button className="back-action" type="button" onClick={() => {
                setMode("choice");
                setError("");
              }}>← Back</button>
              <span className="step-number">02 / JOIN</span>
              <h2>Unlock the shared desk</h2>
              <p>The PIN is checked before this device receives any clipboard or file details.</p>

              <label className="field-label" htmlFor="session-code">Session code</label>
              <input
                id="session-code"
                className="line-input code-input"
                placeholder="ABCD-EFGH-JKLM"
                value={sessionCode}
                onChange={(event) => setSessionCode(formatSessionCode(event.target.value))}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />

              <label className="field-label" htmlFor="session-pin">5-digit PIN</label>
              <input
                id="session-pin"
                className="line-input pin-input"
                placeholder="•••••"
                value={pin}
                onChange={(event) => setPin(normalizePin(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                type="password"
              />

              <label className="field-label" htmlFor="join-device-name">This device is called</label>
              <input
                id="join-device-name"
                className="line-input"
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
                autoComplete="off"
              />

              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-action" type="submit">
                Join session <ArrowIcon />
              </button>
            </form>
          )}

          <footer className="entry-footer">
            <span>PIN stays on your devices</span>
            <span>Rooms expire after 24h</span>
          </footer>
        </div>
      </section>
    </main>
  );
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function transferLabel(item: TransferItem) {
  const labels: Record<TransferItem["status"], string> = {
    connecting: "Making a direct route…",
    offered: "Ready to receive",
    waiting: "Waiting for acceptance",
    transferring: item.direction === "send" ? "Sending" : "Receiving",
    paused: "Paused",
    finishing: "Finishing safely…",
    complete: "Complete",
    declined: "Declined",
    failed: "Transfer stopped",
  };
  return labels[item.status];
}

function ConnectionBadge({ status, peerCount }: { status: ConnectionStatus; peerCount: number }) {
  const connected = status === "connected";
  return (
    <div className={`connection-badge ${connected ? "is-live" : ""}`}>
      <span className="status-dot" />
      <span>{connected ? (peerCount ? `${peerCount + 1} devices live` : "Waiting for device") : status}</span>
    </div>
  );
}

function SessionSheet({
  session,
  onClose,
}: {
  session: SessionState;
  onClose: () => void;
}) {
  const [showPin, setShowPin] = useState(session.createdHere);
  const [copied, setCopied] = useState("");
  const inviteUrl = window.location.href;

  const copy = async (label: string, value: string) => {
    await copyText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1600);
  };

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <section className="session-sheet" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="sheet-close" onClick={onClose} aria-label="Close">×</button>
        <span className="step-number">PRIVATE SESSION</span>
        <h2>Connect the other machine</h2>
        <p>Open CopyPaesto there and enter these two values. The invite link carries the session code, never the PIN.</p>

        <div className="credential-row">
          <div>
            <span>Session code</span>
            <strong>{session.code}</strong>
          </div>
          <button onClick={() => void copy("code", session.code)}>{copied === "code" ? "Copied" : "Copy"}</button>
        </div>

        <div className="credential-row pin-row">
          <div>
            <span>5-digit PIN</span>
            <strong>{showPin ? session.pin : "•••••"}</strong>
          </div>
          <button onClick={() => setShowPin((visible) => !visible)}>{showPin ? "Hide" : "Show"}</button>
          <button onClick={() => void copy("pin", session.pin)}>{copied === "pin" ? "Copied" : "Copy"}</button>
        </div>

        <button className="secondary-action wide" onClick={() => void copy("link", inviteUrl)}>
          <CopyIcon /> {copied === "link" ? "Invite link copied" : "Copy invite link"}
        </button>
        <div className="security-caption"><LockIcon /> PIN is held in memory only and disappears when you leave or refresh.</div>
      </section>
    </div>
  );
}

function TransferRow({
  item,
  onAccept,
  onDecline,
  onPause,
}: {
  item: TransferItem;
  onAccept: () => void;
  onDecline: () => void;
  onPause: () => void;
}) {
  const percent = item.size ? Math.min(100, (item.transferred / item.size) * 100) : 0;
  const canPause = item.status === "transferring" || item.status === "paused";
  return (
    <div className={`transfer-row transfer-${item.status}`}>
      <div className="file-glyph"><FileIcon /></div>
      <div className="transfer-info">
        <strong title={item.name}>{item.name}</strong>
        <span>{transferLabel(item)} · {formatBytes(item.size)}</span>
        {item.error && <em>{item.error}</em>}
        {!['offered', 'waiting', 'declined', 'failed'].includes(item.status) && (
          <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
        )}
      </div>
      {item.status === "offered" && (
        <div className="transfer-actions">
          <button className="accept-button" onClick={onAccept}>Save</button>
          <button onClick={onDecline}>Decline</button>
        </div>
      )}
      {canPause && <button className="pause-button" onClick={onPause}>{item.status === "paused" ? "Resume" : "Pause"}</button>}
    </div>
  );
}

function Workspace({ session, deviceName, onLeave }: {
  session: SessionState;
  deviceName: string;
  onLeave: () => void;
}) {
  const clientId = useMemo(getClientId, []);
  const room = useRoom({
    sessionCode: session.code,
    pin: session.pin,
    clientId,
    deviceName,
  });
  const files = useFileTransfer({
    peers: room.peers,
    sendSignal: room.sendSignal,
    subscribeToSignals: room.subscribeToSignals,
  });
  const [activeSlot, setActiveSlot] = useState(0);
  const [showSession, setShowSession] = useState(session.createdHere);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = room.slots[activeSlot];

  const copyActive = async () => {
    await copyText(active.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const pasteActive = async () => {
    try {
      const value = await navigator.clipboard.readText();
      room.updateSlot(activeSlot, value);
    } catch {
      // The browser displays its own clipboard permission guidance.
    }
  };

  const offerFiles = (list: FileList | File[]) => {
    const selected = Array.from(list);
    if (selected.length) void files.sendFiles(selected);
  };

  const chooseFiles = () => {
    if (!room.peers.length) {
      files.setNotice("Connect the second machine before choosing a file.");
      return;
    }
    fileInput.current?.click();
  };

  if (room.status === "denied") {
    return (
      <main className="session-denied">
        <BrandMark />
        <div><LockIcon /></div>
        <h1>That PIN didn’t unlock this session.</h1>
        <p>No clipboard text or device information was shared.</p>
        <button className="primary-action" onClick={onLeave}>Try again <ArrowIcon /></button>
      </main>
    );
  }

  return (
    <main className="workspace">
      <header className="workspace-header">
        <BrandMark />
        <div className="header-presence">
          <ConnectionBadge status={room.status} peerCount={room.peers.length} />
          <span className="status-detail">{room.statusDetail}</span>
        </div>
        <div className="header-actions">
          <button className="session-button" onClick={() => setShowSession(true)}><LockIcon /> Session</button>
          <button className="leave-button" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <div className="workspace-grid">
        <nav className="slot-rail" aria-label="Clipboard slots">
          <div className="rail-heading">
            <span>Clipboard</span>
            <i>{room.slots.filter((slot) => slot.text).length}/3</i>
          </div>
          {room.slots.map((slot, index) => (
            <button
              key={index}
              className={`slot-tab ${activeSlot === index ? "active" : ""}`}
              onClick={() => setActiveSlot(index)}
            >
              <span className="slot-number">0{index + 1}</span>
              <span className="slot-preview">{slot.text || "Empty slot"}</span>
              {slot.authorId && slot.authorId !== clientId && <i className="remote-mark" title={`Updated by ${slot.author}`} />}
            </button>
          ))}
          <div className="rail-security"><LockIcon /><span>AES-encrypted<br />before sync</span></div>
        </nav>

        <section className="editor-pane">
          <div className="pane-heading">
            <div>
              <span>CLIPBOARD / 0{activeSlot + 1}</span>
              <h1>Live text</h1>
            </div>
            <div className="editor-meta">
              {active.author ? `Last edited by ${active.author}` : "Ready on both machines"}
            </div>
          </div>

          <textarea
            aria-label={`Clipboard slot ${activeSlot + 1}`}
            className="clipboard-editor"
            placeholder="Type or paste here. It appears on the other machine as you work…"
            value={active.text}
            maxLength={120_000}
            onChange={(event) => room.updateSlot(activeSlot, event.target.value)}
            spellCheck
          />

          <footer className="editor-footer">
            <div className="editor-tools">
              <button onClick={() => void pasteActive()}>Paste from this device</button>
              <button className="copy-button" onClick={() => void copyActive()}><CopyIcon /> {copied ? "Copied" : "Copy text"}</button>
              {active.text && <button className="clear-button" onClick={() => room.updateSlot(activeSlot, "")}>Clear</button>}
            </div>
            <span>{active.text.length.toLocaleString()} characters</span>
          </footer>
        </section>

        <aside className="files-pane">
          <div className="pane-heading files-heading">
            <div>
              <span>DIRECT TRANSFER</span>
              <h2>Files</h2>
            </div>
            <span className="route-label">{files.relayAvailable ? "Relay fallback ready" : "Direct route"}</span>
          </div>

          <button
            className={`drop-zone ${dragging ? "is-dragging" : ""}`}
            onClick={chooseFiles}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              offerFiles(event.dataTransfer.files);
            }}
          >
            <span className="drop-arrow">↗</span>
            <strong>Drop anything</strong>
            <small>{room.peers.length ? `Send to ${room.peers[0].name}` : "Waiting for the other machine"}</small>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) offerFiles(event.target.files);
              event.target.value = "";
            }}
          />

          <div className="large-file-note">
            <strong>Large files stay light.</strong>
            <span>Chunks stream straight to disk, so a 1 GB file does not occupy 1 GB of browser memory.</span>
          </div>

          {files.notice && <div className="file-notice">{files.notice}<button onClick={() => files.setNotice("")}>×</button></div>}

          <div className="transfer-list">
            {files.transfers.length ? files.transfers.map((item) => (
              <TransferRow
                key={item.id}
                item={item}
                onAccept={() => void files.acceptTransfer(item.id)}
                onDecline={() => files.declineTransfer(item.id)}
                onPause={() => files.togglePause(item.id)}
              />
            )) : (
              <div className="empty-transfers">No transfers in this session</div>
            )}
          </div>
        </aside>
      </div>

      {showSession && <SessionSheet session={session} onClose={() => setShowSession(false)} />}
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [deviceName, setDeviceName] = useState(getDeviceName);

  useEffect(() => {
    const handleHashChange = () => {
      if (!window.location.hash && session) setSession(null);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [session]);

  const enter = (next: SessionState, name: string) => {
    setDeviceName(name);
    setSession(next);
  };

  const leave = () => {
    clearSessionHash();
    setSession(null);
  };

  return session
    ? <Workspace key={`${session.code}:${session.pin}`} session={session} deviceName={deviceName} onLeave={leave} />
    : <Onboarding onEnter={enter} />;
}
