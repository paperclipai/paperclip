import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeRecoveryNoticeScope } from "../native-recovery-notice-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { pendingNativeRecoveryNotices, resolveCommittedNativeRecoveryNotices } from "./native-recovery-notices.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };

export function nativeRecoveryNoticeWork(db: Db, resolve = resolveCommittedNativeRecoveryNotices) {
  async function load(scope?: NativeRecoveryNoticeScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await pendingNativeRecoveryNotices(db, scope, after);
      entries.push(...rows.map(row => ({ ...row, dueAt: 0 })));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native recovery notice discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native recovery notice resolution stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId, runId: entry.id };
    await resolve(db, scope, true);
    return (await pendingNativeRecoveryNotices(db, scope)).length ? { ...entry, dueAt: Date.now() + 30_000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeRecoveryNotices, batchSize: 25,
      decodeScope: (hint: string): NativeRecoveryNoticeScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeRecoveryNoticeScope) => !scope || entry.companyId === scope.companyId
        && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (entry, signal) => {
        if (!canRun()) throw new Error("Native recovery notice resolution paused");
        return await canRecover() ? check(entry, signal) : null;
      },
    }, canRun);
  }
  return { load, check, register };
}
