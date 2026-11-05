import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, executionWorkspaces, executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "metadata">;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DestroyRemoteWorkspaceLease = (input: {
  companyId: string; workspaceId: string; leaseId: string; environmentId: string; providerLeaseId: string;
}) => Promise<EnvironmentLease | null>;

export type WorkspaceSourceLease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId">;

export async function preparedRemoteWorkspaceSource(db: Db, lease: WorkspaceSourceLease) {
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" || !lease.providerLeaseId) return null;
  const [bound] = await db.select({ lease: environmentLeases, run: {
    id: heartbeatRuns.id, runtimeMode: heartbeatRuns.runtimeMode,
    controllerBootId: heartbeatRuns.controllerBootId,
    issueId: sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'`,
    legacyReference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
  } }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
      eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId), eq(environmentLeases.provider, lease.provider),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'state' = 'prepared'`)).limit(1);
  if (!bound) return null;
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(bound.run.reference);
  if (!parsed.success || parsed.data.state !== "prepared" || bound.run.legacyReference != null) return null;
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, lease.companyId), eq(executionWorkspaces.id, parsed.data.workspaceId))).limit(1);
  return matchPreparedRemoteWorkspaceSource(bound, workspace);
}

type PreparedSourceBinding = {
  lease: Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId"
    | "issueId" | "executionWorkspaceId" | "environmentId" | "metadata">;
  run: { id: string; runtimeMode: string; controllerBootId: string | null; issueId: string | null;
    reference: unknown; legacyReference: unknown };
};

/** Shared binding proof for single-source inspection and batched allocation fencing. */
export function matchPreparedRemoteWorkspaceSource<T extends PreparedSourceBinding>(bound: T,
  workspace: Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "sourceIssueId" | "mode" | "metadata"> | null | undefined) {
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(bound.run.reference);
  if (!parsed.success || parsed.data.state !== "prepared" || bound.run.legacyReference != null) return null;
  const reference = parsed.data;
  const issueId = bound.run.issueId;
  if (typeof issueId !== "string" || bound.lease.issueId !== issueId || reference.leaseId !== bound.lease.id
    || reference.providerLeaseId !== bound.lease.providerLeaseId || reference.remoteCwd !== bound.lease.metadata?.remoteCwd
    || bound.lease.executionWorkspaceId && bound.lease.executionWorkspaceId !== reference.workspaceId) return null;
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (!workspace || workspace.companyId !== bound.lease.companyId || workspace.id !== reference.workspaceId
    || workspace.sourceIssueId !== issueId && workspace.mode !== "shared_workspace"
    || !authority || !authority.dirty || authority.writerRunId !== bound.run.id || authority.epoch !== reference.epoch
    || authority.snapshotId !== reference.snapshotId || !authority.location
    || authority.location.environmentId !== bound.lease.environmentId || authority.location.leaseId !== bound.lease.id
    || authority.location.providerLeaseId !== bound.lease.providerLeaseId || authority.location.remoteCwd !== reference.remoteCwd) return null;
  return { ...bound, workspace, reference, issueId };
}

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
