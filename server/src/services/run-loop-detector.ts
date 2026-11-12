/**
 * Heartbeat-side run-loop detector.
 *
 * Groups recent runs for an agent by (scopeKind, issueId, wakeReason) and
 * returns a signal when any group exceeds `threshold` runs inside the rolling
 * window.
 *
 * `scopeKind` and `issueId` are the run's SAVED read boundary (the persisted
 * heartbeat_runs columns), never `contextSnapshot.issueId`. Cross-task wake
 * coalescing rewrites the snapshot's issueId in place without touching the
 * saved binding, so grouping on the snapshot would attribute a run — and its
 * id, counts and timestamps — to a different private issue than the one it is
 * actually bound to, leaking those details to viewers of the replacement
 * issue. Using the saved boundary keeps every run (and the signal that carries
 * it) inside its own read scope.
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
 * Safety ceiling on how many recent runs the queue fetches to feed the
 * detector. The fetch is bounded by the rolling window (createdAt > windowStart)
 * so that counts are established over the WHOLE window, not a recency-ordered
 * prefix of it.
 *
 * An earlier design capped the fetch at `max(50, threshold)` rows ordered by
 * createdAt desc. Because that cap was applied globally across every group
 * before grouping, unrelated newer runs could push a qualifying loop's own runs
 * out of the fetched prefix: at threshold 51 the cap was exactly 51, so a single
 * unrelated newer run left only 50 runs from the looping group and the loop went
 * unreported. Counting over the full window removes that interleaving blind
 * spot.
 *
 * This ceiling only guards against pathological single-agent volume inside one
 * window (it never realistically binds — even a tight loop produces far fewer
 * runs per window than this). It is kept at or above the threshold so a high
 * `PAPERCLIP_LOOP_DETECTOR_THRESHOLD` can never make the ceiling itself drop
 * below the number of rows a single loop needs.
 */
export const LOOP_DETECTOR_MAX_WINDOW_RUNS = Math.max(5000, LOOP_DETECTOR_THRESHOLD);

export interface DetectRunLoopRecentRun {
  id: string;
  /** Saved read boundary of the run; never derived from contextSnapshot. */
  scopeKind: "company" | "issue";
  /** Saved issue binding (null for company-scoped runs); never the snapshot. */
  issueId: string | null;
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
  /** Read boundary the signal must be delivered within (saved, not snapshot). */
  scopeKind: "company" | "issue";
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
 * Pure function. Returns every (scopeKind, issueId, wakeReason) group that
 * reached the threshold inside the window, sorted worst-first.
 *
 * Grouping uses the run's SAVED read boundary (scopeKind, issueId), so a group
 * — and the signal built from it — only ever contains runs that share one read
 * scope. `wakeReason` (a non-private loop dimension) is still read from the
 * context snapshot.
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
    scopeKind: "company" | "issue";
    issueId: string | null;
    wakeReason: string | null;
    runs: DetectRunLoopRecentRun[];
  }>();

  for (const run of input.recentRuns) {
    if (run.createdAt.getTime() < windowStartMs) continue;
    const ctx = run.contextSnapshot ?? {};
    const wakeReason = readString(ctx["wakeReason"]);
    // Read boundary comes only from the saved columns. Company-scoped runs have
    // no issue binding; force issueId null so a stale snapshot issueId can never
    // widen their scope.
    const scopeKind = run.scopeKind;
    const issueId = scopeKind === "issue" ? readString(run.issueId) : null;
    if (issueId === null && wakeReason === null) continue;

    const key = `${scopeKind}\u0000${issueId ?? ""}\u0000${wakeReason ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.runs.push(run);
    } else {
      groups.set(key, { scopeKind, issueId, wakeReason, runs: [run] });
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
      scopeKind: bucket.scopeKind,
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
