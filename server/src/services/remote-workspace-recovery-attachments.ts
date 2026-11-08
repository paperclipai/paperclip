import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { hasRemoteRecoveryAttachment, removeRemoteRecoveryAttachment } from "./remote-workspace-transport.js";
import { removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { LEGACY_WORKSPACE_RECOVERY_MIGRATION } from "./legacy-workspace-recovery-migration.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
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
  sourceRunIds: string[]; cwd: string; storage?: StorageService; retiredOperationIds?: ReadonlySet<string>;
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
    if (input.retiredOperationIds?.has(operationId)) continue;
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
      } finally { await removeTaskDirectoryTree(staging); }
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
  verifySelectedSnapshot: (operationId: string, provenance: string) => Promise<boolean>;
}): Promise<string | null> {
  const [source] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId)));
  const issueId = source?.nativeIssueId ?? source?.issueId ?? source?.contextSnapshot?.issueId;
  if (!source || typeof issueId !== "string") return null;
  let historyAllowed = input.issueIds.includes(issueId);
  if (!historyAllowed) {
    // Committed migration history is a workspace-scoped proof, independent of
    // task relationships. A verified saved workspace can prove the same path.
    const marker = record(input.workspace.metadata?.legacyWorkspaceRecoveryMigration);
    const sourceMarker = record(source.runnerProfileJson?.legacyWorkspaceRecoveryMigration
      ?? source.runnerProfileJson?.finalizedWorkspaceRecoveryMigration);
    if (marker.schema === LEGACY_WORKSPACE_RECOVERY_MIGRATION && typeof marker.operationId === "string"
      && sourceMarker.schema === marker.schema && sourceMarker.operationId === marker.operationId
      && sourceMarker.workspaceId === input.workspace.id) {
      const [migration] = await input.db.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.workspace.id),
        eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration"),
        eq(workspaceOperations.status, "succeeded")));
      const history = migration?.metadata?.legacyRecoverySources;
      historyAllowed = Array.isArray(history) && history.some(value => {
        const entry = record(value); return entry.runId === source.id && entry.issueId === issueId;
      });
    }
  }
  const [operation] = await input.db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, issueId),
    eq(workspaceOperations.heartbeatRunId, source.id), eq(workspaceOperations.id, input.operationId),
    eq(workspaceOperations.status, "succeeded")));
  let provenance: string | null = null;
  if (operation?.phase === "workspace_recovery_snapshot") {
    const saved = readSnapshot(operation.metadata, input.companyId, source.id);
    const proof = await verifiedWorkspaceSnapshotReceipt(input.db, { companyId: input.companyId, issueId,
      runId: source.id, actionId: saved.recoveryActionId, operationIds: [operation.id],
      leaseId: saved.leaseId, providerLeaseId: saved.providerLeaseId });
    provenance = proof ? JSON.stringify({ schema: saved.schema, operationId: operation.id, sourceRunId: source.id,
      leaseId: saved.leaseId, sha256: saved.archive.sha256 }) : null;
  } else if (operation?.phase === "workspace_recovery") {
    const proof = await immutableRemoteWorkspaceRecoveryAttachment(input.db, source);
    provenance = proof?.operationId === operation.id ? JSON.stringify({ schema: "paperclip.remote-workspace-recovery-attachment.v1",
      operationId: proof.operationId, sourceRunId: source.id, workspaceId: proof.workspaceId,
      snapshotId: proof.snapshotId, sha256: proof.sha256 }) : null;
  }
  return provenance && (historyAllowed || await input.verifySelectedSnapshot(input.operationId, provenance)) ? provenance : null;
}

/** Recovered copies to remove: those already retired, and those shown to a
 * run other than this one that then succeeded, which had its turn to use them. */
export async function retiredRecoveryAttachments(db: Db,
  workspace: Pick<typeof executionWorkspaces.$inferSelect, "companyId" | "metadata">, runId: string) {
  const retired = new Set<string>();
  const recorded = workspace.metadata?.remoteWorkspaceRecoveredFiles;
  for (const value of Array.isArray(recorded) ? recorded : []) {
    const item = record(value);
    if (typeof item.operationId !== "string") continue;
    if (item.retired === true) { retired.add(item.operationId); continue; }
    const shownTo = item.presentedToRunId;
    if (typeof shownTo !== "string" || shownTo === runId || !/^[a-f0-9-]{36}$/.test(shownTo)) continue;
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, shownTo)));
    if (run?.status === "succeeded") retired.add(item.operationId);
  }
  return retired;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Publish only existing sidecars with exact host-recorded or receipt-backed
 * provenance. This checks the selected root; it never imports or replaces files. */
export async function retainRemoteRecoveryAttachments(input: {
  db: Db; workspace: Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "sourceIssueId" | "metadata">;
  runId: string; remoteRoot: string; target: AdapterSandboxExecutionTarget; assertOwned?: () => Promise<void>;
  recoveredFiles: Array<{ operationId: string; sourceRunId: string; path: string; provenance: string; retired?: true }>;
  retiredOperationIds: ReadonlySet<string>; storage?: StorageService;
}) {
  let snapshotScratch: string | null = null, snapshotFiles: string | null = null, snapshotLoaded = false;
  const verifySelectedSnapshot = async (operationId: string, provenance: string) => {
    if (!snapshotLoaded) {
      snapshotLoaded = true;
      const authority = readRemoteWorkspaceAuthority(input.workspace.metadata);
      if (!authority?.snapshotId) return false;
      const [receipt] = await input.db.select({ status: executionWorkspaceSnapshots.status }).from(executionWorkspaceSnapshots).where(and(
        eq(executionWorkspaceSnapshots.companyId, input.workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspace.id),
        eq(executionWorkspaceSnapshots.id, authority.snapshotId)));
      if (!receipt || !["committed", "superseded"].includes(receipt.status)) return false;
      const saved = await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId,
        workspaceId: input.workspace.id, snapshotId: authority.snapshotId });
      if (!saved) return false;
      await input.assertOwned?.();
      snapshotScratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "pc-retained-recovery-proof-")));
      const archivePath = path.join(snapshotScratch, "archive.pcws");
      await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: saved, targetPath: archivePath });
      snapshotFiles = path.join(snapshotScratch, "files");
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir: snapshotFiles, expectedManifestDigest: saved.manifestDigest });
      await input.assertOwned?.();
    }
    if (!snapshotFiles) return false;
    const directory = path.join(snapshotFiles, ".paperclip-recovered", operationId);
    if (await realpath(directory).catch(() => null) !== directory) return false;
    const file = path.join(directory, "provenance.json"), stat = await lstat(file).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16_384
      && await readFile(file, "utf8") === provenance);
  };
  try {
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
          sourceRunId: item.sourceRunId, operationId: item.operationId, verifySelectedSnapshot });
        if (!provenance) throw new Error("remote_workspace_recovery_receipt_invalid");
      }
      await input.assertOwned?.();
      const location = { target: input.target, remoteCwd: input.remoteRoot, operationId: item.operationId, provenance };
      if (input.retiredOperationIds.has(item.operationId)) {
        await removeRemoteRecoveryAttachment(location);
        input.recoveredFiles.push({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: item.path, provenance, retired: true });
        continue;
      }
      if (await hasRemoteRecoveryAttachment(location))
        input.recoveredFiles.push({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: item.path, provenance });
    }
  } finally { if (snapshotScratch) await removeTaskDirectoryTree(snapshotScratch); }
}
