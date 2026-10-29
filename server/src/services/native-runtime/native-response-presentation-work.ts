import { nativeResponsePresentationCandidates } from "./native-response-presentation-query.js";
import { asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeResponsePresentationScope } from "../native-response-presentation-notifications.js";
import { onCommittedChatResponseAuthorityRegistered } from "../durable-chat-wakeup.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { recoverCommittedNativeChatResponse } from "./native-run-finalizer.js";

export function registerNativeResponsePresentationWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
  return nativeResponsePresentationWork(db).register(coordinator, canRun);
}

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };

export function nativeResponsePresentationWork(db: Db) {
  const candidates = (scope?: NativeResponsePresentationScope, after?: string, runId?: string) => {
    const query = nativeResponsePresentationCandidates(scope, after, runId).as("pending_native_response");
    return db.select().from(query).orderBy(asc(query.id));
  };
  async function load(scope?: NativeResponsePresentationScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, dueAt: row.nextAttemptAt?.getTime() ?? 0 });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native response presentation discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId };
    const [current] = await candidates(scope, undefined, entry.id);
    if (!current) return null;
    if (current.nextAttemptAt && current.nextAttemptAt.getTime() > Date.now()) return { ...entry, dueAt: current.nextAttemptAt.getTime() };
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const recoveryStartedAt = Date.now();
    await recoverCommittedNativeChatResponse(db, { ...scope, runId: entry.id, onlyWhenDue: true });
    const [remaining] = await candidates(scope, undefined, entry.id);
    return remaining?.nextAttemptAt && remaining.nextAttemptAt.getTime() > recoveryStartedAt
      ? { ...entry, dueAt: remaining.nextAttemptAt.getTime() } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeResponsePresentation,
      decodeScope: (hint: string): NativeResponsePresentationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeResponsePresentationScope) => !scope || entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId) && (!scope.agentId || entry.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (entry, signal) => {
        if (!canRun()) throw new Error("Native response presentation recovery paused");
        return check(entry, signal);
      },
    }, canRun);
    const unsubscribe = onCommittedChatResponseAuthorityRegistered(db, () => worker.invalidate());
    return { ...worker, stop: unsubscribe };
  }
  return { load, check, register };
}
