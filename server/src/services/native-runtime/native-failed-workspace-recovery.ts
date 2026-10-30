import type { CancelledWorkspacePreservationScope } from "../cancelled-workspace-preservation-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, workspaceRestoreFailureCodesSql, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { recordRequiredWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { logActivity } from "../activity-log.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-workspace-finalization-ownership.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { logger } from "../../middleware/logger.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export async function preserveNativeFailedWorkspace(db: Db, selected: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "issueId" | "contextSnapshot" | "runnerProfileJson">,
  options: { allowPreterminal?: boolean; requireCancelledStop?: boolean; restartRecovery?: NativeRestartRecoveryClaim } = {}) {
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
    if (options.requireCancelledStop && coordinator?.phase !== "terminal_failure") return;
    const claim = options.restartRecovery;
    const reference = readNativeWorkspaceSyncReference(selected.runnerProfileJson?.nativeWorkspaceSync)!;
    const ownsClaim = Boolean(options.allowPreterminal && coordinator?.phase === "observed" && claim
      && claim.runId === selected.id && claim.leaseOwner === coordinator.leaseOwner
      && claim.controllerGeneration === coordinator.controllerGeneration && claim.providerAttempt === coordinator.attempt
      && coordinator.leaseExpiresAt && coordinator.leaseExpiresAt.getTime() > Date.now()
      && (claim.kind !== "reattach_remote_runner" || (claim.remote.kind !== "plugin_task" && claim.remote.providerLeaseId === reference.providerLeaseId
        && claim.remote.remoteCwd === reference.remoteCwd)));
    if ((coordinator?.leaseOwner || (claim && coordinator?.phase === "observed")) && !ownsClaim) throw new NativeWorkspaceFinalizationBusyError();
    if (!coordinator || coordinator.resultId
      || !(options.allowPreterminal ? ["observed", "terminal_failure"] : ["terminal_failure"]).includes(coordinator.phase)) return;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, selected.id), eq(heartbeatRuns.companyId, selected.companyId),
    )).for("update");
    if (!run || run.runtimeMode !== "native" || (!options.allowPreterminal && run.status !== "failed")) return;
    if (options.requireCancelledStop && (run.status !== "cancelled" || !hasAcknowledgedNativeStopIntent(run))) return;
    const currentReference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
    if (!currentReference || currentReference.state !== "prepared"
      || (claim?.kind === "reattach_remote_runner" && (claim.remote.kind === "plugin_task" || claim.remote.providerLeaseId !== currentReference.providerLeaseId
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
    if (retainFiles && !alreadyRetained) await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
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

export async function preserveOrphanedNativeWorkspace(db: Db, lease: Pick<typeof environmentLeases.$inferSelect,
  "companyId" | "heartbeatRunId">): Promise<boolean> {
  if (!lease.heartbeatRunId) return false;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId),
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed"),
  )).limit(1);
  if (!run || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  try {
    const retained = await preserveNativeFailedWorkspace(db, run);
    return Boolean(retained && hasRequiredWorkspaceRecovery(retained.resultJson));
  } catch (error) {
    if (error instanceof NativeWorkspaceFinalizationBusyError) return false;
    const code = retentionContentionCode(error);
    if (!code) throw error;
    logger.warn({ runId: run.id, code }, "Native workspace retention is waiting for its current owner");
    return false;
  }
}

function retentionContentionCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === "55P03" || value.code === "57014") return value.code;
    current = value.cause;
  }
  return null;
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
      try { await preserveNativeFailedWorkspace(db, run, { allowPreterminal: true, requireCancelledStop: true }); }
      catch (error) {
        if (error instanceof NativeWorkspaceFinalizationBusyError) continue;
        const code = retentionContentionCode(error);
        if (!code) throw error;
        logger.warn({ runId: run.id, code }, "Cancelled native workspace retention is waiting for its current owner");
      }
    }
  }
}

function pendingCancelledWorkspace() {
  return sql`${heartbeatRuns.runtimeMode} = 'native' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'
    AND ${heartbeatRuns.resultJson}->'nativeCancellation'->>'dispatchState' = 'acknowledged'
    AND (${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
      AND ${heartbeatRuns.resultJson}->>'workspaceRestoreFailure' IN (${workspaceRestoreFailureCodesSql})) IS NOT TRUE`;
}

export function registerCancelledWorkspacePreservationWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
  canRecover: () => Promise<boolean>) {
  type Entry = { id: string; companyId: string; dueAt: number };
  type Candidate = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId"
    | "runtimeMode" | "driverKind" | "status" | "resultJson" | "runnerProfileJson">;
  const eligible = (run: Candidate) => run.nativeIssueId !== null && hasAcknowledgedNativeStopIntent(run)
    && readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync)?.state === "prepared"
    && !hasRequiredWorkspaceRecovery(run.resultJson) && !nativeRunHasNoWorkspaceAccess(run);
  const scopeCondition = (scope?: CancelledWorkspacePreservationScope) => scope ? and(
    eq(heartbeatRuns.companyId, scope.companyId), scope.runId ? eq(heartbeatRuns.id, scope.runId) : undefined) : undefined;
  async function load(scope: CancelledWorkspacePreservationScope | undefined, signal?: AbortSignal) {
    if (!await canRecover()) return [];
    const entries: Entry[] = [];
    let cursor: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode,
        driverKind: heartbeatRuns.driverKind, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
        runnerProfileJson: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(pendingCancelledWorkspace(), scopeCondition(scope),
        cursor ? gt(heartbeatRuns.id, cursor) : undefined)).orderBy(asc(heartbeatRuns.id)).limit(100);
      for (const row of rows) if (eligible(row)) entries.push({ id: row.id, companyId: row.companyId, dueAt: 0 });
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
    throw new Error("Cancelled workspace preservation reconstruction stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (!await canRecover()) return null;
    const [run] = await db.select().from(heartbeatRuns)
      .where(and(pendingCancelledWorkspace(), scopeCondition({ companyId: entry.companyId, runId: entry.id })));
    if (!run || !eligible(run)) return null;
    if (!canRun() || signal?.aborted) throw new Error("Cancelled workspace preservation stopped");
    const [finalization] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
      eq(nativeRunFinalizations.issueId, run.nativeIssueId!),
    ));
    if (finalization?.resultId) return null;
    if (finalization?.phase !== "terminal_failure" || finalization.leaseOwner)
      return { ...entry, dueAt: Date.now() + 30_000 };
    const [source] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      or(eq(environmentLeases.status, "active"), and(inArray(environmentLeases.status, ["pending_cleanup", "released"]),
        eq(environmentLeases.leasePolicy, "ephemeral"))),
    )).limit(1);
    if (source) await preserveNativeFailedWorkspace(db, run, { allowPreterminal: true, requireCancelledStop: true });
    const [current] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    return current && current.status === "cancelled" && eligible(current) ? { ...entry, dueAt: Date.now() + 30_000 } : null;
  }
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.cancelledWorkspacePreservation, batchSize: 5,
    decodeScope: (hint: string): CancelledWorkspacePreservationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry: Entry, scope?: CancelledWorkspacePreservationScope) => !scope ||
      entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
    load, check,
  }, canRun);
}
