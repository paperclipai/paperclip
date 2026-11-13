import { sql, type SQL } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA } from "./remote-workspace-epoch-abandonment.js";

export const ABANDONED_WORKSPACE_FILES_RETENTION_DAYS = 7;
export const ABANDONED_WORKSPACE_FILES_RETENTION_MS = ABANDONED_WORKSPACE_FILES_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type AbandonedWorkspaceFilesReleaseReason = "recovered" | "discarded" | "retention_expired";

type HoldLease = Pick<typeof environmentLeases.$inferSelect, "companyId" | "provider" | "providerLeaseId">;

export function abandonedWorkspaceFilesHeldSql(companyId: SQL | string, providerLeaseId: SQL | string): SQL {
  return sql`exists (select 1 from execution_workspaces held_workspace
    cross join lateral jsonb_array_elements(case when jsonb_typeof(held_workspace.metadata->'remoteWorkspaceAbandonedEpochs') = 'array'
      then held_workspace.metadata->'remoteWorkspaceAbandonedEpochs' else '[]'::jsonb end) held_receipt
    where held_workspace.company_id = ${companyId}
      and held_workspace.metadata ? 'remoteWorkspaceAbandonedEpochs'
      and held_receipt->>'schema' = ${REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA}
      and held_receipt->'location'->>'providerLeaseId' = ${providerLeaseId}
      and coalesce(jsonb_typeof(held_receipt->'released'), 'null') = 'null')`;
}

export function abandonedWorkspaceFilesHeldOnLeaseRowSql(): SQL {
  return sql`(${environmentLeases.providerLeaseId} is not null and coalesce(${environmentLeases.provider}, 'local') <> 'local'
    and ${abandonedWorkspaceFilesHeldSql(sql`${environmentLeases.companyId}`, sql`${environmentLeases.providerLeaseId}`)})`;
}

export async function abandonedWorkspaceFilesHeldOnLease(db: Pick<Db, "execute">, lease: HoldLease): Promise<boolean> {
  if (!lease.providerLeaseId || !lease.provider || lease.provider === "local") return false;
  const [row] = await db.execute<{ held: boolean }>(sql`select ${abandonedWorkspaceFilesHeldSql(
    sql`${lease.companyId}::uuid`, lease.providerLeaseId)} as held`);
  return row?.held === true;
}
