import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { rebuildNativeEventCursorPage, type NativeEventCursorScope } from "./native-event-cursors.js";

type Entry = NativeEventCursorScope & { id: string; dueAt: number };

export function nativeEventCursorWork(db: Db) {
  async function load(scope?: NativeEventCursorScope, signal?: AbortSignal): Promise<Entry[]> {
    signal?.throwIfAborted();
    const rows = await db.select({ runId: heartbeatRuns.id, companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.eventCursorRebuildPending, true),
        scope ? and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId)) : undefined));
    return rows.map(row => ({ ...row, id: row.runId, dueAt: 0 }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const result = await rebuildNativeEventCursorPage(db, entry, signal);
    return result.pending ? { ...entry, dueAt: Date.now() + (result.contended ? 1000 : 0) } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeEventCursorRebuild,
      minimumPassIntervalMs: 0,
      decodeScope: (hint: string): NativeEventCursorScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeEventCursorScope) => !scope ||
        entry.companyId === scope.companyId && entry.runId === scope.runId,
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
