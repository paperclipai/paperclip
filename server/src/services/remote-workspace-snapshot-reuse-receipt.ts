import { and, eq, isNull, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, workspaceOperations, type Db } from "@paperclipai/db";
import type { RemoteWorkspaceRunReference } from "@paperclipai/shared";

type Snapshot = typeof executionWorkspaceSnapshots.$inferSelect;

export async function verifiedWorkspaceSnapshotReuse(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string; reference: RemoteWorkspaceRunReference; snapshot: Snapshot;
}): Promise<string | null> {
  const { reference, snapshot } = input;
  if (reference.state !== "saved" || reference.snapshotId !== snapshot.id || snapshot.companyId !== input.companyId
    || snapshot.executionWorkspaceId !== reference.workspaceId || !["committed", "superseded"].includes(snapshot.status)
    || !snapshot.objectKey?.startsWith(`${input.companyId}/workspace-snapshots/${reference.workspaceId}/${snapshot.id}/`)
    || !snapshot.key || !snapshot.sha256 || !snapshot.manifestDigest || !snapshot.byteSize) return null;
  const rows = await db.select({ id: workspaceOperations.id, metadata: workspaceOperations.metadata,
    generation: executionWorkspaceSnapshots.generation }).from(workspaceOperations)
    .innerJoin(executionWorkspaceSnapshots, and(
      eq(executionWorkspaceSnapshots.companyId, input.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, reference.workspaceId),
      eq(executionWorkspaceSnapshots.sourceOperationId, workspaceOperations.id),
      eq(executionWorkspaceSnapshots.sourceRunId, input.runId),
      eq(executionWorkspaceSnapshots.epoch, reference.epoch),
      eq(executionWorkspaceSnapshots.parentSnapshotId, snapshot.id),
      eq(executionWorkspaceSnapshots.status, "deleted"),
      isNull(executionWorkspaceSnapshots.objectKey), isNull(executionWorkspaceSnapshots.sha256),
      isNull(executionWorkspaceSnapshots.byteSize), isNull(executionWorkspaceSnapshots.key),
      isNull(executionWorkspaceSnapshots.manifestDigest),
      sql`coalesce(${executionWorkspaceSnapshots.metadata}->'uploads', '[]'::jsonb) = '[]'::jsonb`))
    .where(and(eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId),
      eq(workspaceOperations.executionWorkspaceId, reference.workspaceId), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.metadata}->>'boundary' = 'final'`,
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(reference.epoch)}`,
      sql`${workspaceOperations.metadata}->>'parentSnapshotId' = ${snapshot.id}`,
      sql`${workspaceOperations.metadata}->>'snapshotId' = ${snapshot.id}`,
      sql`${workspaceOperations.metadata}->>'reusedSnapshotId' = ${snapshot.id}`,
      sql`${workspaceOperations.metadata}->>'sha256' = ${snapshot.sha256}`,
      sql`${workspaceOperations.metadata}#>>'{exportCleanup,leaseId}' = ${reference.leaseId}`,
      sql`${workspaceOperations.metadata}#>>'{exportCleanup,providerLeaseId}' = ${reference.providerLeaseId}`,
      sql`${workspaceOperations.metadata}#>>'{exportCleanup,remoteCwd}' = ${reference.remoteCwd}`)).limit(2);
  if (rows.length !== 1) return null;
  const [receipt] = rows, work = receipt.metadata?.saveWork;
  if (receipt.generation <= snapshot.generation || receipt.metadata?.generation !== receipt.generation
    || !work || typeof work !== "object" || Array.isArray(work)) return null;
  const settled = work as Record<string, unknown>;
  if (settled.schema !== "paperclip.remote-workspace-save-work.v1" || settled.unknown !== false
    || !Array.isArray(settled.activeIds) || settled.activeIds.length !== 0
    || typeof settled.quiescedAt !== "string" || !Number.isFinite(Date.parse(settled.quiescedAt))) return null;
  return receipt.id;
}
