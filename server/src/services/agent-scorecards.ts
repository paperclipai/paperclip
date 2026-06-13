// Agent scorecard aggregation for the monthly staffing routine (BLO-10275 /
// retro BLO-10264 #6). Summarizes, per agent over a documented window:
//   - cost per done issue   (cost_events.cost_cents / done issues)
//   - failure rate          (failed+timed_out / terminal heartbeat runs)
//   - review pass rate       (issues.last_evidence_verdict === "pass")
//
// The aggregation is split into a PURE function (`computeAgentScorecards`)
// that takes already-fetched per-agent counters and a thin DB query wrapper
// (`dashboardService.agentScorecards`, in dashboard.ts) that feeds it. Keeping
// the math pure lets it be unit-tested without a Postgres harness, which is the
// "verifying signal" the issue asks for (representative + low-sample agents).

import type { AgentStatus, HeartbeatRunStatus } from "@paperclipai/shared";

// Sample-size floors below which a metric is not statistically meaningful and
// must not be ranked as if it were. Documented + tunable per the issue AC.
export const MIN_SAMPLE_DONE = 5;
export const MIN_SAMPLE_RUNS = 10;
export const MIN_SAMPLE_REVIEWS = 5;

/** Heartbeat-run status counts for one agent in the window. */
export interface AgentRunCounts {
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
}

/** Latest-evidence-verdict counts for one agent's issues in the window. */
export interface AgentReviewCounts {
  pass: number;
  warn: number;
  block: number;
}

/** Per-agent inputs fed to the pure aggregator (already scoped to the window). */
export interface AgentScorecardInput {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  doneIssues: number;
  /** Total spend attributed to the agent in the window, in whole US cents. */
  costCents: number;
  runs: AgentRunCounts;
  reviews: AgentReviewCounts;
}

export interface AgentScorecardOptions {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  minSampleDone?: number;
  minSampleRuns?: number;
  minSampleReviews?: number;
}

/** Which metrics have enough sample to be ranked, per agent. */
export interface PerMetricSufficient {
  costPerDoneIssue: boolean;
  failureRate: boolean;
  reviewPassRate: boolean;
}

export interface AgentScorecard {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  doneIssues: number;
  costUsd: number;
  /** null = N/A (no done issues); never 0 or Infinity. */
  costPerDoneIssue: number | null;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  failureRate: number | null;
  reviewedIssues: number;
  passedReviews: number;
  reviewPassRate: number | null;
  /** Not enough of anything to rank this agent against peers. */
  lowSample: boolean;
  perMetricSufficient: PerMetricSufficient;
}

export interface AgentScorecardsResult {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  minSampleDone: number;
  minSampleRuns: number;
  minSampleReviews: number;
  agents: AgentScorecard[];
}

export const TERMINAL_RUN_STATUSES: HeartbeatRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Pure aggregator: turn per-agent counters into ranked scorecards. No I/O.
 *
 * Definitions (see the issue's spec doc):
 *  - completedRuns = succeeded + failed + timedOut  (cancelled excluded from
 *    the failure-rate denominator — cancellations are usually external dedup /
 *    preemption, not the agent failing — but surfaced separately).
 *  - failureRate   = (failed + timedOut) / completedRuns
 *  - reviewPassRate = pass / (pass + warn + block)   (warn & block = not-pass)
 *  - costPerDoneIssue = costUsd / doneIssues
 * Any rate/ratio with a zero denominator is null (N/A), never 0 or Infinity.
 */
export function computeAgentScorecards(
  inputs: AgentScorecardInput[],
  opts: AgentScorecardOptions,
): AgentScorecardsResult {
  const minSampleDone = opts.minSampleDone ?? MIN_SAMPLE_DONE;
  const minSampleRuns = opts.minSampleRuns ?? MIN_SAMPLE_RUNS;
  const minSampleReviews = opts.minSampleReviews ?? MIN_SAMPLE_REVIEWS;

  const agents = inputs.map((row): AgentScorecard => {
    const costUsd = round(row.costCents / 100, 2);
    const doneIssues = row.doneIssues;
    const costPerDoneIssue = doneIssues > 0 ? round(costUsd / doneIssues, 2) : null;

    const failedRuns = row.runs.failed + row.runs.timedOut;
    const cancelledRuns = row.runs.cancelled;
    const completedRuns = row.runs.succeeded + failedRuns;
    const failureRate = completedRuns > 0 ? round(failedRuns / completedRuns, 4) : null;

    const reviewedIssues = row.reviews.pass + row.reviews.warn + row.reviews.block;
    const passedReviews = row.reviews.pass;
    const reviewPassRate = reviewedIssues > 0 ? round(passedReviews / reviewedIssues, 4) : null;

    const perMetricSufficient: PerMetricSufficient = {
      costPerDoneIssue: doneIssues >= minSampleDone,
      failureRate: completedRuns >= minSampleRuns,
      reviewPassRate: reviewedIssues >= minSampleReviews,
    };

    // Low sample = not enough of either primary signal to rank. An agent with
    // plenty of runs but few done issues still ranks on failure rate, so it is
    // NOT globally low-sample.
    const lowSample = doneIssues < minSampleDone && completedRuns < minSampleRuns;

    return {
      agentId: row.agentId,
      agentName: row.agentName,
      status: row.status,
      doneIssues,
      costUsd,
      costPerDoneIssue,
      completedRuns,
      failedRuns,
      cancelledRuns,
      failureRate,
      reviewedIssues,
      passedReviews,
      reviewPassRate,
      lowSample,
      perMetricSufficient,
    };
  });

  // Stable default ordering for the "Ranked" group: cheapest cost/done first
  // among agents whose cost/done is meaningful; everyone else falls below,
  // ordered by name. The UI re-groups (Ranked vs Insufficient sample) and may
  // re-sort by column, but a deterministic default keeps tests + SSR stable.
  agents.sort((a, b) => {
    const aRankable = a.perMetricSufficient.costPerDoneIssue && a.costPerDoneIssue !== null;
    const bRankable = b.perMetricSufficient.costPerDoneIssue && b.costPerDoneIssue !== null;
    if (aRankable && bRankable) {
      if (a.costPerDoneIssue !== b.costPerDoneIssue) {
        return (a.costPerDoneIssue as number) - (b.costPerDoneIssue as number);
      }
    } else if (aRankable !== bRankable) {
      return aRankable ? -1 : 1;
    }
    return a.agentName.localeCompare(b.agentName);
  });

  return {
    windowDays: opts.windowDays,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    generatedAt: opts.generatedAt,
    minSampleDone,
    minSampleRuns,
    minSampleReviews,
    agents,
  };
}
