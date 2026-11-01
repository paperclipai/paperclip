import { and, asc, eq, gt, ne, notExists } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { onNativeWorkspaceFinalizationRelease, type NativeWorkspaceFinalizationScope } from "../native-workspace-finalization-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { measureRunPhase, withRunWorkspaceFinalizationTiming } from "../execution-preparation-timing.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { attemptNativeWorkspaceFinalization, recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };
type AttemptInput = Parameters<typeof attemptNativeWorkspaceFinalization>[0];


const OWNERSHIP_RECHECK_MS = 30_000;

export function nativeWorkspaceFinalizationWork(db: Db, options: {
  environmentRuntime?: AttemptInput["environmentRuntime"];
  pluginWorkerManager?: AttemptInput["pluginWorkerManager"];
  attempt?: typeof attemptNativeWorkspaceFinalization;
  onWorkspaceSettled(input: { runId: string; companyId: string; agentId: string; succeeded: boolean }): Promise<void>;
}) {
  function candidates(scope?: NativeWorkspaceFinalizationScope, after?: string) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: nativeRunFinalizations.issueId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.schemaStatus, "accepted")))
      .where(and(eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
        ne(nativeRunFinalizations.phase, "terminal_failure"),
        notExists(db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, nativeRunFinalizations.companyId),
          eq(workspaceOperations.heartbeatRunId, nativeRunFinalizations.runId), eq(workspaceOperations.issueId, nativeRunFinalizations.issueId),
          eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"),
        ))),
        scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
        after ? gt(nativeRunFinalizations.runId, after) : undefined,
      )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
  }
  function entry(row: Awaited<ReturnType<typeof candidates>>[number]): Entry {
    return { id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId,
      dueAt: Math.max(row.nextAttemptAt?.getTime() ?? 0, row.leaseOwner ? row.leaseExpiresAt?.getTime() ?? 0 : 0) };
  }
  async function load(scope?: NativeWorkspaceFinalizationScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (!signal?.aborted && canRun()) {
      const rows = await candidates(scope, after);
      entries.push(...rows.map(entry));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native workspace finalization discovery stopped");
  }
  function check(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    return withRunWorkspaceFinalizationTiming(current.id, () => checkWithinTrace(current, signal));
  }
  async function checkWithinTrace(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native workspace finalization stopped");
    const scope = { companyId: current.companyId, runId: current.id };
    const [row] = await candidates(scope);
    if (!row) return null;
    const due = entry(row);
    if (due.dueAt > Date.now()) return due;
    if (signal?.aborted) throw new Error("Native workspace finalization stopped");
    const outcome = await measureRunPhase("execution.workspace_finalize", () => (options.attempt ?? attemptNativeWorkspaceFinalization)({
      db, runId: current.id, environmentRuntime: options.environmentRuntime, pluginWorkerManager: options.pluginWorkerManager,
    }));
    if (outcome.kind === "retry") return { ...due, dueAt: outcome.retryAt.getTime() };
    if (outcome.kind === "waiting") {
      return outcome.reason === "busy" || outcome.reason === "platform_stop_pending"
        ? { ...due, dueAt: Date.now() + OWNERSHIP_RECHECK_MS } : null;
    }
    if (outcome.kind !== "completed" || outcome.operation.status === "succeeded") return null;
    const failure = await recordNativeWorkspaceFinalizationFailure(db, current.id, outcome.operation);
    if (failure.phase === "terminal_failure") {
      await options.onWorkspaceSettled({ runId: row.id, companyId: row.companyId, agentId: row.agentId, succeeded: false });
      return null;
    }
    const [remaining] = await candidates(scope);
    return remaining ? entry(remaining) : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeWorkspaceFinalization, batchSize: 1,
      decodeScope: (hint: string): NativeWorkspaceFinalizationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (item: Entry, scope?: NativeWorkspaceFinalizationScope) => !scope || item.companyId === scope.companyId
        && (!scope.issueId || item.issueId === scope.issueId) && (!scope.runId || item.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (item, signal) => {
        if (!canRun()) throw new Error("Native workspace finalization paused");
        if (!await canRecover()) return null;
        return check(item, signal);
      },
    }, canRun);
    const stop = onNativeWorkspaceFinalizationRelease(db, scope => worker.invalidate(JSON.stringify(scope)));
    return { ...worker, stop };
  }
  return { load, check, register };
}
