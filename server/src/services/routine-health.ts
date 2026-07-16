/**
 * Routine schedule health rollup.
 *
 * Derives one clear result per scheduled day from the routine's cron triggers and
 * its recorded runs, so operators can distinguish:
 *
 *   - `done`            — the scheduled fire produced an execution issue that reached `done`
 *   - `running`         — the execution issue exists and is still progressing
 *   - `pending`         — the tick is within the dispatch grace window (or run still `received`)
 *   - `blocked`         — the execution issue is currently blocked
 *   - `cancelled`       — the execution issue was cancelled
 *   - `failed`          — dispatch or execution failed outright
 *   - `skipped_active`  — intentional concurrency skip (`skip_if_active`) because a live issue existed
 *   - `coalesced`       — folded into an existing live execution issue
 *   - `suppressed`      — intentionally not dispatched (project paused, activity gate, worktree cutoff)
 *   - `missed`          — no run row exists for an expected tick: the scheduler was offline or the
 *                         trigger claim failed. This is the scheduler-failure signal that
 *                         `skip_missed` used to swallow silently.
 *
 * Missed ticks are derived by enumerating expected cron fires over the window and
 * matching them against recorded runs, so gaps caused by server downtime are visible
 * even though nothing could write a row at the time.
 */
import { nextCronTickInTimeZone } from "./routines.js";

export type RoutineHealthResult =
  | "done"
  | "running"
  | "pending"
  | "blocked"
  | "cancelled"
  | "failed"
  | "skipped_active"
  | "coalesced"
  | "suppressed"
  | "missed";

/** Suppression markers written by recordSuppressedAutomaticRun into failureReason. */
const SUPPRESSION_REASONS: Record<string, string> = {
  paused: "Suppressed: the routine's project was paused at the scheduled time",
  no_external_activity: "Suppressed: activity gate found no external activity since the last run",
  worktree_execution_cutoff: "Suppressed: worktree execution cutoff was active",
};

/** Ticks younger than this with no run row yet are `pending`, not `missed`. */
const DISPATCH_GRACE_MS = 15 * 60 * 1000;

/** Hard cap on enumerated ticks so sub-hourly crons over long windows stay bounded. */
const MAX_TICKS = 500;

/** Worst-first ordering used to pick the single result for a multi-tick day. */
const SEVERITY: RoutineHealthResult[] = [
  "missed",
  "failed",
  "cancelled",
  "blocked",
  "running",
  "pending",
  "suppressed",
  "skipped_active",
  "coalesced",
  "done",
];

/** Day results that warrant an alert line for the operator. */
const ALERTED_RESULTS = new Set<RoutineHealthResult>(["missed", "failed", "cancelled", "blocked"]);

export interface RoutineHealthLinkedIssue {
  id: string;
  identifier: string | null;
  title: string | null;
  status: string;
  completedAt: Date | null;
}

export interface RoutineHealthRunInput {
  id: string;
  triggerId: string | null;
  source: string;
  status: string;
  triggeredAt: Date;
  failureReason: string | null;
  triggerPayload: Record<string, unknown> | null;
  coalescedIntoRunId: string | null;
  linkedIssue: RoutineHealthLinkedIssue | null;
}

export interface RoutineHealthTriggerInput {
  id: string;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
}

export interface RoutineHealthTick {
  expectedAt: string;
  triggerId: string;
  result: RoutineHealthResult;
  reason: string | null;
  runId: string | null;
  runStatus: string | null;
  linkedIssue: (Omit<RoutineHealthLinkedIssue, "completedAt"> & { completedAt: string | null }) | null;
}

export interface RoutineHealthDay {
  date: string;
  result: RoutineHealthResult;
  reason: string | null;
  ticks: RoutineHealthTick[];
}

export interface RoutineHealthReport {
  routineId: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  requestedDays: number;
  timezone: string | null;
  scheduleTriggerCount: number;
  enabledScheduleTriggerCount: number;
  tickLimitExceeded: boolean;
  dailyResults: RoutineHealthDay[];
  unscheduledRunCount: number;
  alerts: string[];
  summary: Partial<Record<RoutineHealthResult, number>>;
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatDayInTimeZone(date: Date, timeZone: string): string {
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    // en-CA renders as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter.format(date);
}

function transientFailureReason(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload !== "object") return null;
  const transient = (payload as { transientFailure?: unknown }).transientFailure;
  if (!transient || typeof transient !== "object") return null;
  const reason = (transient as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

function classifyRun(run: RoutineHealthRunInput): { result: RoutineHealthResult; reason: string | null } {
  const issueStatus = run.linkedIssue?.status ?? null;
  switch (run.status) {
    case "completed": {
      // failureReason on a completed run is legacy transient-block residue; the
      // write path now stores it as triggerPayload.transientFailure instead.
      const transient = transientFailureReason(run.triggerPayload) ?? run.failureReason;
      return {
        result: "done",
        reason: transient ? `Recovered after a transient failure: ${transient}` : null,
      };
    }
    case "issue_created": {
      if (issueStatus === "done") return { result: "done", reason: null };
      if (issueStatus === "blocked") {
        return { result: "blocked", reason: "Execution issue is currently blocked" };
      }
      if (issueStatus === "cancelled") {
        return { result: "cancelled", reason: "Execution issue was cancelled" };
      }
      return {
        result: "running",
        reason: issueStatus ? `Execution issue is ${issueStatus}` : "Execution issue is still open",
      };
    }
    case "skipped": {
      const suppression = run.failureReason ? SUPPRESSION_REASONS[run.failureReason] : undefined;
      if (suppression) return { result: "suppressed", reason: suppression };
      return {
        result: "skipped_active",
        reason: "Skipped intentionally: a live execution issue already existed (skip_if_active)",
      };
    }
    case "coalesced":
      return { result: "coalesced", reason: "Coalesced into the existing live execution issue" };
    case "failed": {
      if (issueStatus === "blocked") {
        return { result: "blocked", reason: "Execution issue is currently blocked" };
      }
      if (issueStatus === "cancelled" || run.failureReason === "Execution issue moved to cancelled") {
        return { result: "cancelled", reason: run.failureReason ?? "Execution issue was cancelled" };
      }
      return { result: "failed", reason: run.failureReason ?? "Run failed" };
    }
    case "received":
      return { result: "pending", reason: "Run received but not dispatched yet" };
    default:
      return { result: "running", reason: `Run status ${run.status}` };
  }
}

function worstResult(results: RoutineHealthResult[]): RoutineHealthResult {
  for (const candidate of SEVERITY) {
    if (results.includes(candidate)) return candidate;
  }
  return "done";
}

export function computeRoutineHealth(input: {
  routineId: string;
  triggers: RoutineHealthTriggerInput[];
  runs: RoutineHealthRunInput[];
  now?: Date;
  days?: number;
}): RoutineHealthReport {
  const now = input.now ?? new Date();
  const requestedDays = Math.max(1, Math.min(input.days ?? 7, 31));
  const windowStart = new Date(now.getTime() - requestedDays * 24 * 60 * 60 * 1000);

  const scheduleTriggers = input.triggers.filter((trigger) => trigger.cronExpression && trigger.timezone);
  const enabledTriggers = scheduleTriggers.filter((trigger) => trigger.enabled);

  const windowRuns = input.runs.filter((run) => run.triggeredAt.getTime() <= now.getTime());
  const scheduledRuns = windowRuns
    .filter((run) => run.source === "schedule")
    .sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
  const unscheduledRunCount = windowRuns.filter(
    (run) => run.source !== "schedule" && run.triggeredAt.getTime() >= windowStart.getTime(),
  ).length;

  let tickLimitExceeded = false;
  const ticks: RoutineHealthTick[] = [];
  const matchedRunIds = new Set<string>();

  for (const trigger of enabledTriggers) {
    const expected: Date[] = [];
    let cursor = nextCronTickInTimeZone(trigger.cronExpression!, trigger.timezone!, windowStart);
    while (cursor && cursor.getTime() <= now.getTime()) {
      expected.push(cursor);
      if (expected.length >= MAX_TICKS) {
        tickLimitExceeded = true;
        break;
      }
      cursor = nextCronTickInTimeZone(trigger.cronExpression!, trigger.timezone!, cursor);
    }

    for (let i = 0; i < expected.length; i += 1) {
      const tickAt = expected[i]!;
      // A catch-up fire for a missed tick lands late but before the next tick, so the
      // match window runs from just before this tick until just before the next one.
      const matchStart = tickAt.getTime() - 60 * 1000;
      const matchEnd = i + 1 < expected.length
        ? expected[i + 1]!.getTime() - 60 * 1000
        : Number.POSITIVE_INFINITY;
      const matchesWindow = (run: RoutineHealthRunInput) => {
        if (matchedRunIds.has(run.id)) return false;
        const at = run.triggeredAt.getTime();
        return at >= matchStart && at < matchEnd;
      };
      const exactMatches = scheduledRuns.filter(
        (run) => run.triggerId === trigger.id && matchesWindow(run),
      );
      const legacyMatches = exactMatches.length === 0
        ? scheduledRuns.filter((run) => run.triggerId === null && matchesWindow(run))
        : [];
      const matched = exactMatches.length > 0 ? exactMatches : legacyMatches;

      if (matched.length === 0) {
        const withinGrace = now.getTime() - tickAt.getTime() < DISPATCH_GRACE_MS;
        ticks.push({
          expectedAt: tickAt.toISOString(),
          triggerId: trigger.id,
          result: withinGrace ? "pending" : "missed",
          reason: withinGrace
            ? "Scheduled tick is within the dispatch grace window"
            : "No run was recorded for this scheduled tick: the scheduler was offline or the trigger claim failed",
          runId: null,
          runStatus: null,
          linkedIssue: null,
        });
        continue;
      }

      // Prefer the run that actually linked an issue; otherwise the latest attempt.
      const primary = matched.find((run) => run.linkedIssue !== null) ?? matched[matched.length - 1]!;
      if (exactMatches.length > 0) {
        for (const run of exactMatches) matchedRunIds.add(run.id);
      } else {
        matchedRunIds.add(primary.id);
      }
      const { result, reason } = classifyRun(primary);
      ticks.push({
        expectedAt: tickAt.toISOString(),
        triggerId: trigger.id,
        result,
        reason,
        runId: primary.id,
        runStatus: primary.status,
        linkedIssue: primary.linkedIssue
          ? {
            id: primary.linkedIssue.id,
            identifier: primary.linkedIssue.identifier,
            title: primary.linkedIssue.title,
            status: primary.linkedIssue.status,
            completedAt: primary.linkedIssue.completedAt?.toISOString() ?? null,
          }
          : null,
      });
    }
  }

  const timezone = enabledTriggers[0]?.timezone ?? scheduleTriggers[0]?.timezone ?? null;
  const dayBuckets = new Map<string, RoutineHealthTick[]>();
  for (const tick of ticks) {
    const day = formatDayInTimeZone(new Date(tick.expectedAt), timezone ?? "UTC");
    const bucket = dayBuckets.get(day);
    if (bucket) bucket.push(tick);
    else dayBuckets.set(day, [tick]);
  }

  const dailyResults: RoutineHealthDay[] = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayTicks]) => {
      const result = worstResult(dayTicks.map((tick) => tick.result));
      const reason = dayTicks.find((tick) => tick.result === result)?.reason ?? null;
      return { date, result, reason, ticks: dayTicks };
    });

  const summary: Partial<Record<RoutineHealthResult, number>> = {};
  for (const day of dailyResults) {
    summary[day.result] = (summary[day.result] ?? 0) + 1;
  }

  const alerts = dailyResults
    .filter((day) => ALERTED_RESULTS.has(day.result))
    .map((day) => `${day.date}: ${day.result}${day.reason ? ` — ${day.reason}` : ""}`);

  return {
    routineId: input.routineId,
    generatedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    requestedDays,
    timezone,
    scheduleTriggerCount: scheduleTriggers.length,
    enabledScheduleTriggerCount: enabledTriggers.length,
    tickLimitExceeded,
    dailyResults,
    unscheduledRunCount,
    alerts,
    summary,
  };
}
