import { useEffect, useRef, useState } from "react";
import type { BridgeSessionPayload } from "../../ipc/bridgeChannels";
import { useBridgeLiveEvents } from "../../ipc/bridgeChannels";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import { BridgeSessionDetailPanel } from "./BridgeSessionDetailPanel";

/**
 * BridgeSessionBadge — ADR-0005 §8 / CLI-142
 *
 * Status-strip badge showing the active bridge session. Feature-flag gated on
 * `bridge.session_indicator.v1`. Absent from the DOM entirely when no session
 * is active (idle).
 *
 * State machine (kind):
 *   idle      — no active session (badge not rendered)
 *   active    — session has > 60s remaining
 *   amber     — session has ≤ 60s remaining; shows mm:ss countdown
 *   expired   — session exp ≤ now; shows "expired — reconnect"
 *   deny-flash — one or more bridge-deny events in flight (3s each, non-coalesced)
 *
 * The `deny-flash` state overlays any of active/amber/expired and returns to the
 * underlying state once all deny timers drain. Each deny event creates its own
 * independent 3000ms timer so overlapping events are handled correctly.
 */

type BaseKind = "idle" | "active" | "amber" | "expired";
type Kind = BaseKind | "deny-flash";

function computeBaseKind(payload: NonNullable<BridgeSessionPayload>): BaseKind {
  const remaining = payload.exp - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining <= 60_000) return "amber";
  return "active";
}

function formatCountdown(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function BridgeSessionBadge() {
  const enabled = useFeatureFlag("bridge.session_indicator.v1");
  const { onSessionState, onDenyFlash } = useBridgeLiveEvents();

  const [session, setSession] = useState<BridgeSessionPayload>(null);
  const [baseKind, setBaseKind] = useState<BaseKind>("idle");
  const [denyCount, setDenyCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  const sessionRef = useRef<BridgeSessionPayload>(null);
  const denyCountRef = useRef(0);
  const liveRegionRef = useRef<HTMLDivElement | null>(null);
  const announcementSerialRef = useRef(0);

  // Subscribe to bridge session state events
  useEffect(() => {
    return onSessionState((payload) => {
      sessionRef.current = payload;
      setSession(payload);
      if (payload === null) {
        setBaseKind("idle");
      } else {
        setBaseKind(computeBaseKind(payload));
      }
    });
  }, [onSessionState]);

  // Subscribe to deny-flash events — each event is independent (non-coalesced).
  // ARIA announcement is appended directly to the DOM as a new child node so
  // each event creates a synchronously-visible childList mutation that
  // MutationObserver records reliably (independent of React's commit timing).
  useEffect(() => {
    return onDenyFlash(() => {
      denyCountRef.current += 1;
      setDenyCount((c) => c + 1);

      const region = liveRegionRef.current;
      if (region) {
        announcementSerialRef.current += 1;
        const serial = announcementSerialRef.current;
        const node = region.ownerDocument.createElement("span");
        node.textContent = `Bridge session deny event ${serial}`;
        region.appendChild(node);
      }

      setTimeout(() => {
        denyCountRef.current -= 1;
        setDenyCount((count) => Math.max(0, count - 1));
      }, 3_000);
    });
  }, [onDenyFlash]);

  // Periodic tick to catch wall-clock transitions (active→amber, amber→expired)
  // without needing a new server message.
  useEffect(() => {
    const interval = setInterval(() => {
      const s = sessionRef.current;
      if (s !== null) {
        setBaseKind(computeBaseKind(s));
      }
    }, 250);
    return () => clearInterval(interval);
  }, []);

  if (!enabled) return null;

  const kind: Kind = denyCount > 0 ? "deny-flash" : baseKind;
  const isIdle = kind === "idle";

  const capCount = session?.capabilityCount ?? 0;
  const displayCount = capCount > 99 ? "99+" : String(capCount);
  const shortId = session?.jti ? `cap-${session.jti.substring(0, 4)}` : "";
  const remaining = session?.exp != null ? session.exp - Date.now() : 0;

  return (
    <>
      {/* ARIA live region — always present so screen readers are wired up.
          Deny events directly append child <span> nodes via a ref so each
          event triggers a discrete childList mutation (synchronously visible
          to MutationObserver, independent of React commit timing). */}
      <div
        ref={liveRegionRef}
        role="status"
        aria-live="assertive"
        style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}
      />

      {!isIdle && (
        <button
          data-testid="bridge-session-badge"
          data-state={kind}
          tabIndex={0}
          onClick={() => setPanelOpen(true)}
        >
          <span>Bridge</span>
          {shortId && <span>{shortId}</span>}
          <span>{displayCount}</span>
          {kind === "amber" && <span>{formatCountdown(remaining)}</span>}
          {kind === "expired" && <span>expired — reconnect</span>}
        </button>
      )}

      {panelOpen && session != null && (
        <BridgeSessionDetailPanel session={session} onClose={() => setPanelOpen(false)} />
      )}
    </>
  );
}
