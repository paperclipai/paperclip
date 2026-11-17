import { registerTaskWatchdogWork } from "../task-watchdog-work.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import { decodeIssueRecoveryHint, ISSUE_RECOVERY_BACKSTOP_MS, ISSUE_RECOVERY_FULL_BACKSTOP_MS, ISSUE_RECOVERY_RELOAD_HINT, issueRecoveryBackstopHint,
  issueRecoveryScopeMatches, resolveAgentIssues, resolveIssueGraph, type IssueRecoveryScope } from "../issue-recovery-notifications.js";
import { setDatabaseWorkReconnectHint } from "@paperclipai/db/work-signals";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { recoveryActionSweepCondition } from "./blocker-stall-wakeups.js";
import { changedTaskCondition } from "./changed-tasks.js";
import { createRecoveryPassReads, type RecoveryPassReads } from "./pass-reads.js";

type Entry = { id: string; companyId: string; dueAt: number; fromDeadline?: true;
  origin?: "reload" | "reconnect" | "backstop" | "company" | "every_task" | "agent" | "hint" };
type Scope = { companyId: string; issueId: string; onDeferredDeadline: (at: number, detail?: { unchanged: boolean }) => void;
  pass?: RecoveryPassReads };
const PAGE_SIZE = 100;
/** How long past its deadline a saved deferral of a task that left its queue is kept. */
const STALE_DEFERRAL_MS = 10 * 60_000;
/** How long past its saved deadline a task that keeps deferring leaves its row as is.
 * A boot re-checks every task with a row whatever its deadline, so only the
 * stale prune reads it; refreshing well before STALE_DEFERRAL_MS keeps the
 * row of a task that is still deferring from ever looking stale. */
const DEFERRAL_REFRESH_MS = STALE_DEFERRAL_MS / 2;

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
      listSuspects(scope: { companyId?: string; issueId?: string; issueIds?: string[]; changed?: SQL }, cursor: string | null, limit: number):
        Promise<Array<{ id: string; companyId: string; updatedAt: Date }>>;
      checkIssue(scope: Scope): Promise<unknown>;
    };
  },
  canRun: () => boolean,
  options: { backstopMs?: number; fullBackstopMs?: number } = {},
) {
  const backstopMs = options.backstopMs ?? ISSUE_RECOVERY_BACKSTOP_MS;
  const fullBackstopMs = options.fullBackstopMs ?? options.backstopMs ?? ISSUE_RECOVERY_FULL_BACKSTOP_MS;
  /** A plain company hint: changed rows only, unless no full pass is recent. */
  const isPlainCompany = (scope: IssueRecoveryScope) => !scope.issueId && !isGraph(scope) && !scope.agentId && !scope.everyTask
    && !scope.backstop && !scope.reload;
  /** When each company was last fully checked and last looked at for changes.
   * Full passes are saved, so a replaced or overlapping server keeps the same
   * hourly schedule instead of starting over with a full pass at boot. */
  function fullPasses(queue: DeliveryQueue) {
    const completedAt = new Map<string, number>(), changedAt = new Map<string, number>();
    type Scan = { filter: SQL | null; startedAt: number; reloadCutoff?: number; unchecked: Set<string>;
      seen: Set<string>; savedDeferrals?: Map<string, number> };
    const scans = new Map<string, Scan>();
    // A full pass is saved only once every task it loaded has been checked, so
    // a server replaced mid-pass leaves no saved pass and its replacement runs
    // the full pass again instead of skipping the tasks it never reached.
    const unsaved: Array<{ unchecked: Set<string>; save: () => Promise<void> }> = [];
    // The saved deferral row (issue_recovery_deferrals) this server last read
    // or wrote for a task, by its deadline. Every delete names that deadline,
    // so it never removes a row another server rewrote since; a lost race
    // costs one extra check, never a missed one.
    const deferred = new Map<string, number>();
    // Saved passes from before scheduling was suppressed are ignored: entries
    // were dropped while suppressed, so the next pass must look at every task.
    let distrustBefore = 0;
    const lastFull = (companyId: string) => Math.max(completedAt.get("*") ?? 0, completedAt.get(companyId) ?? 0);
    const lastLook = (companyId: string) => Math.max(lastFull(companyId), changedAt.get("*") ?? 0, changedAt.get(companyId) ?? 0);
    const fullDue = (companyId: string) => Date.now() - lastFull(companyId) >= fullBackstopMs;
    const at = (ms: number) => sql`${new Date(ms).toISOString()}::timestamptz`;
    async function readSaved(companyId: string) {
      if (!fullDue(companyId)) return;
      // An unreadable record means a full pass, never a missed check.
      const rows: Array<{ started_at?: string | Date | null }> = await db.execute<{ started_at: string | Date }>(sql`select started_at
        from issue_recovery_full_passes where company_id = ${companyId}::uuid and queue = ${queue}`).catch(() => []);
      const saved = rows[0]?.started_at ? new Date(rows[0].started_at).getTime() : 0;
      if (saved > distrustBefore) completedAt.set(companyId, Math.max(completedAt.get(companyId) ?? 0, saved));
    }
    async function save(startedAt: number, companies: SQL) {
      // A lost record costs one extra full pass later, never a missed check, so
      // it must not fail (and repeat) the pass it describes.
      await db.execute(sql`insert into issue_recovery_full_passes (company_id, queue, started_at)
        select c.id, ${queue}, ${at(startedAt)} from companies c where ${companies}
        on conflict (company_id, queue) do update set started_at = greatest(issue_recovery_full_passes.started_at, excluded.started_at)`)
        .catch(() => undefined);
    }
    /** Whether the company has a saved full pass newer than `cutoff`. */
    const recentFull = (companyId: SQL, cutoff: number) => sql`exists (select 1 from issue_recovery_full_passes p
      where p.company_id = ${companyId} and p.queue = ${queue} and p.started_at > ${at(cutoff)})`;
    return {
      backstop: (scope: IssueRecoveryScope | undefined) => scope?.backstop ? lastLook(scope.companyId) + backstopMs : null,
      /** The row filter for this load: changed rows, or null to load every task. */
      async filter(scope: IssueRecoveryScope | undefined, key: string, firstPage: boolean): Promise<SQL | null> {
        if (firstPage || !scans.has(key)) {
          const scan: Scan = { startedAt: Date.now(), filter: null, unchecked: new Set(), seen: new Set() };
          scans.set(key, scan);
          if (scope?.reload) {
            // Per company: every task when no saved full pass is recent, else
            // the rows changed since that pass or this server's last reload.
            const cutoff = scan.reloadCutoff = Math.max(Date.now() - fullBackstopMs, distrustBefore);
            const since = sql`(greatest((select p.started_at from issue_recovery_full_passes p
              where p.company_id = ${issues.companyId} and p.queue = ${queue}), ${at(changedAt.get("*") ?? 0)})
              - ${`${ISSUE_RECOVERY_BACKSTOP_MS} milliseconds`}::interval)`;
            // A task with a pending deferral is checked again too, so its
            // deadline survives the server that set it.
            scan.filter = sql`(not ${recentFull(sql`${issues.companyId}`, cutoff)} or ${changedTaskCondition(since)}
              or exists (select 1 from issue_recovery_deferrals d where d.queue = ${queue} and d.issue_id = ${issues.id}))`;
            // Unreadable deferrals mean a full reload, never a lost deadline.
            const saved = await db.execute<{ issue_id: string; due_at: string | Date }>(sql`select issue_id::text, due_at
              from issue_recovery_deferrals where queue = ${queue}`).then(rows => [...rows], () => null);
            if (saved) {
              scan.savedDeferrals = new Map(saved.map(row => [row.issue_id, new Date(row.due_at).getTime()]));
              for (const [id, dueAt] of scan.savedDeferrals) deferred.set(id, dueAt);
            } else scan.filter = null;
          } else if (scope && (scope.backstop || isPlainCompany(scope))) {
            await readSaved(scope.companyId);
            if (!fullDue(scope.companyId)) scan.filter = changedTaskCondition(new Date(lastLook(scope.companyId) - ISSUE_RECOVERY_BACKSTOP_MS));
          }
        }
        return scans.get(key)!.filter;
      },
      async loaded(scope: IssueRecoveryScope | undefined, key: string, complete: boolean) {
        if (!complete) return;
        const scan = scans.get(key);
        scans.delete(key);
        const startedAt = scan?.startedAt ?? Date.now();
        const saveOnceChecked = async (companies: SQL) => {
          const pending = { unchecked: scan?.unchecked ?? new Set<string>(), save: () => save(startedAt, companies) };
          if (pending.unchecked.size === 0) { await pending.save(); return; }
          // A task that leaves the queue unchecked (deleted, or no longer
          // eligible) holds its pass unsaved; drop the oldest rather than grow.
          unsaved.push(pending);
          if (unsaved.length > 16) unsaved.shift();
        };
        if (scope?.reload) {
          changedAt.set("*", Math.max(changedAt.get("*") ?? 0, startedAt));
          // The reload loads every task with a saved deferral that this queue
          // can still check. A row it did not load belongs to a task that left
          // the queue, for whatever reason, and no check will clear it. It is
          // deleted once its task is closed or its deadline is well past; the
          // delete also requires the deadline it read, so a row another server
          // wrote since stays.
          const stale = [...scan?.savedDeferrals ?? []].filter(([id]) => !scan!.seen.has(id))
            .map(([id, dueAt]) => ({ id, due: new Date(dueAt).toISOString() }));
          if (stale.length > 0) {
            for (const { id } of stale) deferred.delete(id);
            await db.execute(sql`delete from issue_recovery_deferrals d using jsonb_to_recordset(${JSON.stringify(stale)}::jsonb)
                as s(id uuid, due timestamptz)
              where d.queue = ${queue} and d.issue_id = s.id and d.due_at = s.due
                and (d.due_at < ${at(Date.now() - STALE_DEFERRAL_MS)} or exists (select 1 from issues i
                  where i.id = d.issue_id and i.status in ('done', 'cancelled')))`).catch(() => undefined);
          }
          // The companies this reload loaded in full now have a recent full pass.
          await saveOnceChecked(sql`not ${recentFull(sql`c.id`, scan?.reloadCutoff ?? startedAt)}`);
        } else if (scan?.filter && scope) changedAt.set(scope.companyId, Math.max(changedAt.get(scope.companyId) ?? 0, startedAt));
        else if (!scope?.issueId && !scope?.agentId && (!isGraph(scope) || scope?.wholeCompany)) {
          const companyKey = scope?.companyId ?? "*";
          completedAt.set(companyKey, Math.max(completedAt.get(companyKey) ?? 0, startedAt));
          await saveOnceChecked(scope ? sql`c.id = ${scope.companyId}::uuid` : sql`true`);
        }
      },
      /** Rows a load returned; each must be checked before its pass is saved. */
      seen(key: string, ids: readonly string[]) {
        const scan = scans.get(key);
        if (scan) for (const id of ids) { scan.unchecked.add(id); scan.seen.add(id); }
      },
      /** Saves a checked task's deferral deadline, or clears the row this
       * server knows of when the check no longer defers. One statement when
       * the deadline changed or a known row is cleared; none otherwise. False
       * when a deadline could not be saved: the check then does not count
       * toward a saved full pass, so a successor's full pass rebuilds it. */
      async deferral(id: string, companyId: string, dueAt: number | null): Promise<boolean> {
        const known = deferred.get(id);
        if (dueAt !== null) {
          // A task that defers again and again (now + 30 s while a run lives)
          // keeps its saved row until that row's deadline is well past.
          if (known !== undefined && (known === dueAt || Date.now() < known + DEFERRAL_REFRESH_MS)) return true;
          deferred.delete(id);
          const saved = await db.execute(sql`insert into issue_recovery_deferrals (queue, issue_id, company_id, due_at)
            values (${queue}, ${id}::uuid, ${companyId}::uuid, ${at(dueAt)})
            on conflict (queue, issue_id) do update set due_at = excluded.due_at`).then(() => true, () => false);
          if (saved) deferred.set(id, dueAt);
          return saved;
        }
        if (known !== undefined) {
          deferred.delete(id);
          // Only the row this server read or wrote; a newer deadline from
          // another server stays. A row left behind costs one extra check.
          await db.execute(sql`delete from issue_recovery_deferrals
            where queue = ${queue} and issue_id = ${id}::uuid and due_at = ${at(known)}`).catch(() => undefined);
        }
        return true;
      },
      /** A task was checked; save each full pass that has no unchecked task left. */
      async checked(id: string) {
        for (const scan of scans.values()) scan.unchecked.delete(id);
        for (let index = unsaved.length - 1; index >= 0; index--) {
          const pending = unsaved[index]!;
          pending.unchecked.delete(id);
          if (pending.unchecked.size > 0) continue;
          unsaved.splice(index, 1);
          await pending.save();
        }
      },
      suppressed() {
        completedAt.clear(); changedAt.clear(); scans.clear(); unsaved.length = 0;
        distrustBefore = Date.now();
      },
    };
  }
  const reconstructionIntervalMs = (scope: IssueRecoveryScope | undefined) =>
    scope?.backstop || scope?.reload || scope?.agentId || scope?.graphRunId || scope?.graphIssueId ? 0 : 30_000;
  const scopeKey = (scope: IssueRecoveryScope | undefined) => {
    if (!scope) return "*";
    const key: unknown[] = [scope.companyId, scope.issueId, scope.graphRunId, scope.graphIssueId, scope.backstop];
    return JSON.stringify(scope.everyTask || scope.agentId || scope.reload ? [...key, scope.everyTask, scope.agentId, scope.reload] : key);
  };
  const isGraph = (scope: IssueRecoveryScope | undefined) => Boolean(scope?.graphRunId || scope?.graphIssueId);
  const loadOrigin = (scope: IssueRecoveryScope | undefined) => !workSignalDebug.enabled ? undefined : !scope ? "reload" as const
    : scope.reload ? "reconnect" as const : scope.backstop ? "backstop" as const : scope.everyTask ? "every_task" as const
    : scope.agentId ? "agent" as const : scope.issueId || isGraph(scope) ? "hint" as const : "company" as const;
  const graphs = new Map<string, { at: number; ids: Promise<string[] | null> }>();
  async function resolveGraph(scope: IssueRecoveryScope | undefined) {
    if (!scope || (!isGraph(scope) && !scope.agentId)) return;
    const key = scopeKey(scope);
    for (const [other, cached] of graphs) if (cached.at < Date.now() - 2_000) graphs.delete(other);
    let cached = graphs.get(key);
    if (!cached) {
      cached = { at: Date.now(), ids: scope.agentId ? resolveAgentIssues(db, { companyId: scope.companyId, agentId: scope.agentId })
        : resolveIssueGraph(db, { companyId: scope.companyId, runId: scope.graphRunId, issueId: scope.graphIssueId }) };
      graphs.set(key, cached);
    }
    const ids = await cached.ids.catch(error => { graphs.delete(key); throw error; });
    scope.issueIds = ids ?? undefined;
    scope.wholeCompany = ids === null;
  }
  async function toCompany(scope: IssueRecoveryScope | undefined, worker: { invalidate(hint?: string): void }) {
    if (scope && isGraph(scope)) worker.invalidate(issueRecoveryBackstopHint(scope.companyId));
    await resolveGraph(scope);
    if (!scope?.wholeCompany) return false;
    worker.invalidate(JSON.stringify({ companyId: scope.companyId, everyTask: true }));
    return true;
  }
  function register(queue: DeliveryQueue, statuses: string[] | null, check: (scope: Scope) => Promise<unknown>, eligible?: SQL) {
    const cursors = new Map<string, string>();
    const passes = fullPasses(queue);
    let enabled = false;
    let pass = createRecoveryPassReads();
    const worker: ReturnType<typeof registerScopedDeadlineWork<Entry, IssueRecoveryScope>> = registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
      queue,
      reconstructionIntervalMs,
      initialHint: ISSUE_RECOVERY_RELOAD_HINT,
      backstop: passes.backstop,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      beforeChecks: entries => { pass = createRecoveryPassReads(entries.map(entry => entry.id)); },
      decodeScope: decodeIssueRecoveryHint,
      matches: issueRecoveryScopeMatches,
      load: async scope => {
        const key = scopeKey(scope);
        if (workSignalDebug.enabled) workSignalDebug.event(queue, "load", { scope: key });
        if (!enabled) { cursors.delete(key); passes.suppressed(); return []; }
        if (await toCompany(scope, worker)) return { rows: null, complete: true };
        if (scope?.issueIds?.length === 0) return { rows: [], complete: true };
        const cursor = cursors.get(key);
        const changed = await passes.filter(scope, key, !cursor);
        const rows = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
          scope && !scope.reload ? eq(issues.companyId, scope.companyId) : undefined,
          changed ?? undefined,
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
        passes.seen(key, rows.map(row => row.id));
        await passes.loaded(scope, key, complete);
        const keepUnseen = changed ? { keepUnseen: true as const } : {};
        const origin = loadOrigin(scope);
        return { rows: rows.map(row => ({ ...row, dueAt: Date.now(), ...(origin ? { origin } : {}) })), complete, ...keepUnseen };
      },
      check: async entry => {
        if (!enabled) return null;
        if (workSignalDebug.enabled) workSignalDebug.event(queue, "check", { issueId: entry.id, companyId: entry.companyId,
          wake: entry.fromDeadline ? "deadline" : entry.origin ?? "load", dueAt: entry.dueAt });
        let next: number | null = null;
        await check({ companyId: entry.companyId, issueId: entry.id, pass,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
        if (await passes.deferral(entry.id, entry.companyId, next)) await passes.checked(entry.id);
        return next === null ? null : { ...entry, dueAt: next, ...(workSignalDebug.enabled ? { fromDeadline: true as const } : {}) };
      },
    }, canRun);
    return worker;
  }
  /** Event-driven: run terminal states, hold settlements and boot mark the
   * company dirty; checks schedule their own grace and back-off deadlines.
   * Newest-updated tasks are checked first, a small batch per pass. */
  function registerAssignedWork(sweep: NonNullable<typeof owner.assignedWork>) {
    type Suspect = Entry & { updatedAt: number; unchanged?: true; fromBackstop?: true };
    const cursors = new Map<string, string>();
    const passes = fullPasses(DELIVERY_QUEUES.assignedWorkInvariant);
    let enabled = false;
    const worker: ReturnType<typeof registerScopedDeadlineWork<Suspect, IssueRecoveryScope>> = registerScopedDeadlineWork<Suspect, IssueRecoveryScope>(coordinator, {
      queue: DELIVERY_QUEUES.assignedWorkInvariant,
      reconstructionIntervalMs,
      initialHint: ISSUE_RECOVERY_RELOAD_HINT,
      backstop: passes.backstop,
      batchSize: 25,
      beforePass: async () => { enabled = !(await owner.schedulingSuppressed()); },
      decodeScope: decodeIssueRecoveryHint,
      matches: issueRecoveryScopeMatches,
      priority: entry => entry.updatedAt,
      mergeEntry: (pending, loaded) => pending.unchanged && !loaded.fromBackstop ? loaded
        : { ...loaded, dueAt: Math.max(pending.dueAt, loaded.dueAt), ...(pending.unchanged ? { unchanged: true as const } : {}) },
      load: async scope => {
        const key = scopeKey(scope);
        if (!enabled) { cursors.delete(key); passes.suppressed(); return []; }
        if (await toCompany(scope, worker)) return { rows: null, complete: true };
        if (scope?.issueIds?.length === 0) return { rows: [], complete: true };
        const changed = await passes.filter(scope, key, !cursors.has(key));
        const rows = await sweep.listSuspects(scope && !scope.reload ? { companyId: scope.companyId, issueId: scope.issueId,
          issueIds: scope.issueIds, ...(changed ? { changed } : {}) } : changed ? { changed } : {}, cursors.get(key) ?? null, PAGE_SIZE);
        const complete = rows.length < PAGE_SIZE;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        passes.seen(key, rows.map(row => row.id));
        await passes.loaded(scope, key, complete);
        const origin = loadOrigin(scope);
        return { rows: rows.map(row => ({ id: row.id, companyId: row.companyId, updatedAt: row.updatedAt.getTime(), dueAt: Date.now(),
          ...(scope?.backstop ? { fromBackstop: true as const } : {}), ...(origin ? { origin } : {}) })), complete,
          ...(changed ? { keepUnseen: true as const } : {}) };
      },
      check: async entry => {
        if (!enabled) return null;
        if (workSignalDebug.enabled) workSignalDebug.event(DELIVERY_QUEUES.assignedWorkInvariant, "check", { issueId: entry.id,
          companyId: entry.companyId, wake: entry.fromDeadline ? "deadline" : entry.origin ?? "load", dueAt: entry.dueAt });
        let next: number | null = null, unchanged = false;
        await sweep.checkIssue({ companyId: entry.companyId, issueId: entry.id,
          onDeferredDeadline: (at, detail) => { next = next === null ? at : Math.min(next, at); unchanged ||= detail?.unchanged === true; } });
        if (await passes.deferral(entry.id, entry.companyId, next)) await passes.checked(entry.id);
        const { unchanged: _previous, fromBackstop: _source, ...rest } = entry;
        return next === null ? null : { ...rest, dueAt: next, ...(unchanged ? { unchanged: true as const } : {}),
          ...(workSignalDebug.enabled ? { fromDeadline: true as const } : {}) };
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
  // A reconnect can lose only another server's hints, whose writes the changed
  // rows find, so it rebuilds company by company instead of re-checking all.
  for (const queue of [DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.resolvedDependencies, DELIVERY_QUEUES.staleIssueLocks,
    ...(assignedWork ? [DELIVERY_QUEUES.assignedWorkInvariant] : [])]) setDatabaseWorkReconnectHint(db, queue, ISSUE_RECOVERY_RELOAD_HINT);
  const watchdogs = registerTaskWatchdogWork(db, coordinator, {
    reconcile: owner.watchdogs, enabled: async () => !(await owner.schedulingSuppressed()),
  }, canRun);
  const workers = [assignments, orphanBlockers, recoveryActions, dependencies, locks, watchdogs,
    ...(assignedWork ? [assignedWork] : [])];
  const queues: string[] = [DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions,
    DELIVERY_QUEUES.resolvedDependencies, DELIVERY_QUEUES.staleIssueLocks, DELIVERY_QUEUES.taskWatchdogs,
    ...(assignedWork ? [DELIVERY_QUEUES.assignedWorkInvariant] : [])];
  return { watchdogs, assignments, assignedWork, ready: Promise.all(workers.map(worker => worker.ready)),
    wake: function wake() {
      if (workSignalDebug.enabled) {
        const topic = queues.find(queue => workSignalDebug.allows(queue));
        if (topic) workSignalDebug.event(topic, "direct_wake", { queues: queues.join(",") }, "always", wake);
      }
      for (const worker of workers) worker.invalidate();
    },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
