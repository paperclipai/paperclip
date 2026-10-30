import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Called in the lease-release transaction; an absent PID/timeout grants no authority. */
export async function clearRemoteWorkspaceLocationForReleasedLease(input: { db: Db | Transaction; lease: EnvironmentLease }) {
  if (!hasRemoteTerminationReceipt(input.lease)
    || (input.lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state !== "destroyed") return;
  const workspaces = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.lease.companyId),
    sql`${executionWorkspaces.metadata}->'remoteWorkspace'->'location'->>'leaseId' = ${input.lease.id}`,
  )).for("update");
  for (const workspace of workspaces) {
    const authority = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!authority?.location || authority.dirty || !authority.snapshotId || authority.writerRunId
      || authority.location.providerLeaseId !== input.lease.providerLeaseId || authority.location.environmentId !== input.lease.environmentId) continue;
    const [saved] = await input.db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
      eq(executionWorkspaceSnapshots.id, authority.snapshotId), eq(executionWorkspaceSnapshots.status, "committed")));
    if (!saved) continue;
    await notifyRemoteWorkspaceSnapshots(input.db, `workspace:${workspace.id}`);
    await input.db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: { ...authority, location: null } }, updatedAt: new Date() })
      .where(and(eq(executionWorkspaces.id, workspace.id),
        sql`${executionWorkspaces.metadata}->'remoteWorkspace' = ${JSON.stringify(authority)}::jsonb`));
  }
}
