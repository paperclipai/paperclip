import { and, asc, eq, gt, inArray, isNotNull, not, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import type { NativeRecoveryNoticeScope } from "../native-recovery-notice-notifications.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { pendingNativeStatusEffectsCondition } from "./native-pending-effect-work.js";
import { pendingNativeRunProjectionCondition } from "./native-run-projection.js";

function matchingNotice(runId: string | typeof nativeRunFinalizations.runId) {
  return and(
    eq(issueRecoveryActions.kind, "active_run_watchdog"),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}::text`,
    or(sql`${issueRecoveryActions.wakePolicy}->>'kind' = 'resume_native_run'`,
      eq(issueRecoveryActions.cause, "native_workspace_finalization_owner_unverified")),
  );
}

export function pendingNativeRecoveryNotices(db: Db, scope?: NativeRecoveryNoticeScope, after?: string) {
  return db.select({ id: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
    issueId: nativeRunFinalizations.issueId })
    .from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.phase, "committed"), isNotNull(nativeRunFinalizations.resultId),
      eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
      not(pendingNativeStatusEffectsCondition(db)), not(pendingNativeRunProjectionCondition(db)),
      sql`exists (${db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, nativeRunFinalizations.companyId),
        eq(issueRecoveryActions.sourceIssueId, nativeRunFinalizations.issueId), matchingNotice(nativeRunFinalizations.runId)))})`,
      scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
      scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
      scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
      after ? gt(nativeRunFinalizations.runId, after) : undefined,
    )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
}



export async function resolveCommittedNativeRecoveryNotices(db: Db,
  scope: { companyId: string; issueId: string; runId: string }, onlyWhenSettled = false) {
  const [pending] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
    matchingNotice(scope.runId))).limit(1);
  if (!pending) return;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;


    const [coordinator] = await tx.select({ phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, scope.companyId),
        eq(nativeRunFinalizations.issueId, scope.issueId), eq(nativeRunFinalizations.runId, scope.runId))).for("update");
    if (!coordinator || coordinator.phase !== "committed" || !coordinator.resultId) return;
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId))).for("update");
    if (!issue) return;
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.runtimeMode, "native"),
      nativeRunnerOwnershipNotHeldCondition())).for("update");
    if (!run) return;
    if (onlyWhenSettled && !(await pendingNativeRecoveryNotices(tx, scope)).length) return;
    const actions = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
      matchingNotice(scope.runId))).for("update");
    for (const action of actions) await issueRecoveryActionService(tx).resolveActiveForIssue({
      companyId: scope.companyId, sourceIssueId: scope.issueId, actionId: action.id,
      status: "resolved", outcome: "restored",
      resolutionNote: "The accepted native result and workspace finalization committed successfully; this run needs no further finalization retry.",
    });
  });
}
