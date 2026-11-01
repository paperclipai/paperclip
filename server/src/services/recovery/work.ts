import { registerTaskWatchdogWork } from "../task-watchdog-work.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import type { IssueRecoveryScope } from "../issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };
type Scope = { companyId: string; issueId: string; onDeferredDeadline: (at: number) => void };
const PAGE_SIZE = 100;

export function registerIssueRecoveryWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    stranded(scope: Scope): Promise<unknown>;
    orphanBlockers(scope: { companyId: string }): Promise<unknown>;
    recoveryActions(scope: { companyId: string }): Promise<unknown>;
    dependencies(scope: Scope): Promise<{ enqueueFailed: number }>;
    locks(scope: Scope): Promise<unknown>;
    watchdogs(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  function register(queue: DeliveryQueue, statuses: string[] | null, check: (scope: Scope) => Promise<unknown>) {
    const cursors = new Map<string, string>();
    let enabled = false;
    return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
      queue,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
      matches: (entry, scope) => !scope || (entry.companyId === scope.companyId && (!scope.issueId || entry.id === scope.issueId)),
      load: async scope => {
        const key = scope ? JSON.stringify([scope.companyId, scope.issueId]) : "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        const rows = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
          scope ? eq(issues.companyId, scope.companyId) : undefined,
          scope?.issueId ? eq(issues.id, scope.issueId) : undefined,
          cursor ? gt(issues.id, cursor) : undefined,
          statuses ? inArray(issues.status, statuses) : or(isNotNull(issues.checkoutRunId), isNotNull(issues.executionRunId)),
          statuses ? isNull(issues.hiddenAt) : undefined,
          statuses ? isNull(issues.assigneeUserId) : undefined,
          statuses ? or(isNotNull(issues.assigneeAgentId), eq(issues.status, "in_review")) : undefined,
        )).orderBy(asc(issues.id)).limit(PAGE_SIZE);
        const complete = rows.length < PAGE_SIZE;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
      },
      check: async entry => {
        if (!enabled) return null;
        let next: number | null = null;
        await check({ companyId: entry.companyId, issueId: entry.id,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
        return next === null ? null : { ...entry, dueAt: next };
      },
    }, canRun);
  }
  function registerCompany(queue: DeliveryQueue, kind: "blockers" | "actions", check: (scope: { companyId: string }) => Promise<unknown>) {
    const cursors = new Map<string, string>();
    let enabled = false;
    return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
      queue,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
      load: async scope => {
        const key = scope?.companyId ?? "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        const rows = kind === "actions"
          ? await db.selectDistinct({ id: issueRecoveryActions.companyId, companyId: issueRecoveryActions.companyId })
            .from(issueRecoveryActions).where(and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
              scope ? eq(issueRecoveryActions.companyId, scope.companyId) : undefined,
              cursor ? gt(issueRecoveryActions.companyId, cursor) : undefined))
            .orderBy(asc(issueRecoveryActions.companyId)).limit(PAGE_SIZE)
          : await db.selectDistinct({ id: issues.companyId, companyId: issues.companyId }).from(issues).where(and(
              inArray(issues.status, ["todo", "blocked"]), isNull(issues.assigneeAgentId), isNull(issues.assigneeUserId),
              isNotNull(issues.createdByAgentId),
              scope ? eq(issues.companyId, scope.companyId) : undefined,
              cursor ? gt(issues.companyId, cursor) : undefined,
              sql`exists (select 1 from ${issueRelations} r inner join ${issues} dependent
                on dependent.id = r.related_issue_id and dependent.company_id = r.company_id
                where r.company_id = ${issues.companyId} and r.issue_id = ${issues.id}
                and r.type = 'blocks' and dependent.status not in ('done', 'cancelled'))`,
            )).orderBy(asc(issues.companyId)).limit(PAGE_SIZE);
        const complete = rows.length < PAGE_SIZE;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
      },
      check: async entry => { if (enabled) await check({ companyId: entry.companyId }); return null; },
    }, canRun);
  }
  const assignments = register(DELIVERY_QUEUES.strandedAssignments, ["todo", "in_progress", "in_review"], owner.stranded);
  const orphanBlockers = registerCompany(DELIVERY_QUEUES.orphanBlockers, "blockers", owner.orphanBlockers);
  const recoveryActions = registerCompany(DELIVERY_QUEUES.activeRecoveryActions, "actions", owner.recoveryActions);
  const dependencies = register(DELIVERY_QUEUES.resolvedDependencies, ["blocked"], async scope => {
    const result = await owner.dependencies(scope);
    if (result.enqueueFailed > 0) throw new Error("Resolved dependency wake remains undelivered");
  });
  const locks = register(DELIVERY_QUEUES.staleIssueLocks, null, owner.locks);
  const watchdogs = registerTaskWatchdogWork(db, coordinator, {
    reconcile: owner.watchdogs, enabled: async () => !(await owner.schedulingSuppressed()),
  }, canRun);
  const workers = [assignments, orphanBlockers, recoveryActions, dependencies, locks, watchdogs];
  return { ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
