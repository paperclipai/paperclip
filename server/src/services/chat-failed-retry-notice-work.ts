import type { ChatChannelService } from "./chat-channels.js";
import type { FailedRetryNoticeCursor, FailedRetryNoticeScope } from "./chat-channels/failed-retry-notices.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

type Entry = {
  id: string; companyId: string; issueId: string; dueAt: number;
  cursor: FailedRetryNoticeCursor | null; contended: boolean;
};
const batchSize = 100;

export function chatFailedRetryNoticeWork(service: Pick<ChatChannelService,
  "loadFailedRetryNoticeScopes" | "reconcileFailedRetryNotices">) {
  async function load(scope?: FailedRetryNoticeScope, signal?: AbortSignal): Promise<Entry[]> {
    return (await service.loadFailedRetryNoticeScopes(scope, signal)).map(row => ({
      ...row, id: `${row.companyId}:${row.issueId}`, dueAt: 0, cursor: null, contended: false,
    }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const result = await service.reconcileFailedRetryNotices({
      scope: { companyId: entry.companyId, issueId: entry.issueId },
      limit: batchSize, cursor: entry.cursor, signal,
    });
    const contended = entry.contended || result.contended;
    if (result.nextCursor) return { ...entry, cursor: result.nextCursor, contended, dueAt: Date.now() };
    return contended ? { ...entry, cursor: null, contended: false, dueAt: Date.now() + 1000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatFailedRetryNotices,
      decodeScope: (hint: string): FailedRetryNoticeScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: FailedRetryNoticeScope) => !scope ||
        (entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId)),
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
