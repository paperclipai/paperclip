import { randomUUID } from "node:crypto";
import type { DeadlineReconciliationSnapshot } from "./deadline-reconciliation.js";
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
    concurrentChecks?: {
      limit: number;
      key(entry: Entry): string | readonly string[];
      // A pass otherwise ends only after its slowest check. Owners whose checks
      // can legitimately run for minutes may let idle slots keep admitting
      // entries that become due meanwhile, so one slow resource cannot hold
      // every other resource's saved deadline until it finishes. check() must
      // revalidate each entry against durable state, because an entry admitted
      // this way is not reconstructed first.
      admitDueWhileActive?: boolean;
    };
    reconstructionIntervalMs?: number | ((scope: Scope | undefined) => number);
    beforePass?(): Promise<void>;
    decodeScope(hint: string): Scope | undefined;
    matches(entry: Entry, scope?: Scope): boolean;
    /**
     * Optional partition of `matches`: a scope whose key is defined can match
     * only entries with the same key. Then an entry is tested only against
     * the scopes of its own key (and unkeyed scopes), not against every scope.
     */
    scopeKey?: { entry(entry: Entry): string; scope(scope: Scope): string | undefined };
    load(scope?: Scope, signal?: AbortSignal): Promise<Entry[] | { rows: Entry[] | null; complete: boolean }>;
    // Owners may retain pending queue priority while refreshing eligibility.
    mergeEntry?(pending: Entry, loaded: Entry): Entry;
    priority?(entry: Entry): number;
    check(entry: Entry, signal?: AbortSignal): Promise<Entry | null>;
    onStop?(): void;
  },
  canRun: () => boolean,
) {
  if (options.concurrentChecks && (!Number.isInteger(options.concurrentChecks.limit) || options.concurrentChecks.limit < 1)) {
    throw new RangeError("Concurrent check limit must be a positive integer");
  }
  const ownerRevision = randomUUID();
  let revision = 0, running = false, stopped = false, lastRunFailed = false;
  const dirty = new Set<string>(["*"]);
  const versions = new Map<string, number>();
  const scans = new Map<string, { version: number; seen: Set<string> }>();
  const entries = new Map<string, Entry>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const scopeFailures = new Map<string, { count: number; retryAt: number }>();
  const reconstructAfter = new Map<string, number>();
  let earliest = 0;
  let lastCompany: string | null = null;
  // Hints are immutable strings, so a decoded scope can be reused while the
  // hint is still referenced (dirty or scanning).
  const decodedScopes = new Map<string, Scope | undefined>();
  function decode(hint: string) {
    if (decodedScopes.has(hint)) return decodedScopes.get(hint);
    const scope = options.decodeScope(hint);
    decodedScopes.set(hint, scope);
    return scope;
  }
  function forgetDecoded() {
    for (const hint of decodedScopes.keys()) if (!dirty.has(hint) && !scans.has(hint)) decodedScopes.delete(hint);
  }
  /** Whether an entry matches any of `scopes`, without testing every scope. */
  function matcher(scopes: Array<Scope | undefined>): (entry: Entry) => boolean {
    if (scopes.length === 0) return () => false;
    const keyOf = options.scopeKey;
    if (!keyOf) return entry => scopes.some(scope => options.matches(entry, scope));
    const unkeyed: Array<Scope | undefined> = [];
    const keyed = new Map<string, Scope[]>();
    for (const scope of scopes) {
      const key = scope === undefined ? undefined : keyOf.scope(scope);
      if (key === undefined) unkeyed.push(scope);
      else { const list = keyed.get(key) ?? []; list.push(scope!); keyed.set(key, list); }
    }
    return entry => unkeyed.some(scope => options.matches(entry, scope))
      || (keyed.get(keyOf.entry(entry))?.some(scope => options.matches(entry, scope)) ?? false);
  }
  function failed(map: typeof failures, id: string) {
    const count = Math.min((map.get(id)?.count ?? 0) + 1, 5);
    map.set(id, { count, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** (count - 1)) });
  }
  function dirtyScopes() {
    return [...dirty].filter(hint => hint !== "*" || !scopeFailures.has(hint))
      .filter(hint => !scans.has(hint) || scopeFailures.has(hint))
      .filter(hint => (reconstructAfter.get(hint) ?? 0) <= Date.now() || scopeFailures.has(hint))
      .map(hint => { try { return decode(hint); } catch { return undefined; } });
  }
  function next() {
    if (!canRun()) return dirty.size > 0 || entries.size > 0 ? Date.now() + 30_000 : null;
    let nextAt: number | null = null;
    const take = (at: number) => { nextAt = nextAt === null ? at : Math.min(nextAt, at); };
    for (const hint of dirty) take(Math.max(earliest, reconstructAfter.get(hint) ?? 0, scopeFailures.get(hint)?.retryAt ?? 0));
    const unavailable = matcher(dirtyScopes());
    for (const entry of entries.values()) if (!unavailable(entry))
      take(Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0));
    return nextAt;
  }
  const worker = coordinator.register(options.queue, {
    retryMs: 30_000,
    pausePassiveMaintenance: true,
    onStop: () => { stopped = true; revision++; options.onStop?.(); },
    onSettled: hints => { revision++; for (const hint of hints ?? ["*"]) {
      dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    } },
    run: async signal => {
      revision++; running = true;
      try {
        if (!canRun() || Date.now() < earliest) return;
        for (const [hint, until] of reconstructAfter) {
          if (until <= Date.now()) reconstructAfter.delete(hint);
        }
        const ready = [...dirty].filter(hint => Math.max(reconstructAfter.get(hint) ?? 0, scopeFailures.get(hint)?.retryAt ?? 0) <= Date.now());
        if (ready.length === 0 && ![...entries.values()].some(entry => Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())) return;
        earliest = Date.now() + (options.minimumPassIntervalMs ?? 1000);
        try { await options.beforePass?.(); } catch (error) {
          for (const hint of ready) failed(scopeFailures, hint);
          for (const entry of entries.values()) if (entry.dueAt <= Date.now()) failed(failures, entry.id);
          throw error;
        }
        const errors: unknown[] = [];
        const requested = ready.includes("*")
          ? ["*", ...ready.filter(hint => hint !== "*")].slice(0, 25)
          : ready.slice(0, 25);
        for (const hint of requested) dirty.delete(hint);
        // Entries by scope key for this pass, built on first use, so a keyed
        // scope visits only its own entries when it drops vanished ones.
        let byKey: Map<string, Set<string>> | null = null;
        const indexEntry = (entry: Entry) => {
          if (!byKey || !options.scopeKey) return;
          const key = options.scopeKey.entry(entry);
          const ids = byKey.get(key) ?? new Set<string>();
          ids.add(entry.id); byKey.set(key, ids);
        };
        const entriesIn = (scope: Scope | undefined): Entry[] => {
          const key = scope === undefined ? undefined : options.scopeKey?.scope(scope);
          if (key === undefined) return [...entries.values()];
          if (!byKey) { byKey = new Map(); for (const entry of entries.values()) indexEntry(entry); }
          return [...(byKey.get(key) ?? [])].flatMap(id => entries.get(id) ?? []);
        };
        for (let index = 0; index < requested.length; index++) {
          if (signal.aborted || !canRun()) { for (const hint of requested.slice(index)) dirty.add(hint); return; }
          const hint = requested[index];
          let scope: Scope | undefined;
          let decoded = false;
          try {
            scope = decode(hint); decoded = true;
            const scan = scans.get(hint) ?? { version: versions.get(hint) ?? 0, seen: new Set<string>() };
            scans.set(hint, scan);
            const loaded = await options.load(scope, signal);
            const result = Array.isArray(loaded) ? { rows: loaded, complete: true } : loaded;
            const progressScopes = [...scans].map(([other, progress]) => ({ progress, scope: decode(other) }));
            for (const entry of result.rows ?? []) {
              const pending = entries.get(entry.id);
              entries.set(entry.id, pending && options.mergeEntry ? options.mergeEntry(pending, entry) : entry);
              indexEntry(entry);
              for (const { progress, scope: other } of progressScopes) if (options.matches(entry, other)) progress.seen.add(entry.id);
            }
            if (!result.complete) { dirty.add(hint); continue; }
            if (result.rows !== null) for (const entry of entriesIn(scope)) if (options.matches(entry, scope) && !scan.seen.has(entry.id)) {
              entries.delete(entry.id); failures.delete(entry.id);
            }
            scans.delete(hint);
            const reconstructionInterval = typeof options.reconstructionIntervalMs === "function"
              ? options.reconstructionIntervalMs(scope) : (options.reconstructionIntervalMs ?? 0);
            if (reconstructionInterval > 0) {
              reconstructAfter.set(hint, Date.now() + reconstructionInterval);
            }
            if ((versions.get(hint) ?? 0) !== scan.version) dirty.add(hint); else versions.delete(hint);
            if (!scope) scopeFailures.clear(); else scopeFailures.delete(hint);
          } catch (error) {
            const retryHint = decoded ? hint : "*";
            if (!decoded) { scans.delete(hint); versions.delete(hint); }
            dirty.add(retryHint); failed(scopeFailures, retryHint); errors.push(error);
          }
        }
        forgetDecoded();
        const unavailable = matcher(dirtyScopes());
        const due = [...entries.values()].filter(entry => !unavailable(entry)
          && Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
          .sort((a, b) => (options.priority?.(b) ?? 0) - (options.priority?.(a) ?? 0)
            || a.dueAt - b.dueAt || a.id.localeCompare(b.id));
        const batch = takeCompanyWorkBatch(due, options.batchSize ?? 25, lastCompany); lastCompany = batch.lastCompany;
        // An owner may share more than one resource (for example a task and an
        // endpoint). Merge intersecting keys before dispatch so waiting siblings
        // do not occupy the bounded check slots ahead of independent work.
        const parents = batch.entries.map((_, index) => index);
        const root = (index: number): number => {
          while (parents[index] !== index) index = parents[index];
          return index;
        };
        const owners = new Map<string, number>();
        for (const [index, entry] of batch.entries.entries()) {
          const configured = options.concurrentChecks?.key(entry) ?? "";
          const keys = typeof configured === "string" ? [configured] : configured;
          for (const key of keys) {
            const previous = owners.get(key);
            if (previous === undefined) owners.set(key, index);
            else parents[root(index)] = root(previous);
          }
        }
        const groups = new Map<number, Entry[]>();
        for (const [index, entry] of batch.entries.entries()) {
          const key = root(index);
          const group = groups.get(key) ?? [];
          group.push(entry); groups.set(key, group);
        }
        const pending = [...groups.values()];
        let nextGroup = 0;
        const admitDueWhileActive = options.concurrentChecks?.admitDueWhileActive === true;
        const keysOf = (entry: Entry) => {
          const configured = options.concurrentChecks?.key(entry) ?? "";
          return typeof configured === "string" ? [configured] : [...configured];
        };
        // Entries owned by this pass (queued in a group or running) and the
        // resource keys they hold. Every batch group reserves its keys until the
        // whole group finishes, so admission can neither overlap a queued
        // sibling nor jump ahead of it. Admission never overlaps either set.
        const owned = new Set(batch.entries.map(entry => entry.id));
        const busyKeys = new Map<string, number>();
        const reserve = (keys: readonly string[]) => {
          for (const key of keys) busyKeys.set(key, (busyKeys.get(key) ?? 0) + 1);
        };
        const release = (keys: readonly string[]) => {
          for (const key of keys) {
            const count = (busyKeys.get(key) ?? 1) - 1;
            if (count > 0) busyKeys.set(key, count); else busyKeys.delete(key);
          }
        };
        const groupKeys = pending.map(group => [...new Set(group.flatMap(keysOf))]);
        for (const keys of groupKeys) reserve(keys);
        const lastChecked = new Map<string, number>();
        const spacing = options.minimumPassIntervalMs ?? 1000;
        let running = 0;
        let changed: (() => void) | null = null;
        const notify = () => { const resolve = changed; changed = null; resolve?.(); };
        const checkEntry = async (entry: Entry) => {
          running += 1;
          try {
            const current = await options.check(entry, signal);
            if (current) entries.set(entry.id, current); else entries.delete(entry.id);
            failures.delete(entry.id);
          } catch (error) { failed(failures, entry.id); errors.push(error); }
          finally {
            running -= 1;
            lastChecked.set(entry.id, Date.now());
            notify();
          }
        };
        const nextAdmission = () => {
          // Mid-pass settlements mark scopes dirty, but reconstruction waits for
          // the next pass. Admission therefore relies on check() revalidating
          // the entry against durable state, as the option requires.
          const now = Date.now();
          let wakeAt: number | null = null;
          let candidate: Entry | null = null;
          for (const item of entries.values()) {
            if (owned.has(item.id)) continue;
            if (keysOf(item).some(key => busyKeys.has(key))) continue;
            const at = Math.max(item.dueAt, failures.get(item.id)?.retryAt ?? 0, (lastChecked.get(item.id) ?? -Infinity) + spacing);
            if (at > now) { wakeAt = wakeAt === null ? at : Math.min(wakeAt, at); continue; }
            if (!candidate || item.dueAt < candidate.dueAt || (item.dueAt === candidate.dueAt && item.id < candidate.id)) candidate = item;
          }
          return { candidate, wakeAt };
        };
        const waitForChange = (wakeAt: number | null) => new Promise<void>(resolve => {
          const timer = wakeAt === null ? undefined : setTimeout(finish, Math.max(0, wakeAt - Date.now()));
          function finish() {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            if (changed === finish) changed = null;
            resolve();
          }
          const previous = changed;
          changed = previous ? () => { previous(); finish(); } : finish;
          signal.addEventListener("abort", finish, { once: true });
        });
        const checkGroups = async () => {
          while (!signal.aborted && canRun()) {
            const index = nextGroup++;
            const group = pending[index];
            if (group) {
              try {
                for (const entry of group) {
                  if (signal.aborted || !canRun()) return;
                  try { await checkEntry(entry); } finally { owned.delete(entry.id); }
                }
              } finally { release(groupKeys[index]); notify(); }
              continue;
            }
            if (!admitDueWhileActive) return;
            const { candidate, wakeAt } = nextAdmission();
            if (candidate) {
              const keys = keysOf(candidate);
              owned.add(candidate.id); reserve(keys);
              try { await checkEntry(candidate); } finally { owned.delete(candidate.id); release(keys); notify(); }
              continue;
            }
            // Nothing is admissible now. Stay available only while another
            // check still holds this pass open; otherwise the pass ends and the
            // coordinator schedules the next saved deadline as usual.
            if (running === 0) return;
            await waitForChange(wakeAt);
          }
        };
        // With admission enabled, spare slots start too: a pass that begins with
        // one slow group must still admit other resources that come due later.
        const workers = admitDueWhileActive ? options.concurrentChecks!.limit
          : Math.min(options.concurrentChecks?.limit ?? 1, pending.length);
        const checks = await Promise.allSettled(Array.from({ length: workers }, checkGroups));
        for (const result of checks) if (result.status === "rejected") errors.push(result.reason);
        if (errors.length) throw new AggregateError(errors, `${options.queue} could not settle`);
        lastRunFailed = false;
      } catch (error) { lastRunFailed = true; throw error; }
      finally { running = false; revision++; }
    },
    // Retain scopes/deadlines for resume without retaining a settled write's
    // idle hold during drain. The coordinator still fences unresolved XIDs.
    hasPending: async () => canRun() && dirty.size > 0,
    nextRunAt: next,
    nextRunAtOnError: next,
  });
  function invalidate(hint = "*") {
    revision++;
    dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    worker.wake();
  }
  return { ...worker,
    reconciliationSnapshot: (): DeadlineReconciliationSnapshot => ({
      revision: `${ownerRevision}:${revision}`,
      reconciled: !stopped && !running && !lastRunFailed && dirty.size === 0 && scans.size === 0
        && failures.size === 0 && scopeFailures.size === 0,
    }),
    wake() { revision++; worker.wake(); },
    invalidate,
    refresh(hint = "*") {
      reconstructAfter.delete(hint);
      invalidate(hint);
    },
  };
}
