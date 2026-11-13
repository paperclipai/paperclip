import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

/** The wake reason an inbound chat message records (see chat inbound wakeups). */
export const EXTERNAL_CHAT_MESSAGE_WAKE_REASON = "External chat message received";
/** The mutation an inbound chat message wake records. */
export const EXTERNAL_CHAT_MESSAGE_WAKE_MUTATION = "chat_message_received";

/**
 * Per-comment consumption (work-intent outbox, invariant 4). A succeeded run
 * of the wake's agent that started after the comment's latest revision
 * consumed it when it received the comment as its own wake input, or when it
 * was a retry of an interrupted turn whose task history included the comment
 * (the retry re-reads the whole thread). Task history alone does not consume
 * a message saved for its own turn, and a run that was already running never
 * counts: its context can be refreshed after the fact, and an edit made after
 * it started is still unread. Every path that replays a saved message reads
 * this before delivering it.
 *
 * A run that took the message into its first provider turn
 * (`firstTurnQueuedInput`, sealed by that run before `turn.start`) consumed
 * it once the provider accepted that turn, whatever the run's later outcome.
 * Before acceptance the receipt proves nothing and the message stays queued.
 */
export async function deliveredQueuedCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const { companyId, issueId } = input;
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, input.commentIds),
    sql`(exists (select 1 from ${heartbeatRuns} delivered_run
      where delivered_run.company_id = ${companyId} and delivered_run.agent_id = ${input.agentId}
        and delivered_run.status = 'succeeded'
        and (delivered_run.native_issue_id = ${issueId} or delivered_run.context_snapshot->>'issueId' = ${issueId})
        and delivered_run.started_at > ${issueComments.createdAt}
        and delivered_run.started_at >= ${issueComments.updatedAt}
        and (coalesce(delivered_run.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${issueComments.id}::text
          or (delivered_run.retry_of_run_id is not null and jsonb_path_exists(delivered_run.context_snapshot, '$.executionContinuation.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text))
          or jsonb_path_exists(delivered_run.context_snapshot, '$.paperclipWake.messages[*] ? (@.id == $id)',
            jsonb_build_object('id', ${issueComments.id}::text)))))
    or ${firstTurnDeliveredSql(companyId, issueId, input.agentId)}
    or ${historyReadDeliveredSql(companyId, issueId, input.agentId)})`,
  ));
  return new Set(rows.map(row => row.id));
}

export const TASK_HISTORY_READ_EVENT = "task_history.read";

export async function recordTaskHistoryRead(db: Db, input: {
  companyId: string; agentId: string; runId: string; comments: ReadonlyArray<{ id: string; updatedAt: Date }>;
}): Promise<void> {
  if (input.comments.length === 0) return;
  await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
    eventType: TASK_HISTORY_READ_EVENT, stream: "system", level: "info",
    payload: { comments: Object.fromEntries(input.comments.map(comment => [comment.id, comment.updatedAt.toISOString()])) } });
}

export async function taskHistoryReadsForRun(db: Pick<Db, "select">, input: { companyId: string; runId: string }): Promise<Array<{
  commentId: string; readAt: Date; revision: Date;
}>> {
  const rows = await db.select({ readAt: heartbeatRunEvents.createdAt, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.eventType, TASK_HISTORY_READ_EVENT)))
    .orderBy(heartbeatRunEvents.seq);
  const latest = new Map<string, { commentId: string; readAt: Date; revision: Date }>();
  for (const row of rows) {
    const comments = row.payload?.comments;
    if (!comments || typeof comments !== "object" || Array.isArray(comments)) continue;
    for (const [commentId, value] of Object.entries(comments as Record<string, unknown>)) {
      const revision = typeof value === "string" ? new Date(value) : null;
      if (revision && !Number.isNaN(revision.getTime())) latest.set(commentId, { commentId, readAt: row.readAt, revision });
    }
  }
  return [...latest.values()];
}

export async function historyReadDeliveredCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, input.commentIds), historyReadDeliveredSql(input.companyId, input.issueId, input.agentId)));
  return new Set(rows.map(row => row.id));
}

export const COMMENT_EVIDENCE_REF_PREFIX = "comment:";

function historyReadDeliveredSql(companyId: string, issueId: string, agentId: string) {
  const handled = sql`exists (select 1 from ${heartbeatRunEvents} handled
        where handled.company_id = ${companyId} and handled.run_id = reading_run.id
          and handled.event_type = 'run.result.accepted'
          and (jsonb_path_exists(handled.payload, '$.prpEvent.payload.result.evidence[*].ref ? (@ starts with $ref)',
              jsonb_build_object('ref', ${COMMENT_EVIDENCE_REF_PREFIX} || ${issueComments.id}::text))
            or jsonb_path_exists(handled.payload, '$.prpEvent.payload.result.completionClaim.criteria[*].evidenceRefs[*] ? (@ starts with $ref)',
              jsonb_build_object('ref', ${COMMENT_EVIDENCE_REF_PREFIX} || ${issueComments.id}::text))))`;
  return sql`(${historyReadSql(companyId, agentId, sql`reading_run.native_issue_id = ${issueId}`, sql`and reading_run.status = 'succeeded' and ${handled}`)}
    or ${historyReadSql(companyId, agentId, sql`reading_run.context_snapshot->>'issueId' = ${issueId}`, sql`and reading_run.status = 'succeeded' and ${handled}`)})`;
}

function historyReadSql(companyId: string, agentId: string, binding: SQL, condition: SQL) {
  return sql`exists (select 1 from ${heartbeatRuns} reading_run
      cross join lateral (select 1 from ${heartbeatRunEvents} history_read
        where history_read.company_id = ${companyId} and history_read.run_id = reading_run.id
          and history_read.event_type = ${TASK_HISTORY_READ_EVENT}
          and (history_read.payload->'comments'->>${issueComments.id}::text)::timestamptz
            >= date_trunc('milliseconds', ${issueComments.updatedAt})
        limit 1) read_revision
      where reading_run.company_id = ${companyId} and ${binding}
        and reading_run.agent_id = ${agentId} ${condition}
        and reading_run.finished_at >= date_trunc('milliseconds', ${issueComments.updatedAt}) offset 0)`;
}

export async function readByEarlierTurnCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[]; currentRunId?: string | null;
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const { companyId, issueId, agentId } = input;
  const notCurrent = input.currentRunId ? sql`and reading_run.id <> ${input.currentRunId}` : sql``;
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, input.commentIds),
    sql`(${historyReadSql(companyId, agentId, sql`reading_run.native_issue_id = ${issueId}`, notCurrent)}
      or ${historyReadSql(companyId, agentId, sql`reading_run.context_snapshot->>'issueId' = ${issueId}`, notCurrent)})`));
  return new Set(rows.map(row => row.id));
}

export async function commentsArrivedDuringRun(db: Pick<Db, "select">, input: {
  companyId: string; runId: string; agentId: string;
  comments: ReadonlyArray<{ id: string; authorAgentId: string | null; createdAt: Date; updatedAt: Date }>;
}): Promise<string[]> {
  if (input.comments.length === 0) return [];
  const [run] = await db.select({ startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const startedAt = run?.startedAt;
  if (!startedAt) return [];
  return input.comments.filter(comment => comment.authorAgentId !== input.agentId
    && Math.max(comment.createdAt.getTime(), comment.updatedAt.getTime()) > startedAt.getTime()).map(comment => comment.id);
}

export function taskHistoryHandlingGuidance(commentIds: readonly string[]) {
  return commentIds.length === 0 ? {} : {
    arrivedDuringThisTurn: commentIds.map(id => `${COMMENT_EVIDENCE_REF_PREFIX}${id}`),
    handling: "These comments arrived while this turn was running. For each one this turn applies, include its ref in the evidence of paperclip_finish or paperclip_block. Paperclip delivers any comment that is not cited to you again in a new turn after this one.",
  };
}

/**
 * The comment row was taken into an accepted first provider turn of a run of
 * this agent on this task, and not edited after that run sealed its input.
 */
function firstTurnDeliveredSql(companyId: string, issueId: string, agentId: string) {
  return sql`exists (select 1 from ${heartbeatRuns} first_turn_run
      where first_turn_run.company_id = ${companyId} and first_turn_run.agent_id = ${agentId}
        and (first_turn_run.native_issue_id = ${issueId} or first_turn_run.context_snapshot->>'issueId' = ${issueId})
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'schema' = 'paperclip.first-turn-queued-input.v1'
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'runId' = first_turn_run.id::text
        and first_turn_run.context_snapshot->'firstTurnQueuedInput'->'commentIds' ? ${issueComments.id}::text
        and (first_turn_run.context_snapshot->'firstTurnQueuedInput'->>'claimedAt')::timestamptz >= date_trunc('milliseconds', ${issueComments.updatedAt})
        and exists (select 1 from ${heartbeatRunEvents} accepted
          where accepted.company_id = ${companyId} and accepted.run_id = first_turn_run.id
            and accepted.event_type in ('turn.accepted', 'turn.started')))`;
}

/** Ids that an accepted first provider turn already received (see `deliveredQueuedCommentIds`). */
export async function firstTurnDeliveredCommentIds(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (input.commentIds.length === 0) return new Set();
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, input.commentIds), firstTurnDeliveredSql(input.companyId, input.issueId, input.agentId)));
  return new Set(rows.map(row => row.id));
}
