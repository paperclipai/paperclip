import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { onRetainedNativeSessionCleanupRelease, type RetainedNativeSessionCleanupScope } from "../retained-native-session-cleanup-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { findRetainedNativeSessionCleanupCandidates, pendingRetainedNativeSessionCleanup, runRetainedNativeSessionCleanup,
  type RetainedNativeSessionCleanup } from "./retained-native-session-cleanup.js";

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };


const PROCESS_EXIT_PROBE_MS = 30_000;

export function retainedNativeSessionCleanupWork(db: Db, cleanup: RetainedNativeSessionCleanup) {
  async function load(scope?: RetainedNativeSessionCleanupScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (!signal?.aborted && canRun()) {
      const rows = await findRetainedNativeSessionCleanupCandidates(db, { scope, after, limit: 100, includeLeased: true });
      for (const row of rows) entries.push({ id: row.runId, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId,
        dueAt: row.leaseOwner ? row.leaseExpiresAt?.getTime() ?? 0 : 0 });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].runId;
    }
    throw new Error("Retained native cleanup discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Retained native cleanup stopped");
    let pending = pendingRetainedNativeSessionCleanup(db, entry.id);
    if (!pending) {
      const [current] = await findRetainedNativeSessionCleanupCandidates(db, {
        scope: { companyId: entry.companyId, runId: entry.id }, limit: 1, includeLeased: true,
      });
      if (!current) return null;
      if (current.leaseOwner && current.leaseExpiresAt && current.leaseExpiresAt.getTime() > Date.now()) {
        return { ...entry, dueAt: current.leaseExpiresAt.getTime() };
      }
      if (signal?.aborted) throw new Error("Retained native cleanup stopped");
      pending = runRetainedNativeSessionCleanup(db, { companyId: entry.companyId, runId: entry.id }, cleanup);
    }
    const result = await pending;
    if (result.status !== "deferred") return null;
    if (result.waitFor === "lease_expiry") return { ...entry, dueAt: result.retryAt.getTime() };
    if (result.waitFor === "process_exit") return { ...entry, dueAt: Date.now() + PROCESS_EXIT_PROBE_MS };


    return null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.retainedNativeSessionCleanup, batchSize: 1,
      decodeScope: (hint: string): RetainedNativeSessionCleanupScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: RetainedNativeSessionCleanupScope) => !scope || entry.companyId === scope.companyId
        && (!scope.runId || entry.id === scope.runId) && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.agentId || entry.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (entry, signal) => {
        if (!canRun()) throw new Error("Retained native cleanup paused");
        return check(entry, signal);
      },
    }, canRun);
    const unsubscribe = onRetainedNativeSessionCleanupRelease(db, scope => worker.invalidate(JSON.stringify(scope)));
    return { ...worker, stop: unsubscribe };
  }
  return { load, check, register };
}
