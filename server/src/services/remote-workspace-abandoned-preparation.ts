import { and, eq } from "drizzle-orm";
import { executionWorkspaces, type heartbeatRuns, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA } from "./remote-workspace-epoch-abandonment.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runnerProfileJson">;

export async function isAbandonedPreparedRemoteWorkspace(db: Db, run: Run): Promise<boolean> {
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!parsed.success || parsed.data.state !== "prepared") return false;
  const reference = parsed.data;
  const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (!authority || authority.epoch <= reference.epoch || authority.writerRunId === run.id) return false;
  const receipts = Array.isArray(workspace?.metadata?.remoteWorkspaceAbandonedEpochs)
    ? workspace!.metadata!.remoteWorkspaceAbandonedEpochs as Array<Record<string, unknown>> : [];
  return receipts.some(receipt => {
    const location = receipt?.location as Record<string, unknown> | undefined;
    return receipt?.schema === REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA && receipt.runId === run.id
      && receipt.epoch === reference.epoch && (receipt.snapshotId ?? null) === (reference.snapshotId ?? null)
      && location?.leaseId === reference.leaseId && location?.providerLeaseId === reference.providerLeaseId
      && location?.remoteCwd === reference.remoteCwd;
  });
}
