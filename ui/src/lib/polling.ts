import { useMemo, useRef } from "react";
import { getPageVisibility, usePageVisibility, type PageVisibility } from "./page-visibility";

/**
 * Polling-cadence and startup-jitter helpers for restore-storm mitigation
 * (PAP-12556 / Phase 1). See PAP-12552 UX guidance §2/§6.
 *
 * Goals:
 *   - Visible+focused tabs poll at their normal cadence (active-tab exemption).
 *   - Merely-visible-but-unfocused tabs may poll a little slower.
 *   - Hidden tabs poll slowly or not at all.
 *   - Restored tabs add a small, bounded, randomized jitter so a whole restored
 *     window doesn't fire every poller on the same millisecond.
 *
 * Jitter is a herd-breaking tool, not a user-facing delay: content is already on
 * screen from cache (stale-while-revalidate), so jitter never gates first paint.
 */

/** Default bound for jitter added to a focused tab's first poll (ms). */
export const FOCUSED_JITTER_MAX_MS = 250;
/** Default bound for jitter added on background / restored tabs (ms). */
export const BACKGROUND_JITTER_MAX_MS = 3_000;

export interface PollingIntervalOptions {
  /** Interval when the tab is visible AND focused. Required. */
  visibleMs: number;
  /**
   * Interval when visible but not focused. Defaults to `visibleMs`
   * (keep near-normal cadence for on-screen tabs).
   */
  unfocusedMs?: number;
  /**
   * Interval when hidden. `false` (default) stops polling entirely while hidden;
   * react-query also pauses interval timers for hidden tabs, so this is defence in depth.
   */
  hiddenMs?: number | false;
}

/**
 * Pure resolver: given a visibility state and cadence options, return the react-query
 * `refetchInterval` value (`number` to poll, `false` to pause).
 */
export function resolvePollingInterval(
  state: PageVisibility,
  options: PollingIntervalOptions,
): number | false {
  if (!state.visible) return options.hiddenMs ?? false;
  if (state.focused) return options.visibleMs;
  return options.unfocusedMs ?? options.visibleMs;
}

/**
 * Pure jitter calculator. `rng` returns a float in [0, 1) (injectable for tests).
 * Result is clamped to `[0, maxMs]` and rounded to an integer number of ms.
 */
export function computeStartupJitterMs(maxMs: number, rng: () => number): number {
  if (maxMs <= 0) return 0;
  const clamped = Math.min(Math.max(rng(), 0), 0.999999);
  return Math.round(clamped * maxMs);
}

/**
 * Pick the appropriate jitter bound for the current visibility: small for a focused
 * tab (don't make active use feel laggy), wider for background/restored tabs.
 */
export function jitterBoundForVisibility(
  state: PageVisibility,
  opts?: { focusedMaxMs?: number; backgroundMaxMs?: number },
): number {
  const focusedMax = opts?.focusedMaxMs ?? FOCUSED_JITTER_MAX_MS;
  const backgroundMax = opts?.backgroundMaxMs ?? BACKGROUND_JITTER_MAX_MS;
  return state.focused ? focusedMax : backgroundMax;
}

export interface VisibilityRefetchOptions extends PollingIntervalOptions {
  /**
   * Add a small, stable, per-mount jitter to the active interval so a window full of
   * restored tabs doesn't fire the same poller on the same millisecond. Defaults to
   * true. The jitter is computed once at mount (so react-query is not rescheduled on
   * every render) and is bounded to `min(jitterMaxMs, visibleMs * 0.2)`.
   */
  jitter?: boolean;
  /** Upper bound for the polling jitter (ms). Default 1000. */
  jitterMaxMs?: number;
}

/**
 * React hook: a visibility-aware `refetchInterval` value for react-query.
 * Re-renders (and thus reschedules the query) when visibility/focus changes, but the
 * de-phasing jitter is fixed per mount so the scheduler is not thrashed.
 *
 * Usage:
 *   const refetchInterval = useVisibilityRefetchInterval({ visibleMs: 5000 });
 *   useQuery({ ..., refetchInterval });
 */
export function useVisibilityRefetchInterval(options: VisibilityRefetchOptions): number | false {
  const state = usePageVisibility();
  const jitterRef = useRef<number | null>(null);
  if (jitterRef.current === null) {
    if (options.jitter === false) {
      jitterRef.current = 0;
    } else {
      const bound = Math.min(options.jitterMaxMs ?? 1_000, Math.round(options.visibleMs * 0.2));
      jitterRef.current = computeStartupJitterMs(bound, Math.random);
    }
  }
  const jitter = jitterRef.current;
  return useMemo(() => {
    const base = resolvePollingInterval(state, options);
    return base === false ? false : base + jitter;
    // Options are typically inline literals; depend on their primitive fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, options.visibleMs, options.unfocusedMs, options.hiddenMs, jitter]);
}

/**
 * React hook returning a stable, bounded startup-jitter delay (ms), computed once
 * per mount from the visibility state at mount time. Use to stagger a non-critical
 * refresh after restore, e.g. gate an `enabled` flag or delay an initial refetch.
 *
 * The value is memoised so it does not change on every render (which would defeat
 * the purpose and thrash timers).
 */
export function useStartupJitterMs(opts?: {
  focusedMaxMs?: number;
  backgroundMaxMs?: number;
}): number {
  const ref = useRef<number | null>(null);
  if (ref.current === null) {
    const state = getPageVisibility();
    const bound = jitterBoundForVisibility(state, opts);
    ref.current = computeStartupJitterMs(bound, Math.random);
  }
  return ref.current;
}
