import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";

type Lease = typeof environmentLeases.$inferSelect;

type LeaseIdentity = {
  id: string; companyId: string; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
};

/** Bind a provider receipt to the exact host-owned lease and run. Old plugins
 * return void; that remains supported but grants no continuation authority. */
export function remoteTerminationReceipt(lease: LeaseIdentity, value: unknown) {
  const receipt = value as { providerLeaseId?: unknown; state?: unknown } | null;
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" ||
      !lease.providerLeaseId || receipt?.providerLeaseId !== lease.providerLeaseId ||
      !["stopped", "destroyed"].includes(String(receipt?.state))) return undefined;
  return {
    schema: "paperclip.remote-termination.v1", companyId: lease.companyId,
    runId: lease.heartbeatRunId, leaseId: lease.id, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, state: receipt!.state,
    confirmedAt: new Date().toISOString(),
  };
}

type ReceiptLease = LeaseIdentity & {
  releasedAt: unknown; cleanupStatus: string | null; status: string;
  metadata: Record<string, unknown> | null;
};

/** The lease carries a provider stop receipt bound to its exact company, run,
 * lease, provider and physical task. It proves execution there stopped, not
 * that the lease's resources were released. */
export function hasBoundRemoteStopReceipt(lease: Pick<ReceiptLease, keyof LeaseIdentity | "metadata">): boolean {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  return Boolean(receipt && receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt));
}

/** The lease was released with successful cleanup and its bound stop receipt.
 * Resource cleanup gates use this; it never accepts an unreleased lease. */
export function hasRemoteTerminationReceipt(lease: ReceiptLease): boolean {
  return Boolean(lease.releasedAt && lease.cleanupStatus === "success" &&
    ["released", "expired", "failed"].includes(lease.status) && hasBoundRemoteStopReceipt(lease));
}

/** Release or destroy of this lease has started: plugin release and destroy
 * record their cleanup method first, and task settlement, startup cleanup and
 * interrupted-creation cleanup mark the task retiring. The provider can then be
 * releasing the task's resources while the lease row is still active. */
function leaseReleaseStarted(lease: Pick<ReceiptLease, "metadata">): boolean {
  return lease.metadata?.pluginLeaseCleanupMethod !== undefined || lease.metadata?.runnerTaskRetiring === true;
}

/** Execution on this lease has stopped: it was released with its termination
 * receipt, or it is still active, its release has not started, and its plugin
 * task recorded the provider's stop when it settled. Release can be held long
 * after that stop (for example by a pending workspace export); once release
 * starts, it owns the receipt until the lease is released. */
function remoteLeaseExecutionStopped(lease: ReceiptLease): boolean {
  return hasRemoteTerminationReceipt(lease) ||
    lease.status === "active" && !lease.releasedAt && !leaseReleaseStarted(lease) && hasBoundRemoteStopReceipt(lease);
}

/** Workspace recovery saved this run's files, re-stopped its sandbox, and then
 * queued the stopped sandbox for destroy. The destroy is resource cleanup: the
 * stop receipt it carried forward still proves no provider can run there. */
export function hasRecoveredCleanupStopReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; status: string; metadata: Record<string, unknown> | null;
}): boolean {
  const cleanup = lease.metadata?.workspaceRecoveryCleanup as Record<string, unknown> | undefined;
  if (!cleanup || cleanup.runId !== lease.heartbeatRunId || !lease.releasedAt ||
      !["pending_cleanup", "released", "expired", "failed"].includes(lease.status)) return false;
  return hasRemoteTerminationReceipt({ ...lease, status: "released", cleanupStatus: "success",
    metadata: { remoteExecutionTermination: cleanup.stopReceipt } });
}

export function remoteLeaseCleanupScope(lease: Pick<LeaseIdentity, "provider" | "providerLeaseId">) {
  return lease.provider && lease.provider !== "local" && lease.providerLeaseId
    ? JSON.stringify([lease.provider, lease.providerLeaseId]) : undefined;
}

export async function resolveRemoteTerminationLease(db: Db, lease: Lease): Promise<Lease> {
  if (hasRemoteTerminationReceipt(lease) || lease.status !== "expired" ||
      lease.leasePolicy !== "reuse_by_environment" || !lease.provider || !lease.providerLeaseId) return lease;
  const history = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
  ));
  const current = history.find(row => row.id === lease.id);
  if (!current || current.companyId !== lease.companyId || current.heartbeatRunId !== lease.heartbeatRunId) return lease;
  const tips = history.filter(row => !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return current;
  const tip = tips[0]!;
  const receipt = tip.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  if (!hasRemoteTerminationReceipt(tip) || receipt?.state !== "destroyed") return current;
  const predecessors = retiredReusableLeasePredecessors(tip, history.filter(row => row.id !== tip.id));
  if (!predecessors?.some(row => row.id === current.id)) return current;
  const termination = remoteTerminationReceipt(current, { providerLeaseId: current.providerLeaseId, state: "destroyed" });
  if (!termination) return current;
  return { ...current, metadata: { ...current.metadata, remoteExecutionTermination: {
    ...termination, confirmedAt: receipt.confirmedAt,
  } } };
}

async function runRemoteLeases(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  return Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
}

/** Cleanup scopes of a run whose every lease has stopped execution, or null. */
export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await runRemoteLeases(db, companyId, runId);
  if (leases.length === 0 || !leases.every(remoteLeaseExecutionStopped)) return null;
  return [...new Set(leases.map(lease => remoteLeaseCleanupScope(lease)!))];
}

/** Every lease of the run has stopped execution. Its resources can still be held. */
export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string) {
  return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
}

/** Every lease of the run was released with its termination receipt. */
export async function remoteExecutionHasReleased(db: Db, companyId: string, runId: string) {
  const leases = await runRemoteLeases(db, companyId, runId);
  return leases.length > 0 && leases.every(hasRemoteTerminationReceipt);
}
