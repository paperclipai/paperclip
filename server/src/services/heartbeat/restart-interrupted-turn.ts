import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeRestartRecoveryClaim } from "../native-runtime/native-restart-recovery.js";
import { isUserCommentContinuationReason } from "../explicit-native-continuation.js";
import { requestTaskRetry } from "../task-retry.js";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";

/** Reattachment could not find the run's original runner or allocation: the
 * sandbox lease or plugin task is gone, or the remote runner process is not
 * there to verify. This is infrastructure, not the task's own failure. */
const REATTACHMENT_LOST_ERRORS = ["native_remote_recovery_lease_mismatch", "native_plugin_recovery_lease_mismatch",
  "runner_remote_process_identity_unavailable"];

const TURN_STARTED_EVENTS = ["turn.submitted", "turn.started", "turn.accepted"];
const TURN_SETTLED_EVENTS = ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A terminal event proves the turn ended only when the provider reported it.
 * A driver that lost its event stream records `providerTerminalObserved: false`
 * (on the event or its stored PRP source): the real outcome is unknown, and
 * another turn could repeat work that already happened. */
function isProvenTurnSettlement(event: { eventType: string; payload: unknown }) {
  if (!TURN_SETTLED_EVENTS.includes(event.eventType)) return false;
  const payload = asRecord(event.payload);
  return payload.providerTerminalObserved !== false &&
    asRecord(asRecord(payload.prpEvent).payload).providerTerminalObserved !== false;
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
 * outcome is unknown, so it keeps the visible Retry. Admission keeps every gate,
 * including stop proof and saved-work recovery before the next turn.
 */
export async function requestRestartInterruptedTurnRetry(db: Db, claim: NativeRestartRecoveryClaim): Promise<Outcome> {
  if (claim.kind !== "reattach_remote_runner") return { requested: false, reason: "not_reattachment" };
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, claim.runId));
  if (!run || run.runtimeMode !== "native" || run.status !== "failed" || !REATTACHMENT_LOST_ERRORS.includes(run.error ?? ""))
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
  const actorId = wake?.requestedByActorType === "user" ? wake.requestedByActorId : null;
  const reason = typeof context.wakeReason === "string" ? context.wakeReason : wake?.reason;
  // System wakes keep their policy: only a new user turn continues them.
  if (!actorId) return { requested: false, reason: "not_user_request" };
  if (reason === "task_retry") {
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
      eq(issueComments.authorUserId, actorId), isNull(issueComments.deletedAt), isNull(issueComments.createdByRunId),
    )) : [];
    if (!comment && reason !== "issue_assigned") return { requested: false, reason: "message_unavailable" };
  } else return { requested: false, reason: "not_user_request" };
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
