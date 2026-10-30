import { registerTaskWatchdogWork } from "../task-watchdog-work.js";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import type { IssueRecoveryScope } from "../issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };
type Scope = { companyId: string; issueId: string; onDeferredDeadline: (at: number) => void };

export function registerIssueRecoveryWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    stranded(scope: Scope): Promise<unknown>;
    dependencies(scope: Scope): Promise<{ enqueueFailed: number }>;
    locks(scope: Scope): Promise<unknown>;
    watchdogs(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  function register(queue: DeliveryQueue, statuses: string[] | null, check: (scope: Scope) => Promise<unknown>) {
    return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
      queue,
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
      load: async scope => {
        const rows = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
          scope ? eq(issues.companyId, scope.companyId) : undefined,
          statuses ? inArray(issues.status, statuses) : or(isNotNull(issues.checkoutRunId), isNotNull(issues.executionRunId)),
          statuses ? isNull(issues.hiddenAt) : undefined,
        ));
        return rows.map(row => ({ ...row, dueAt: Date.now() }));
      },
      check: async entry => {
        if (await owner.schedulingSuppressed()) return null;
        let next: number | null = null;
        await check({ companyId: entry.companyId, issueId: entry.id,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
        return next === null ? null : { ...entry, dueAt: next };
      },
    }, canRun);
  }
  const assignments = register(DELIVERY_QUEUES.strandedAssignments, ["todo", "in_progress", "in_review"], owner.stranded);
  const dependencies = register(DELIVERY_QUEUES.resolvedDependencies, ["blocked"], async scope => {
    const result = await owner.dependencies(scope);
    if (result.enqueueFailed > 0) throw new Error("Resolved dependency wake remains undelivered");
  });
  const locks = register(DELIVERY_QUEUES.staleIssueLocks, null, owner.locks);
  const watchdogs = registerTaskWatchdogWork(db, coordinator, {
    reconcile: owner.watchdogs, enabled: async () => !(await owner.schedulingSuppressed()),
  }, canRun);
  return { ready: Promise.all([assignments.ready, dependencies.ready, locks.ready, watchdogs.ready]),
    wake() { assignments.invalidate(); dependencies.invalidate(); locks.invalidate(); watchdogs.invalidate(); },
    async stop() { await Promise.all([assignments.stop(), dependencies.stop(), locks.stop(), watchdogs.stop()]); } };
}
