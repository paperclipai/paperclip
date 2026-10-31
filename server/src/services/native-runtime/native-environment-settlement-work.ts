import { and, asc, eq, exists, gt, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import type { ProviderResourceDisposition } from "../environment-runtime.js";
import { nextRunLeaseReleaseAt, pendingRunLeaseReleaseCondition } from "../environment-lease-release-state.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeEnvironmentSettlementScope } from "../native-environment-settlement-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson" | "resultJson">;
export function nativeEnvironmentSettlementDisposition(run: Run, succeeded: boolean): ProviderResourceDisposition {
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  const saved = run.runnerProfileJson?.nativeResourceDisposition;
  const disposition = reference?.resourceDisposition
    ?? (saved === "keep_running" || saved === "stop_and_retain" || saved === "destroy" ? saved : "stop_and_retain");
  return succeeded && (!run.resultJson?.workspaceExportRetry || disposition === "destroy")
    ? disposition : "stop_and_retain";
}

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };
type Settlement = { runId: string; companyId: string; agentId: string; succeeded: boolean };



export function nativeEnvironmentSettlementWork(db: Db, settle: (input: Settlement) => Promise<void>) {
  const retryFloors = new Map<string, Entry>();
  const matches = (item: Entry, scope?: NativeEnvironmentSettlementScope) => !scope || item.companyId === scope.companyId
    && (!scope.issueId || item.issueId === scope.issueId) && (!scope.runId || item.id === scope.runId);
  function candidates(scope?: NativeEnvironmentSettlementScope, after?: string) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: nativeRunFinalizations.issueId, phase: nativeRunFinalizations.phase,
      runnerProfileJson: sql<Run["runnerProfileJson"]>`case when ${heartbeatRuns.runnerProfileJson} is null then null
        else jsonb_build_object('nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync',
          'nativeResourceDisposition', ${heartbeatRuns.runnerProfileJson}->'nativeResourceDisposition') end`,
      resultJson: sql<Run["resultJson"]>`case when ${heartbeatRuns.resultJson} is null then null
        else jsonb_build_object('workspaceExportRetry', ${heartbeatRuns.resultJson}->'workspaceExportRetry') end`,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.schemaStatus, "accepted")))
      .where(and(eq(heartbeatRuns.runtimeMode, "native"),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
        or(eq(nativeRunFinalizations.phase, "committed"),
          and(eq(nativeRunFinalizations.phase, "terminal_failure"),
            sql`${nativeRunFinalizations.failureDetail} ? 'workspaceFinalizeAttempt'`)),
        exists(db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
          eq(environmentLeases.companyId, heartbeatRuns.companyId), eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
          pendingRunLeaseReleaseCondition(true)))),
        scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
        after ? gt(heartbeatRuns.id, after) : undefined,
      )).orderBy(asc(heartbeatRuns.id)).limit(100);
  }
  async function entry(row: Awaited<ReturnType<typeof candidates>>[number]): Promise<Entry | null> {
    const dueAt = await nextRunLeaseReleaseAt(db, row.companyId, row.id,
      nativeEnvironmentSettlementDisposition(row, row.phase === "committed"));
    if (dueAt === null) { retryFloors.delete(row.id); return null; }
    return { id: row.id, companyId: row.companyId, issueId: row.issueId,
      dueAt: Math.max(dueAt, retryFloors.get(row.id)?.dueAt ?? 0) };
  }
  async function load(scope?: NativeEnvironmentSettlementScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (!signal?.aborted && canRun()) {
      const rows = await candidates(scope, after);
      for (const row of rows) {
        if (signal?.aborted || !canRun()) throw new Error("Native environment discovery stopped");
        const pending = await entry(row);
        if (pending) entries.push(pending);
      }
      if (rows.length < 100) {
        const retained = new Set(entries.map(item => item.id));
        for (const item of retryFloors.values()) if (matches(item, scope) && !retained.has(item.id)) retryFloors.delete(item.id);
        return entries;
      }
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native environment discovery stopped");
  }
  async function check(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native environment settlement stopped");
    const scope = { companyId: current.companyId, issueId: current.issueId, runId: current.id };
    const [row] = await candidates(scope);
    if (!row) { retryFloors.delete(current.id); return null; }
    const pending = await entry(row);
    if (!pending || pending.dueAt > Date.now()) return pending;
    if (signal?.aborted) throw new Error("Native environment settlement stopped");
    await settle({ runId: row.id, companyId: row.companyId, agentId: row.agentId, succeeded: row.phase === "committed" });


    const [remaining] = await candidates(scope);
    const next = remaining ? await entry(remaining) : null;
    if (!next) { retryFloors.delete(current.id); return null; }
    const floor = Date.now() + 30_000;


    retryFloors.set(current.id, { ...next, dueAt: floor });
    return { ...next, dueAt: Math.max(next.dueAt, floor) };
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeEnvironmentSettlement, batchSize: 1,
      decodeScope: (hint: string): NativeEnvironmentSettlementScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches,
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (item, signal) => {
        if (!canRun()) throw new Error("Native environment settlement paused");
        return await canRecover() ? check(item, signal) : null;
      },
    }, canRun);
  }
  return { load, check, register };
}
