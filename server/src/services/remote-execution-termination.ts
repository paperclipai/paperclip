import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";

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

export function remoteLeaseCleanupScope(lease: Pick<LeaseIdentity, "provider" | "providerLeaseId">) {
  return lease.provider && lease.provider !== "local" && lease.providerLeaseId
    ? JSON.stringify([lease.provider, lease.providerLeaseId]) : undefined;
}

export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  if (leases.length === 0 || !leases.every(hasRemoteTerminationReceipt)) return null;
  return [...new Set(leases.map(lease => remoteLeaseCleanupScope(lease)!))];
}

export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string) {
  return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
}
