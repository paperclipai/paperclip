import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeRestartRecoveryClaim } from "../native-runtime/native-restart-recovery.js";
import { isUserCommentContinuationReason } from "../explicit-native-continuation.js";
import { requestTaskRetry } from "../task-retry.js";
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

/**
 * The run's last refused reattachment proved its Runner process gone and its
 * controller journal proved that no turn command was ever issued
 * (`providerTurnIssued: false`, recorded by the executor). No turn or tool
 * event may exist either.
 */
async function hasProvenNoProviderTurn(db: Db, run: { companyId: string; id: string }) {
  const [activity] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, PROVIDER_TURN_ACTIVITY_EVENTS))).limit(1);
  if (activity) return false;
  const [refusal] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, "native.remote_runner_recovery_failed"),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const proof = asRecord(asRecord(refusal?.payload).remoteRunnerRecovery);
  return proof.stage === "process_verification" && proof.reason === "process_not_running" && proof.providerTurnIssued === false;
}

/** Automatic continuation is requested at most once per chain of runs. */
export const RESTART_RETRY_KEY_PREFIX = "restart-interrupted-turn:";

type Outcome = { requested: true; requestId: string } | { requested: false; reason: string };

/**
 * Reattachment runs after a server restart and for a same-run retry of a remote
 * native run. When it fails because the original runner or sandbox is gone,
 * request the same Retry a user would click, once and idempotently per run,
 * under the requesting user's authority. Only when the run's user input was not
 * yet acted on, or its last provider turn is settled; an in-flight turn's
 * outcome is unknown, so it keeps the visible Retry. A system wake continues
 * this way only when the controller journal proved that no turn was ever
 * issued, under the run's responsible user. Admission keeps every gate,
 * including stop proof and saved-work recovery before the next turn.
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
  if (lastTurn && !isProvenTurnSettlement(lastTurn)) return { requested: false, reason: "provider_turn_unsettled" };
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
    if (!wake || reason === "task_retry" || !run.responsibleUserId || !await hasProvenNoProviderTurn(db, run))
      return { requested: false, reason: "not_user_request" };
    actorId = run.responsibleUserId;
  } else if (reason === "task_retry") {
    // A Retry this hook already requested gets no second automatic attempt.
    const retryId = typeof context.taskRetryRequestId === "string" ? context.taskRetryRequestId : null;
    const [receipt] = retryId ? await db.select({ key: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), sql`${agentWakeupRequests.id}::text = ${retryId}`)) : [];
    if (!receipt) return { requested: false, reason: "retry_source_missing" };
    if (receipt.key?.startsWith(`task-retry:${RESTART_RETRY_KEY_PREFIX}`)) return { requested: false, reason: "automatic_retry_used" };
  } else if (isUserCommentContinuationReason(reason)) {
    const commentId = typeof context.wakeCommentId === "string" ? context.wakeCommentId
      : typeof wake!.payload?.commentId === "string" ? wake!.payload.commentId : null;
    const [comment] = commentId ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
      sql`${issueComments.id}::text = ${commentId}`, eq(issueComments.authorType, "user"),
      eq(issueComments.authorUserId, userActorId), isNull(issueComments.deletedAt), isNull(issueComments.createdByRunId),
    )) : [];
    if (!comment && reason !== "issue_assigned") return { requested: false, reason: "message_unavailable" };
  } else return { requested: false, reason: "not_user_request" };
  if (!actorId) return { requested: false, reason: "not_user_request" };
  const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues)
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
  if (!issue || issue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(issue.status))
    return { requested: false, reason: "task_changed" };
  try {
    const receipt = await requestTaskRetry({ db, companyId: run.companyId, issueId, actorId,
      actorSource: actorId === "local-board" ? "local_implicit" : "session",
      idempotencyKey: `${RESTART_RETRY_KEY_PREFIX}${run.id}`, observedRunId: run.id, initiatedBy: "restart_recovery" });
    return receipt.accepted && receipt.requestId
      ? { requested: true, requestId: receipt.requestId } : { requested: false, reason: "retry_stale" };
  } catch (error) {
    // Authority or conversation checks refused it; the visible Retry remains.
    if (!(error instanceof HttpError)) throw error;
    logger.info({ runId: run.id, status: error.status }, "interrupted native turn left for an explicit Retry");
    return { requested: false, reason: "retry_refused" };
  }
}
