import { and, eq } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, type EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "metadata">;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DestroyRemoteWorkspaceLease = (input: {
  companyId: string; workspaceId: string; leaseId: string; environmentId: string; providerLeaseId: string;
}) => Promise<EnvironmentLease | null>;

export async function inspectRemoteWorkspacePersistence(db: Db | Transaction, workspace: Workspace) {
  const authority = readRemoteWorkspaceAuthority(workspace.metadata);
  if (!authority || authority.dirty || authority.writerRunId || !authority.snapshotId) {
    return { ready: false, reason: "The workspace still has unsaved work or an unfinished writer.", authority };
  }
  const [snapshot] = await db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
    eq(executionWorkspaceSnapshots.id, authority.snapshotId), eq(executionWorkspaceSnapshots.status, "committed"),
  ));
  return { ready: Boolean(snapshot), reason: snapshot ? null : "The saved workspace is unavailable. Its remote files were retained.", authority };
}

/** Called within the workspace lifecycle fence; the saved workspace remains durable. */
export async function cleanupRemoteWorkspaceAllocation(input: {
  db: Db; workspace: Workspace; destroyLease: DestroyRemoteWorkspaceLease;
}) {
  const [workspace] = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.workspace.companyId), eq(executionWorkspaces.id, input.workspace.id),
  ));
  if (!workspace || !["archived", "cleanup_failed"].includes(workspace.status)) throw new Error("remote_workspace_cleanup_binding_changed");
  const persistence = await inspectRemoteWorkspacePersistence(input.db, workspace);
  if (!persistence.ready || !persistence.authority) throw new Error(persistence.reason ?? "remote_workspace_saved_state_required");
  const location = persistence.authority.location;
  if (location) {
    const released = await input.destroyLease({ companyId: workspace.companyId, workspaceId: workspace.id,
      leaseId: location.leaseId, environmentId: location.environmentId, providerLeaseId: location.providerLeaseId });
    if (!released || !hasRemoteTerminationReceipt(released)
      || (released.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state !== "destroyed") {
      throw new Error("remote_workspace_cleanup_unconfirmed");
    }
  }
  return { cleaned: true, warnings: [] as string[] };
}
