import { and, asc, eq, exists, gt, not, notInArray } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeResultCommitScope } from "../native-result-commit-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { pendingNativeStatusEffectsCondition } from "./native-pending-effect-work.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { finalizeNativeRun, NativeFinalizationDeferredError, recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };



export function nativeResultCommitWork(db: Db, finalize = finalizeNativeRun) {
  function candidates(scope?: NativeResultCommitScope, after?: string) {
    return db.select({ id: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
      issueId: nativeRunFinalizations.issueId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.schemaStatus, "accepted")))
      .where(and(eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
        notInArray(nativeRunFinalizations.phase, ["committed", "terminal_failure"]),
        not(pendingNativeStatusEffectsCondition(db)),
        exists(db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, nativeRunFinalizations.companyId),
          eq(workspaceOperations.issueId, nativeRunFinalizations.issueId), eq(workspaceOperations.heartbeatRunId, nativeRunFinalizations.runId),
          eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"),
        ))),
        scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
        after ? gt(nativeRunFinalizations.runId, after) : undefined,
      )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
  }
  function entry(row: Awaited<ReturnType<typeof candidates>>[number]): Entry {
    return { id: row.id, companyId: row.companyId, issueId: row.issueId,
      dueAt: Math.max(row.nextAttemptAt?.getTime() ?? 0, row.leaseOwner ? row.leaseExpiresAt?.getTime() ?? 0 : 0) };
  }
  async function load(scope?: NativeResultCommitScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      entries.push(...rows.map(entry));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native result commit discovery stopped");
  }
  async function check(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native result commit stopped");
    const scope = { companyId: current.companyId, issueId: current.issueId, runId: current.id };
    const [row] = await candidates(scope);
    if (!row) return null;
    const due = entry(row);
    if (due.dueAt > Date.now()) return due;
    const [run] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, current.companyId), eq(heartbeatRuns.id, current.id)));
    if (!run) return null;
    if (signal?.aborted) throw new Error("Native result commit stopped");
    try {
      await finalize({ db, runId: current.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
        onlyWhenDue: true, skipNativeResponsePresentation: true, skipNativeReviewResponse: true,
        preserveProviderAttempt: Boolean(readNativeWorkspaceSyncReference(run.profile?.nativeWorkspaceSync)),
      });
    } catch (error) {

      if (!(error instanceof NativeFinalizationDeferredError)) {
        await recordNativeFinalizationFailure({ db, runId: current.id, error, projectRunStatus: true });
      }
    }
    const [remaining] = await candidates(scope);
    if (!remaining) return null;
    const next = entry(remaining);


    return next.dueAt > Date.now() ? next : { ...next, dueAt: Date.now() + 30_000 };
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeResultCommit, batchSize: 1,
      decodeScope: (hint: string): NativeResultCommitScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (item: Entry, scope?: NativeResultCommitScope) => !scope || item.companyId === scope.companyId
        && (!scope.issueId || item.issueId === scope.issueId) && (!scope.runId || item.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (item, signal) => {
        if (!canRun()) throw new Error("Native result commit paused");
        return await canRecover() ? check(item, signal) : null;
      },
    }, canRun);
  }
  return { load, check, register };
}
