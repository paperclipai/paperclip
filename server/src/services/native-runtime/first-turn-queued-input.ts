import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueAttachments, issueComments, issues } from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";

import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";
import { PROVIDER_TURN_ACCEPTED_EVENT_TYPES } from "./provider-attempt-outcome.js";

/**
 * Queued input for a run's first provider turn.
 *
 * A user's message that arrives while a run is still preparing waits as a
 * deferred wake behind that run. Interrupting the run for it throws away the
 * whole preparation. Instead, the run takes the waiting messages into the
 * turn it is about to start: the runner calls `claimFirstTurnQueuedInput`
 * immediately before `turn.start`, and the claim and the first-turn input are
 * sealed in one transaction on the run row.
 *
 * The claim does not remove the messages from their deferred wake. It records
 * a receipt in the run's context. A message counts as delivered only after the
 * provider accepted that run's turn (`deliveredQueuedCommentIds`). If the run
 * ends before that, the receipt proves nothing and the deferred wake still
 * holds the message, so the next run delivers it exactly once. A restart
 * before the turn was accepted repeats the same claim from the receipt.
 */
export const FIRST_TURN_QUEUED_INPUT_KEY = "firstTurnQueuedInput";
export const FIRST_TURN_QUEUED_INPUT_SCHEMA = "paperclip.first-turn-queued-input.v1";

const DEFERRED_WAKE_STATUS = "deferred_issue_execution";
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const COMMENT_WAKE_REASONS = new Set(["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"]);
const MAX_COMMENT_CHARS = 16_000;
const MAX_TOTAL_CHARS = 48_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FirstTurnQueuedInputReceipt = {
  schema: typeof FIRST_TURN_QUEUED_INPUT_SCHEMA;
  runId: string;
  wakeupRequestIds: string[];
  commentIds: string[];
  claimedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
}

/**
 * The receipt this exact run sealed. A retry copies its predecessor's context,
 * so a receipt naming another run is inert.
 */
export function readFirstTurnQueuedInputReceipt(run: { id: string; contextSnapshot?: unknown }): FirstTurnQueuedInputReceipt | null {
  const receipt = record(record(run.contextSnapshot)[FIRST_TURN_QUEUED_INPUT_KEY]);
  if (receipt.schema !== FIRST_TURN_QUEUED_INPUT_SCHEMA || receipt.runId !== run.id) return null;
  const claimedAt = nonEmptyString(receipt.claimedAt);
  if (!claimedAt) return null;
  return {
    schema: FIRST_TURN_QUEUED_INPUT_SCHEMA,
    runId: run.id,
    wakeupRequestIds: stringIds(receipt.wakeupRequestIds),
    commentIds: stringIds(receipt.commentIds),
    claimedAt,
  };
}

/** Message ids a live run already took into its first turn; queue views hide them. */
export function firstTurnClaimedCommentIds(run: { id: string; status?: string | null; contextSnapshot?: unknown } | null | undefined): Set<string> {
  if (!run || (run.status !== undefined && run.status !== "running")) return new Set();
  return new Set(readFirstTurnQueuedInputReceipt(run)?.commentIds ?? []);
}

/**
 * Whether a deferred wake is plain user input that the run's first turn may
 * take. Interaction answers, interrupt intents, independent continuations and
 * chat-conversation wakes keep their own delivery contracts. Only the run's
 * responsible user's own messages qualify, so taking them cannot change the
 * run's execution authority.
 */
export function deferredWakeJoinsFirstTurn(
  wake: { agentId: string; status: string; requestedByActorType: string | null; requestedByActorId: string | null; reason: string | null; payload: unknown },
  run: { agentId: string; responsibleUserId: string | null },
): boolean {
  const payload = record(wake.payload);
  const context = record(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  const reason = nonEmptyString(context.wakeReason) ?? nonEmptyString(wake.reason);
  return wake.status === DEFERRED_WAKE_STATUS &&
    wake.agentId === run.agentId &&
    wake.requestedByActorType === "user" &&
    Boolean(run.responsibleUserId) && wake.requestedByActorId === run.responsibleUserId &&
    reason !== null && COMMENT_WAKE_REASONS.has(reason) &&
    !payload.interactionId && !context.interactionId && !context.interactionStatus &&
    !payload.queuedCommentInterrupt && context.resumeIntent !== true &&
    !nonEmptyString(context.chatConversationId) && !nonEmptyString(payload.externalChatProvider) &&
    queuedCommentIdsFromWakePayload(payload).length > 0;
}

type QueuedMessage = { id: string; body: string; createdAt: Date };

export function renderFirstTurnQueuedInput(messages: readonly QueuedMessage[]): string | null {
  if (messages.length === 0) return null;
  let remaining = MAX_TOTAL_CHARS;
  const sections = messages.map((message, index) => {
    const limit = Math.max(0, Math.min(MAX_COMMENT_CHARS, remaining));
    const truncated = message.body.length > limit;
    const body = truncated ? message.body.slice(0, limit) : message.body;
    remaining -= body.length;
    return [
      `[Message ${index + 1} of ${messages.length} · comment ${message.id} · ${message.createdAt.toISOString()}]`,
      body,
      ...(truncated ? [`(Truncated here. Read comment ${message.id} on the task for the rest.)`] : []),
    ].join("\n");
  });
  return [
    "New messages from the user arrived while this run was starting. They were not in the request above. Handle each of them in this turn, oldest first, together with that request:",
    ...sections,
  ].join("\n\n");
}

/**
 * The one rule for which queued comment a first turn may take: a live, plain
 * comment written directly by the run's responsible user, with no files. The
 * prompt carries text only; a message with files keeps its own delivery, which
 * stages those files for the turn that reads it.
 */
function firstTurnEligibleComment(input: { companyId: string; issueId: string; responsibleUserId: string }) {
  return and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorUserId, input.responsibleUserId),
    isNull(issueComments.authorAgentId), isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`not exists (select 1 from ${issueAttachments} where ${issueAttachments.companyId} = ${input.companyId}
      and ${issueAttachments.issueCommentId} = ${issueComments.id})`);
}

async function readQueuedMessages(
  tx: Db,
  input: { companyId: string; issueId: string; agentId: string; responsibleUserId: string; commentIds: string[]; excludeDelivered: boolean },
): Promise<QueuedMessage[]> {
  if (input.commentIds.length === 0) return [];
  const rows = await tx.select({
    id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt,
    sourceTrust: issueComments.sourceTrust,
  }).from(issueComments).where(and(inArray(issueComments.id, input.commentIds), firstTurnEligibleComment(input)));
  const delivered = input.excludeDelivered
    ? await deliveredQueuedCommentIds(tx, { companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
      commentIds: rows.map(row => row.id) })
    : new Set<string>();
  const byId = new Map(rows.map(row => [row.id, row]));
  return input.commentIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row || delivered.has(id)) return [];
    const safe = sanitizeQuarantinedCommentForHigherTrust({ ...row, sourceTrust: row.sourceTrust as SourceTrustMetadata | null });
    return [{ id, body: safe.body, createdAt: row.createdAt }];
  });
}

/**
 * Seals the first provider turn's input. Returns the queued messages to add to
 * that turn, or null. Called once per turn start, immediately before
 * `turn.start`; repeated calls for the same run return the same messages.
 */
export async function claimFirstTurnQueuedInput(
  db: Db,
  binding: { companyId: string; runId: string; issueId: string; agentId: string },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Redact on this transaction's own connection: a second pool connection
    // while the seal holds its locks can wait forever on a one-connection pool.
    const render = async (messages: QueuedMessage[]) => messages.length === 0 ? null : renderFirstTurnQueuedInput(
      await createRunSecretRedactionRegistry(tx as unknown as Db).redactForIssue(binding.companyId, binding.issueId, messages));
    // Lock in the queue routes' order (task, queue, run) so a concurrent
    // Interrupt and this seal serialize instead of deadlocking.
    const [issue] = await tx.select({ conversationAgentId: issues.conversationAgentId, executionRunId: issues.executionRunId })
      .from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update").limit(1);
    const wakes = !issue ? [] : await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, binding.companyId), eq(agentWakeupRequests.agentId, binding.agentId),
      eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${binding.issueId}`,
    )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id)).for("update");
    const [run] = await tx.select({
      id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
      runtimeMode: heartbeatRuns.runtimeMode, responsibleUserId: heartbeatRuns.responsibleUserId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId))).for("update").limit(1);
    if (!run || run.status !== "running" || run.runtimeMode !== "native" || !run.responsibleUserId) return null;
    const receipt = readFirstTurnQueuedInputReceipt(run);
    // A restart before the provider accepted the turn repeats the sealed input.
    if (receipt) {
      return render(await readQueuedMessages(tx as unknown as Db, { ...binding, responsibleUserId: run.responsibleUserId,
        commentIds: receipt.commentIds, excludeDelivered: false }));
    }
    // Only the run that holds the task takes its queue. Conversations keep
    // their own turn-boundary contract.
    const joining = !issue || issue.conversationAgentId || issue.executionRunId !== run.id
      ? [] : wakes.filter(wake => deferredWakeJoinsFirstTurn(wake, run));
    const commentIds = [...new Set(joining.flatMap(wake => queuedCommentIdsFromWakePayload(wake.payload)))];
    const taken = await readQueuedMessages(tx as unknown as Db, { ...binding, responsibleUserId: run.responsibleUserId,
      commentIds, excludeDelivered: true });
    // Render before sealing: once the receipt commits, nothing can fail
    // between it and the turn input that the receipt describes.
    const text = await render(taken);
    // Seal even when nothing joined: later messages wait for the turn boundary.
    const sealed: FirstTurnQueuedInputReceipt = {
      schema: FIRST_TURN_QUEUED_INPUT_SCHEMA,
      runId: run.id,
      wakeupRequestIds: joining.filter(wake => queuedCommentIdsFromWakePayload(wake.payload)
        .some(id => taken.some(message => message.id === id))).map(wake => wake.id),
      commentIds: taken.map(message => message.id),
      claimedAt: new Date().toISOString(),
    };
    await tx.update(heartbeatRuns).set({
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ [FIRST_TURN_QUEUED_INPUT_KEY]: sealed })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    return text;
  });
}

/**
 * True while a running native run can still take queued input into its first
 * turn: it has not sealed that input and no provider turn was accepted. A run
 * saved by a release without the seal counts as started once its provider
 * accepted a turn, so a mid-turn Interrupt keeps its old meaning.
 */
export async function runAcceptsFirstTurnQueuedInput(
  tx: Pick<Db, "select">,
  run: { id: string; companyId: string; status: string; runtimeMode: string | null; runtimeModeResolvedAt?: Date | null;
    runnerProfileJson?: unknown; contextSnapshot?: unknown },
): Promise<boolean> {
  if (run.status !== "running") return false;
  const preparingNative = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    record(record(run.runnerProfileJson).adapterDispatch).adapterType === "paperclip_runner";
  if (run.runtimeMode !== "native" && !preparingNative) return false;
  if (readFirstTurnQueuedInputReceipt(run)) return false;
  const [accepted] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, [...PROVIDER_TURN_ACCEPTED_EVENT_TYPES]))).limit(1);
  return !accepted;
}

/** The wake facts `deferredWakeJoinsFirstTurn` reads, without the rest of a large payload. */
export const firstTurnWakeColumns = {
  agentId: agentWakeupRequests.agentId,
  reason: agentWakeupRequests.reason,
  requestedByActorType: agentWakeupRequests.requestedByActorType,
  requestedByActorId: agentWakeupRequests.requestedByActorId,
};

/** The lean payload fields `deferredWakeJoinsFirstTurn` reads, for a `jsonb_build_object` projection. */
export function firstTurnWakePayloadFields(payload: typeof agentWakeupRequests.payload) {
  return sql`'interactionId', ${payload}->'interactionId',
    'queuedCommentInterrupt', ${payload}->'queuedCommentInterrupt'->'requestedAt',
    'externalChatProvider', ${payload}->'externalChatProvider'`;
}

/** The lean `_paperclipWakeContext` fields `deferredWakeJoinsFirstTurn` reads. */
export function firstTurnWakeContextFields(payload: typeof agentWakeupRequests.payload) {
  return sql`'wakeReason', ${payload}->'_paperclipWakeContext'->'wakeReason',
    'interactionId', ${payload}->'_paperclipWakeContext'->'interactionId',
    'interactionStatus', ${payload}->'_paperclipWakeContext'->'interactionStatus',
    'resumeIntent', ${payload}->'_paperclipWakeContext'->'resumeIntent',
    'chatConversationId', ${payload}->'_paperclipWakeContext'->'chatConversationId'`;
}

/**
 * The messages in one deferred queue that the running run's first turn takes:
 * the ones it already sealed, or, while it is still starting, the ones its
 * claim will take under the same rule as `claimFirstTurnQueuedInput`. A queue
 * view shows these as sent instead of waiting for Steer, which cannot reach a
 * run whose provider session (for example a booting sandbox) is not up yet.
 * Presentation only: delivery still belongs to the claim and the deferred wake.
 */
export async function firstTurnQueuedCommentIds(
  tx: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    wake: { agentId: string; status: string; reason: string | null; requestedByActorType: string | null;
      requestedByActorId: string | null; payload: unknown };
  },
): Promise<string[]> {
  const { wake } = input;
  if (wake.status !== DEFERRED_WAKE_STATUS) return [];
  const wakeIds = queuedCommentIdsFromWakePayload(wake.payload);
  if (wakeIds.length === 0) return [];
  // Read only the receipt and dispatch choice; a run snapshot can be large.
  const [row] = await tx.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt, responsibleUserId: heartbeatRuns.responsibleUserId,
    dispatchAdapterType: sql<string | null>`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`,
    receipt: sql<unknown>`${heartbeatRuns.contextSnapshot}->${FIRST_TURN_QUEUED_INPUT_KEY}`,
    executionRunId: issues.executionRunId, conversationAgentId: issues.conversationAgentId,
  }).from(heartbeatRuns)
    .leftJoin(issues, and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  if (!row || row.status !== "running" || row.agentId !== wake.agentId) return [];
  const run = { ...row, runnerProfileJson: { adapterDispatch: { adapterType: row.dispatchAdapterType } },
    contextSnapshot: { [FIRST_TURN_QUEUED_INPUT_KEY]: row.receipt } };
  const receipt = readFirstTurnQueuedInputReceipt(run);
  if (receipt) {
    const sealed = new Set(receipt.commentIds);
    return wakeIds.filter(id => sealed.has(id));
  }
  if (row.conversationAgentId || row.executionRunId !== run.id || !run.responsibleUserId) return [];
  if (!deferredWakeJoinsFirstTurn(wake, run)) return [];
  if (!(await runAcceptsFirstTurnQueuedInput(tx, run))) return [];
  const eligible = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    inArray(issueComments.id, wakeIds),
    firstTurnEligibleComment({ companyId: input.companyId, issueId: input.issueId, responsibleUserId: run.responsibleUserId })));
  const ids = new Set(eligible.map(row => row.id));
  return wakeIds.filter(id => ids.has(id));
}

/**
 * True when the first turn would take every pending message in this queue,
 * under the same rule as the claim. Another user's message, an agent's, or one
 * with files keeps its own delivery, so Interrupt must still apply.
 */
export async function firstTurnTakesAllQueuedComments(
  tx: Pick<Db, "select">,
  input: { companyId: string; issueId: string; responsibleUserId: string | null; commentIds: string[] },
): Promise<boolean> {
  if (input.commentIds.length === 0 || !input.responsibleUserId) return false;
  const rows = await tx.select({
    id: issueComments.id,
    eligible: sql<boolean>`coalesce((${firstTurnEligibleComment({ ...input, responsibleUserId: input.responsibleUserId })}), false)`,
  }).from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, input.commentIds), isNull(issueComments.deletedAt)));
  return rows.length > 0 && rows.every(row => row.eligible === true);
}
