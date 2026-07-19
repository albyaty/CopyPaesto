import { useEffect, useRef, useState } from "react";
import {
  approvePairing,
  createPairing,
  createPairingIdentity,
  listPairingRequests,
  rejectPairing,
  sealPairingSession,
  type CreatedPairing,
  type PairingIdentity,
  type PendingPairingRequest,
} from "../lib/pairing";

interface AddDeviceSheetProps {
  clientId: string;
  deviceName: string;
  session: { code: string; pin: string };
  onClose: () => void;
}

interface InvitationState {
  identity: PairingIdentity;
  pairing: CreatedPairing;
}

export function AddDeviceSheet({
  clientId,
  deviceName,
  session,
  onClose,
}: AddDeviceSheetProps) {
  const [invitation, setInvitation] = useState<InvitationState | null>(null);
  const [pending, setPending] = useState<PendingPairingRequest | null>(null);
  const [approvedName, setApprovedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void (async () => {
        try {
          const identity = await createPairingIdentity();
          const pairing = await createPairing(clientId, deviceName, identity.publicKey);
          if (activeRef.current) setInvitation({ identity, pairing });
        } catch (cause) {
          if (activeRef.current) {
            setError(cause instanceof Error ? cause.message : "Could not create an invitation");
          }
        }
      })();
    }
    return () => {
      activeRef.current = false;
    };
  }, [clientId, deviceName]);

  useEffect(() => {
    if (!invitation) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const requests = await listPairingRequests(
          invitation.pairing.pairingId,
          invitation.pairing.hostToken,
        );
        if (stopped) return;
        setPending(requests[0] ?? null);
        if (requests[0]) setApprovedName("");
        timer = window.setTimeout(poll, 1_100);
      } catch (cause) {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "Invitation stopped");
        timer = window.setTimeout(poll, 2_500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [invitation]);

  const copyCode = async () => {
    if (!invitation) return;
    await navigator.clipboard.writeText(invitation.pairing.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  const approve = async () => {
    if (!invitation || !pending) return;
    setBusy(true);
    setError("");
    try {
      const envelope = await sealPairingSession(
        invitation.identity.keyPair.privateKey,
        pending.publicKey,
        pending.requestId,
        session,
      );
      await approvePairing(
        invitation.pairing.pairingId,
        pending.requestId,
        invitation.pairing.hostToken,
        envelope,
      );
      setApprovedName(pending.deviceName);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this device");
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!invitation || !pending) return;
    setBusy(true);
    setError("");
    try {
      await rejectPairing(
        invitation.pairing.pairingId,
        pending.requestId,
        invitation.pairing.hostToken,
      );
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decline this device");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <section
        className="session-sheet add-device-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        aria-modal="true"
        role="dialog"
        aria-label="Add another device"
      >
        <button className="sheet-close" onClick={onClose} aria-label="Close">×</button>
        <span className="step-number">ADD A DEVICE</span>
        <h2>Bring another device in</h2>
        <p>Open CopyPaesto there, choose “Join with a 5-digit code,” then approve its name here.</p>

        {!invitation && !error && (
          <div className="pairing-wait invite-loading"><i /><span>Creating a fresh invitation…</span></div>
        )}

        {invitation && (
          <>
            <div className="pairing-code-display invite-code" aria-label={`Pairing code ${invitation.pairing.code}`}>
              {[...invitation.pairing.code].map((digit, index) => (
                <span key={`${digit}-${index}`}>{digit}</span>
              ))}
            </div>
            <button className="copy-pairing-code" onClick={() => void copyCode()}>
              {copied ? "Copied" : "Copy code"}
            </button>

            {pending ? (
              <div className="approval-request invite-approval">
                <span>DEVICE REQUEST</span>
                <strong>{pending.deviceName}</strong>
                <p>Approve only if this is the device you are adding.</p>
                <div>
                  <button disabled={busy} className="approve-button" onClick={() => void approve()}>
                    {busy ? "Approving…" : "Approve"}
                  </button>
                  <button disabled={busy} onClick={() => void decline()}>Not mine</button>
                </div>
              </div>
            ) : approvedName ? (
              <div className="invite-approved">
                <i>✓</i><div><strong>{approvedName} approved</strong><span>It will appear here as soon as it connects.</span></div>
              </div>
            ) : (
              <div className="pairing-wait"><i /><span>Waiting for another device…</span></div>
            )}
          </>
        )}

        {error && <p className="form-error invite-error" role="alert">{error}</p>}
        <div className="security-caption">The code expires after 10 minutes. Every new device requires a separate approval.</div>
      </section>
    </div>
  );
}
