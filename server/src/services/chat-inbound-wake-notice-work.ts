import type { ChatChannelService } from "./chat-channels.js";
import type { InboundWakeNoticeCursor, InboundWakeNoticeScope } from "./chat-channels/inbound/wakeup-notices.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

type Entry = {
  id: string; companyId: string; issueId: string; dueAt: number;
  cursor: InboundWakeNoticeCursor | null; contended: boolean;
};
const batchSize = 100;

/** Admission receipts own queued/not-started/removed notices. The channel
 * service retains authorization and publication policy; this owner schedules
 * only unfinished batches, contention, and failed reconciliation. */
export function chatInboundWakeNoticeWork(service: Pick<ChatChannelService,
  "loadInboundWakeNoticeScopes" | "reconcileInboundWakeNotices">) {
  async function load(scope?: InboundWakeNoticeScope, signal?: AbortSignal): Promise<Entry[]> {
    return (await service.loadInboundWakeNoticeScopes(scope, signal)).map(row => ({
      ...row, id: `${row.companyId}:${row.issueId}`, dueAt: 0, cursor: null, contended: false,
    }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const result = await service.reconcileInboundWakeNotices({
      scope: { companyId: entry.companyId, issueId: entry.issueId },
      limit: batchSize, cursor: entry.cursor, signal,
    });
    const contended = entry.contended || result.contended;
    if (result.nextCursor) return { ...entry, cursor: result.nextCursor, contended, dueAt: Date.now() };
    // Finish the pass before revisiting contention, so a locked prefix cannot
    // starve later candidates. Do not forget an earlier page's unresolved lock.
    return contended ? { ...entry, cursor: null, contended: false, dueAt: Date.now() + 1000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatInboundWakeNotices,
      decodeScope: (hint: string): InboundWakeNoticeScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: InboundWakeNoticeScope) => !scope ||
        (entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId)),
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
