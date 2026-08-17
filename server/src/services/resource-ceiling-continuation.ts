import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments } from "@paperclipai/db";

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
