import { completeTerminatedRemoteNativeSessionCleanup } from "../vendor/paperclip-runner/index.js";
import { hasRemoteTerminationReceipt, remoteLeaseCleanupScope } from "./remote-execution-termination.js";
import { z } from "zod";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  approvals, issueApprovals, issueThreadInteractions,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";

type Run = typeof heartbeatRuns.$inferSelect;
const terminal = ["failed", "interrupted", "timed_out", "cancelled"];

function processStopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Called under the issue lock, in the transaction that creates the new turn.
 * A user request authorizes a new conversation, not replay of the failed run.
 * Unknown action outcomes and all prior records stay intact.
 */
export async function admitExplicitNativeContinuation(input: {
  db: Db; companyId: string; issueId: string; agentId: string;
  actorType: string | null | undefined; actorId: string | null | undefined;
  reason: string | null; commentId: string | null; successorRunId: string;
  dryRun?: boolean;
}): Promise<{ previousRunId: string; commentId: string } | null> {
  const { db, companyId, issueId, agentId, actorId, commentId } = input;
  if (input.actorType !== "user" || !actorId || !commentId ||
      !["issue_commented", "issue_reopened_via_comment"].includes(input.reason ?? "")) return null;
  if (!z.string().guid().safeParse(commentId).success) return null;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  ));
  if (!task || task.assigneeAgentId !== agentId || ["done", "cancelled"].includes(task.status)) return null;
  const [comment] = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId), eq(issueComments.authorType, "user"),
    eq(issueComments.authorUserId, actorId), isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt),
  ));
  if (!comment?.body.trim()) return null;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return null;
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  if (blocker && blocker.recoveryActionId === null) return null;
  const [pendingInteraction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  const [pendingApproval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId),
  )).where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issueId),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (pendingInteraction || pendingApproval) return null;

  const sources: Run[] = [];
  for (const action of actions) {
    const runId = action.evidence.runId ?? action.evidence.sourceRunId;
    if (typeof runId !== "string") return null;
    // Text comparison keeps malformed historical evidence a hold, not a UUID cast error.
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id}::text = ${runId}`,
    ));
    if (!run || run.agentId !== agentId || !terminal.includes(run.status) ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
        !run.finishedAt || comment.createdAt <= run.finishedAt) return null;
    if (adapterExecutionControls.has(run.id)) return null;
    const unusedAdmission = run.status === "cancelled" && !run.startedAt &&
      run.errorCode === "execution_reconciliation_required" &&
      !run.processPid && !run.processGroupId && !run.nativeSessionId;
    if (run.runtimeMode !== "native" && !unusedAdmission) return null;
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id),
    )).for("update");
    if (coordinator && (coordinator.phase !== "terminal_failure" || coordinator.leaseOwner ||
        coordinator.resultId || coordinator.failureDetail?.successorRunId)) return null;
    const leases = await db.select()
      .from(environmentLeases).where(and(
        eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
      ));
    const remote = leases.some(lease => lease.provider !== "local");
    if (remote) {
      // Never interpret remote PIDs using the control-plane host's process table.
      if (!leases.every(hasRemoteTerminationReceipt)) return null;
      if (!input.dryRun && !leases.every(lease => completeTerminatedRemoteNativeSessionCleanup({
        companyId, runId: run.id, remoteCleanupScope: remoteLeaseCleanupScope(lease)!,
      }))) return null;
    } else {
      if (leases.some(lease => !lease.releasedAt || lease.cleanupStatus === "failed")) return null;
      if (!unusedAdmission) {
        // A missing process identity is not evidence that a provider exited.
        if (!run.processPid && !run.processGroupId) return null;
        if (run.processPid && !processStopped(run.processPid)) return null;
        if (run.processGroupId && !processStopped(-run.processGroupId)) return null;
      }
    }
    sources.push(run);
  }
  const nativeSources = sources.filter(run => run.runtimeMode === "native");
  if (!nativeSources.length) return null;
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
    ne(heartbeatRuns.id, input.successorRunId),
  )).limit(1);
  if (active) return null;
  const previous = nativeSources.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  // Prove required task history is available before retiring any hold.
  await buildExecutionContinuation({ db, companyId, issueId, agentId,
    context: { previousRunId: previous.id, wakeCommentId: commentId },
    summary: null, exposeLowTrustRaw: false });
  if (input.dryRun) return { previousRunId: previous.id, commentId };
  const authorization = { actorId, commentId, runId: input.successorRunId,
    previousRunId: previous.id, recordedAt: new Date().toISOString() };
  await db.update(nativeRunFinalizations).set({
    failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "explicit_user_continuation" })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.runId, nativeSources.map(run => run.id))));
  for (const action of actions) {
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: "A new user message starts a fresh conversation turn. Prior action outcomes remain recorded.",
      resolutionNote: "The user continued after the prior execution stopped. No action outcomes were inferred.",
      wakePolicy: null, monitorPolicy: null,
      evidence: { ...action.evidence, explicitUserContinuation: authorization,
        ...(action.evidence.automaticRecovery ? { automaticRecovery: {
          ...(action.evidence.automaticRecovery as Record<string, unknown>), replay: "explicit_user_continuation",
        } } : {}),
      },
    }).where(eq(issueRecoveryActions.id, action.id));
  }
  await persistActivity(db, { companyId, actorType: "user", actorId,
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: issueId,
    details: { continuation: "explicit_user_message", ...authorization,
      recoveryActionIds: actions.map(action => action.id), previousRunIds: sources.map(run => run.id) },
  });
  return { previousRunId: previous.id, commentId };
}
