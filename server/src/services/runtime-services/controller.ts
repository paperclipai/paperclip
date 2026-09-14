export type RuntimeServiceWorkKind = "start" | "stop" | "observe" | "retain";
export interface RuntimeServiceWork { id: string; companyId: string }

// Slow allocation/start calls must not consume the capacity needed to stop an
// unrelated service, enforce a running service's lifetime, or retain its files.
const CAPACITY: Record<RuntimeServiceWorkKind, number> = { start: 2, stop: 4, observe: 4, retain: 2 };
const KINDS = Object.keys(CAPACITY) as RuntimeServiceWorkKind[];

export function createRuntimeServiceController(options: {
  select(kind: RuntimeServiceWorkKind, limit: number, excludedIds: string[]): Promise<RuntimeServiceWork[]>;
  reconcile(companyId: string, id: string): Promise<void>;
  retain(companyId: string, id: string): Promise<void>;
  onError(): void;
}) {
  const jobs = new Map<string, { kind: RuntimeServiceWorkKind; done: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let scanning: Promise<void> | undefined;
  let stopped = true;
  const report = () => { try { options.onError(); } catch { /* Reporting cannot stop reconciliation. */ } };
  const key = (kind: RuntimeServiceWorkKind, id: string) => `${kind === "retain" ? "allocation" : "service"}:${id}`;

  async function scan() {
    for (const kind of KINDS) {
      if (stopped) return;
      const active = [...jobs.entries()];
      const capacity = CAPACITY[kind] - active.filter(([, job]) => job.kind === kind).length;
      if (capacity <= 0) continue;
      const excluded = active.filter(([id]) => id.startsWith(kind === "retain" ? "allocation:" : "service:"))
        .map(([id]) => id.slice(id.indexOf(":") + 1));
      let candidates: RuntimeServiceWork[];
      try { candidates = await options.select(kind, capacity, excluded); }
      catch { report(); continue; }
      if (stopped) return;
      for (const candidate of candidates.slice(0, capacity)) {
        const id = key(kind, candidate.id);
        if (jobs.has(id)) continue;
        const done = Promise.resolve()
          .then(() => kind === "retain" ? options.retain(candidate.companyId, candidate.id) : options.reconcile(candidate.companyId, candidate.id))
          .catch(report)
          .finally(() => { jobs.delete(id); });
        jobs.set(id, { kind, done });
      }
    }
  }

  function tick() {
    if (stopped || scanning) return;
    scanning = scan().catch(report).finally(() => { scanning = undefined; });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(tick, 2_000);
      timer.unref();
      tick();
    },
    /** Drain controller work only. Service processes survive this shutdown. */
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await scanning;
      await Promise.allSettled([...jobs.values()].map((job) => job.done));
    },
  };
}
