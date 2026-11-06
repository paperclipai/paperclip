import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { hasRemoteRecoveryAttachment } from "./remote-workspace-transport.js";
import { LEGACY_WORKSPACE_RECOVERY_MIGRATION } from "./legacy-workspace-recovery-migration.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { readSnapshot, verifiedWorkspaceSnapshotReceipt } from "./workspace-recovery-snapshot.js";
import { recoveryRunAncestry } from "./recovery-run-ancestry.js";
import { immutableRemoteWorkspaceRecoveryAttachment } from "./workspace-recovery-receipt.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { assertExecutionWorkspaceRecordAccess } from "./task-workspace-access.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { getStorageService, type StorageService } from "../storage/index.js";

/** Import verified canonical recovery as a sidecar. The selected workspace and
 * its own files stay intact; this does not grant execution or replay authority. */
export async function attachPreservedRemoteWorkspaceSnapshots(input: {
  db: Db; companyId: string; issueId: string; runId: string; workspaceId: string;
  sourceRunIds: string[]; cwd: string; storage?: StorageService;
}) {
  const [writer] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.status, "running"),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  ));
  if (!writer) throw new Error("remote_workspace_recovery_writer_changed");
  const ancestry: Array<{ id: string }> = await recoveryRunAncestry(input);
  const sources = ancestry.length ? await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, ancestry.map(row => row.id)),
  )) : [];
  const canonicalReceipts = sources.length ? await input.db.select({ runId: workspaceOperations.heartbeatRunId })
    .from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
      eq(workspaceOperations.issueId, input.issueId), inArray(workspaceOperations.heartbeatRunId, sources.map(source => source.id)),
      eq(workspaceOperations.phase, "workspace_recovery"), sql`${workspaceOperations.metadata}->>'storage' = 'remote_workspace'`,
    )) : [];
  const canonicalSources = new Set(canonicalReceipts.map(receipt => receipt.runId));
  const result: Array<{ operationId: string; path: string; sourceRunId: string }> = [];
  for (const source of sources) {
    if (source.runnerProfileJson?.remoteWorkspace == null) {
      if (canonicalSources.has(source.id)) throw new Error("remote_workspace_recovery_receipt_invalid");
      continue;
    }
    const parsed = remoteWorkspaceRunReferenceSchema.safeParse(source.runnerProfileJson.remoteWorkspace);
    if (!parsed.success) {
      if (hasRequiredWorkspaceRecovery(source.resultJson)) throw new Error("remote_workspace_recovery_receipt_invalid");
      continue;
    }
    const remote = parsed.data;
    if (canonicalSources.has(source.id) && (remote.state !== "saved" || !remote.snapshotId))
      throw new Error("remote_workspace_recovery_receipt_invalid");
    if (remote.workspaceId === input.workspaceId || remote.state !== "saved" || !remote.snapshotId) continue;
    const proof = await immutableRemoteWorkspaceRecoveryAttachment(input.db, source);
    if (!proof) {
      if (hasRequiredWorkspaceRecovery(source.resultJson)) throw new Error("remote_workspace_recovery_receipt_invalid");
      continue;
    }
    const operationId = proof.operationId;
    await assertExecutionWorkspaceRecordAccess(input.db, { type: "agent", source: "agent_jwt",
      companyId: input.companyId, agentId: writer.agentId, runId: writer.id,
      onBehalfOfUserId: writer.responsibleUserId === "local-board" ? null : writer.responsibleUserId },
    input.companyId, remote.workspaceId);
    const saved = await getWorkspaceSnapshot(input.db, { companyId: input.companyId,
      workspaceId: remote.workspaceId, snapshotId: remote.snapshotId });
    if (!saved || saved.sha256 !== proof.sha256 || saved.generation !== proof.generation)
      throw new Error("remote_workspace_recovery_snapshot_missing");
    const provenance = JSON.stringify({ schema: "paperclip.remote-workspace-recovery-attachment.v1",
      operationId, sourceRunId: source.id, workspaceId: remote.workspaceId,
      snapshotId: remote.snapshotId, sha256: saved.sha256 });
    const parent = path.join(await realpath(input.cwd), ".paperclip-recovered");
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent)
      throw new Error("remote_workspace_recovery_attachment_invalid");
    const destination = path.join(parent, operationId);
    const prior = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (prior) {
      const proofPath = path.join(destination, "provenance.json");
      const proof = await lstat(proofPath).catch(() => null);
      if (!prior.isDirectory() || prior.isSymbolicLink() || await realpath(destination) !== destination
        || !proof?.isFile() || proof.isSymbolicLink() || await readFile(proofPath, "utf8") !== provenance)
        throw new Error("remote_workspace_recovery_attachment_invalid");
    } else {
      const staging = await mkdtemp(path.join(parent, ".preparing-"));
      try {
        const archivePath = path.join(staging, "archive.pcws");
        await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: saved, targetPath: archivePath });
        await restoreRemoteWorkspaceArchive({ archivePath, targetDir: path.join(staging, "files"), expectedManifestDigest: saved.manifestDigest });
        await rm(archivePath);
        await writeFile(path.join(staging, "provenance.json"), provenance, { flag: "wx", mode: 0o600 });
        await rename(staging, destination);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    result.push({ operationId, path: destination, sourceRunId: source.id });
  }
  return result;
}

/** Verify a sidecar already inside an authorized shared workspace. This only
 * reconstructs its immutable identity; it cannot import files or admit work. */
async function retainedRecoveryAttachmentProvenance(input: {
  db: Db; companyId: string; issueIds: string[]; sourceRunId: string; operationId: string;
  workspace: Pick<typeof executionWorkspaces.$inferSelect, "id" | "metadata">;
}): Promise<string | null> {
  const [source] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId)));
  const issueId = source?.nativeIssueId ?? source?.issueId ?? source?.contextSnapshot?.issueId;
  if (!source || typeof issueId !== "string") return null;
  if (!input.issueIds.includes(issueId)) {
    // A committed workspace migration is the history owner for all related
    // task attachments. Task relationships alone never authorize retention.
    const marker = record(input.workspace.metadata?.legacyWorkspaceRecoveryMigration);
    const sourceMarker = record(source.runnerProfileJson?.legacyWorkspaceRecoveryMigration
      ?? source.runnerProfileJson?.finalizedWorkspaceRecoveryMigration);
    if (marker.schema !== LEGACY_WORKSPACE_RECOVERY_MIGRATION || typeof marker.operationId !== "string"
      || sourceMarker.schema !== marker.schema || sourceMarker.operationId !== marker.operationId
      || sourceMarker.workspaceId !== input.workspace.id) return null;
    const [migration] = await input.db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.workspace.id),
      eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration"),
      eq(workspaceOperations.status, "succeeded")));
    const history = migration?.metadata?.legacyRecoverySources;
    if (!Array.isArray(history) || !history.some(value => {
      const entry = record(value); return entry.runId === source.id && entry.issueId === issueId;
    })) return null;
  }
  const [operation] = await input.db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, issueId),
    eq(workspaceOperations.heartbeatRunId, source.id), eq(workspaceOperations.id, input.operationId),
    eq(workspaceOperations.status, "succeeded")));
  if (operation?.phase === "workspace_recovery_snapshot") {
    const saved = readSnapshot(operation.metadata, input.companyId, source.id);
    const proof = await verifiedWorkspaceSnapshotReceipt(input.db, { companyId: input.companyId, issueId,
      runId: source.id, actionId: saved.recoveryActionId, operationIds: [operation.id],
      leaseId: saved.leaseId, providerLeaseId: saved.providerLeaseId });
    return proof ? JSON.stringify({ schema: saved.schema, operationId: operation.id, sourceRunId: source.id,
      leaseId: saved.leaseId, sha256: saved.archive.sha256 }) : null;
  }
  if (operation?.phase !== "workspace_recovery") return null;
  const proof = await immutableRemoteWorkspaceRecoveryAttachment(input.db, source);
  return proof?.operationId === operation.id ? JSON.stringify({ schema: "paperclip.remote-workspace-recovery-attachment.v1",
    operationId: proof.operationId, sourceRunId: source.id, workspaceId: proof.workspaceId,
    snapshotId: proof.snapshotId, sha256: proof.sha256 }) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Publish only existing sidecars with exact host-recorded or receipt-backed
 * provenance. This checks the selected root; it never imports or replaces files. */
export async function retainRemoteRecoveryAttachments(input: {
  db: Db; workspace: Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "sourceIssueId" | "metadata">;
  runId: string; remoteRoot: string; target: AdapterSandboxExecutionTarget; assertOwned?: () => Promise<void>;
  recoveredFiles: Array<{ operationId: string; sourceRunId: string; path: string; provenance: string }>;
}) {
  const retained = input.workspace.metadata?.remoteWorkspaceRecoveredFiles;
  for (const value of Array.isArray(retained) ? retained : []) {
    const item = record(value);
    if (typeof item.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(item.operationId)
      || typeof item.sourceRunId !== "string" || item.path !== `.paperclip-recovered/${item.operationId}`)
      throw new Error("remote_workspace_recovered_files_invalid");
    if (input.recoveredFiles.some(current => current.operationId === item.operationId)) continue;
    let provenance = typeof item.provenance === "string" ? item.provenance : null;
    if (!provenance) {
      const [writer] = await input.db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.workspace.companyId), eq(heartbeatRuns.id, input.runId)));
      const issueId = writer?.nativeIssueId ?? writer?.issueId ?? writer?.contextSnapshot?.issueId;
      provenance = await retainedRecoveryAttachmentProvenance({ db: input.db, companyId: input.workspace.companyId,
        workspace: input.workspace, issueIds: [issueId, input.workspace.sourceIssueId].filter((id): id is string => typeof id === "string"),
        sourceRunId: item.sourceRunId, operationId: item.operationId });
      if (!provenance) throw new Error("remote_workspace_recovery_receipt_invalid");
    }
    await input.assertOwned?.();
    if (await hasRemoteRecoveryAttachment({ target: input.target, remoteCwd: input.remoteRoot, operationId: item.operationId, provenance }))
      input.recoveredFiles.push({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: item.path, provenance });
  }
}
