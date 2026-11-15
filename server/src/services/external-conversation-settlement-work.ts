import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import { externalConversationSettlementCandidates, pendingExternalConversationSettlement,
  settleExternalConversation, type ExternalConversationSettlementScope } from "./slack-conversation-lifecycle.js";

type Entry = { id: string; companyId: string; dueAt: number };

export function externalConversationSettlementWork(db: Db, settle = settleExternalConversation) {
  async function load(scope?: ExternalConversationSettlementScope, signal?: AbortSignal, canRun = () => true) {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const candidates = await externalConversationSettlementCandidates(db, scope, after);
      for (const row of candidates) {
        if (!canRun() || signal?.aborted) throw new Error("Conversation settlement discovery stopped");
        if (await pendingExternalConversationSettlement(db, row.companyId, row.id)) entries.push({ ...row, dueAt: 0 });
      }
      if (candidates.length < 100) return entries;
      after = candidates[candidates.length - 1].id;
    }
    throw new Error("Conversation settlement discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Conversation settlement stopped");
    await settle(db, entry.companyId, entry.id);
    return await pendingExternalConversationSettlement(db, entry.companyId, entry.id)
      ? { ...entry, dueAt: Date.now() + 30_000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.externalConversationSettlement, batchSize: 25,
      decodeScope: (hint: string): ExternalConversationSettlementScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: ExternalConversationSettlementScope) => !scope || entry.companyId === scope.companyId
        && (!scope.issueId || entry.id === scope.issueId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (entry, signal) => {
        if (!canRun()) throw new Error("Conversation settlement paused");
        return await canRecover() ? check(entry, signal) : null;
      },
    }, canRun);
  }
  return { load, check, register };
}
