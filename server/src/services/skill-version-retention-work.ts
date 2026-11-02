import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { onSkillVersionCacheChange } from "./skill-version-retention-notifications.js";
import type { skillVersionRetentionService, SkillVersionPruneResult } from "./skill-version-retention.js";

type RetentionService = ReturnType<typeof skillVersionRetentionService>;
type ActiveCompany = { id: string; cursor: SkillVersionPruneResult["cursor"]; nextRunAt: number | null; rescanOwed: boolean };

export function registerSkillVersionRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: RetentionService,
  canRun: () => boolean,
) {
  const root = path.resolve(resolvePaperclipInstanceRoot(), "skills");
  const dirty = new Set<string>();
  const deadlines = new Map<string, number>();
  const failures = new Map<string, number>();
  const freshScanAfter = new Map<string, number>();
  const cacheChanges = new Map<string, Map<string, number>>();
  const cacheDeadline = (id: string) => {
    let next = Infinity;
    for (const at of cacheChanges.get(id)?.values() ?? []) next = Math.min(next, at);
    return next;
  };
  let discoveryAfter = 0, discoveryLoading = false, discoveryAgain = false;
  let discovery: { after?: string; retryAt: number } | null = { retryAt: 0 };
  let active: ActiveCompany | null = null;
  let continuationAt = 0;
  const readyAt = (id: string) => Math.max(failures.get(id) ?? 0,
    Math.min(deadlines.get(id) ?? Infinity, cacheDeadline(id)) <= Date.now() ? 0 : freshScanAfter.get(id) ?? 0);
  const changed = (hints?: ReadonlySet<string>) => {
    for (const hint of hints ?? ["*"]) {
      if (hint === "*") {
        if (!discovery) discovery = { retryAt: discoveryAfter };
        else if (discoveryLoading || discovery.after !== undefined) discoveryAgain = true;
      } else dirty.add(hint);
    }
  };
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.skillVersionRetention, {
    canRun,
    retryMs: 30_000,
    continuationMs: 1000,
    notificationCoalesceMs: 1000,
    onSettled: changed,
    run: async signal => {
      const admitted = () => !signal.aborted && canRun();
      for (const [id, at] of freshScanAfter) if (at <= Date.now()) freshScanAfter.delete(id);
      for (const [id, at] of deadlines) if (at <= Date.now()) {
        dirty.add(id);
        if (active?.id === id) active.rescanOwed = true;
        freshScanAfter.delete(id);
        deadlines.delete(id);
      }
      for (const [id, entries] of cacheChanges) {
        for (const [directory, at] of entries) if (at <= Date.now()) {
          dirty.add(id);
          if (active?.id === id) active.rescanOwed = true;
          freshScanAfter.delete(id);
          entries.delete(directory);
        }
        if (entries.size === 0) cacheChanges.delete(id);
      }
      let inspected = 0;
      let companies = 0;
      const scope = discovery;
      if (scope && scope.retryAt <= Date.now() && admitted()) {
        discoveryLoading = true;
        try {
          const rows = await service.listCompanies(scope.after);
          for (const row of rows) dirty.add(row.id);
          if (discovery === scope) {
            if (rows.length === 51) discovery = { after: rows.at(-1)!.id, retryAt: 0 };
            else {
              discoveryAfter = Date.now() + 30_000;
              discovery = discoveryAgain ? { retryAt: discoveryAfter } : null;
              discoveryAgain = false;
            }
          }
        } catch (err) {
          if (discovery === scope) scope.retryAt = Date.now() + 30_000;
          logger.warn({ err }, "skill cache retention company discovery failed");
        } finally { discoveryLoading = false; }
      }
      while (companies < 50 && inspected < 50 && admitted()) {
        if (!active) {
          const id = [...dirty].find(id => readyAt(id) <= Date.now());
          if (!id) break;
          dirty.delete(id);
          active = { id, cursor: null, nextRunAt: null, rescanOwed: false };
          deadlines.delete(id);
          cacheChanges.delete(id);
        }
        const company = active;
        try {
          const result = await service.pruneCompany(company.id, {
            cursor: company.cursor, maxEntries: 50 - inspected, shouldContinue: admitted,
          });
          if (result.checked > 0 || result.failed > 0 || Object.keys(result.skipped).length > 0) {
            logger.info({ ...result, companyId: company.id, dryRun: service.dryRun }, "skill version snapshot retention");
          }
          inspected += result.checked;
          companies++;
          if (result.nextRunAt !== null) company.nextRunAt = Math.min(company.nextRunAt ?? Infinity, result.nextRunAt);
          company.cursor = result.cursor;
          failures.delete(company.id);
          if (result.interrupted || !admitted()) {
            company.cursor = null;
            company.nextRunAt = null;
            continuationAt = Date.now() + 1000;
            return;
          }
          if (result.truncated) break;
          if (company.rescanOwed) freshScanAfter.delete(company.id);
          else freshScanAfter.set(company.id, Date.now() + 30_000);
          if (company.nextRunAt !== null) deadlines.set(company.id, company.nextRunAt);
          active = null;
        } catch (err) {
          dirty.add(company.id);
          failures.set(company.id, Date.now() + 30_000);
          active = null;
          companies++;
          logger.warn({ err, companyId: company.id }, "skill cache retention company inspection failed");
        }
      }
      continuationAt = Date.now() + 1000;
    },
    next: async () => {
      let next: number | null = null;
      const take = (at: number) => { next = Math.min(next ?? Infinity, at); };
      if (discovery) take(Math.max(continuationAt, discovery.retryAt));
      if (active) take(continuationAt);
      for (const id of dirty) take(Math.max(continuationAt, readyAt(id)));
      for (const [id, at] of deadlines) take(Math.max(at, failures.get(id) ?? 0));
      for (const id of cacheChanges.keys()) take(Math.max(cacheDeadline(id), failures.get(id) ?? 0));
      return next;
    },
  });
  const unsubscribe = onSkillVersionCacheChange(change => {
    if (change.root !== root) return;
    let entries = cacheChanges.get(change.companyId);
    if (!entries) { entries = new Map(); cacheChanges.set(change.companyId, entries); }
    entries.set(change.directory, change.occurredAt + service.graceMs);
    if (change.source === "publication") dirty.add(change.companyId);
    worker.wake();
  });
  return { ...worker, unsubscribe, dispose: () => { unsubscribe(); cacheChanges.clear(); return service.dispose(); } };
}
