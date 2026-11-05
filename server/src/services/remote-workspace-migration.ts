import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  companies, environmentLeases, executionWorkspaceRepositories, executionWorkspaceRuntimeLeases, executionWorkspaceSnapshots, executionWorkspaces,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, projects, workspaceOperations, workspaceRuntimeServices, type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceSourceSchema, type RemoteWorkspaceAuthority, type RemoteWorkspaceSource } from "@paperclipai/shared";
import { offlineMigrationExecutionWhere } from "./offline-migration-execution.js";
import type { StorageService } from "../storage/types.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";
import { materializeTaskDirectorySnapshot, removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { loadTaskDirectoryRestorePoint, mayBeIsolatedTaskDirectoryWorkspace, readTaskDirectoryRetention, validateTaskDirectoryRestorePointRef } from "./isolated-task-directory-retention.js";
import { inspectArchivedGitMigrationSource, materializeArchivedGitMigrationSource, type ArchivedGitMigrationSource } from "./remote-workspace-migration-git.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { isLegacyWorkspaceTaskRelated, readLegacyWorkspaceRecoveryAllocations, LEGACY_WORKSPACE_RECOVERY_MIGRATION, type LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { offlineWorkspaceMigrationBlockers, prepareNestedWorkspaceImports, validateImportedWorkspaceChildren, workspaceMigrationLayoutBlockers } from "./remote-workspace-migration-tree.js";

import { inspectNativeWorkspaceMigration, nativeWorkspaceMigrationMarker } from "./native-runtime/native-workspace-migration.js";

const SCHEMA = "paperclip.remote-workspace-migration.v1";
type Workspace = typeof executionWorkspaces.$inferSelect;
type ReadDb = Pick<Db, "select">;
async function lockMigrationParents(db: ReadDb, companyId: string, issueId: string | null) {
  await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share");
  if (issueId) await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
}

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
const gitSourceProof = (source: ArchivedGitMigrationSource | null) => source ? {
  commit: source.commit, sourcePath: source.sourcePath, cleanupOperationId: source.cleanupOperationId,
} : null;

async function inspect(db: ReadDb, input: { companyId: string; workspaceId: string; operationId?: string; writersStopped?: boolean }) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
  if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
  const authority = readRemoteWorkspaceAuthority(workspace.metadata);
  const marker = object(workspace.metadata?.remoteWorkspaceMigration);
  const allowedOperation = input.operationId ?? (marker.schema === SCHEMA && typeof marker.operationId === "string" ? marker.operationId : undefined);
  const reasons: string[] = [];
  if (authority) return { workspace, reasons, authority, marker, source: authority.source, issueBinding: null, retainedDirectory: null, archivedGitSource: null, legacyRecoverySources: [] as LegacyWorkspaceRecoverySource[] };
  if (input.writersStopped) reasons.push(...await offlineWorkspaceMigrationBlockers(db));
  if (!["local_fs", "git_worktree"].includes(workspace.providerType)) reasons.push("workspace_provider_unsupported");
  if (!["active", "idle", "in_review", "archived"].includes(workspace.status)) reasons.push("workspace_not_active");
  if (!workspace.sourceIssueId) reasons.push("task_binding_required");
  const nestedMigration = workspace.metadata?.nestedCloneMigrationPending;
  if (nestedMigration != null && (typeof nestedMigration !== "object" || Array.isArray(nestedMigration)
    || Object.keys(nestedMigration).length > 0)) reasons.push("nested_clone_migration_unresolved");
  const cwd = workspace.cwd ?? workspace.providerRef;
  let retainedDirectory = null as ReturnType<typeof readTaskDirectoryRetention>;
  let archivedGitSource: ArchivedGitMigrationSource | null = null;
  if (!cwd || !path.isAbsolute(cwd)) reasons.push("local_source_missing");
  else {
    const entry = await fs.lstat(cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry && workspace.status === "archived" && mayBeIsolatedTaskDirectoryWorkspace(workspace)) {
      const retained = readTaskDirectoryRetention(workspace);
      if (retained?.removed === true && retained.restorePoint && retained.generation === retained.restorePoint.generation) {
        if (retained.restorePoint.expiredAt) reasons.push("restore_point_expired");
        else {
          try { validateTaskDirectoryRestorePointRef(retained.restorePoint, workspace); retainedDirectory = retained; }
          catch { reasons.push("restore_point_invalid"); }
        }
      }
    }
    if (!entry && workspace.status === "archived" && !retainedDirectory) {
      try { archivedGitSource = await inspectArchivedGitMigrationSource(db, workspace); }
      catch (error) { reasons.push(error instanceof Error && error.message === "remote_workspace_migration_restore_point_expired"
        ? "restore_point_expired" : "archived_git_source_unavailable"); }
    }
    if (!retainedDirectory && !archivedGitSource && (!entry?.isDirectory() || entry.isSymbolicLink())) reasons.push("local_source_unsafe_or_missing");
    if (entry?.isDirectory() && !entry.isSymbolicLink()) reasons.push(...await workspaceMigrationLayoutBlockers(db, workspace, input.writersStopped));
  }
  const [issue] = workspace.sourceIssueId ? await db.select().from(issues).where(and(eq(issues.companyId, workspace.companyId), eq(issues.id, workspace.sourceIssueId))) : [];
  // Historical records still own their saved files after the task selects a
  // different workspace. Importing them must not reopen or rebind that task.
  if (workspace.sourceIssueId && !issue) reasons.push("task_binding_changed");
  const [project] = workspace.projectId ? await db.select({ policy: projects.executionWorkspacePolicy }).from(projects)
    .where(and(eq(projects.companyId, workspace.companyId), eq(projects.id, workspace.projectId))) : [];
  const issuePolicy = object(issue?.executionWorkspaceSettings), projectPolicy = object(project?.policy);
  if (workspace.mode === "shared_workspace" && (issuePolicy.sharedWorkspaceConcurrency ?? (projectPolicy.enabled === true ? projectPolicy.sharedWorkspaceConcurrency : undefined)) === "allow") reasons.push("parallel_shared_writers_unsupported");
  if (issue?.executionRunId || issue?.checkoutRunId) reasons.push("task_writer_bound");
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId),
    input.writersStopped ? offlineMigrationExecutionWhere() : inArray(heartbeatRuns.status, ["queued", "running"]), sql`(${heartbeatRuns.nativeIssueId} = ${workspace.sourceIssueId}::uuid
      or ${heartbeatRuns.issueId} = ${workspace.sourceIssueId}::uuid
      or ${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${workspace.id}
      or ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId' = ${workspace.id})`,
  )).limit(1);
  if (run) reasons.push("active_execution");
  const unexported = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    issueId: heartbeatRuns.nativeIssueId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId' = ${workspace.id}`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
  ));
  const legacyRecoverySources: LegacyWorkspaceRecoverySource[] = [];
  for (const run of unexported.sort((a, b) => a.id.localeCompare(b.id))) {
    const reference = readNativeWorkspaceSyncReference(run.reference);
    const [owner] = await db.select({ phase: nativeRunFinalizations.phase, leaseOwner: nativeRunFinalizations.leaseOwner,
      leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt, resultId: nativeRunFinalizations.resultId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, workspace.companyId), eq(nativeRunFinalizations.runId, run.id)));
    const unsettled = owner && ["observed", "retryable_failure"].includes(owner.phase) && owner.resultId === null;
    const owned = owner?.leaseOwner && (!owner.leaseExpiresAt || owner.leaseExpiresAt > new Date());
    if (!input.writersStopped || !reference || run.runtimeMode !== "native" || !run.issueId
      || !await isLegacyWorkspaceTaskRelated(db, { companyId: workspace.companyId, issueId: run.issueId, sourceIssueId: workspace.sourceIssueId })
      || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)
      || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()
      || !owner || owned || !(["committed", "terminal_failure"].includes(owner.phase) || unsettled)) reasons.push("remote_copyback_unresolved");
    else legacyRecoverySources.push({ runId: run.id, issueId: run.issueId, reference,
      ...(unsettled ? { unresolvedFinalization: { phase: owner.phase, leaseOwner: owner.leaseOwner,
        leaseExpiresAt: owner.leaseExpiresAt?.toISOString() ?? null } } : {}) });
  }
  const finalizations = workspace.sourceIssueId ? await db.select({ id: nativeRunFinalizations.runId, phase: nativeRunFinalizations.phase,
    leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    resultId: nativeRunFinalizations.resultId, run: heartbeatRuns }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.id, nativeRunFinalizations.runId))).where(and(
    eq(nativeRunFinalizations.companyId, workspace.companyId), eq(nativeRunFinalizations.issueId, workspace.sourceIssueId),
    sql`${nativeRunFinalizations.phase} not in ('committed', 'terminal_failure')`,
  )) : [];
  for (const row of finalizations) {
    if (legacyRecoverySources.some(source => source.runId === row.id && source.unresolvedFinalization)) continue;
    const stopped = input.writersStopped && row.run.runtimeMode === "native"
      && ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(row.run.status)
      && !(row.run.controllerLeaseExpiresAt && row.run.controllerLeaseExpiresAt > new Date())
      && !(row.leaseOwner && (!row.leaseExpiresAt || row.leaseExpiresAt > new Date()));
    const reference = readNativeWorkspaceSyncReference(row.run.runnerProfileJson?.nativeWorkspaceSync);
    // The finalizer retries from its operation receipt, not the sync descriptor.
    // Without that receipt it would try exporting the newly migrated workspace,
    // which intentionally has no live location. Keep the local authority until
    // the existing owner records completion; then assessment/status can resume.
    if (stopped && reference?.state === "finalized") {
      const [finalized] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.heartbeatRunId, row.id),
        eq(workspaceOperations.issueId, row.run.nativeIssueId!), eq(workspaceOperations.phase, "workspace_finalize"),
        eq(workspaceOperations.status, "succeeded"),
      )).limit(1);
      if (finalized) continue;
    }
    if (stopped && reference && reference.workspaceId !== workspace.id) {
      const [other] = await db.select({ providerType: executionWorkspaces.providerType, cwd: executionWorkspaces.cwd,
        sourceIssueId: executionWorkspaces.sourceIssueId, metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, workspace.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
      // The offline batch must migrate every local record before the app can
      // start. Another workspace's coordinator is checked with its own source.
      if (other && ((other.cwd && ["local_fs", "git_worktree"].includes(other.providerType)) || readRemoteWorkspaceAuthority(other.metadata))
        && await isLegacyWorkspaceTaskRelated(db, { companyId: workspace.companyId, issueId: row.run.nativeIssueId, sourceIssueId: other.sourceIssueId })) continue;
    }
    if (stopped && row.run.runnerProfileJson?.nativeWorkspaceSync == null && row.run.runnerProfileJson?.remoteWorkspace == null
      && row.resultId === null && ["observed", "retryable_failure"].includes(row.phase)) {
      legacyRecoverySources.push({ runId: row.id, issueId: row.run.nativeIssueId!, reference: null,
        recoveryAllocations: await readLegacyWorkspaceRecoveryAllocations(db, row.run),
        unresolvedFinalization: { phase: row.phase, leaseOwner: row.leaseOwner,
          leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null } });
      continue;
    }
    reasons.push("execution_finalization_unresolved");
  }
  legacyRecoverySources.sort((a, b) => a.runId.localeCompare(b.runId));
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
  // A control lease can expire while the service process remains alive. Require
  // settled service state independently, including inherited shared services.
  const runtime = object(workspace.metadata?.config).workspaceRuntime;
  const inheritedSourceId = workspace.mode === "shared_workspace" && workspace.projectWorkspaceId
    && (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) ? workspace.projectWorkspaceId : null;
  const [service] = await db.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(and(
    eq(workspaceRuntimeServices.companyId, workspace.companyId), ne(workspaceRuntimeServices.status, "stopped"),
    or(eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id), inheritedSourceId ? and(
      eq(workspaceRuntimeServices.projectWorkspaceId, inheritedSourceId), eq(workspaceRuntimeServices.scopeType, "project_workspace"),
    ) : undefined),
  )).limit(1);
  if (service) reasons.push("workspace_runtime_service_unsettled");
  const recoveryIssueIds = [...new Set([workspace.sourceIssueId, ...legacyRecoverySources.map(source => source.issueId)].filter((id): id is string => Boolean(id)))];
  const recoveries = recoveryIssueIds.length ? await db.select({ id: issueRecoveryActions.id, kind: issueRecoveryActions.kind,
    cause: issueRecoveryActions.cause, evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, workspace.companyId), inArray(issueRecoveryActions.sourceIssueId, recoveryIssueIds),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )) : [];
  if (recoveries.some(recovery => {
    if (!input.writersStopped || object(recovery.evidence?.systemRecovery).state === "running") return true;
    if (legacyRecoverySources.some(source => source.runId === recovery.evidence?.runId)) return false;
    // These warnings govern task disposition, not file authority. Keep them
    // unchanged while the offline owner saves the workspace. Unknown recovery
    // kinds and any declared file source still require explicit preservation.
    return !["stranded_assigned_issue", "configuration_validation", "missing_disposition"].includes(recovery.kind)
      || ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(recovery.cause)
      || ["workspaceRestoreRecovery", "workspaceRecovery", "historicalWorkspaceSource", "systemRecovery", "nativeFailureBlock"]
        .some(key => recovery.evidence?.[key] != null);
  })) reasons.push("workspace_recovery_unresolved");
  const repositories = await db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, workspace.companyId),
    eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id)));
  if (repositories.some(repository => repository.state !== "ready")) reasons.push("repository_preparation_unresolved");
  const source: RemoteWorkspaceSource = workspace.repoUrl ? { kind: "git", repoUrl: workspace.repoUrl,
    ref: archivedGitSource?.commit ?? workspace.baseRef, branchName: workspace.branchName } : { kind: "empty" };
  if (repositories.length) source.repositories = repositories.map(repository => ({ id: repository.id, relativePath: repository.relativePath,
    repoUrl: repository.repoUrl, ref: repository.requestedRef, ...(repository.pinnedCommit ? { pinnedCommit: repository.pinnedCommit } : {}) }));
  return { workspace, reasons: [...new Set(reasons)], authority, marker, source, issueBinding: issue?.executionWorkspaceId ?? null, retainedDirectory, archivedGitSource, legacyRecoverySources };
}

export async function inventoryRemoteWorkspaceMigration(db: Db, input: { companyId: string; workspaceId: string; writersStopped?: boolean }) {
  const result = await inspect(db, input);
  return { companyId: input.companyId, workspaceId: input.workspaceId, eligible: result.reasons.length === 0,
    alreadyMigrated: Boolean(result.authority), reasons: result.reasons, localPath: result.workspace.cwd ?? result.workspace.providerRef,
    source: result.source, operationId: typeof result.marker.operationId === "string" ? result.marker.operationId : null,
    snapshotId: result.authority?.snapshotId ?? null };
}

/** Administrative import. The CLI enforces external deployment prerequisites. */
export async function migrateRemoteWorkspace(input: {
  db: Db; storage: StorageService; companyId: string; workspaceId: string; apply?: boolean; source?: RemoteWorkspaceSource;
  writersStopped?: boolean; signal?: AbortSignal;
}) {
  if (!input.apply) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: false };
  return withExecutionWorkspaceLifecycleLock(input.db, input.workspaceId, async lock => {
    const reserved = await input.db.transaction(async tx => {
      const [selected] = await tx.select({ sourceIssueId: executionWorkspaces.sourceIssueId }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
      if (!selected) throw new Error("remote_workspace_migration_workspace_missing");
      await lockMigrationParents(tx, input.companyId, selected.sourceIssueId);
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
      if (workspace.sourceIssueId !== selected.sourceIssueId) throw new Error("remote_workspace_migration_source_changed");
      const current = await inspect(tx as unknown as Db, input);
      if (current.authority) return { workspace, authority: current.authority, operation: null, source: current.source, sourceFingerprint: "", issueBinding: current.issueBinding, retainedDirectory: null, archivedGitSource: null, legacyRecoverySources: [] as LegacyWorkspaceRecoverySource[] };
      if (current.reasons.length) throw new Error(`remote_workspace_migration_blocked:${current.reasons.join(",")}`);
      const nativeSessionContinuity = await inspectNativeWorkspaceMigration(tx as unknown as Db, workspace);
      const source = remoteWorkspaceSourceSchema.parse(input.source ?? current.source);
      const sourceFingerprint = fingerprint(workspace);
      const marker = current.marker;
      if (marker.schema === SCHEMA && typeof marker.operationId === "string") {
        if (marker.sourceFingerprint !== sourceFingerprint || canonical(marker.source) !== canonical(source)) throw new Error("remote_workspace_migration_source_changed");
        const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
          eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration")));
        if (!operation) throw new Error("remote_workspace_migration_operation_missing");
        if (canonical(operation.metadata?.nativeSessionContinuity ?? null) !== canonical(nativeSessionContinuity)) throw new Error("native_workspace_migration_source_changed");
        // Older operations only admitted the task's current workspace. Preserve
        // that binding when resuming an import journaled before this field existed.
        const issueBinding = Object.hasOwn(operation.metadata ?? {}, "sourceIssueBinding")
          ? operation.metadata!.sourceIssueBinding : workspace.id;
        if (issueBinding !== current.issueBinding) throw new Error("remote_workspace_migration_source_changed");
        if (Boolean(operation.metadata?.retainedDirectory) !== Boolean(current.retainedDirectory)) throw new Error("remote_workspace_migration_source_changed");
        if (canonical(operation.metadata?.archivedGitSource ?? null) !== canonical(gitSourceProof(current.archivedGitSource))) throw new Error("remote_workspace_migration_source_changed");
        if (canonical(operation.metadata?.legacyRecoverySources ?? []) !== canonical(current.legacyRecoverySources)) throw new Error("remote_workspace_migration_source_changed");
        return { workspace, authority: null, operation, source, sourceFingerprint, issueBinding, retainedDirectory: current.retainedDirectory, archivedGitSource: current.archivedGitSource, legacyRecoverySources: current.legacyRecoverySources };
      }
      const [operation] = await tx.insert(workspaceOperations).values({ companyId: workspace.companyId, executionWorkspaceId: workspace.id,
        issueId: workspace.sourceIssueId, cwd: workspace.cwd ?? workspace.providerRef, phase: "remote_workspace_migration", status: "running",
        metadata: { schema: SCHEMA, sourceFingerprint, source, sourceIssueBinding: current.issueBinding,
          ...(nativeSessionContinuity ? { nativeSessionContinuity } : {}),
          nestedWorkspaceScope: { version: 1, state: "pending" },
          ...(current.legacyRecoverySources.length ? { legacyRecoverySources: current.legacyRecoverySources } : {}),
          ...(current.archivedGitSource ? { archivedGitSource: gitSourceProof(current.archivedGitSource) } : {}),
          ...(current.retainedDirectory ? { retainedDirectory: { restorePointId: current.retainedDirectory.restorePoint.id,
            generation: current.retainedDirectory.generation, digest: current.retainedDirectory.restorePoint.digest } } : {}) } }).returning();
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspaceMigration: {
        schema: SCHEMA, operationId: operation!.id, state: "running", sourceFingerprint, source,
      } }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
      return { workspace, authority: null, operation: operation!, source, sourceFingerprint, issueBinding: current.issueBinding, retainedDirectory: current.retainedDirectory, archivedGitSource: current.archivedGitSource, legacyRecoverySources: current.legacyRecoverySources };
    });
    if (reserved.authority) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: true, replayed: true };
    let operation = reserved.operation!;
    const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.companyId, workspaceId: input.workspaceId,
      operationId: operation.id, generation: 1, epoch: 1 });
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-migration-"));
    try {
      input.signal?.throwIfAborted();
      const retained = reserved.retainedDirectory?.restorePoint;
      const sourceRoot = retained ? await materializeTaskDirectorySnapshot({
        payload: await loadTaskDirectoryRestorePoint({ storage: input.storage, workspace: reserved.workspace, ref: retained }),
        target: path.join(scratch, "retained-source"), expectedDigest: retained.digest,
      }) : reserved.archivedGitSource ? await materializeArchivedGitMigrationSource({ db: input.db, storage: input.storage,
        workspace: reserved.workspace, source: reserved.archivedGitSource, scratch }) : reserved.workspace.cwd ?? reserved.workspace.providerRef!;
      const scope = object(operation.metadata?.nestedWorkspaceScope);
      if (operation.metadata?.nestedWorkspaceScope !== undefined && (scope.version !== 1 || !["pending", "fixed"].includes(String(scope.state))))
        throw new Error("nested_workspace_scope_invalid");
      // Journals predating scoped captures included every child. Preserve that
      // archive identity even if a later batch has already imported the leaves.
      const recordedChildren = scope.state === "fixed" ? validateImportedWorkspaceChildren(scope.children)
        : scope.state === "pending" ? undefined : [];
      const nested = input.writersStopped && !retained && !reserved.archivedGitSource
        ? await prepareNestedWorkspaceImports({ ...input, workspace: reserved.workspace, scratch, recordedChildren }) : [];
      if (scope.state === "pending") {
        const [saved] = await input.db.update(workspaceOperations).set({ metadata: { ...operation.metadata,
          nestedWorkspaceScope: { version: 1, state: "fixed", children: nested } }, updatedAt: new Date() })
          .where(and(eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.id, operation.id),
            eq(workspaceOperations.status, "running"))).returning();
        if (!saved) throw new Error("remote_workspace_migration_operation_changed");
        operation = saved;
      }
      const exclude = nested.map(child => child.relativePath);
      const archivePath = path.join(scratch, "workspace.pcws");
      const captured = await captureRemoteWorkspaceDirectory({ cwd: sourceRoot, archivePath, exclude, signal: input.signal });
      const ref = await uploadWorkspaceSnapshot({ db: input.db, storage: input.storage, snapshotId: snapshot.id,
        companyId: input.companyId, workspaceId: input.workspaceId, archivePath, manifestDigest: captured.manifestDigest, signal: input.signal });
      const restoredArchive = path.join(scratch, "verified.pcws"), restored = path.join(scratch, "restored");
      await loadWorkspaceSnapshotArchive({ storage: input.storage, reference: ref, targetPath: restoredArchive, signal: input.signal });
      await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir: restored, expectedManifestDigest: ref.manifestDigest, signal: input.signal });
      const currentArchive = path.join(scratch, "current.pcws");
      const current = await captureRemoteWorkspaceDirectory({ cwd: sourceRoot, archivePath: currentArchive, exclude, signal: input.signal });
      if (current.manifestDigest !== captured.manifestDigest) throw new Error("remote_workspace_migration_source_changed");
      if (nested.length) {
        const verifyScratch = path.join(scratch, "verify-nested"); await fs.mkdir(verifyScratch);
        const verified = await prepareNestedWorkspaceImports({ ...input, workspace: reserved.workspace, scratch: verifyScratch, recordedChildren: nested });
        if (canonical(verified) !== canonical(nested)) throw new Error("nested_workspace_source_changed");
      }
      input.signal?.throwIfAborted();
      await lock.execute(sql`select 1`);
      const publication = await input.db.transaction(async tx => {
        await lockMigrationParents(tx, input.companyId, reserved.workspace.sourceIssueId);
        for (const source of reserved.legacyRecoverySources) {
          await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
            .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, source.runId))).for("update", { noWait: true });
          await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, source.runId))).for("update", { noWait: true });
        }
        const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
        if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
        const existing = readRemoteWorkspaceAuthority(workspace.metadata);
        if (existing?.snapshotId === ref.id) return null;
        if (existing || fingerprint(workspace) !== reserved.sourceFingerprint
          || object(workspace.metadata?.remoteWorkspaceMigration).operationId !== operation.id) throw new Error("remote_workspace_migration_publication_changed");
        for (const source of reserved.legacyRecoverySources) {
          for (const allocation of source.recoveryAllocations ?? []) await tx.select({ id: environmentLeases.id })
            .from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
              eq(environmentLeases.id, allocation.leaseId))).for("update", { noWait: true });
        }
        const validation = await inspect(tx as unknown as Db, { ...input, operationId: operation.id });
        if (validation.issueBinding !== reserved.issueBinding) throw new Error("remote_workspace_migration_source_changed");
        if (Boolean(validation.retainedDirectory) !== Boolean(reserved.retainedDirectory)) throw new Error("remote_workspace_migration_source_changed");
        if (canonical(gitSourceProof(validation.archivedGitSource)) !== canonical(gitSourceProof(reserved.archivedGitSource))) throw new Error("remote_workspace_migration_source_changed");
        if (validation.reasons.length) throw new Error(`remote_workspace_migration_blocked:${validation.reasons.join(",")}`);
        const [uploaded] = await tx.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, workspace.companyId),
          eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id), eq(executionWorkspaceSnapshots.id, ref.id))).for("update");
        if (!uploaded || uploaded.status !== "uploaded" || uploaded.sourceOperationId !== operation.id) throw new Error("remote_workspace_migration_snapshot_changed");
        for (const child of [...nested].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId))) {
          const [saved] = await tx.select().from(executionWorkspaceSnapshots).where(and(
            eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.id, child.snapshotId),
            eq(executionWorkspaceSnapshots.executionWorkspaceId, child.workspaceId),
          )).for("update");
          if (!saved || !["committed", "superseded"].includes(saved.status) || saved.manifestDigest !== child.manifestDigest
            || saved.sourceOperationId !== child.operationId) throw new Error("nested_workspace_snapshot_changed");
        }
        if (canonical(validation.legacyRecoverySources) !== canonical(reserved.legacyRecoverySources)) throw new Error("remote_workspace_migration_source_changed");
        const continuity = await inspectNativeWorkspaceMigration(tx as unknown as Db, workspace);
        if (canonical(continuity) !== canonical(operation.metadata?.nativeSessionContinuity ?? null)) throw new Error("native_workspace_migration_source_changed");
        const authority: RemoteWorkspaceAuthority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: ref.id,
          source: reserved.source, location: null, writerRunId: null, dirty: false };
        const metadata: Record<string, unknown> = { ...workspace.metadata, remoteWorkspace: authority }; delete metadata.remoteWorkspaceMigration;
        if (continuity) metadata.nativeWorkspaceMigration = nativeWorkspaceMigrationMarker(operation.id);
        if (reserved.legacyRecoverySources.length) {
          metadata.legacyWorkspaceRecoveryMigration = { schema: LEGACY_WORKSPACE_RECOVERY_MIGRATION, operationId: operation.id };
          for (const source of reserved.legacyRecoverySources) {
            // The offline deployment fence has stopped the old controller. The
            // locked validation above must still match its journaled expired
            // lease exactly. Release only that coordinator lease so explicit
            // file recovery can proceed; its phase/checkpoint and the provider's
            // independent stop obligation remain unchanged.
            if (source.unresolvedFinalization?.leaseOwner) await tx.update(nativeRunFinalizations).set({
              leaseOwner: null, leaseExpiresAt: null,
              recoveryHistory: sql`${nativeRunFinalizations.recoveryHistory} || ${JSON.stringify([{
                event: "legacy_workspace_migration_owner_released", operationId: operation.id,
                workspaceId: workspace.id, previousOwner: source.unresolvedFinalization,
              }])}::jsonb`, updatedAt: new Date(),
            }).where(and(eq(nativeRunFinalizations.companyId, workspace.companyId),
              eq(nativeRunFinalizations.runId, source.runId), eq(nativeRunFinalizations.issueId, source.issueId)));
            await tx.update(heartbeatRuns).set({
            runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({
              legacyWorkspaceRecoveryMigration: { schema: LEGACY_WORKSPACE_RECOVERY_MIGRATION,
                operationId: operation.id, workspaceId: workspace.id },
            })}::jsonb`, updatedAt: new Date(),
            }).where(and(eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, source.runId)));
          }
          const prior = Array.isArray(metadata.remoteWorkspaceRecoverySourceRunIds) ? metadata.remoteWorkspaceRecoverySourceRunIds : [];
          metadata.remoteWorkspaceRecoverySourceRunIds = [...new Set([...prior, ...reserved.legacyRecoverySources.map(source => source.runId)])];
        }
        await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
        await tx.update(executionWorkspaceSnapshots).set({ status: "committed", deleteAfter: null,
          metadata: { ...uploaded.metadata, ...(nested.length ? { importedWorkspaceChildren: nested } : {}) },
          updatedAt: new Date() }).where(eq(executionWorkspaceSnapshots.id, ref.id));
        await tx.update(executionWorkspaces).set({ providerType: "cloud_sandbox", providerRef: null, cwd: `/workspaces/${workspace.id}`, metadata,
          updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
        await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
          metadata: { ...operation.metadata, snapshotId: ref.id, manifestDigest: ref.manifestDigest } }).where(eq(workspaceOperations.id, operation.id));
        return (await persistActivity(tx as unknown as Db, { companyId: workspace.companyId, actorType: "system", actorId: "workspace-migration",
          action: "workspace.remote_storage_migrated", entityType: "execution_workspace", entityId: workspace.id,
          details: { snapshotId: ref.id, operationId: operation.id, manifestDigest: ref.manifestDigest } })).publication;
      }).catch(error => {
        const failure = object(error), cause = object(failure.cause);
        if ((cause.code ?? failure.code) !== "55P03") throw error;
        throw new Error("remote_workspace_migration_blocked:execution_rows_busy", { cause: error });
      });
      if (publication) publishActivity(publication);
      return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: true, replayed: false };
    } finally { await removeTaskDirectoryTree(scratch); }
  });
}
