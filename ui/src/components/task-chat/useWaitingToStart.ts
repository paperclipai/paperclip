import { useEffect, useReducer } from "react";

/**
 * How long a queued turn keeps the startup feedback ("Working" / "Thinking")
 * before it says it is waiting. DESIGN.md keeps that feedback from message
 * submission through admission so a normal start does not flicker. Admission
 * normally claims a run within a few seconds; a run still queued after 30 s
 * with no named hold is not starting, and saying "Working" would be untrue.
 */
export const QUEUED_START_GRACE_MS = 30_000;
export const WAITING_TO_START_LABEL = "Waiting to start";

/**
 * True once an eligible queued turn has waited past the grace period since
 * `sinceMs`. One timer at the threshold; no per-second ticking.
 */
export function useWaitingToStart(eligible: boolean, sinceMs: number | null): boolean {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const remainingMs = eligible && sinceMs != null ? QUEUED_START_GRACE_MS - (Date.now() - sinceMs) : null;
  const pending = remainingMs != null && remainingMs > 0;
  useEffect(() => {
    if (!eligible || sinceMs == null) return;
    const delay = QUEUED_START_GRACE_MS - (Date.now() - sinceMs);
    if (delay <= 0) return;
    const timer = setTimeout(rerender, delay + 50);
    return () => clearTimeout(timer);
  }, [eligible, sinceMs, pending]);
  return remainingMs != null && remainingMs <= 0;
}
