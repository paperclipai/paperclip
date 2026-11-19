import { and, asc, eq, gt, not, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeRunProjectionScope } from "../native-run-projection-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { pendingNativeStatusEffectsCondition } from "./native-pending-effect-work.js";
import { pendingNativeRunProjectionCondition, projectCommittedRun } from "./native-run-projection.js";
import { endSupersededNativeFinalizationRuns, NATIVE_FINALIZATION_SUPERSEDED } from "./native-run-finalizer.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { preserveSupersededWorkspaceExport, supersededWorkspaceExportUnpreservedCondition } from "./native-superseded-workspace-export.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };



/**
 * A run an earlier release left running after retiring its finalizer as
 * superseded. It gets the terminal status the retirement now writes itself.
 */
function supersededRunStillRunningCondition() {
  return and(eq(nativeRunFinalizations.phase, "terminal_failure"),
    eq(nativeRunFinalizations.failureCode, NATIVE_FINALIZATION_SUPERSEDED),
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    nativeRunnerOwnershipNotHeldCondition());
}

export function nativeRunProjectionWork(db: Db, project = projectCommittedRun,
  endSuperseded: (db: Db, runIds: readonly string[]) => Promise<string[]> = endSupersededNativeFinalizationRuns,
  preserveExport: (db: Db, runId: string) => Promise<{ recheckAt: number | null }> =
    (db, runId) => preserveSupersededWorkspaceExport(db, runId, preserveNativeFailedWorkspace)) {
  function candidates(scope?: NativeRunProjectionScope, after?: string) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: nativeRunFinalizations.issueId })
      .from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
      .where(and(or(and(eq(nativeRunFinalizations.phase, "committed"),
        pendingNativeRunProjectionCondition(db),
        not(pendingNativeStatusEffectsCondition(db))), supersededRunStillRunningCondition(),
        supersededWorkspaceExportUnpreservedCondition()),
        scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
        after ? gt(heartbeatRuns.id, after) : undefined,
      )).orderBy(asc(heartbeatRuns.id)).limit(100);
  }
  async function load(scope?: NativeRunProjectionScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      entries.push(...rows.map(row => ({ ...row, dueAt: 0 })));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native run projection discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native run projection stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId, runId: entry.id };
    const [pending] = await candidates(scope);
    if (!pending) return null;
    const [superseded] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
      .where(and(eq(nativeRunFinalizations.runId, entry.id), eq(nativeRunFinalizations.companyId, entry.companyId),
        supersededRunStillRunningCondition()));
    if (superseded) {
      await endSuperseded(db, [entry.id]);
      return (await candidates(scope)).length ? { ...entry, dueAt: Date.now() + 30_000 } : null;
    }
    const [unsavedExport] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
      .where(and(eq(nativeRunFinalizations.runId, entry.id), eq(nativeRunFinalizations.companyId, entry.companyId),
        supersededWorkspaceExportUnpreservedCondition()));
    if (unsavedExport) {
      // An ended superseded run still holds its workspace with unsaved files.
      // Record the files for automatic recovery; a refusal rests until the
      // next start or signal, except while its sandbox stop is still arriving.
      const { recheckAt } = await preserveExport(db, entry.id);
      return recheckAt === null ? null : { ...entry, dueAt: recheckAt };
    }
    const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, nativePhase: heartbeatRuns.nativePhase,
      runtimeMode: heartbeatRuns.runtimeMode, nativeIssueId: heartbeatRuns.nativeIssueId,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, entry.id), eq(heartbeatRuns.companyId, entry.companyId)));
    const [coordinator] = await db.select({ resultId: nativeRunFinalizations.resultId, issueId: nativeRunFinalizations.issueId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, entry.id),
        eq(nativeRunFinalizations.companyId, entry.companyId), eq(nativeRunFinalizations.issueId, entry.issueId),
        eq(nativeRunFinalizations.phase, "committed")));
    if (!run || !coordinator) return null;
    if (signal?.aborted) throw new Error("Native run projection stopped");
    await project({ db, run, coordinator, onlyWhenEffectsSettled: true });
    return (await candidates(scope)).length ? { ...entry, dueAt: Date.now() + 30_000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeRunProjection, batchSize: 25,
      decodeScope: (hint: string): NativeRunProjectionScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeRunProjectionScope) => !scope || entry.companyId === scope.companyId
        && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (entry, signal) => {
        if (!canRun()) throw new Error("Native run projection paused");
        return await canRecover() ? check(entry, signal) : null;
      },
    }, canRun);
  }
  return { load, check, register };
}
