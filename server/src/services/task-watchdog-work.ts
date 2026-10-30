import { and, eq } from "drizzle-orm";
import { issueWatchdogs, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { IssueRecoveryScope } from "./issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };

export function registerTaskWatchdogWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    enabled(): Promise<boolean>;
    reconcile(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
  },
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
    queue: DELIVERY_QUEUES.taskWatchdogs,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
    load: async scope => (await db.select({ id: issueWatchdogs.id, companyId: issueWatchdogs.companyId })
      .from(issueWatchdogs).where(and(eq(issueWatchdogs.status, "active"),
        scope ? eq(issueWatchdogs.companyId, scope.companyId) : undefined)))
      .map(row => ({ ...row, dueAt: Date.now() })),
    check: async entry => {
      if (!(await owner.enabled())) return null;
      let next: number | null = null;
      const result = await owner.reconcile({ companyId: entry.companyId, watchdogId: entry.id,
        onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
      if (result.incomplete > 0) throw new Error(`Task watchdog ${entry.id} in company ${entry.companyId} has an incomplete subtree`);
      return next === null ? null : { ...entry, dueAt: next };
    },
  }, canRun);
}
