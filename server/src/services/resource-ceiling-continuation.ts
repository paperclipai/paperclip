import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments } from "@paperclipai/db";
import { ISSUE_PROGRESS_ACTIVITY_ACTIONS } from "./issue-rewake-throttle.js";

/**
 * Bounded auto-continuation for resource-ceiling stops (TSMC-20820).
 *
 * `max_turns_exhausted` / `token_budget_exhausted` are scoping verdicts, not
 * lane failures (see RESOURCE_CEILING_ERROR_CODES in recovery/equivalent-failure.ts,
 * which deliberately keeps them out of the circuit breaker). Round-based work —
 * benches, staged QA, consolidations — legitimately spends a full turn budget
 * per round. Queuing NO retry and routing the issue to a recovery owner
 * strands that work after round 1, and the operator's clear-error path just
 * re-fires the same doomed wake.
 *
 * Policy implemented here + in heartbeat.ts:
 * - a non-operator run that ends on one of those codes queues ONE bounded
 *   continuation wake for the same agent+issue (the existing
 *   `max_turns_continuation` scheduled-retry machinery);
 * - the round counter is persisted as the scheduled-continuation heartbeat
 *   run rows themselves (scheduledRetryReason marker), capped per
 *   (agent, issue) per rolling 24h window;
 * - on cap: a LOUD issue comment naming the cap and rounds consumed — and the
 *   issue is deliberately NOT blocked on a recovery owner;
 * - operator-requested runs (`on_demand` invocation source — a direct
 *   operator kick) never auto-continue. The wake-request actor type is NOT
 *   part of that gate: automation/assignment wakes stamp the upstream
 *   cascade's actor, so user-authored comments/approvals produce
 *   `requestedByActorType = "user"` on routine automation wakes — keying the
 *   skip on it made hermes-path ceilings (lanes fed almost entirely by
 *   user-authored board comments) miss the continuation systematically;
 * - a granted continuation round runs with its FRESH configured per-run
 *   token budget — it is never clamped to the issue's residual aggregate
 *   budget (which handed rounds shrinking micro-budgets that exhausted
 *   instantly and burned the cap). The issue-generation admission gate still
 *   denies the next round once the aggregate ceiling is crossed.
 */
export const RESOURCE_CEILING_CONTINUATION_RETRY_REASON = "max_turns_continuation";

export const RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW = 5;
export const RESOURCE_CEILING_CONTINUATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Small backoff between rounds: 30s, 60s, 120s, 240s, 480s (capped). Enough to
 * let the control plane settle between rounds without stalling legitimate
 * multi-round work.
 */
export const RESOURCE_CEILING_CONTINUATION_BASE_DELAY_MS = 30_000;
export const RESOURCE_CEILING_CONTINUATION_MAX_DELAY_MS = 8 * 60_000;

export type ResourceCeilingContinuationCause = "max_turns_exhausted" | "token_budget_exhausted";

export function computeResourceCeilingContinuationDelayMs(roundsConsumed: number) {
  const exponent = Math.max(0, Math.min(Math.floor(roundsConsumed), 10));
  return Math.min(
    RESOURCE_CEILING_CONTINUATION_BASE_DELAY_MS * 2 ** exponent,
    RESOURCE_CEILING_CONTINUATION_MAX_DELAY_MS,
  );
}

/**
 * Persisted round counter: every continuation the policy has granted for this
 * (agent, issue) pair inside the rolling window, regardless of how the granted
 * round ended. Counting grants (rows) rather than outcomes keeps the cap
 * monotonic even when a granted round is later cancelled by a gate.
 */
export async function countResourceCeilingContinuationRounds(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - RESOURCE_CEILING_CONTINUATION_WINDOW_MS);
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.scheduledRetryReason, RESOURCE_CEILING_CONTINUATION_RETRY_REASON),
        gte(heartbeatRuns.createdAt, cutoff),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW + 1);
  return rows.length;
}

/**
 * How many grants to inspect when computing the PROGRESS-AWARE count. The
 * plain counter can stop at cap+1 because every row counts; here a productive
 * round does not consume budget, so a long-running card may legitimately hold
 * many more grants than the cap and we must see all of them to judge.
 */
export const RESOURCE_CEILING_CONTINUATION_PROGRESS_SAMPLE_LIMIT = 64;

/**
 * Progress-aware round counter (TSMC-21320).
 *
 * The plain counter above counts GRANTS, so the cap trips on repetition alone.
 * That parks genuinely-progressing deep work: measured 2026-08-23, TSR-5723
 * had three successful continuations — each leaving real issue-visible state —
 * and was still blocked for fresh-card supersede, forcing a manual unblock.
 * Round-based work (benches, staged QA, consolidations) is exactly the shape
 * that spends a full turn budget per round and keeps delivering.
 *
 * The cap exists to stop UNPRODUCTIVE burn, so only unproductive rounds should
 * spend it. A granted round counts against the cap unless its run left
 * issue-visible progress — the same narrow definition the re-wake throttle
 * uses (ISSUE_PROGRESS_ACTIVITY_ACTIONS: a comment alone is not progress;
 * a mutation, document, work product, child issue, or scheduled continuation
 * is). Monotonicity is preserved: a run's progress is a historical fact, so
 * the count only falls as rounds age out of the window, exactly as before.
 */
export async function countUnproductiveResourceCeilingContinuationRounds(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    now?: Date;
  },
): Promise<{ unproductive: number; granted: number; productive: number }> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - RESOURCE_CEILING_CONTINUATION_WINDOW_MS);
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.scheduledRetryReason, RESOURCE_CEILING_CONTINUATION_RETRY_REASON),
        gte(heartbeatRuns.createdAt, cutoff),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(RESOURCE_CEILING_CONTINUATION_PROGRESS_SAMPLE_LIMIT);

  const granted = rows.length;
  if (granted === 0) return { unproductive: 0, granted: 0, productive: 0 };

  const runIds = rows.map((row) => row.id);
  const progressRows = await db
    .select({ runId: activityLog.runId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        inArray(activityLog.runId, runIds),
        inArray(activityLog.action, ISSUE_PROGRESS_ACTIVITY_ACTIONS),
      ),
    );

  const productiveRunIds = new Set(
    progressRows.map((row) => row.runId).filter((runId): runId is string => Boolean(runId)),
  );
  const productive = rows.filter((row) => productiveRunIds.has(row.id)).length;
  return { unproductive: granted - productive, granted, productive };
}

/**
 * Stable heading doubles as the recency-bounded dedup marker (K40 pattern:
 * an identical record inside the window is churn, not information).
 */
export const RESOURCE_CEILING_CAP_COMMENT_HEADING = "## Bounded continuation cap reached";

export function buildResourceCeilingCapComment(input: {
  runId: string;
  cause: ResourceCeilingContinuationCause;
  roundsConsumed: number;
  cap: number;
}) {
  const windowHours = Math.round(RESOURCE_CEILING_CONTINUATION_WINDOW_MS / 3_600_000);
  return (
    `${RESOURCE_CEILING_CAP_COMMENT_HEADING} — automatic continuation stopped\n\n` +
    `- Run: \`${input.runId}\`\n` +
    `- Stop cause: \`${input.cause}\` (resource ceiling — a scoping verdict, not a lane failure)\n` +
    `- Continuation rounds consumed: **${input.roundsConsumed} of ${input.cap}** for this agent+issue within the last ${windowHours}h\n` +
    `- Further automatic continuation: **not queued** until the ${windowHours}h window clears\n` +
    "- The issue was deliberately **not** blocked on a recovery owner; the partial round progress on this issue stands.\n" +
    "- Next step: review the accumulated rounds, then split the remaining work into bounded issues, raise the per-run budget, or explicitly re-wake the agent to continue.\n"
  );
}

export async function findRecentResourceCeilingCapComment(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - RESOURCE_CEILING_CONTINUATION_WINDOW_MS);
  return db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        gte(issueComments.createdAt, cutoff),
        sql`${issueComments.body} like ${`${RESOURCE_CEILING_CAP_COMMENT_HEADING}%`}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
