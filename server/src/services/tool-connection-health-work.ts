import { healthScope, type HealthScope } from "./tool-connection-health-notifications.js";
import { takeCompanyWorkBatch } from "./company-work-batch.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { ConnectionHealthDeadline } from "./tool-access/catalog/health-schedule.js";

export function registerToolConnectionHealthWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: {
    load(companyId?: string, connectionId?: string, applicationId?: string, signal?: AbortSignal): Promise<ConnectionHealthDeadline[]>;
    check(id: string): Promise<ConnectionHealthDeadline | null>;
  },
  canRun: () => boolean,
) {
  const dirty = new Set<string>(["*"]);
  const deadlines = new Map<string, ConnectionHealthDeadline>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const refreshFailures = new Map<string, { scope: HealthScope; retryAt: number }>();
  const matches = (entry: ConnectionHealthDeadline, scope: HealthScope) =>
    (scope.companyId === undefined || entry.companyId === scope.companyId)
    && (scope.connectionId === undefined || entry.id === scope.connectionId)
    && (scope.applicationId === undefined || entry.applicationId === scope.applicationId);
  const retryMs = 30_000;
  let earliest = 0;
  let lastCompany: string | null = null;
  function request(hints?: ReadonlySet<string>) {
    for (const hint of hints ?? ["*"]) dirty.add(hint);
  }
  function next() {
    let result: number | null = null;
    for (const scope of dirty) {
      const at = Math.max(earliest, refreshFailures.get(scope)?.retryAt ?? 0);
      result = result === null ? at : Math.min(result, at);
    }
    for (const entry of deadlines.values()) {
      let at = Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0);
      for (const failure of refreshFailures.values()) if (matches(entry, failure.scope)) at = Math.max(at, failure.retryAt);
      result = result === null ? at : Math.min(result, at);
    }
    return result;
  }
  return coordinator.register(DELIVERY_QUEUES.toolConnectionHealth, {
    retryMs,
    pausePassiveMaintenance: true,
    onSettled: request,
    run: async signal => {
      if (!canRun() || Date.now() < earliest) return;
      earliest = Date.now() + retryMs;
      const scopes = dirty.has("*") ? ["*"] : [...dirty];
      dirty.clear();
      const errors: unknown[] = [];
      const unavailable: HealthScope[] = [];
      for (let index = 0; index < scopes.length; index++) {
        const scope = scopes[index];
        if (signal.aborted || !canRun()) { for (const remaining of scopes.slice(index)) dirty.add(remaining); return; }
        let target: HealthScope | undefined;
        try {
          target = healthScope(scope);
          if ((refreshFailures.get(scope)?.retryAt ?? 0) > Date.now()) {
            dirty.add(scope); unavailable.push(target); continue;
          }
          const rows = await service.load(target.companyId, target.connectionId, target.applicationId, signal);
          if (target.connectionId) {
            const current = deadlines.get(target.connectionId);
            if (current && matches(current, target)) deadlines.delete(current.id);
          } else for (const entry of deadlines.values()) if (matches(entry, target)) deadlines.delete(entry.id);
          for (const entry of rows) deadlines.set(entry.id, entry);
          if (scope === "*") refreshFailures.clear(); else refreshFailures.delete(scope);
        } catch (error) {
          const retryScope = target ? scope : "*";
          refreshFailures.set(retryScope, { scope: target ?? {}, retryAt: Date.now() + retryMs });
          dirty.add(retryScope); unavailable.push(target ?? {}); errors.push(error);
        }
      }
      for (const id of failures.keys()) {
        const current = deadlines.get(id);
        if (!current || current.dueAt > Date.now()) failures.delete(id);
      }
      const due = [...deadlines.values()].filter(entry => !unavailable.some(scope => matches(entry, scope))
        && Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
      const batch = takeCompanyWorkBatch(due, 25, lastCompany);
      lastCompany = batch.lastCompany;
      for (const entry of batch.entries) {
        if (signal.aborted || !canRun()) break;
        try {
          const current = await service.check(entry.id);
          if (current) deadlines.set(entry.id, current); else deadlines.delete(entry.id);
          failures.delete(entry.id);
        } catch (error) {
          const count = Math.min((failures.get(entry.id)?.count ?? 0) + 1, 6);
          failures.set(entry.id, { count, retryAt: Date.now() + Math.min(15 * 60_000, retryMs * 2 ** (count - 1)) });
          errors.push(error);
        }
      }
      if (due.length > batch.entries.length) earliest = Date.now() + 1_000;
      if (errors.length) throw new AggregateError(errors, "Tool connection health checks could not settle");
    },
    // Keep the hints/deadlines for resume, but release settled intent while
    // paused. The coordinator independently fences unresolved transactions.
    hasPending: async () => canRun() && dirty.size > 0,
    nextRunAt: next,
  });
}
