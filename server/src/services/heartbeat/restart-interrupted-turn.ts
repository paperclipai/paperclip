import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import type { NativeRestartRecoveryClaim } from "../native-runtime/native-restart-recovery.js";
import { isUserCommentContinuationReason } from "../explicit-native-continuation.js";
import { requestTaskRetry } from "../task-retry.js";
import { EXTERNAL_CHAT_MESSAGE_WAKE_REASON } from "../queued-comment-delivery.js";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH } from "../native-runtime/remote-recovery-lease-mismatch.js";

/** Reattachment could not find the run's original runner or allocation: the
 * sandbox lease or plugin task is gone, or the remote runner process is not
 * there to verify. This is infrastructure, not the task's own failure. */
const REATTACHMENT_LOST_ERRORS = [NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH, "native_plugin_recovery_lease_mismatch",
  "runner_remote_process_identity_unavailable", "runner_continuity_break_archive_failed"];

/** A failure message is one of the closed codes, optionally followed by
 * ": " and bounded diagnostic detail (for example, the archive's exit status). */
function isReattachmentLoss(error: string | null): boolean {
  return error !== null && REATTACHMENT_LOST_ERRORS.some(code => error === code || error.startsWith(`${code}: `));
}

export const TURN_STARTED_EVENTS = ["turn.submitted", "turn.started", "turn.accepted"];
export const TURN_SETTLED_EVENTS = ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A terminal event proves the turn ended only when the provider reported it.
 * A driver that lost its event stream records `providerTerminalObserved: false`
 * (on the event or its stored PRP source): the real outcome is unknown, and
 * another turn could repeat work that already happened. */
export function isProvenTurnSettlement(event: { eventType: string; payload: unknown }) {
  if (!TURN_SETTLED_EVENTS.includes(event.eventType)) return false;
  const payload = asRecord(event.payload);
  return payload.providerTerminalObserved !== false &&
    asRecord(asRecord(payload.prpEvent).payload).providerTerminalObserved !== false;
}

/** Any turn or tool event: the run may have done provider work that a new turn could repeat. */
const PROVIDER_TURN_ACTIVITY_EVENTS = [...TURN_STARTED_EVENTS, ...TURN_SETTLED_EVENTS,
  "tool.execution.started", "tool.execution.completed"];

async function provenRunnerExit(db: Db, run: { companyId: string; id: string }) {
  const [refusal] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, "native.remote_runner_recovery_failed"),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const proof = asRecord(asRecord(refusal?.payload).remoteRunnerRecovery);
  return proof.stage === "process_verification" && proof.reason === "process_not_running" ? proof : null;
}

/**
 * The run's last refused reattachment proved its Runner process gone and its
 * controller journal proved that no turn command was ever issued
 * (`providerTurnIssued: false`, recorded by the executor). No turn or tool
 * event may exist either.
 */
async function hasProvenNoProviderTurn(db: Db, run: { companyId: string; id: string }, runnerExit: Record<string, unknown> | null) {
  if (runnerExit?.providerTurnIssued !== false) return false;
  const [activity] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, PROVIDER_TURN_ACTIVITY_EVENTS))).limit(1);
  return !activity;
}

export const INTERRUPTED_TURN_OUTCOME_UNKNOWN_EVENT = "native.interrupted_turn_outcome_unknown";

async function recordUnknownTurnOutcome(db: Db, run: { companyId: string; id: string; agentId: string },
  lastTurn: { eventType: string; payload: unknown }, runnerExit: Record<string, unknown>) {
  const [recorded] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, INTERRUPTED_TURN_OUTCOME_UNKNOWN_EVENT))).limit(1);
  if (recorded) return;
  const payload = asRecord(lastTurn.payload);
  const turnId = asRecord(payload.prpEvent).turnId ?? payload.turnId;
  await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
    eventType: INTERRUPTED_TURN_OUTCOME_UNKNOWN_EVENT, stream: "system", level: "warn",
    message: "The Runner stopped during a provider turn, so the turn's outcome is unknown. It is not replayed; a fresh session continues from the saved work.",
    payload: { turnId: typeof turnId === "string" ? turnId : null, lastTurnEvent: lastTurn.eventType, replayed: false,
      runnerExit: { stage: runnerExit.stage, reason: runnerExit.reason,
        ...(typeof runnerExit.runnerLifecycle === "string" ? { runnerLifecycle: runnerExit.runnerLifecycle } : {}) } } });
}

/** Automatic continuation is requested at most once per chain of runs, plus once for each deploy that interrupts a continuation. */
export const RESTART_RETRY_KEY_PREFIX = "restart-interrupted-turn:";

const MAX_RETRY_CHAIN = 32;

async function chainUsedAutomaticRetry(db: Db, run: { companyId: string; id: string; retryOfRunId: string | null;
  contextSnapshot: Record<string, unknown> | null }) {
  const visited = new Set<string>();
  let current: typeof run | undefined = run;
  while (current && !visited.has(current.id) && visited.size < MAX_RETRY_CHAIN) {
    visited.add(current.id);
    const retryId = current.contextSnapshot?.taskRetryRequestId;
    if (typeof retryId === "string") {
      const [receipt] = await db.select({ key: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), sql`${agentWakeupRequests.id}::text = ${retryId}`));
      if (receipt?.key?.startsWith(`task-retry:${RESTART_RETRY_KEY_PREFIX}`)) return true;
    }
    if (!current.retryOfRunId) return false;
    [current] = await db.select({ companyId: heartbeatRuns.companyId, id: heartbeatRuns.id, retryOfRunId: heartbeatRuns.retryOfRunId,
      contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, current.retryOfRunId)));
  }
  return visited.size >= MAX_RETRY_CHAIN;
}

const RESTART_CLAIM_DISPOSITIONS = ["reattach_remote_runner", "reattach_existing_runner", "resume_dead_runner",
  "bootstrap_incomplete"];

async function lostControllerToRestart(db: Db, run: { companyId: string; id: string }) {
  const [evidence] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, "native.recovery.transition"),
    sql`(${heartbeatRunEvents.payload}->>'restartKind' = 'graceful' or (${heartbeatRunEvents.payload}->>'trigger' is null
      and ${heartbeatRunEvents.payload}->>'runnerDisposition' in (${sql.join(RESTART_CLAIM_DISPOSITIONS.map(kind => sql`${kind}`), sql`, `)})))`,
  )).limit(1);
  return evidence !== undefined;
}

type PrepareChatRetry = NonNullable<Parameters<typeof requestTaskRetry>[0]["prepareChatRetry"]>;

/** A connected conversation's Retry goes through the chat service, which the
 * app registers at startup. Without it, a connected task keeps its Retry. */
let interruptedTurnChatRetry: PrepareChatRetry | undefined;
export function registerInterruptedTurnChatRetry(prepare: PrepareChatRetry | undefined) {
  interruptedTurnChatRetry = prepare;
}

/** The chat or comment message that woke the run is still on the task and was
 * not written by a run, so the run still owes it an answer. */
async function wakeMessageStillOwed(db: Db, companyId: string, issueId: string, reason: string | null | undefined,
  context: Record<string, unknown>, wake: { payload: Record<string, unknown> | null }) {
  if (reason !== EXTERNAL_CHAT_MESSAGE_WAKE_REASON && !isUserCommentContinuationReason(reason)) return false;
  const commentId = typeof context.wakeCommentId === "string" ? context.wakeCommentId
    : typeof wake.payload?.commentId === "string" ? wake.payload.commentId : null;
  if (!commentId) return false;
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    sql`${issueComments.id}::text = ${commentId}`, isNull(issueComments.deletedAt), isNull(issueComments.createdByRunId)));
  return comment !== undefined;
}

type Outcome ={ requested: true; requestId: string } | { requested: false; reason: string };

/**
 * Reattachment runs after a server restart and for a same-run retry of a remote
 * native run. When it fails because the original runner or sandbox is gone,
 * request the same Retry a user would click, once and idempotently per run,
 * under the requesting user's authority. Only when the run's user input was not
 * yet acted on, its last provider turn is settled, or the Runner process is
 * proven gone; an in-flight turn's outcome is then unknown and recorded, and the
 * Retry's fresh session never replays it. Without that proof the in-flight turn
 * keeps the visible Retry. A system wake continues this way only when the
 * controller journal proved that no turn was ever issued, or when it carried
 * owed work (an automatic retry, a system assignment, or a chat message still
 * on the task) whose Runner is proven gone, under the run's responsible user. Admission keeps every gate, including stop proof and
 * saved-work recovery before the next turn.
 */
export async function requestRestartInterruptedTurnRetry(db: Db, claim: NativeRestartRecoveryClaim): Promise<Outcome> {
  if (claim.kind !== "reattach_remote_runner") return { requested: false, reason: "not_reattachment" };
  return requestInterruptedNativeTurnRetry(db, claim.runId);
}

export async function requestInterruptedNativeTurnRetry(db: Db, runId: string): Promise<Outcome> {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run || run.runtimeMode !== "native" || run.status !== "failed" || !isReattachmentLoss(run.error))
    return { requested: false, reason: "not_reattachment_loss" };
  const context = run.contextSnapshot ?? {};
  const issueId = run.nativeIssueId ?? run.issueId ?? (typeof context.issueId === "string" ? context.issueId : null);
  if (!issueId || !run.wakeupRequestId) return { requested: false, reason: "source_missing" };
  const [lastTurn] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      inArray(heartbeatRunEvents.eventType, [...TURN_STARTED_EVENTS, ...TURN_SETTLED_EVENTS]),
    )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const runnerExit = await provenRunnerExit(db, run);
  const unknownTurn = lastTurn && !isProvenTurnSettlement(lastTurn) ? lastTurn : null;
  if (unknownTurn && !runnerExit) return { requested: false, reason: "provider_turn_unsettled" };
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id)));
  const userActorId = wake?.requestedByActorType === "user" ? wake.requestedByActorId : null;
  const reason = typeof context.wakeReason === "string" ? context.wakeReason : wake?.reason;
  let actorId = userActorId;
  if (!userActorId) {
    // System wakes keep their policy (only a new user turn continues them),
    // except when the controller journal positively proves that no turn was
    // ever issued: nothing the run did can be repeated, so the Retry runs once
    // under the run's responsible user. Missing events alone prove nothing,
    // because a turn can reach the provider before its events are stored.
    // Work the wake still owes the task also continues once the Runner is
    // proven gone: an automatic retry of earlier owed work, a system
    // assignment (a routine's dispatch), or a chat message that is still on
    // the task. Monitors and other system wakes keep their policy.
    const owedRedelivery = runnerExit !== null && wake !== undefined && (run.retryOfRunId !== null
      || reason === "issue_assigned" || await wakeMessageStillOwed(db, run.companyId, issueId, reason, context, wake));
    if (!wake || reason === "task_retry" || !run.responsibleUserId
      || !(owedRedelivery || await hasProvenNoProviderTurn(db, run, runnerExit)))
      return { requested: false, reason: "not_user_request" };
    if (owedRedelivery && await chainUsedAutomaticRetry(db, run) && !await lostControllerToRestart(db, run))
      return { requested: false, reason: "automatic_retry_used" };
    actorId = run.responsibleUserId;
  } else if (reason === "task_retry") {
    // A Retry this hook already requested gets no second automatic attempt unless a deploy interrupted it.
    const retryId = typeof context.taskRetryRequestId === "string" ? context.taskRetryRequestId : null;
    const [receipt] = retryId ? await db.select({ key: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), sql`${agentWakeupRequests.id}::text = ${retryId}`)) : [];
    if (!receipt) return { requested: false, reason: "retry_source_missing" };
    if (receipt.key?.startsWith(`task-retry:${RESTART_RETRY_KEY_PREFIX}`) && !await lostControllerToRestart(db, run))
      return { requested: false, reason: "automatic_retry_used" };
  } else if (isUserCommentContinuationReason(reason)) {
    const commentId = typeof context.wakeCommentId === "string" ? context.wakeCommentId
      : typeof wake!.payload?.commentId === "string" ? wake!.payload.commentId : null;
    const [comment] = commentId ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
      sql`${issueComments.id}::text = ${commentId}`, eq(issueComments.authorType, "user"),
      eq(issueComments.authorUserId, userActorId), isNull(issueComments.deletedAt), isNull(issueComments.createdByRunId),
    )) : [];
    if (!comment && reason !== "issue_assigned") return { requested: false, reason: "message_unavailable" };
  } else if (reason === EXTERNAL_CHAT_MESSAGE_WAKE_REASON) {
    // A linked person's chat message is stored by the chat bridge, not always
    // as that person's own comment, so the message itself must still be there.
    if (!await wakeMessageStillOwed(db, run.companyId, issueId, reason, context, wake!))
      return { requested: false, reason: "message_unavailable" };
  } else return { requested: false, reason: "not_user_request" };
  if (!actorId) return { requested: false, reason: "not_user_request" };
  const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues)
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
  if (!issue || issue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(issue.status))
    return { requested: false, reason: "task_changed" };
  if (unknownTurn && runnerExit) await recordUnknownTurnOutcome(db, run, unknownTurn, runnerExit);
  try {
    const receipt = await requestTaskRetry({ db, companyId: run.companyId, issueId, actorId,
      actorSource: actorId === "local-board" ? "local_implicit" : "session",
      idempotencyKey: `${RESTART_RETRY_KEY_PREFIX}${run.id}`, observedRunId: run.id, initiatedBy: "restart_recovery",
      prepareChatRetry: interruptedTurnChatRetry });
    return receipt.accepted && receipt.requestId
      ? { requested: true, requestId: receipt.requestId } : { requested: false, reason: "retry_stale" };
  } catch (error) {
    // Authority or conversation checks refused it; the visible Retry remains.
    if (!(error instanceof HttpError)) throw error;
    logger.info({ runId: run.id, status: error.status }, "interrupted native turn left for an explicit Retry");
    return { requested: false, reason: "retry_refused" };
  }
}
