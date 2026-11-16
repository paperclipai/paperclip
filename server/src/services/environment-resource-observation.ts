import { dedicatedDbConnectionStats, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { PluginEnvironmentLeaseObservation } from "@paperclipai/plugin-sdk";

type LeaseBinding = Pick<EnvironmentLease, "id" | "companyId" | "environmentId" | "heartbeatRunId" |
  "provider" | "providerLeaseId" | "status" | "releasedAt">;
export type ObservedResourceBinding = { leaseId: string; environmentId: string; providerLeaseId: string };
export type EnvironmentResourceObservationScope = { signal: AbortSignal; db?: Db };
type ObservationFailure = "budget_exhausted" | "lease_read_failed" | "lease_changed" |
  "observation_capacity_busy" | "inspection_failed" | "inspection_unavailable" | "foreign_observation" | "resource_active" | "resource_unknown";
const failures = new WeakMap<object, ObservationFailure>();

/** Read-only evidence; never execution, replacement, or cleanup authority. */
export class EnvironmentResourceStoppedError extends Error {
  readonly code = "environment_resource_stopped";
  constructor(readonly binding: ObservedResourceBinding, readonly state: "stopped" | "destroyed", cause: unknown) {
    super("The exact environment resource is positively stopped.", { cause });
    this.name = "EnvironmentResourceStoppedError";
  }
  matches(binding: ObservedResourceBinding | undefined): boolean {
    return binding !== undefined && binding.leaseId === this.binding.leaseId &&
      binding.environmentId === this.binding.environmentId && binding.providerLeaseId === this.binding.providerLeaseId;
  }
}

export function readEnvironmentResourceObservationFailure(error: unknown): ObservationFailure | null {
  return error && typeof error === "object" ? failures.get(error) ?? null : null;
}

/** A failed command may hide a stopped namespace. Observe only that SAME lease,
 * through its normal provider port, inside the command's original budget. */
export async function observeStoppedExecutionResource<T extends LeaseBinding>(input: {
  expected: T; originalError: unknown; deadline: number;
  db?: Db;
  readCurrentLease: (scope: EnvironmentResourceObservationScope) => Promise<T | null>;
  inspect: (lease: T, timeoutMs: number, scope: EnvironmentResourceObservationScope) => Promise<PluginEnvironmentLeaseObservation | undefined>;
}): Promise<EnvironmentResourceStoppedError | null> {
  const fail = (reason: ObservationFailure) => {
    if (input.originalError && typeof input.originalError === "object") failures.set(input.originalError, reason);
    return null;
  };
  const remaining = () => Math.min(15_000, Math.floor(input.deadline - performance.now()));
  if (!Number.isFinite(input.deadline) || remaining() < 1) return fail("budget_exhausted");
  const expected = { ...input.expected };
  const controller = new AbortController();
  let owned: Db | undefined;
  let ending: Promise<void> | undefined;
  const endOwned = () => {
    if (owned) ending ??= owned.$client.end({ timeout: 0 }).catch(() => undefined);
  };
  let expire!: (value: null) => void;
  const expired = new Promise<null>(resolve => { expire = resolve; });
  const timer = setTimeout(() => {
    controller.abort();
    endOwned(); // Only this borrowed connection; never the caller's shared pool.
    expire(fail("budget_exhausted"));
  }, Math.max(0, input.deadline - performance.now()));
  const observe = async (scope: EnvironmentResourceObservationScope) => {
    let current: T | null;
    try { current = await input.readCurrentLease(scope); } catch { return fail(scope.signal.aborted ? "budget_exhausted" : "lease_read_failed"); }
    if (scope.signal.aborted || remaining() < 1) return fail("budget_exhausted");
    if (!current || !expected.environmentId || !expected.heartbeatRunId || !expected.provider || !expected.providerLeaseId ||
        current.id !== expected.id || current.companyId !== expected.companyId || current.environmentId !== expected.environmentId ||
        current.heartbeatRunId !== expected.heartbeatRunId || current.provider !== expected.provider ||
        current.providerLeaseId !== expected.providerLeaseId || current.status !== expected.status ||
        current.releasedAt?.getTime() !== expected.releasedAt?.getTime()) return fail("lease_changed");
    const timeoutMs = remaining();
    if (timeoutMs < 1) return fail("budget_exhausted");
    let observation: PluginEnvironmentLeaseObservation | undefined;
    try { observation = await input.inspect(current, timeoutMs, scope); } catch { return fail(scope.signal.aborted ? "budget_exhausted" : "inspection_failed"); }
    if (scope.signal.aborted || remaining() < 1) return fail("budget_exhausted");
    if (!observation) return fail("inspection_unavailable");
    if (observation.providerLeaseId !== current.providerLeaseId) return fail("foreign_observation");
    if (observation.state === "active") return fail("resource_active");
    if (observation.state !== "stopped" && observation.state !== "destroyed") return fail("resource_unknown");
    // Provider inspection awaited outside the database. A concurrent resume,
    // release, or resource rotation must not turn a stale positive into evidence.
    let after: T | null;
    try { after = await input.readCurrentLease(scope); } catch { return fail(scope.signal.aborted ? "budget_exhausted" : "lease_read_failed"); }
    if (scope.signal.aborted || remaining() < 1) return fail("budget_exhausted");
    if (!after || after.id !== expected.id || after.companyId !== expected.companyId ||
        after.environmentId !== expected.environmentId || after.heartbeatRunId !== expected.heartbeatRunId ||
        after.provider !== expected.provider || after.providerLeaseId !== expected.providerLeaseId ||
        after.status !== expected.status || after.releasedAt?.getTime() !== expected.releasedAt?.getTime()) return fail("lease_changed");
    if (scope.signal.aborted || remaining() < 1) return fail("budget_exhausted");
    return new EnvironmentResourceStoppedError({ leaseId: current.id, environmentId: expected.environmentId,
      providerLeaseId: expected.providerLeaseId }, observation.state, input.originalError);
  };
  const run = async (connection?: Db) => {
    owned = connection;
    if (controller.signal.aborted) { endOwned(); return fail("budget_exhausted"); }
    // Resolve the borrowed action on expiry so its normal finally releases the
    // dedicated admission slot even if an external callback never settles.
    return await Promise.race([observe({ signal: controller.signal, db: connection }), expired]);
  };
  try {
    // Both the snapshot and the helper's slot reservation run synchronously
    // before their first await. Optional diagnostics never jump queued owners
    // or use the helper's deliberate nested/soft-overage escape hatch.
    if (input.db) {
      const capacity = dedicatedDbConnectionStats(input.db);
      if (!capacity || capacity.closed || capacity.inUse >= capacity.limit || capacity.waiting > 0) {
        return fail("observation_capacity_busy");
      }
    }
    const work = input.db
      ? withDedicatedDbConnection(input.db, run, { admitWithoutWaiting: true })
      : run();
    return await Promise.race([work, expired]);
  } catch {
    return fail(controller.signal.aborted ? "budget_exhausted" : "lease_read_failed");
  } finally {
    clearTimeout(timer);
  }
}
