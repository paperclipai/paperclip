import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { recoveryRunAncestry } from "./recovery-run-ancestry.js";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { assertExecutionWorkspaceRecordAccess } from "./task-workspace-access.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { getStorageService } from "../storage/index.js";

/** Import verified canonical recovery as a sidecar. The selected workspace and
 * its own files stay intact; this does not grant execution or replay authority. */
export async function attachPreservedRemoteWorkspaceSnapshots(input: {
  db: Db; companyId: string; issueId: string; runId: string; workspaceId: string;
  sourceRunIds: string[]; cwd: string;
}) {
  const [writer] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.status, "running"),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  ));
  if (!writer) throw new Error("remote_workspace_recovery_writer_changed");
  const ancestry = await recoveryRunAncestry(input);
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
    if (remote.workspaceId === input.workspaceId || remote.state !== "saved" || !remote.snapshotId) continue;
    const operationId = await verifiedWorkspaceRepairReceipt(input.db, source);
    if (!operationId) {
      if (hasRequiredWorkspaceRecovery(source.resultJson)) throw new Error("remote_workspace_recovery_receipt_invalid");
      continue;
    }
    await assertExecutionWorkspaceRecordAccess(input.db, { type: "agent", source: "agent_jwt",
      companyId: input.companyId, agentId: writer.agentId, runId: writer.id,
      onBehalfOfUserId: writer.responsibleUserId === "local-board" ? null : writer.responsibleUserId },
    input.companyId, remote.workspaceId);
    const saved = await getWorkspaceSnapshot(input.db, { companyId: input.companyId,
      workspaceId: remote.workspaceId, snapshotId: remote.snapshotId });
    if (!saved) throw new Error("remote_workspace_recovery_snapshot_missing");
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
        await loadWorkspaceSnapshotArchive({ storage: getStorageService(), reference: saved, targetPath: archivePath });
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
