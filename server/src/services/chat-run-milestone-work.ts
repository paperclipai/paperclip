import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { ChatRunMilestoneScope } from "./chat-run-milestone-notifications.js";
import { enqueueChatRunLifecycleMilestones, loadChatRunLifecycleMilestoneScopes } from "./chat-run-publications.js";

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };
const batchSize = 100;

/** No periodic discovery: reconstruct on startup/committed changes, drain
 * current notices, and retain a retry only for failure or an unfinished batch. */
export function chatRunMilestoneWork(db: Db, publicBaseUrl?: string | null) {
  async function load(scope?: ChatRunMilestoneScope, signal?: AbortSignal): Promise<Entry[]> {
    return (await loadChatRunLifecycleMilestoneScopes(db, scope, signal)).map(row => ({
      ...row, id: `${row.companyId}:${row.issueId}`, dueAt: 0,
    }));
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const inserted = await enqueueChatRunLifecycleMilestones(db, {
      scope: { companyId: entry.companyId, issueId: entry.issueId },
      publicBaseUrl, limit: batchSize, signal,
    });
    // A short batch exhausted the selector, including currently suppressed
    // candidates. Their dependencies must signal a later eligibility change.
    return inserted === batchSize ? { ...entry, dueAt: Date.now() } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatRunMilestones,
      decodeScope: (hint: string): ChatRunMilestoneScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: ChatRunMilestoneScope) => !scope ||
        (entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId)),
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
