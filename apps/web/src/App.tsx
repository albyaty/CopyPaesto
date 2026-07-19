import { useEffect, useMemo, useRef, useState } from "react";
import { AddDeviceSheet } from "./components/AddDeviceSheet";
import { useAutoSaveFolder } from "./hooks/useAutoSaveFolder";
import { useFileTransfer } from "./hooks/useFileTransfer";
import { useRoom } from "./hooks/useRoom";
import {
  approvePairing,
  createPairing,
  createPairingIdentity,
  joinPairing,
  listPairingRequests,
  openPairingSession,
  pairingRequestStatus,
  rejectPairing,
  sealPairingSession,
  type CreatedPairing,
  type JoinedPairing,
  type PairingIdentity,
  type PendingPairingRequest,
} from "./lib/pairing";
import {
  generatePin,
  generateSessionCode,
  isValidPin,
  isValidPairingCode,
  isValidSessionCode,
  normalizePairingCode,
} from "./lib/session";
import type { ConnectionStatus, Peer, TransferItem } from "./types";

interface SessionState {
  code: string;
  pin: string;
  createdHere: boolean;
}

interface RememberedSessionRecord {
  version: 1;
  session: SessionState;
  deviceName: string;
  rememberedAt: number;
}

const REMEMBERED_SESSION_KEY = "copypaesto:remembered-session:v1";

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionState>;
  return (
    typeof candidate.code === "string" &&
    isValidSessionCode(candidate.code) &&
    typeof candidate.pin === "string" &&
    isValidPin(candidate.pin) &&
    typeof candidate.createdHere === "boolean"
  );
}

function forgetRememberedSession() {
  try {
    localStorage.removeItem(REMEMBERED_SESSION_KEY);
  } catch {
    // Some privacy modes block persistent browser storage.
  }
}

function readRememberedSession(): { session: SessionState; deviceName: string } | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_SESSION_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<RememberedSessionRecord>;
    const deviceName = typeof record.deviceName === "string" ? record.deviceName.trim() : "";
    if (record.version !== 1 || !isSessionState(record.session) || !deviceName || deviceName.length > 40) {
      forgetRememberedSession();
      return null;
    }
    return { session: record.session, deviceName };
  } catch {
    forgetRememberedSession();
    return null;
  }
}

function rememberSession(session: SessionState, deviceName: string) {
  try {
    const record: RememberedSessionRecord = {
      version: 1,
      session,
      deviceName,
      rememberedAt: Date.now(),
    };
    localStorage.setItem(REMEMBERED_SESSION_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
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
  try {
    return localStorage.getItem("copypaesto:device-name") || "My computer";
  } catch {
    return "My computer";
  }
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

interface HostPairingState {
  identity: PairingIdentity;
  pairing: CreatedPairing;
  session: SessionState;
  deviceName: string;
}

interface JoinPairingState {
  identity: PairingIdentity;
  pairing: JoinedPairing;
  deviceName: string;
  code: string;
}

function Onboarding({ onEnter }: { onEnter: (session: SessionState, deviceName: string) => void }) {
  const [mode, setMode] = useState<"choice" | "join" | "host" | "joining">("choice");
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState(getDeviceName);
  const [hostState, setHostState] = useState<HostPairingState | null>(null);
  const [joinState, setJoinState] = useState<JoinPairingState | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingPairingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const persistDeviceName = () => {
    const clean = deviceName.trim() || "My computer";
    try {
      localStorage.setItem("copypaesto:device-name", clean);
    } catch {
      // Pairing still works when persistent site storage is unavailable.
    }
    return clean;
  };

  const backToChoice = () => {
    setMode("choice");
    setHostState(null);
    setJoinState(null);
    setPendingRequest(null);
    setPairingCode("");
    setError("");
    setBusy(false);
  };

  const startPairing = async () => {
    setBusy(true);
    setError("");
    try {
      const name = persistDeviceName();
      const identity = await createPairingIdentity();
      const pairing = await createPairing(getClientId(), name, identity.publicKey);
      setHostState({
        identity,
        pairing,
        session: {
          code: generateSessionCode(),
          pin: generatePin(),
          createdHere: true,
        },
        deviceName: name,
      });
      setMode("host");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start pairing");
    } finally {
      setBusy(false);
    }
  };

  const requestToJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isValidPairingCode(pairingCode)) {
      setError("Enter the 5-digit code shown on the inviting device.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const name = persistDeviceName();
      const identity = await createPairingIdentity();
      const pairing = await joinPairing(
        pairingCode,
        getClientId(),
        name,
        identity.publicKey,
      );
      setJoinState({ identity, pairing, deviceName: name, code: pairingCode });
      setMode("joining");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request connection");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (mode !== "host" || !hostState) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const requests = await listPairingRequests(
          hostState.pairing.pairingId,
          hostState.pairing.hostToken,
        );
        if (!stopped) {
          setPendingRequest(requests[0] ?? null);
          timer = window.setTimeout(poll, 1_200);
        }
      } catch (cause) {
        if (!stopped) {
          const message = cause instanceof Error ? cause.message : "Pairing stopped";
          if (/expired/i.test(message)) backToChoice();
          setError(message);
          timer = window.setTimeout(poll, 2_500);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [hostState, mode]);

  useEffect(() => {
    if (mode !== "joining" || !joinState) return;
    let stopped = false;
    let completed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await pairingRequestStatus(
          joinState.pairing.pairingId,
          joinState.pairing.requestId,
          joinState.pairing.joinToken,
        );
        if (stopped || completed) return;
        if (result.status === "approved" && result.envelope) {
          completed = true;
          const session = await openPairingSession(
            joinState.identity.keyPair.privateKey,
            joinState.pairing.hostPublicKey,
            joinState.pairing.requestId,
            result.envelope,
          );
          if (!stopped) onEnter({ ...session, createdHere: false }, joinState.deviceName);
          return;
        }
        if (result.status === "rejected") {
          setError("The first computer declined this request.");
          setJoinState(null);
          setMode("join");
          return;
        }
        timer = window.setTimeout(poll, 1_100);
      } catch (cause) {
        if (!stopped) {
          const message = cause instanceof Error ? cause.message : "Pairing stopped";
          setError(message);
          if (/expired|not found/i.test(message)) {
            setJoinState(null);
            setMode("join");
          } else {
            timer = window.setTimeout(poll, 2_500);
          }
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [joinState, mode, onEnter]);

  const approveRequest = async () => {
    if (!hostState || !pendingRequest) return;
    setBusy(true);
    setError("");
    try {
      const envelope = await sealPairingSession(
        hostState.identity.keyPair.privateKey,
        pendingRequest.publicKey,
        pendingRequest.requestId,
        hostState.session,
      );
      await approvePairing(
        hostState.pairing.pairingId,
        pendingRequest.requestId,
        hostState.pairing.hostToken,
        envelope,
      );
      onEnter(hostState.session, hostState.deviceName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this computer");
      setBusy(false);
    }
  };

  const declineRequest = async () => {
    if (!hostState || !pendingRequest) return;
    setBusy(true);
    setError("");
    try {
      await rejectPairing(
        hostState.pairing.pairingId,
        pendingRequest.requestId,
        hostState.pairing.hostToken,
      );
      setPendingRequest(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decline this request");
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async () => {
    if (!hostState) return;
    await copyText(hostState.pairing.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <main className="onboarding">
      <header className="onboarding-header">
        <BrandMark />
        <div className="privacy-note"><LockIcon /> Host approval required</div>
      </header>

      <section className="onboarding-stage">
        <div className="intro-copy">
          <p className="eyebrow">One clipboard · every machine</p>
          <h1>Move thought<br />at typing speed.</h1>
          <p className="intro-body">
            Pair with five digits, approve each device, then type or move files without ceremony.
          </p>
          <div className="connection-sketch" aria-hidden="true">
            <span className="machine-dot"><i /></span>
            <span className="signal-line"><i /></span>
            <span className="machine-dot second"><i /></span>
          </div>
        </div>

        <div className="entry-panel">
          {mode === "choice" && (
            <div className="entry-content enter-animation">
              <span className="step-number">PAIR / 05 DIGITS</span>
              <h2>Connect your devices</h2>
              <p>Start with one short code, then invite more trusted devices from inside the room.</p>

              <label className="field-label" htmlFor="device-name">This computer is called</label>
              <input
                id="device-name"
                className="line-input"
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
                autoComplete="off"
              />

              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-action" disabled={busy} onClick={() => void startPairing()}>
                {busy ? "Creating code…" : "Show pairing code"} <ArrowIcon />
              </button>
              <button className="text-action" onClick={() => { setMode("join"); setError(""); }}>
                Join with a 5-digit code
              </button>
            </div>
          )}

          {mode === "join" && (
            <form className="entry-content enter-animation" onSubmit={requestToJoin}>
              <button className="back-action" type="button" onClick={backToChoice}>← Back</button>
              <span className="step-number">JOINING DEVICE</span>
              <h2>Enter five digits</h2>
              <p>Use the code visible on the first computer. Nothing else to type.</p>

              <label className="field-label" htmlFor="pairing-code">Pairing code</label>
              <input
                id="pairing-code"
                className="line-input pairing-code-input"
                placeholder="00000"
                value={pairingCode}
                onChange={(event) => setPairingCode(normalizePairingCode(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
              />

              <label className="field-label" htmlFor="join-device-name">This computer is called</label>
              <input
                id="join-device-name"
                className="line-input"
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
                autoComplete="off"
              />

              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-action" disabled={busy} type="submit">
                {busy ? "Sending request…" : "Request connection"} <ArrowIcon />
              </button>
            </form>
          )}

          {mode === "host" && hostState && (
            <div className="entry-content enter-animation pairing-stage">
              <button className="back-action" type="button" onClick={backToChoice}>← Cancel</button>
              <span className="step-number">FIRST COMPUTER</span>
              <h2>Type this there</h2>
              <div className="pairing-code-display" aria-label={`Pairing code ${hostState.pairing.code}`}>
                {[...hostState.pairing.code].map((digit, index) => <span key={`${digit}-${index}`}>{digit}</span>)}
              </div>
              <button className="copy-pairing-code" onClick={() => void copyPairingCode()}>
                {copied ? "Copied" : "Copy code"}
              </button>

              {pendingRequest ? (
                <div className="approval-request">
                  <span>CONNECTION REQUEST</span>
                  <strong>{pendingRequest.deviceName}</strong>
                  <p>Approve only if this is the trusted device you are adding.</p>
                  <div>
                    <button disabled={busy} className="approve-button" onClick={() => void approveRequest()}>
                      {busy ? "Approving…" : "Approve"}
                    </button>
                    <button disabled={busy} onClick={() => void declineRequest()}>Not mine</button>
                  </div>
                </div>
              ) : (
                <div className="pairing-wait"><i /><span>Waiting for another device…</span></div>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          )}

          {mode === "joining" && joinState && (
            <div className="entry-content enter-animation pairing-stage">
              <button className="back-action" type="button" onClick={backToChoice}>← Cancel</button>
              <span className="step-number">REQUEST SENT</span>
              <h2>Approve this computer</h2>
              <div className="pairing-code-display compact" aria-label={`Pairing code ${joinState.code}`}>
                {[...joinState.code].map((digit, index) => <span key={`${digit}-${index}`}>{digit}</span>)}
              </div>
              <p>On {joinState.pairing.hostName}, press Approve. This page will connect automatically.</p>
              <div className="pairing-wait"><i /><span>Waiting for approval…</span></div>
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          )}

          <footer className="entry-footer">
            <span>5 digits · explicit approval</span>
            <span>Pairing expires in 10 min</span>
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
    connecting: `Connecting to ${item.peerName}…`,
    offered: `From ${item.peerName} · ready to receive`,
    waiting: `Waiting for ${item.peerName}`,
    transferring: item.direction === "send"
      ? `Sending to ${item.peerName}`
      : `Receiving from ${item.peerName}`,
    paused: `Paused with ${item.peerName}`,
    finishing: `Finishing with ${item.peerName}…`,
    complete: `Complete with ${item.peerName}`,
    declined: item.direction === "send" ? `${item.peerName} declined` : "Declined",
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
  deviceName,
  peers,
  remembered,
  canAddDevice,
  onAddDevice,
  onForget,
  onClose,
}: {
  deviceName: string;
  peers: Peer[];
  remembered: boolean;
  canAddDevice: boolean;
  onAddDevice: () => void;
  onForget: () => void;
  onClose: () => void;
}) {
  const devices = [{ id: "this-device", name: deviceName, current: true }, ...peers.map((peer) => ({
    ...peer,
    current: false,
  }))];
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <section className="session-sheet" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="sheet-close" onClick={onClose} aria-label="Close">×</button>
        <span className="step-number">SECURE SESSION</span>
        <h2>{devices.length} {devices.length === 1 ? "device" : "devices"} in this room</h2>
        <p>Clipboard changes reach every connected device. Send a file to one device or everyone at once.</p>

        <div className="session-device-list" aria-label="Connected devices">
          {devices.map((device) => (
            <div key={device.id}>
              <i />
              <strong>{device.name}</strong>
              <span>{device.current ? "This device" : "Connected"}</span>
            </div>
          ))}
        </div>

        <div className="session-fact">
          <LockIcon />
          <div><strong>Clipboard stays end-to-end encrypted</strong><span>Clipboard content and session controls are encrypted before they reach the relay.</span></div>
        </div>
        <div className="session-fact">
          <span className="session-fact-number">{remembered ? "ON" : "!"}</span>
          <div>
            <strong>{remembered ? "Remembered on this browser" : "Browser memory is unavailable"}</strong>
            <span>{remembered
              ? "Close tabs or restart Chrome and this device reconnects automatically. Leave forgets the room here."
              : "This browser blocked persistent site storage, so keep this tab open or pair again later."}</span>
          </div>
        </div>
        <div className="session-fact">
          <span className="session-fact-number">24h</span>
          <div><strong>Relay state stays temporary</strong><span>Stored clipboard state expires after 24 hours. Browser memory can reconnect to an empty room; it does not preserve old content.</span></div>
        </div>
        <button
          className="add-device-sheet-button"
          disabled={!canAddDevice}
          onClick={onAddDevice}
        >
          {canAddDevice ? "+ Add another device" : "Room is full"}
        </button>
        <button className="forget-session-button" onClick={onForget}>Leave &amp; forget this room</button>
        <div className="security-caption">Up to eight devices can join. Open a fresh five-digit invitation whenever you want to add one, and approve every requester separately.</div>
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
  const route = item.relayProtection === "transport"
    ? "Turbo relay"
    : item.relayProtection === "e2e"
      ? "Encrypted relay"
      : "Direct";
  return (
    <div className={`transfer-row transfer-${item.status}`}>
      <div className="file-glyph"><FileIcon /></div>
      <div className="transfer-info">
        <strong title={item.name}>{item.name}</strong>
        <span>{transferLabel(item)} · {formatBytes(item.size)} · {route}{item.autoSaved ? " · Auto-save" : ""}</span>
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

function Workspace({ session, deviceName, remembered, onLeave }: {
  session: SessionState;
  deviceName: string;
  remembered: boolean;
  onLeave: () => void;
}) {
  const clientId = useMemo(getClientId, []);
  const room = useRoom({
    sessionCode: session.code,
    pin: session.pin,
    clientId,
    deviceName,
  });
  const autoSave = useAutoSaveFolder();
  const files = useFileTransfer({
    peers: room.peers,
    turnAccess: room.turnAccess,
    sendSignal: room.sendSignal,
    subscribeToSignals: room.subscribeToSignals,
    sendRelayFile: room.sendRelayFile,
    sendRelayChunk: room.sendRelayChunk,
    subscribeToRelayFiles: room.subscribeToRelayFiles,
    subscribeToRelayChunks: room.subscribeToRelayChunks,
    createAutoSaveTarget: autoSave.ready ? autoSave.createTarget : undefined,
  });
  const [activeSlot, setActiveSlot] = useState(0);
  const [showSession, setShowSession] = useState(false);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [recipientTarget, setRecipientTarget] = useState<"all" | string>("all");
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = room.slots[activeSlot];
  const selectedPeers = recipientTarget === "all"
    ? room.peers
    : room.peers.filter((peer) => peer.id === recipientTarget);
  const recipientSummary = recipientTarget === "all"
    ? room.peers.length === 1
      ? room.peers[0]?.name ?? "another device"
      : `${room.peers.length} connected devices`
    : selectedPeers[0]?.name ?? "another device";
  const canAddDevice = room.peers.length < 7;

  useEffect(() => {
    if (recipientTarget !== "all" && !room.peers.some((peer) => peer.id === recipientTarget)) {
      setRecipientTarget("all");
    }
  }, [recipientTarget, room.peers]);

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
    if (selected.length && selectedPeers.length) {
      void Promise.all(selectedPeers.map((peer) => files.sendFiles(selected, peer.id, "transport")));
    } else if (selected.length) {
      files.setNotice("Choose a connected device before sending a file.");
    }
  };

  const chooseFiles = () => {
    if (!room.peers.length) {
      files.setNotice("Connect another device before choosing a file.");
      return;
    }
    fileInput.current?.click();
  };

  if (room.status === "denied") {
    return (
      <main className="session-denied">
        <BrandMark />
        <div><LockIcon /></div>
        <h1>This secure room could not be opened.</h1>
        <p>No clipboard text or device information was shared.</p>
        <button className="primary-action" onClick={onLeave}>Forget and pair again <ArrowIcon /></button>
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
          <button
            className="add-device-button"
            disabled={!canAddDevice}
            onClick={() => setShowAddDevice(true)}
          >+ Device</button>
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
              {active.author ? `Last edited by ${active.author}` : "Ready on connected devices"}
            </div>
          </div>

          <textarea
            aria-label={`Clipboard slot ${activeSlot + 1}`}
            className="clipboard-editor"
            placeholder="Type or paste here. It appears on your other devices as you work…"
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
            <span className="route-label">Direct first · Turbo fallback</span>
          </div>

          <div className="file-routing-controls">
            <div className="recipient-picker">
              <span>SEND TO</span>
              <div role="radiogroup" aria-label="File recipients">
                {room.peers.length > 1 && (
                  <button
                    className={`all-devices ${recipientTarget === "all" ? "selected" : ""}`}
                    role="radio"
                    aria-checked={recipientTarget === "all"}
                    onClick={() => setRecipientTarget("all")}
                  >
                    <i />All devices ({room.peers.length})
                  </button>
                )}
                {room.peers.length ? room.peers.map((peer) => (
                  <button
                    key={peer.id}
                    className={recipientTarget === peer.id || (recipientTarget === "all" && room.peers.length === 1) ? "selected" : ""}
                    role="radio"
                    aria-checked={recipientTarget === peer.id || (recipientTarget === "all" && room.peers.length === 1)}
                    onClick={() => setRecipientTarget(peer.id)}
                  >
                    <i />{peer.name}
                  </button>
                )) : <em>No other devices connected</em>}
              </div>
            </div>

            <div className="relay-mode is-turbo">
              <div className="relay-mode-heading">
                <span>TURBO FALLBACK</span>
                <strong>AUTOMATIC</strong>
              </div>
              <small>When direct is blocked, bulk file bytes use TLS for speed. Cloudflare or a work TLS proxy could inspect them.</small>
            </div>
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
            <small>{selectedPeers.length ? `Send to ${recipientSummary}` : "Waiting for another device"}</small>
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

          <div className={`auto-save-control ${autoSave.ready ? "is-enabled" : ""}`}>
            <div>
              <span>TRUSTED AUTO-SAVE</span>
              <strong>{autoSave.ready ? `Saving to ${autoSave.folderName}` : "Manual approval is on"}</strong>
              <small>{!autoSave.supported
                ? "Automatic disk saving needs Chrome or Edge."
                : autoSave.ready
                  ? "Incoming files start immediately; existing files are never overwritten."
                  : autoSave.enabled
                    ? "Reconnect folder permission to resume automatic saving."
                    : "Choose a folder once to receive trusted files without clicking Save."}</small>
              {autoSave.ready && (
                <button className="auto-save-change" onClick={() => void autoSave.chooseFolder()}>
                  Change folder
                </button>
              )}
            </div>
            <button
              disabled={!autoSave.supported || autoSave.busy}
              aria-pressed={autoSave.ready}
              onClick={() => autoSave.ready ? autoSave.disable() : void autoSave.enable()}
            >
              {autoSave.busy ? "Opening…" : autoSave.ready ? "Turn off" : autoSave.folderName ? "Turn on" : "Choose folder"}
            </button>
          </div>
          {autoSave.error && <div className="auto-save-error">{autoSave.error}</div>}

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

      {showSession && (
        <SessionSheet
          deviceName={deviceName}
          peers={room.peers}
          remembered={remembered}
          canAddDevice={canAddDevice}
          onAddDevice={() => {
            setShowSession(false);
            setShowAddDevice(true);
          }}
          onForget={onLeave}
          onClose={() => setShowSession(false)}
        />
      )}
      {showAddDevice && canAddDevice && (
        <AddDeviceSheet
          clientId={clientId}
          deviceName={deviceName}
          session={session}
          onClose={() => setShowAddDevice(false)}
        />
      )}
    </main>
  );
}

export default function App() {
  const [restoredSession] = useState(readRememberedSession);
  const [session, setSession] = useState<SessionState | null>(() => restoredSession?.session ?? null);
  const [deviceName, setDeviceName] = useState(() => restoredSession?.deviceName ?? getDeviceName());
  const [remembered, setRemembered] = useState(() => Boolean(restoredSession));

  const enter = (next: SessionState, name: string) => {
    setDeviceName(name);
    setRemembered(rememberSession(next, name));
    setSession(next);
  };

  const leave = () => {
    const confirmed = window.confirm(
      "Leave and forget this room on this browser? You will need a new five-digit invitation to reconnect.",
    );
    if (!confirmed) return;
    forgetRememberedSession();
    setRemembered(false);
    setSession(null);
  };

  return session
    ? <Workspace
        key={`${session.code}:${session.pin}`}
        session={session}
        deviceName={deviceName}
        remembered={remembered}
        onLeave={leave}
      />
    : <Onboarding onEnter={enter} />;
}
