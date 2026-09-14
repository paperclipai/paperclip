import { and, eq, or, sql } from "drizzle-orm";
import { environmentLeases, runtimeServiceAllocations, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select" | "execute">;
export type ServiceLeaseIdentity = { id: string; companyId: string; provider: string | null; providerLeaseId: string | null };

/** All claims on one physical sandbox use the same lock, including new run leases. */
export async function lockRuntimeServiceLease(db: Reader, lease: ServiceLeaseIdentity) {
  const key = `runtime-service-allocation:${lease.companyId}:${lease.provider ?? "local"}:${lease.providerLeaseId ?? lease.id}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function assertRuntimeServiceLeaseDataAvailable(db: Reader, lease: ServiceLeaseIdentity) {
  const [deleting] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, lease.companyId),
      or(eq(environmentLeases.id, lease.id), lease.providerLeaseId ? and(eq(environmentLeases.providerLeaseId, lease.providerLeaseId), eq(environmentLeases.provider, lease.provider ?? "local")) : undefined),
      sql`${environmentLeases.metadata}->>'runtimeServiceDataDeletionId' IS NOT NULL`)).limit(1);
  if (deleting) throw conflict("This service workspace is being deleted or has been deleted; it cannot accept another run or service");
}

export async function withRuntimeServiceLeaseLock<T>(db: Db, lease: ServiceLeaseIdentity, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => { await lockRuntimeServiceLease(tx, lease); return work(tx); });
}

export async function lockRuntimeServiceEnvironment(db: Reader, environmentId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`runtime-service-environment:${environmentId}`}))`);
}

export async function runtimeServiceRetentionForEnvironment(db: Reader, environmentId: string) {
  return db.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
    .innerJoin(environmentLeases, and(eq(environmentLeases.id, runtimeServiceAllocations.environmentLeaseId), eq(environmentLeases.companyId, runtimeServiceAllocations.companyId)))
    .where(and(eq(environmentLeases.environmentId, environmentId), sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`));
}

export async function runtimeServiceRetentionForLease(db: Reader, lease: ServiceLeaseIdentity) {
  return db.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
    .innerJoin(environmentLeases, and(eq(environmentLeases.id, runtimeServiceAllocations.environmentLeaseId), eq(environmentLeases.companyId, runtimeServiceAllocations.companyId)))
    .where(and(
      eq(runtimeServiceAllocations.companyId, lease.companyId),
      sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`,
      or(eq(environmentLeases.id, lease.id), lease.providerLeaseId ? and(eq(environmentLeases.providerLeaseId, lease.providerLeaseId), lease.provider ? eq(environmentLeases.provider, lease.provider) : undefined) : undefined),
    ));
}

export async function runtimeServiceRetentionForWorkspace(db: Reader, companyId: string, executionWorkspaceId: string) {
  return db.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
    .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.executionWorkspaceId, executionWorkspaceId),
      sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`)).limit(1);
}

export async function assertWorkspaceHasNoRetainedServices(db: Reader, companyId: string, executionWorkspaceId: string) {
  const [allocation] = await runtimeServiceRetentionForWorkspace(db, companyId, executionWorkspaceId);
  if (allocation) throw conflict("This workspace contains retained runtime service files. Release their data retention before removing the workspace.", { allocationId: allocation.id });
}

export async function lockRuntimeServiceWorkspace(db: Reader, companyId: string, workspaceId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`runtime-service-workspace:${companyId}:${workspaceId}`}))`);
}

export async function withRuntimeServiceWorkspaceCleanup<T>(db: Db, companyId: string, workspaceId: string, cleanup: () => Promise<T>) {
  return db.transaction(async (tx) => {
    await lockRuntimeServiceWorkspace(tx, companyId, workspaceId);
    await assertWorkspaceHasNoRetainedServices(tx, companyId, workspaceId);
    return cleanup();
  });
}
