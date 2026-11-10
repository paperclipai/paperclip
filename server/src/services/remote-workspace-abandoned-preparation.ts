import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA } from "./remote-workspace-epoch-abandonment.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runnerProfileJson">;

export async function isAbandonedPreparedRemoteWorkspace(db: Db, run: Run): Promise<boolean> {
  if (run.runnerProfileJson?.nativeWorkspaceSync != null) return false;
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
      && receipt.epoch === reference.epoch
      && location?.leaseId === reference.leaseId && location?.providerLeaseId === reference.providerLeaseId
      && location?.remoteCwd === reference.remoteCwd;
  });
}

export function abandonedPreparedRemoteWorkspaceExists() {
  const reference = sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'`;
  return sql`(${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is null and ${reference}->>'state' = 'prepared'
    and exists (select 1 from execution_workspaces workspace
      cross join lateral jsonb_array_elements(case when jsonb_typeof(workspace.metadata->'remoteWorkspaceAbandonedEpochs') = 'array'
        then workspace.metadata->'remoteWorkspaceAbandonedEpochs' else '[]'::jsonb end) receipt
      where workspace.company_id = ${heartbeatRuns.companyId} and workspace.id::text = ${reference}->>'workspaceId'
        and receipt->>'schema' = ${REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA} and receipt->>'runId' = ${heartbeatRuns.id}::text
        and receipt->'epoch' = ${reference}->'epoch'))`;
}
