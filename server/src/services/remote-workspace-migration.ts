import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  executionWorkspaceRepositories, executionWorkspaceRuntimeLeases, executionWorkspaceSnapshots, executionWorkspaces,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, projects, workspaceOperations, type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceSourceSchema, type RemoteWorkspaceAuthority, type RemoteWorkspaceSource } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";

const SCHEMA = "paperclip.remote-workspace-migration.v1";
type Workspace = typeof executionWorkspaces.$inferSelect;
type ReadDb = Pick<Db, "select">;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fingerprint(workspace: Workspace) {
  const metadata = { ...workspace.metadata }; delete metadata.remoteWorkspaceMigration;
  return createHash("sha256").update(canonical({ companyId: workspace.companyId, id: workspace.id, projectId: workspace.projectId,
    projectWorkspaceId: workspace.projectWorkspaceId, sourceIssueId: workspace.sourceIssueId, mode: workspace.mode, strategyType: workspace.strategyType,
    providerType: workspace.providerType, cwd: workspace.cwd, providerRef: workspace.providerRef, repoUrl: workspace.repoUrl,
    baseRef: workspace.baseRef, branchName: workspace.branchName, status: workspace.status, closedAt: workspace.closedAt?.toISOString(), metadata })).digest("hex");
}

async function inspect(db: ReadDb, input: { companyId: string; workspaceId: string; operationId?: string }) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
  if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
  const authority = readRemoteWorkspaceAuthority(workspace.metadata);
  const marker = object(workspace.metadata?.remoteWorkspaceMigration);
  const allowedOperation = input.operationId ?? (marker.schema === SCHEMA && typeof marker.operationId === "string" ? marker.operationId : undefined);
  const reasons: string[] = [];
  if (authority) return { workspace, reasons, authority, marker, source: authority.source };
  if (!["local_fs", "git_worktree"].includes(workspace.providerType)) reasons.push("workspace_provider_unsupported");
  if (!["active", "idle", "in_review"].includes(workspace.status)) reasons.push("workspace_not_active");
  if (!workspace.sourceIssueId) reasons.push("task_binding_required");
  const cwd = workspace.cwd ?? workspace.providerRef;
  if (!cwd || !path.isAbsolute(cwd)) reasons.push("local_source_missing");
  else {
    const entry = await fs.lstat(cwd).catch(() => null);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) reasons.push("local_source_unsafe_or_missing");
  }
  const [issue] = workspace.sourceIssueId ? await db.select().from(issues).where(and(eq(issues.companyId, workspace.companyId), eq(issues.id, workspace.sourceIssueId))) : [];
  if (workspace.sourceIssueId && (!issue || issue.executionWorkspaceId !== workspace.id)) reasons.push("task_binding_changed");
  const [project] = workspace.projectId ? await db.select({ policy: projects.executionWorkspacePolicy }).from(projects)
    .where(and(eq(projects.companyId, workspace.companyId), eq(projects.id, workspace.projectId))) : [];
  const issuePolicy = object(issue?.executionWorkspaceSettings), projectPolicy = object(project?.policy);
  if (workspace.mode === "shared_workspace" && (issuePolicy.sharedWorkspaceConcurrency ?? (projectPolicy.enabled === true ? projectPolicy.sharedWorkspaceConcurrency : undefined)) === "allow") reasons.push("parallel_shared_writers_unsupported");
  if (issue?.executionRunId || issue?.checkoutRunId) reasons.push("task_writer_bound");
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId),
    inArray(heartbeatRuns.status, ["queued", "running"]), sql`(${heartbeatRuns.nativeIssueId} = ${workspace.sourceIssueId}::uuid
      or ${heartbeatRuns.issueId} = ${workspace.sourceIssueId}::uuid
      or ${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${workspace.id}
      or ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId' = ${workspace.id})`,
  )).limit(1);
  if (run) reasons.push("active_execution");
  const [unexported] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId' = ${workspace.id}`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
  )).limit(1);
  if (unexported) reasons.push("remote_copyback_unresolved");
  const [finalization] = workspace.sourceIssueId ? await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, workspace.companyId), eq(nativeRunFinalizations.issueId, workspace.sourceIssueId),
    sql`${nativeRunFinalizations.phase} not in ('committed', 'terminal_failure')`,
  )).limit(1) : [];
  if (finalization) reasons.push("execution_finalization_unresolved");
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    allowedOperation ? ne(workspaceOperations.id, allowedOperation) : undefined,
    sql`(${workspaceOperations.status} in ('running', 'pending') or ${workspaceOperations.metadata}->>'uncertain' = 'true')`,
  )).limit(1);
  if (operation) reasons.push("workspace_operation_unresolved");
  const [lease] = await db.select({ id: executionWorkspaceRuntimeLeases.id }).from(executionWorkspaceRuntimeLeases).where(and(
    eq(executionWorkspaceRuntimeLeases.companyId, workspace.companyId), eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, workspace.id),
    sql`${executionWorkspaceRuntimeLeases.expiresAt} > clock_timestamp()`,
  )).limit(1);
  if (lease) reasons.push("workspace_runtime_owned");
  const [recovery] = workspace.sourceIssueId ? await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, workspace.companyId), eq(issueRecoveryActions.sourceIssueId, workspace.sourceIssueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).limit(1) : [];
  if (recovery) reasons.push("workspace_recovery_unresolved");
  const repositories = await db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, workspace.companyId),
    eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id)));
  if (repositories.some(repository => repository.state !== "ready")) reasons.push("repository_preparation_unresolved");
  const source: RemoteWorkspaceSource = workspace.repoUrl ? { kind: "git", repoUrl: workspace.repoUrl,
    ref: workspace.baseRef, branchName: workspace.branchName } : { kind: "empty" };
  if (repositories.length) source.repositories = repositories.map(repository => ({ id: repository.id, relativePath: repository.relativePath,
    repoUrl: repository.repoUrl, ref: repository.requestedRef, ...(repository.pinnedCommit ? { pinnedCommit: repository.pinnedCommit } : {}) }));
  return { workspace, reasons: [...new Set(reasons)], authority, marker, source };
}

export async function inventoryRemoteWorkspaceMigration(db: Db, input: { companyId: string; workspaceId: string }) {
  const result = await inspect(db, input);
  return { companyId: input.companyId, workspaceId: input.workspaceId, eligible: result.reasons.length === 0,
    alreadyMigrated: Boolean(result.authority), reasons: result.reasons, localPath: result.workspace.cwd ?? result.workspace.providerRef,
    source: result.source, operationId: typeof result.marker.operationId === "string" ? result.marker.operationId : null,
    snapshotId: result.authority?.snapshotId ?? null };
}

/** Administrative import. The CLI enforces external deployment prerequisites. */
export async function migrateRemoteWorkspace(input: {
  db: Db; storage: StorageService; companyId: string; workspaceId: string; apply?: boolean; source?: RemoteWorkspaceSource;
}) {
  if (!input.apply) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: false };
  return withExecutionWorkspaceLifecycleLock(input.db, input.workspaceId, async lock => {
    const reserved = await input.db.transaction(async tx => {
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
      if (workspace.sourceIssueId) await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, workspace.companyId), eq(issues.id, workspace.sourceIssueId))).for("update");
      const current = await inspect(tx as unknown as Db, input);
      if (current.authority) return { workspace, authority: current.authority, operation: null, source: current.source, sourceFingerprint: "" };
      if (current.reasons.length) throw new Error(`remote_workspace_migration_blocked:${current.reasons.join(",")}`);
      const source = remoteWorkspaceSourceSchema.parse(input.source ?? current.source);
      const sourceFingerprint = fingerprint(workspace);
      const marker = current.marker;
      if (marker.schema === SCHEMA && typeof marker.operationId === "string") {
        if (marker.sourceFingerprint !== sourceFingerprint || canonical(marker.source) !== canonical(source)) throw new Error("remote_workspace_migration_source_changed");
        const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
          eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration")));
        if (!operation) throw new Error("remote_workspace_migration_operation_missing");
        return { workspace, authority: null, operation, source, sourceFingerprint };
      }
      const [operation] = await tx.insert(workspaceOperations).values({ companyId: workspace.companyId, executionWorkspaceId: workspace.id,
        issueId: workspace.sourceIssueId, phase: "remote_workspace_migration", status: "running",
        metadata: { schema: SCHEMA, sourceFingerprint, source } }).returning();
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspaceMigration: {
        schema: SCHEMA, operationId: operation!.id, state: "running", sourceFingerprint, source,
      } }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
      return { workspace, authority: null, operation: operation!, source, sourceFingerprint };
    });
    if (reserved.authority) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: true, replayed: true };
    const operation = reserved.operation!;
    const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.companyId, workspaceId: input.workspaceId,
      operationId: operation.id, generation: 1, epoch: 1 });
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-migration-"));
    try {
      const archivePath = path.join(scratch, "workspace.pcws");
      const captured = await captureRemoteWorkspaceDirectory({ cwd: reserved.workspace.cwd ?? reserved.workspace.providerRef!, archivePath });
      const ref = await uploadWorkspaceSnapshot({ db: input.db, storage: input.storage, snapshotId: snapshot.id,
        companyId: input.companyId, workspaceId: input.workspaceId, archivePath, manifestDigest: captured.manifestDigest });
      const restoredArchive = path.join(scratch, "verified.pcws"), restored = path.join(scratch, "restored");
      await loadWorkspaceSnapshotArchive({ storage: input.storage, reference: ref, targetPath: restoredArchive });
      await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir: restored, expectedManifestDigest: ref.manifestDigest });
      const currentArchive = path.join(scratch, "current.pcws");
      const current = await captureRemoteWorkspaceDirectory({ cwd: reserved.workspace.cwd ?? reserved.workspace.providerRef!, archivePath: currentArchive });
      if (current.manifestDigest !== captured.manifestDigest) throw new Error("remote_workspace_migration_source_changed");
      await lock.execute(sql`select 1`);
      const publication = await input.db.transaction(async tx => {
        const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
        if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
        const existing = readRemoteWorkspaceAuthority(workspace.metadata);
        if (existing?.snapshotId === ref.id) return null;
        if (existing || fingerprint(workspace) !== reserved.sourceFingerprint
          || object(workspace.metadata?.remoteWorkspaceMigration).operationId !== operation.id) throw new Error("remote_workspace_migration_publication_changed");
        if (workspace.sourceIssueId) await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, workspace.sourceIssueId)).for("update");
        const validation = await inspect(tx as unknown as Db, { ...input, operationId: operation.id });
        if (validation.reasons.length) throw new Error(`remote_workspace_migration_blocked:${validation.reasons.join(",")}`);
        const [uploaded] = await tx.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, workspace.companyId),
          eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id), eq(executionWorkspaceSnapshots.id, ref.id))).for("update");
        if (!uploaded || uploaded.status !== "uploaded" || uploaded.sourceOperationId !== operation.id) throw new Error("remote_workspace_migration_snapshot_changed");
        const authority: RemoteWorkspaceAuthority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: ref.id,
          source: reserved.source, location: null, writerRunId: null, dirty: false };
        const metadata: Record<string, unknown> = { ...workspace.metadata, remoteWorkspace: authority }; delete metadata.remoteWorkspaceMigration;
        await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
        await tx.update(executionWorkspaceSnapshots).set({ status: "committed", deleteAfter: null, updatedAt: new Date() }).where(eq(executionWorkspaceSnapshots.id, ref.id));
        await tx.update(executionWorkspaces).set({ providerType: "cloud_sandbox", providerRef: null, cwd: `/workspaces/${workspace.id}`, metadata,
          updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
        await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
          metadata: { ...operation.metadata, snapshotId: ref.id, manifestDigest: ref.manifestDigest } }).where(eq(workspaceOperations.id, operation.id));
        return (await persistActivity(tx as unknown as Db, { companyId: workspace.companyId, actorType: "system", actorId: "workspace-migration",
          action: "workspace.remote_storage_migrated", entityType: "execution_workspace", entityId: workspace.id,
          details: { snapshotId: ref.id, operationId: operation.id, manifestDigest: ref.manifestDigest } })).publication;
      });
      if (publication) publishActivity(publication);
      return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: true, replayed: false };
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  });
}
