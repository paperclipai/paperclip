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

export function hasRemoteTerminationReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; cleanupStatus: string | null; status: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  return Boolean(lease.releasedAt && lease.cleanupStatus === "success" &&
    ["released", "expired", "failed"].includes(lease.status) && receipt &&
    receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt));
}

export function hasRecoveredSourceStopReceipt(lease: LeaseIdentity & { metadata: Record<string, unknown> | null }): boolean {
  const cleanup = lease.metadata?.workspaceRecoveryCleanup as Record<string, unknown> | undefined;
  const receipt = cleanup?.stoppedTermination as Record<string, unknown> | undefined;
  return Boolean(cleanup && receipt && cleanup.runId === lease.heartbeatRunId &&
    receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt));
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

export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  if (leases.length === 0) return null;
  const resolved = await Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
  if (!resolved.every(hasRemoteTerminationReceipt)) return null;
  return [...new Set(resolved.map(lease => remoteLeaseCleanupScope(lease)!))];
}

export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string) {
  return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
}
