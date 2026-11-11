import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { ChatRunProjectionScope } from "./chat-run-publication-policy.js";
import { loadNativeChatProgressScopes, reconcileNativeChatProgress } from "./chat-native-progress.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };
const batchSize = 100;

export function nativeChatProgressWork(db: Db) {
  async function load(scope?: ChatRunProjectionScope, signal?: AbortSignal): Promise<Entry[]> {
    return (await loadNativeChatProgressScopes(db, scope, signal)).map(row => ({
      ...row, id: `${row.companyId}:${row.issueId}`, dueAt: 0,
    }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const result = await reconcileNativeChatProgress(db, {
      scope: { companyId: entry.companyId, issueId: entry.issueId }, limit: batchSize, signal,
    });
    if (result.inserted === batchSize) return { ...entry, dueAt: Date.now() };
    return result.contended ? { ...entry, dueAt: Date.now() + 1000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatNativeProgress,
      decodeScope: (hint: string): ChatRunProjectionScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: ChatRunProjectionScope) => !scope ||
        (entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId)),
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
