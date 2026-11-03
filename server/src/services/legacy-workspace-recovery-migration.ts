import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { NativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";

export type LegacyWorkspaceRecoverySource = { runId: string; issueId: string; reference: NativeWorkspaceSyncReference };
export const LEGACY_WORKSPACE_RECOVERY_MIGRATION = "paperclip.legacy-workspace-recovery-migration.v1";

/** Child tasks can explicitly reuse an ancestor's workspace. The run's own
 * task remains the scope for its recovery files; migration never rebinds it. */
export async function isLegacyWorkspaceTaskRelated(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string | null; sourceIssueId: string | null;
}) {
  let current = input.issueId;
  const visited = new Set<string>();
  while (current && visited.size < 32 && !visited.has(current)) {
    if (current === input.sourceIssueId) return true;
    visited.add(current);
    const [issue] = await db.select({ parentId: issues.parentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, current)));
    current = issue?.parentId ?? null;
  }
  return false;
}

/** This receipt changes where recovery may save files; it never certifies that
 * a provider stopped or that its files were recovered. The recovery owner must
 * still validate allocation provenance and termination before exporting. */
export async function hasMigratedLegacyWorkspaceSource(db: Pick<Db, "select">, input: {
  companyId: string; runId: string; reference: NativeWorkspaceSyncReference;
}) {
  if (input.reference.state !== "prepared") return false;
  const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.reference.workspaceId),
  ));
  if (!readRemoteWorkspaceAuthority(workspace?.metadata)) return false;
  const marker = workspace?.metadata?.legacyWorkspaceRecoveryMigration as { schema?: unknown; operationId?: unknown } | undefined;
  if (marker?.schema !== LEGACY_WORKSPACE_RECOVERY_MIGRATION || typeof marker.operationId !== "string")
    throw new Error("legacy_workspace_migration_receipt_invalid");
  const [operation] = await db.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.reference.workspaceId),
    eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration"),
    eq(workspaceOperations.status, "succeeded"),
  ));
  const sources = operation?.metadata?.legacyRecoverySources;
  if (!Array.isArray(sources) || !sources.some(source => source && typeof source === "object"
    && source.runId === input.runId && isDeepStrictEqual(source.reference, input.reference)))
    throw new Error("legacy_workspace_migration_receipt_invalid");
  return true;
}
