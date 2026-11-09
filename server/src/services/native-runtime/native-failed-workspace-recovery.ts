import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { recordRequiredWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { logActivity } from "../activity-log.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-workspace-finalization-ownership.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { logger } from "../../middleware/logger.js";

export async function preserveNativeFailedWorkspace(db: Db, selected: typeof heartbeatRuns.$inferSelect, options: { allowPreterminal?: boolean; restartRecovery?: NativeRestartRecoveryClaim } = {}) {
  if (readNativeWorkspaceSyncReference(selected.runnerProfileJson?.nativeWorkspaceSync)?.state !== "prepared") return;
  const issueId = selected.nativeIssueId ?? selected.issueId ?? selected.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return;
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [task] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, selected.companyId),
    )).for("update");
    if (!task) return;
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, selected.id), eq(nativeRunFinalizations.companyId, selected.companyId),
      eq(nativeRunFinalizations.issueId, issueId),
    )).for("update");
    const claim = options.restartRecovery;
    const reference = readNativeWorkspaceSyncReference(selected.runnerProfileJson?.nativeWorkspaceSync)!;
    const ownsClaim = Boolean(options.allowPreterminal && coordinator?.phase === "observed" && claim
      && claim.runId === selected.id && claim.leaseOwner === coordinator.leaseOwner
      && claim.controllerGeneration === coordinator.controllerGeneration && claim.providerAttempt === coordinator.attempt
      && coordinator.leaseExpiresAt && coordinator.leaseExpiresAt.getTime() > Date.now()
      && (claim.kind !== "reattach_remote_runner" || (claim.remote.providerLeaseId === reference.providerLeaseId
        && claim.remote.remoteCwd === reference.remoteCwd)));
    if ((coordinator?.leaseOwner || (claim && coordinator?.phase === "observed")) && !ownsClaim) throw new NativeWorkspaceFinalizationBusyError();
    if (!coordinator || coordinator.resultId
      || !(options.allowPreterminal ? ["observed", "terminal_failure"] : ["terminal_failure"]).includes(coordinator.phase)) return;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, selected.id), eq(heartbeatRuns.companyId, selected.companyId),
    )).for("update");
    if (!run || run.runtimeMode !== "native" || (!options.allowPreterminal && run.status !== "failed")) return;
    const currentReference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
    if (!currentReference || currentReference.state !== "prepared"
      || (claim?.kind === "reattach_remote_runner" && (claim.remote.providerLeaseId !== currentReference.providerLeaseId
        || claim.remote.remoteCwd !== currentReference.remoteCwd))) return;
    const [source] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, currentReference.leaseId), eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, currentReference.providerLeaseId),
    )).limit(1);
    if (!source || source.issueId !== issueId || source.metadata?.remoteCwd !== currentReference.remoteCwd
      || (source.executionWorkspaceId && source.executionWorkspaceId !== currentReference.workspaceId)) return;
    // Ownership settlement still applies to workspace-less external sessions.
    // Their Runner descriptor is not evidence that user files need exporting.
    const retainFiles = !nativeRunHasNoWorkspaceAccess(run);
    const alreadyRetained = hasRequiredWorkspaceRecovery(run.resultJson);
    let retained = !retainFiles || alreadyRetained ? run : await recordRequiredWorkspaceRestoreFailure(tx as unknown as Db, run, { workspaceRestoreFailure: "restore_failed" }, source);
    if (!retained || retainFiles && !hasRequiredWorkspaceRecovery(retained.resultJson)) return;
    if (options.allowPreterminal && coordinator.phase === "observed") {
      await notifyExecutionRunWork(tx);
      const [settled] = await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure",
        leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null, nextAttemptAt: null,
        recoveryState: "blocked", failureCode: coordinator.failureCode ?? "native_continuation_requires_reconciliation", updatedAt: new Date(),
      }).where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
        eq(nativeRunFinalizations.issueId, issueId), eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
        ownsClaim && claim ? and(eq(nativeRunFinalizations.leaseOwner, claim.leaseOwner),
          eq(nativeRunFinalizations.controllerGeneration, claim.controllerGeneration), eq(nativeRunFinalizations.attempt, claim.providerAttempt),
          gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`)) : isNull(nativeRunFinalizations.leaseOwner),
      )).returning({ id: nativeRunFinalizations.runId });
      if (!settled) throw new NativeWorkspaceFinalizationBusyError();
      [retained] = await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).returning();
    }
    if (retainFiles && !alreadyRetained) await logActivity(tx as unknown as Db, {
      companyId: run.companyId, actorType: "system", actorId: "native-workspace-recovery",
      action: "issue.workspace_recovery_required", entityType: "issue",
      entityId: issueId,
      agentId: run.agentId, runId: run.id,
      details: { runId: run.id, leaseId: source.id, reason: "native_execution_failed_before_workspace_export" },
    });
    return retained;
  });
}

const cancelledWorkspaceCursors = new WeakMap<Db, string>();

/** Older controllers could acknowledge Stop without pinning prepared files.
 * Record only the file obligation; the existing stop-only cleanup worker owns
 * provider teardown. This never resumes a turn or changes the task's status. */
export async function preserveCancelledNativeWorkspaces(db: Db) {
  const select = (cursor?: string) => db.selectDistinct({ runId: heartbeatRuns.id })
    .from(environmentLeases).innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId),
    )).innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .where(and(or(eq(environmentLeases.status, "active"), and(
      inArray(environmentLeases.status, ["pending_cleanup", "released"]), eq(environmentLeases.leasePolicy, "ephemeral"),
    )), eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.status, "cancelled"), eq(nativeRunFinalizations.phase, "terminal_failure"),
      isNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.leaseOwner),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
      sql`${heartbeatRuns.resultJson}->'nativeCancellation'->>'dispatchState' = 'acknowledged'`,
      cursor ? gt(heartbeatRuns.id, cursor) : undefined,
    )).orderBy(asc(heartbeatRuns.id)).limit(5);
  let candidates = await select(cancelledWorkspaceCursors.get(db));
  if (!candidates.length) {
    cancelledWorkspaceCursors.delete(db);
    candidates = await select();
  }
  for (const candidate of candidates) {
    cancelledWorkspaceCursors.set(db, candidate.runId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.runId));
    if (run && hasAcknowledgedNativeStopIntent(run)) {
      try { await preserveNativeFailedWorkspace(db, run, { allowPreterminal: true }); }
      catch (error) {
        if (error instanceof NativeWorkspaceFinalizationBusyError) continue;
        let current: unknown = error;
        let code: string | null = null;
        for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
          const value = current as { code?: unknown; cause?: unknown };
          if (value.code === "55P03" || value.code === "57014") { code = value.code; break; }
          current = value.cause;
        }
        if (!code) throw error;
        logger.warn({ runId: run.id, code }, "Cancelled native workspace retention is waiting for its current owner");
      }
    }
  }
}
