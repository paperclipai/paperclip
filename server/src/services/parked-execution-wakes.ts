import { and, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { hasInteractionContinuationWakeContext, isInteractionResolutionWakePayload } from "./heartbeat/run-preparation.js";
import {
  carriesWorkBeyondQueuedComments,
  EXECUTION_STAGE_WAKE_REASONS,
  INTERACTION_CONTINUATION_CONTEXT_KEYS,
  settleWakeAfterDeliveredComments,
  STALE_EXECUTION_WAKE_REASON,
} from "../modules/wake-queue/index.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";

const payload = agentWakeupRequests.payload;
const wakeReasonSql = sql`${payload}#>>'{_paperclipWakeContext,wakeReason}'`;
const savedStageIdSql = sql`coalesce(${payload}#>>'{executionStage,stageId}', ${payload}#>>'{_paperclipWakeContext,executionStage,stageId}')`;
const reasonList = (reasons: readonly string[]) => sql.join(reasons.map(reason => sql`${reason}`), sql`, `);

/**
 * A deferred wake that is only an execution-stage wake (with its saved stage):
 * no queued comments, no interaction or interaction continuation, no resume
 * intent, no other wake reason. Rows with other work keep their existing
 * selection and handling; the release drain still removes a stale stage from
 * them. System continuations (`run_liveness_continuation`,
 * `issue_continuation_needed`) are not selected.
 */
export const parkedExecutionWakePayloadSql = sql`(${wakeReasonSql} in (${reasonList(EXECUTION_STAGE_WAKE_REASONS)})
  and ${savedStageIdSql} is not null
  and coalesce(jsonb_array_length(case when jsonb_typeof(${payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'
    then ${payload}#>'{_paperclipWakeContext,wakeCommentIds}' end), 0) = 0
  and ${payload}->>'mutation' is distinct from 'interaction'
  and ${payload}#>>'{_paperclipWakeContext,resumeIntent}' is distinct from 'true'
  and not jsonb_exists_any(coalesce(${payload}->'_paperclipWakeContext', '{}'::jsonb),
    array[${reasonList(INTERACTION_CONTINUATION_CONTEXT_KEYS)}]::text[]))`;

/** Row versions the scan reads with each wake, for `cancelStaleParkedWake`. */
export const parkedWakeRowVersionSql = {
  wake: sql<string>`${agentWakeupRequests}.xmin::text`,
  issue: sql<string>`${issues}.xmin::text`,
};

type ParkedWakeVersions = { wakeId: string; wakeVersion: string; issueId: string; issueVersion: string; now: Date };

/**
 * Writes a deferred wake only if neither the wake row nor its issue row
 * changed since the caller read them (same `xmin`). A merge into the wake or
 * any issue update, such as a new stage transition, changes the version, so
 * the write is skipped and the next pass, or the release drain under the
 * issue lock, decides again.
 */
async function writeParkedWakeIfUnchanged(
  db: Pick<Db, "update">,
  input: ParkedWakeVersions,
  values: Partial<typeof agentWakeupRequests.$inferInsert>,
): Promise<boolean> {
  const rows = await db.update(agentWakeupRequests)
    .set({ ...values, updatedAt: input.now })
    .where(and(
      eq(agentWakeupRequests.id, input.wakeId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests}.xmin::text = ${input.wakeVersion}`,
      sql`exists (select 1 from ${issues} where ${issues.id} = ${input.issueId}::uuid
        and ${issues}.xmin::text = ${input.issueVersion})`,
    ))
    .returning({ id: agentWakeupRequests.id });
  return rows.length > 0;
}

/** Cancels a stale parked wake, guarded as `writeParkedWakeIfUnchanged`. */
export function cancelStaleParkedWake(db: Pick<Db, "update">, input: ParkedWakeVersions): Promise<boolean> {
  return writeParkedWakeIfUnchanged(db, input, { status: "cancelled", error: STALE_EXECUTION_WAKE_REASON, finishedAt: input.now });
}

export const QUEUED_MESSAGES_DELIVERED_ERROR = "Queued messages were already delivered to a completed run";

/**
 * Cancels a saved wake whose queued comments a completed run already received,
 * guarded as `writeParkedWakeIfUnchanged` (used when that decision judged a
 * saved stage against the issue row).
 */
export function cancelDeliveredParkedWake(db: Pick<Db, "update">, input: ParkedWakeVersions): Promise<boolean> {
  return writeParkedWakeIfUnchanged(db, input,
    { status: "cancelled", error: QUEUED_MESSAGES_DELIVERED_ERROR, finishedAt: input.now });
}

/** Stores a rewritten payload on a deferred wake, guarded as `writeParkedWakeIfUnchanged`. */
export function storeParkedWakePayload(
  db: Pick<Db, "update">,
  input: ParkedWakeVersions & { payload: Record<string, unknown> },
): Promise<boolean> {
  return writeParkedWakeIfUnchanged(db, input, { payload: input.payload });
}

/**
 * The pause-lifted pass, before it resumes a saved message: every saved wake
 * of the agent on the task drops the comments a completed run already
 * received, by the release drain's rules (`settleWakeAfterDeliveredComments`).
 * Each write is guarded by the wake and issue row versions read here, so a
 * decision made on an older wake never overwrites work merged into it, or an
 * issue change, after the read. Returns false if a write was skipped: the
 * caller then leaves the task to its next pass, because the wake it resumes
 * adopts every saved message and would deliver the received comments again.
 */
export async function settleSavedWakesAfterDelivery(
  db: Pick<Db, "select" | "update">,
  input: { companyId: string; agentId: string; issueId: string;
    deliveredCommentIds(commentIds: string[]): Promise<Set<string>> },
): Promise<boolean> {
  const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    executionState: issues.executionState, version: parkedWakeRowVersionSql.issue })
    .from(issues).where(and(eq(issues.companyId, input.companyId), sql`${issues.id}::text = ${input.issueId}`));
  if (!issue) return true;
  const saved = await db.select({ receipt: agentWakeupRequests, version: parkedWakeRowVersionSql.wake })
    .from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`));
  let settledAll = true;
  for (const { receipt, version } of saved) {
    const commentIds = queuedCommentIdsFromWakePayload(receipt.payload);
    const delivered = await input.deliveredCommentIds(commentIds);
    if (delivered.size === 0) continue;
    const remaining = commentIds.filter(commentId => !delivered.has(commentId));
    const settled = settleWakeAfterDeliveredComments({ agentId: receipt.agentId, rowReason: receipt.reason,
      payload: withQueuedCommentIdsInWakePayload(parseObject(receipt.payload), remaining) }, issue);
    const guard = { wakeId: receipt.id, wakeVersion: version, issueId: input.issueId, issueVersion: issue.version, now: new Date() };
    const written = settled.kind === "store" ? await storeParkedWakePayload(db, { ...guard, payload: settled.payload })
      : settled.kind === "cancel_stale" ? await cancelStaleParkedWake(db, guard)
      : await cancelDeliveredParkedWake(db, guard);
    if (!written) settledAll = false;
  }
  return settledAll;
}

/**
 * Whether admission may adopt a deferred wake only by its queued comment IDs
 * into the run it starts (the wake is then marked coalesced). Any work the
 * run would not receive keeps the wake deferred for its own delivery.
 */
export function adoptableAsQueuedCommentsOnly(wake: { idempotencyKey: string | null; reason: string | null; payload: unknown }) {
  const deferredPayload = parseObject(wake.payload);
  const deferredContext = parseObject(deferredPayload._paperclipWakeContext);
  // Dedicated interaction wakes carry their own source and session
  // contract. ID-only adoption must not erase that continuation.
  return (
    // Durable chat work must keep its receipt, actor, source, and
    // session contract through normal promotion and authorization.
    !wake.idempotencyKey?.startsWith("chat-inbound:") &&
    !isInteractionResolutionWakePayload(deferredPayload) &&
    !hasInteractionContinuationWakeContext(deferredContext) &&
    // A comment merged into a stage wake or a run liveness continuation
    // leaves a comment reason on the row. Adopting only its comment IDs would
    // drop that work, so the wake stays deferred, with its comments, for the
    // release drain to judge.
    !carriesWorkBeyondQueuedComments(deferredPayload) &&
    ["issue_commented", "issue_reopened_via_comment"].includes(String(deferredContext.wakeReason ?? wake.reason)) &&
    queuedCommentIdsFromWakePayload(wake.payload).length > 0
  );
}
