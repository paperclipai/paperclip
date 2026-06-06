// Tracks whether the live-events WebSocket (/api/companies/{id}/events/ws) can be
// established in this environment. On the serverless control plane (Vercel) the upgrade
// always 404s, AND the in-process event bus lives in the worker, so the socket is doubly
// unusable there. Without a SHARED signal, each live component (LiveUpdatesProvider,
// useLiveRunTranscripts, AgentDetail) re-attempts the socket every time it remounts —
// and the transcript hooks remount on every ~2s live-runs poll, re-storming /events/ws.
//
// Once any hook detects the socket can't connect, we flip this session-wide flag so all
// hooks skip the socket and rely on polling/fetch. A successful open clears it (so true
// realtime is preserved on worker/self-hosted deployments). Persisted in sessionStorage
// so a reload in the same tab doesn't re-run the detection storm.

const STORAGE_KEY = "valadrien-os:live-socket-unavailable";

let unavailable = false;
try {
  unavailable = typeof sessionStorage !== "undefined" && sessionStorage.getItem(STORAGE_KEY) === "1";
} catch {
  // sessionStorage can throw (private mode / disabled) — fall back to in-memory only.
}

export function isLiveSocketDisabled(): boolean {
  return unavailable;
}

export function markLiveSocketUnavailable(): void {
  if (unavailable) return;
  unavailable = true;
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // ignore
  }
}

export function markLiveSocketAvailable(): void {
  if (!unavailable) return;
  unavailable = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
