/** Host-owned cancellation scopes. Neither provider IDs nor host PIDs cross this seam. */
type Stop = () => Promise<void>;
interface Scope {
  cancelled: boolean;
  stops: Set<Stop>;
  finished: Promise<void>;
  finish(): void;
}
const scopes = new Map<string, Scope>();

export function beginAdapterRunCancellation(runId: string): void {
  if (scopes.has(runId)) throw new Error("Adapter cancellation scope already exists");
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  scopes.set(runId, { cancelled: false, stops: new Set(), finished, finish });
}

export function hasAdapterRunCancellation(runId: string): boolean {
  return scopes.has(runId);
}

export function throwIfAdapterRunCancelled(runId: string): void {
  if (scopes.get(runId)?.cancelled) {
    throw Object.assign(new Error("Adapter run cancelled by control plane"), { code: "ADAPTER_RUN_CANCELLED" });
  }
}

export function registerAdapterRunStop(runId: string, stop: Stop): () => void {
  const scope = scopes.get(runId);
  scope?.stops.add(stop);
  return () => { scope?.stops.delete(stop); };
}

/** Call only after the run's final save and resource teardown have settled. */
export function finishAdapterRunCancellation(runId: string): void {
  const scope = scopes.get(runId);
  if (!scope) return;
  scopes.delete(runId);
  scope.finish();
}

/** The caller persists cancellation before stopping execution, preventing retry admission. */
export async function cancelAdapterRunExecution(runId: string): Promise<void> {
  const scope = scopes.get(runId);
  if (!scope) return;
  scope.cancelled = true;
  // Keep failed stops available for an explicit retry. Never mistake a failed
  // control request for proof that execution or its final save has completed.
  await Promise.all([...scope.stops].map((stop) => stop()));
  await scope.finished;
}

/** A resource acquired during cancellation must be stopped before it is exposed. */
export async function bindAdapterRunStop(runId: string, stop: Stop): Promise<Stop> {
  let stopped: Promise<void> | undefined;
  const once = () => stopped ??= stop();
  const unregister = registerAdapterRunStop(runId, once);
  try { throwIfAdapterRunCancelled(runId); }
  catch (error) {
    unregister();
    await once();
    throw error;
  }
  return async () => {
    try { await once(); } finally { unregister(); }
  };
}
