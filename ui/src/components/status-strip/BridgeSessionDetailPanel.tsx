import { useState } from "react";
import type React from "react";
import type { BridgeSessionPayload } from "../../ipc/bridgeChannels";
import { bridgeApi } from "../../api/bridge";

interface Props {
  session: NonNullable<BridgeSessionPayload>;
  onClose: () => void;
}

/**
 * BridgeSessionDetailPanel — ADR-0005 §8 / CLI-142
 *
 * Shows active bridge session details and allows the user to revoke the session.
 */
export function BridgeSessionDetailPanel({ session, onClose }: Props) {
  const shortId = `cap-${session.jti.substring(0, 4)}`;
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function handleConfirmRevoke() {
    setRevoking(true);
    const result = await bridgeApi.revokeBridgeSession(session.jti);
    setRevoking(false);
    if (result.ok) {
      onClose();
    } else {
      // Rollback: stay open so user sees the session wasn't revoked
      setConfirming(false);
    }
  }

  return (
    <div data-testid="bridge-session-detail-panel">
      <button onClick={onClose} aria-label="Close bridge session panel">×</button>
      <h2>Bridge Session</h2>
      <p>{shortId}</p>
      <ul>
        {session.capabilities.map((cap, i) => (
          <li key={i}>
            <span>{cap.source}</span>
            <span>{cap.scope}</span>
          </li>
        ))}
      </ul>
      <button data-testid="bridge-session-revoke-btn" onClick={() => setConfirming(true)}>
        Revoke session
      </button>
      {confirming && (
        <div data-testid="bridge-session-revoke-confirm">
          <p>Revoke this bridge session? This cannot be undone.</p>
          <button data-testid="confirm-btn" onClick={handleConfirmRevoke} disabled={revoking}>
            {revoking ? "Revoking…" : "Confirm revoke"}
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
