import { registerTaskWatchdogWork } from "../task-watchdog-work.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import { decodeIssueRecoveryHint, ISSUE_RECOVERY_BACKSTOP_MS, issueRecoveryScopeMatches, resolveIssueGraph, type IssueRecoveryScope }
  from "../issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { recoveryActionSweepCondition } from "./blocker-stall-wakeups.js";

type Entry = { id: string; companyId: string; dueAt: number };
type Scope = { companyId: string; issueId: string; onDeferredDeadline: (at: number) => void };
const PAGE_SIZE = 100;

export const resolvedDependencyCandidate = sql`exists (select 1 from ${issueRelations} r where r.company_id = ${issues.companyId}
      and r.related_issue_id = ${issues.id} and r.type = 'blocks' offset 0)
    and not exists (select 1 from ${issueRelations} r inner join ${issues} blocker
      on blocker.id = r.issue_id and blocker.company_id = r.company_id
      where r.company_id = ${issues.companyId} and r.related_issue_id = ${issues.id}
        and r.type = 'blocks' and blocker.status <> 'done' offset 0)`;

export function registerIssueRecoveryWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    stranded(scope: Scope): Promise<unknown>;
    orphanBlockers(scope: { companyId: string }): Promise<unknown>;
    recoveryActions(scope: { companyId: string }): Promise<{ blockerStallWakeFailures?: number; blockerStallRetryAt?: number | null } | unknown>;
    dependencies(scope: Scope): Promise<{ enqueueFailed: number }>;
    locks(scope: Scope): Promise<unknown>;
    watchdogs(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
    schedulingSuppressed(): Promise<boolean>;
    /** The assigned-work invariant (assigned-work-sweep.ts). */
    assignedWork?: {
      listSuspects(scope: { companyId?: string; issueId?: string; issueIds?: string[] }, cursor: string | null, limit: number):
        Promise<Array<{ id: string; companyId: string; updatedAt: Date }>>;
      checkIssue(scope: Scope): Promise<unknown>;
    };
  },
  canRun: () => boolean,
  options: { backstopMs?: number } = {},
) {
  function fullPasses() {
    const completedAt = new Map<string, number>();
    return {
      backstop: (scope: IssueRecoveryScope | undefined) => scope?.backstop
        ? Math.max(completedAt.get("*") ?? 0, completedAt.get(scope.companyId) ?? 0) + (options.backstopMs ?? ISSUE_RECOVERY_BACKSTOP_MS)
        : null,
      loaded(scope: IssueRecoveryScope | undefined, complete: boolean) {
        if (complete && !scope?.issueId && (!isGraph(scope) || scope?.wholeCompany)) completedAt.set(scope?.companyId ?? "*", Date.now());
      },
    };
  }
  const reconstructionIntervalMs = (scope: IssueRecoveryScope | undefined) => scope?.backstop || scope?.graphRunId || scope?.graphIssueId ? 0 : 30_000;
  const scopeKey = (scope: IssueRecoveryScope | undefined) => scope
    ? JSON.stringify([scope.companyId, scope.issueId, scope.graphRunId, scope.graphIssueId, scope.backstop]) : "*";
  const isGraph = (scope: IssueRecoveryScope | undefined) => Boolean(scope?.graphRunId || scope?.graphIssueId);
  const graphs = new Map<string, { at: number; ids: Promise<string[] | null> }>();
  async function resolveGraph(scope: IssueRecoveryScope | undefined) {
    if (!scope || !isGraph(scope)) return;
    const key = scopeKey(scope);
    for (const [other, cached] of graphs) if (cached.at < Date.now() - 2_000) graphs.delete(other);
    let cached = graphs.get(key);
    if (!cached) {
      cached = { at: Date.now(), ids: resolveIssueGraph(db, { companyId: scope.companyId, runId: scope.graphRunId, issueId: scope.graphIssueId }) };
      graphs.set(key, cached);
    }
    const ids = await cached.ids.catch(error => { graphs.delete(key); throw error; });
    scope.issueIds = ids ?? undefined;
    scope.wholeCompany = ids === null;
  }
  async function toCompany(scope: IssueRecoveryScope | undefined, worker: { invalidate(hint?: string): void }) {
    await resolveGraph(scope);
    if (!scope?.wholeCompany) return false;
    worker.invalidate(JSON.stringify({ companyId: scope.companyId }));
    return true;
  }
  function register(queue: DeliveryQueue, statuses: string[] | null, check: (scope: Scope) => Promise<unknown>, eligible?: SQL) {
    const cursors = new Map<string, string>();
    const passes = fullPasses();
    let enabled = false;
    const worker: ReturnType<typeof registerScopedDeadlineWork<Entry, IssueRecoveryScope>> = registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
      queue,
      reconstructionIntervalMs,
      backstop: passes.backstop,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      decodeScope: decodeIssueRecoveryHint,
      matches: issueRecoveryScopeMatches,
      load: async scope => {
        const key = scopeKey(scope);
        if (!enabled) { cursors.delete(key); return []; }
        if (await toCompany(scope, worker)) return { rows: null, complete: true };
        const cursor = cursors.get(key);
        const rows = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
          scope ? eq(issues.companyId, scope.companyId) : undefined,
          scope?.issueId ? eq(issues.id, scope.issueId) : undefined,
          scope?.issueIds ? inArray(issues.id, scope.issueIds) : undefined,
          cursor ? gt(issues.id, cursor) : undefined,
          statuses ? inArray(issues.status, statuses) : or(isNotNull(issues.checkoutRunId), isNotNull(issues.executionRunId)),
          statuses ? isNull(issues.hiddenAt) : undefined,
          statuses ? isNull(issues.assigneeUserId) : undefined,
          statuses ? or(isNotNull(issues.assigneeAgentId), eq(issues.status, "in_review")) : undefined,
          eligible,
        )).orderBy(asc(issues.id)).limit(PAGE_SIZE);
        const complete = rows.length < PAGE_SIZE;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        passes.loaded(scope, complete);
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
    return worker;
  }
  /** Event-driven: run terminal states, hold settlements and boot mark the
   * company dirty; checks schedule their own grace and back-off deadlines.
   * Newest-updated tasks are checked first, a small batch per pass. */
  function registerAssignedWork(sweep: NonNullable<typeof owner.assignedWork>) {
    type Suspect = Entry & { updatedAt: number };
    const cursors = new Map<string, string>();
    const passes = fullPasses();
    let enabled = false;
    const worker: ReturnType<typeof registerScopedDeadlineWork<Suspect, IssueRecoveryScope>> = registerScopedDeadlineWork<Suspect, IssueRecoveryScope>(coordinator, {
      queue: DELIVERY_QUEUES.assignedWorkInvariant,
      reconstructionIntervalMs,
      backstop: passes.backstop,
      batchSize: 25,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      decodeScope: decodeIssueRecoveryHint,
      matches: issueRecoveryScopeMatches,
      priority: entry => entry.updatedAt,
      mergeEntry: (pending, loaded) => ({ ...loaded, dueAt: Math.max(pending.dueAt, loaded.dueAt) }),
      load: async scope => {
        const key = scopeKey(scope);
        if (!enabled) { cursors.delete(key); return []; }
        if (await toCompany(scope, worker)) return { rows: null, complete: true };
        const rows = await sweep.listSuspects(scope ? { companyId: scope.companyId, issueId: scope.issueId,
          issueIds: scope.issueIds } : {}, cursors.get(key) ?? null, PAGE_SIZE);
        const complete = rows.length < PAGE_SIZE;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        passes.loaded(scope, complete);
        return { rows: rows.map(row => ({ id: row.id, companyId: row.companyId, updatedAt: row.updatedAt.getTime(), dueAt: Date.now() })), complete };
      },
      check: async entry => {
        if (!enabled) return null;
        let next: number | null = null;
        await sweep.checkIssue({ companyId: entry.companyId, issueId: entry.id,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
        return next === null ? null : { ...entry, dueAt: next };
      },
    }, canRun);
    return worker;
  }
  function registerCompany(queue: DeliveryQueue, kind: "blockers" | "actions", check: (scope: { companyId: string }) => Promise<number | null | void>) {
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
            .from(issueRecoveryActions).where(and(recoveryActionSweepCondition(),
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
      check: async entry => {
        if (!enabled) return null;
        const next = await check({ companyId: entry.companyId });
        return typeof next === "number" ? { ...entry, dueAt: next } : null;
      },
    }, canRun);
  }
  const assignments = register(DELIVERY_QUEUES.strandedAssignments, ["todo", "in_progress", "in_review"], owner.stranded);
  const orphanBlockers = registerCompany(DELIVERY_QUEUES.orphanBlockers, "blockers", async scope => { await owner.orphanBlockers(scope); });
  const recoveryActions = registerCompany(DELIVERY_QUEUES.activeRecoveryActions, "actions", async scope => {
    const result = await owner.recoveryActions(scope);
    // A stall wake that failed to enqueue must be retried, not dropped with the entry.
    const failures = result && typeof result === "object" && "blockerStallWakeFailures" in result
      ? Number(result.blockerStallWakeFailures) : 0;
    if (failures > 0) throw new Error("Blocker stall wake remains undelivered");
    // A stall held back because the agent takes no wakes is checked again later.
    const retryAt = result && typeof result === "object" && "blockerStallRetryAt" in result ? result.blockerStallRetryAt : null;
    return typeof retryAt === "number" ? retryAt : null;
  });
  const dependencies = register(DELIVERY_QUEUES.resolvedDependencies, ["blocked"], async scope => {
    const result = await owner.dependencies(scope);
    if (result.enqueueFailed > 0) throw new Error("Resolved dependency wake remains undelivered");
  }, resolvedDependencyCandidate);
  const locks = register(DELIVERY_QUEUES.staleIssueLocks, null, owner.locks);
  const assignedWork = owner.assignedWork ? registerAssignedWork(owner.assignedWork) : null;
  const watchdogs = registerTaskWatchdogWork(db, coordinator, {
    reconcile: owner.watchdogs, enabled: async () => !(await owner.schedulingSuppressed()),
  }, canRun);
  const workers = [assignments, orphanBlockers, recoveryActions, dependencies, locks, watchdogs,
    ...(assignedWork ? [assignedWork] : [])];
  return { watchdogs, assignments, assignedWork, ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
