/**
 * Heartbeat-side run-loop detector.
 *
 * Groups recent runs for an agent by (issueId, wakeReason) and returns a
 * signal when any group exceeds `threshold` runs inside the rolling window.
 *
 * Emits a heartbeat.run_loop_suspected live event; does NOT pause the agent
 * or block dispatch. Policy decisions (auto-pause, cooldown) are intentionally
 * left to follow-up PRs.
 *
 * Tracking issue: paperclipai/paperclip#5713
 */

export const LOOP_DETECTOR_THRESHOLD = clampPositiveInt(
  process.env.PAPERCLIP_LOOP_DETECTOR_THRESHOLD,
  5,
);
export const LOOP_DETECTOR_WINDOW_SEC = clampPositiveInt(
  process.env.PAPERCLIP_LOOP_DETECTOR_WINDOW_SEC,
  1800,
);

/**
 * How many recent runs the queue should fetch to feed the detector.
 *
 * A loop can only be flagged if enough of its runs are actually fetched, so the
 * limit must cover at least `threshold` runs. Historically this was a flat 50;
 * a `PAPERCLIP_LOOP_DETECTOR_THRESHOLD` above 50 then silently disabled
 * detection because the query could never return enough rows to reach the
 * threshold. Taking the max keeps the 50-row floor (and its grouping headroom)
 * for the common low thresholds while scaling up for higher ones.
 */
export const LOOP_DETECTOR_RUN_FETCH_LIMIT = Math.max(50, LOOP_DETECTOR_THRESHOLD);

export interface DetectRunLoopRecentRun {
  id: string;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
}

export interface DetectRunLoopInput {
  agentId: string;
  recentRuns: ReadonlyArray<DetectRunLoopRecentRun>;
  now: Date;
  threshold?: number;
  windowSec?: number;
}

export interface RunLoopSignal {
  agentId: string;
  issueId: string | null;
  wakeReason: string | null;
  recentRunIds: string[];
  windowSec: number;
  count: number;
  threshold: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Pure function. Returns every (issueId, wakeReason) group that reached the
 * threshold inside the window, sorted worst-first.
 *
 * "Worst" = highest run count; ties broken by earliest firstAt (longest-running
 * loop wins). A run with no issueId AND no wakeReason is ignored — those are
 * usually one-off bootstraps, not loops.
 *
 * Returning all qualifying groups (not just the single worst) lets the caller
 * skip a group that is on cooldown without hiding a distinct, still-active loop
 * on another issue.
 */
export function detectRunLoops(input: DetectRunLoopInput): RunLoopSignal[] {
  const threshold = input.threshold ?? LOOP_DETECTOR_THRESHOLD;
  const windowSec = input.windowSec ?? LOOP_DETECTOR_WINDOW_SEC;
  if (threshold <= 0 || windowSec <= 0) return [];

  const windowStartMs = input.now.getTime() - windowSec * 1000;
  const groups = new Map<string, {
    issueId: string | null;
    wakeReason: string | null;
    runs: DetectRunLoopRecentRun[];
  }>();

  for (const run of input.recentRuns) {
    if (run.createdAt.getTime() < windowStartMs) continue;
    const ctx = run.contextSnapshot ?? {};
    const issueId = readString(ctx["issueId"]);
    const wakeReason = readString(ctx["wakeReason"]);
    if (issueId === null && wakeReason === null) continue;

    const key = `${issueId ?? ""}\u0000${wakeReason ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.runs.push(run);
    } else {
      groups.set(key, { issueId, wakeReason, runs: [run] });
    }
  }

  const signals: RunLoopSignal[] = [];
  for (const bucket of groups.values()) {
    if (bucket.runs.length < threshold) continue;
    const sorted = [...bucket.runs].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    signals.push({
      agentId: input.agentId,
      issueId: bucket.issueId,
      wakeReason: bucket.wakeReason,
      recentRunIds: sorted.map((r) => r.id),
      windowSec,
      count: sorted.length,
      threshold,
      firstAt: sorted[0].createdAt.toISOString(),
      lastAt: sorted[sorted.length - 1].createdAt.toISOString(),
    });
  }
  // Worst first: highest count, then earliest firstAt (ISO strings compare
  // chronologically). firstAt is unique enough in practice; a stable tiebreak
  // is not required.
  signals.sort(
    (a, b) => b.count - a.count || (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0),
  );
  return signals;
}

/**
 * Pure function. Returns the single worst loop signal found, or null. Thin
 * wrapper over {@link detectRunLoops} for callers that only surface one loop.
 */
export function detectRunLoop(input: DetectRunLoopInput): RunLoopSignal | null {
  return detectRunLoops(input)[0] ?? null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
