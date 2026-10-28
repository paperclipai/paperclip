import { takeCompanyWorkBatch } from "./company-work-batch.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { DeliveryQueue } from "./delivery-work-notifications.js";

type ScheduledEntry = { id: string; companyId: string; dueAt: number };

/** Coalesced scope reconstruction and fair deadline dispatch. Domain owners
 * supply persistence, eligibility, and execution; this helper owns no SQL. */
export function registerScopedDeadlineWork<Entry extends ScheduledEntry, Scope>(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  options: {
    queue: DeliveryQueue;
    batchSize?: number;
    minimumPassIntervalMs?: number;
    decodeScope(hint: string): Scope | undefined;
    matches(entry: Entry, scope?: Scope): boolean;
    load(scope?: Scope, signal?: AbortSignal): Promise<Entry[] | { rows: Entry[] | null; complete: boolean }>;
    check(entry: Entry, signal?: AbortSignal): Promise<Entry | null>;
  },
  canRun: () => boolean,
) {
  const dirty = new Set<string>(["*"]);
  const versions = new Map<string, number>();
  const scans = new Map<string, { version: number; seen: Set<string> }>();
  const entries = new Map<string, Entry>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const scopeFailures = new Map<string, { count: number; retryAt: number }>();
  let earliest = 0;
  let lastCompany: string | null = null;
  function failed(map: typeof failures, id: string) {
    const count = Math.min((map.get(id)?.count ?? 0) + 1, 5);
    map.set(id, { count, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** (count - 1)) });
  }
  function dirtyScopes() {
    return [...dirty].filter(hint => hint !== "*" || !scopeFailures.has(hint))
      .filter(hint => !scans.has(hint) || scopeFailures.has(hint))
      .map(hint => { try { return options.decodeScope(hint); } catch { return undefined; } });
  }
  function next() {
    if (!canRun()) return dirty.size > 0 || entries.size > 0 ? Date.now() + 30_000 : null;
    let nextAt: number | null = null;
    const take = (at: number) => { nextAt = nextAt === null ? at : Math.min(nextAt, at); };
    for (const hint of dirty) take(Math.max(earliest, scopeFailures.get(hint)?.retryAt ?? 0));
    const unavailable = dirtyScopes();
    for (const entry of entries.values()) if (!unavailable.some(scope => options.matches(entry, scope)))
      take(Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0));
    return nextAt;
  }
  const worker = coordinator.register(options.queue, {
    retryMs: 30_000,
    pausePassiveMaintenance: true,
    onSettled: hints => { for (const hint of hints ?? ["*"]) {
      dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    } },
    run: async signal => {
      if (!canRun() || Date.now() < earliest) return;
      earliest = Date.now() + (options.minimumPassIntervalMs ?? 1000);
      const errors: unknown[] = [];
      const ready = [...dirty].filter(hint => (scopeFailures.get(hint)?.retryAt ?? 0) <= Date.now());
      const requested = ready.includes("*")
        ? ["*", ...ready.filter(hint => hint !== "*")].slice(0, 25)
        : ready.slice(0, 25);
      for (const hint of requested) dirty.delete(hint);
      for (let index = 0; index < requested.length; index++) {
        if (signal.aborted || !canRun()) { for (const hint of requested.slice(index)) dirty.add(hint); return; }
        const hint = requested[index];
        let scope: Scope | undefined;
        let decoded = false;
        try {
          scope = options.decodeScope(hint); decoded = true;
          const scan = scans.get(hint) ?? { version: versions.get(hint) ?? 0, seen: new Set<string>() };
          scans.set(hint, scan);
          const loaded = await options.load(scope, signal);
          const result = Array.isArray(loaded) ? { rows: loaded, complete: true } : loaded;
          for (const entry of result.rows ?? []) {
            entries.set(entry.id, entry);
            for (const [other, progress] of scans) if (options.matches(entry, options.decodeScope(other))) progress.seen.add(entry.id);
          }
          if (!result.complete) { dirty.add(hint); continue; }
          if (result.rows !== null) for (const entry of entries.values()) if (options.matches(entry, scope) && !scan.seen.has(entry.id)) {
            entries.delete(entry.id); failures.delete(entry.id);
          }
          scans.delete(hint);
          if ((versions.get(hint) ?? 0) !== scan.version) dirty.add(hint); else versions.delete(hint);
          if (!scope) scopeFailures.clear(); else scopeFailures.delete(hint);
        } catch (error) {
          const retryHint = decoded ? hint : "*";
          if (!decoded) { scans.delete(hint); versions.delete(hint); }
          dirty.add(retryHint); failed(scopeFailures, retryHint); errors.push(error);
        }
      }
      const unavailable = dirtyScopes();
      const due = [...entries.values()].filter(entry => !unavailable.some(scope => options.matches(entry, scope))
        && Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
      const batch = takeCompanyWorkBatch(due, options.batchSize ?? 25, lastCompany); lastCompany = batch.lastCompany;
      for (const entry of batch.entries) {
        if (signal.aborted || !canRun()) break;
        try {
          const current = await options.check(entry, signal);
          if (current) entries.set(entry.id, current); else entries.delete(entry.id);
          failures.delete(entry.id);
        } catch (error) { failed(failures, entry.id); errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `${options.queue} could not settle`);
    },
    // Retain scopes/deadlines for resume without retaining a settled write's
    // idle hold during drain. The coordinator still fences unresolved XIDs.
    hasPending: async () => canRun() && dirty.size > 0,
    nextRunAt: next,
    nextRunAtOnError: next,
  });
  return { ...worker, invalidate(hint = "*") {
    dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    worker.wake();
  } };
}
