import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
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
import { inspectFinalizedWorkspaceRecoveryHold, type FinalizedWorkspaceRecoveryHold } from "./finalized-workspace-recovery-migration.js";
import { workspaceExportCauses } from "./workspace-recovery-source.js";
import type { StorageService } from "../storage/types.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { tryAcquireExecutionWorkspaceLifecycleLock, withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, loadWorkspaceSnapshotArchive, recoverWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";
import { materializeTaskDirectorySnapshot, removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { loadTaskDirectoryRestorePoint, mayBeIsolatedTaskDirectoryWorkspace, readTaskDirectoryRetention, validateTaskDirectoryRestorePointRef } from "./isolated-task-directory-retention.js";
import { inspectArchivedGitMigrationSource, lockArchivedGitMigrationSources, materializeArchivedGitMigrationSource, type ArchivedGitMigrationSource } from "./remote-workspace-migration-git.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { isLegacyWorkspaceTaskRelated, readLegacyWorkspaceRecoveryAllocations, LEGACY_WORKSPACE_RECOVERY_MIGRATION, type LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { createNestedWorkspaceImportVerifier, onlineOrdinarySourceBlockers, offlineWorkspaceMigrationBlockers, prepareNestedWorkspaceImports, validateImportedWorkspaceChildren, workspaceMigrationLayoutBlockers, type WorkspaceMigrationCohort } from "./remote-workspace-migration-tree.js";

import { inspectOnlineWorkspaceSource, requiresOnlineWorkspaceSource, type OnlineWorkspaceSource } from "./online-workspace-source.js";
import { withWorkspaceSourceLocks, withIndependentWorkspaceSourceLocks, IsolatedRepositorySourceBusy } from "./workspace-source-lock.js";
import { inspectOnlineLegacyWorkspaceRecoverySource, inspectOnlineLegacyWorkspaceRecoveryHold, lockOnlineLegacyWorkspaceRecoverySources, ONLINE_LEGACY_WORKSPACE_PRESERVATION, type OnlineLegacyWorkspaceRecoveryHold } from "./online-legacy-workspace-recovery.js";
import { inspectNativeWorkspaceMigration, nativeWorkspaceMigrationMarker } from "./native-runtime/native-workspace-migration.js";
import { readGitCacheExpiration, GIT_CACHE_EXPIRATION_REASON } from "./git-workspace-restoration.js";

const SCHEMA = "paperclip.remote-workspace-migration.v1";
const SUPERSESSION = "paperclip.remote-workspace-migration-supersession.v1";
const supersessionSchema = z.object({ schema: z.literal(SUPERSESSION), companyId: z.string().uuid(), workspaceId: z.string().uuid(),
  cohortId: z.string().uuid(), operationId: z.string().uuid(), supersessionId: z.string().uuid(), snapshotIds: z.array(z.string().uuid()).max(8) }).strict();
const successorSchema = supersessionSchema.extend({ generation: z.number().int().min(1).max(2_147_483_647) });
type Workspace = typeof executionWorkspaces.$inferSelect;
type ReadDb = Pick<Db, "select">;
type OnlineRecoveryHold = OnlineLegacyWorkspaceRecoveryHold & { actionId: string };
async function lockMigrationParents(db: ReadDb, companyId: string, issueId: string | null, recoveryIssueIds: readonly string[] = []) {
  await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share");
  for (const id of [...new Set([...(issueId ? [issueId] : []), ...recoveryIssueIds])].sort())
    await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, id))).for("update", recoveryIssueIds.length ? { noWait: true } : undefined);
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
  ...(source.retainedBranch ? { retainedBranch: source.retainedBranch } : {}),
} : null;

type RepositoryRequest = typeof executionWorkspaceRepositories.$inferSelect;

function isUnmaterializedRepositoryCandidate(repository: RepositoryRequest) {
  const unprepared = repository.state === "pending" && !repository.failureCode
    || repository.state === "needs_repair" && repository.failureCode === "repository_preparation_failed";
  if (!unprepared || repository.pinnedCommit || repository.branchName) return false;
  const relative = repository.relativePath;
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative || relative.split("/").some(part => !part || part === "." || part === "..")) return false;
  return true;
}

async function isUnmaterializedRepositoryRequest(workspace: Pick<Workspace, "cwd">, repository: RepositoryRequest) {
  if (!workspace.cwd || !isUnmaterializedRepositoryCandidate(repository)) return false;
  const relative = repository.relativePath;
  const root = await fs.lstat(workspace.cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  let parent = workspace.cwd;
  for (const part of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const entry = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) return true;
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
  }
  return !await fs.lstat(path.join(workspace.cwd, relative)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function assertArchivedRepositoryIntents(root: string, repositories: readonly RepositoryRequest[]) {
  for (const repository of repositories) {
    if (!await isUnmaterializedRepositoryRequest({ cwd: root }, repository))
      throw new Error("remote_workspace_migration_blocked:repository_preparation_unresolved");
  }
}

async function inspect(db: ReadDb, input: { companyId: string; workspaceId: string; operationId?: string; writersStopped?: boolean; onlineSource?: OnlineWorkspaceSource; onlineSourceUnproven?: boolean }, cohort?: WorkspaceMigrationCohort) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
  if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
  const authority = readRemoteWorkspaceAuthority(workspace.metadata);
  const marker = object(workspace.metadata?.remoteWorkspaceMigration);
  const allowedOperation = input.operationId ?? (marker.schema === SCHEMA && typeof marker.operationId === "string" ? marker.operationId : undefined);
  const reasons: string[] = [];
  if (authority) return { workspace, reasons, authority, marker, source: authority.source, issueBinding: null, retainedDirectory: null, archivedGitSource: null, legacyRecoverySources: [] as LegacyWorkspaceRecoverySource[], finalizedRecoveryHolds: [] as FinalizedWorkspaceRecoveryHold[], onlineRecoveryHolds: [] as OnlineRecoveryHold[], archivedRepositoryIntents: [] as RepositoryRequest[] };
  if (input.writersStopped) reasons.push(...await offlineWorkspaceMigrationBlockers(db));
  if (input.onlineSourceUnproven) reasons.push("online_workspace_source_scope_unproven");
  if (input.onlineSource) {
    const currentScope = await inspectOnlineWorkspaceSource(db, workspace);
    if (canonical(currentScope) !== canonical(input.onlineSource)) reasons.push("online_workspace_source_scope_changed");
    else reasons.push(...await onlineOrdinarySourceBlockers(db as Db, workspace.companyId, currentScope!, workspace, allowedOperation, cohort));
  }
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
    if (!entry && !retainedDirectory && (workspace.status === "archived" || input.writersStopped)) {
      try { archivedGitSource = await inspectArchivedGitMigrationSource(db, workspace, { allowActiveRetainedBranch: input.writersStopped, operationId: allowedOperation }); }
      catch (error) { reasons.push(error instanceof Error && error.message === "remote_workspace_migration_restore_point_expired"
        ? "restore_point_expired" : "archived_git_source_unavailable"); }
    }
    if (!retainedDirectory && !archivedGitSource && (!entry?.isDirectory() || entry.isSymbolicLink())) reasons.push("local_source_unsafe_or_missing");
    if (entry?.isDirectory() && !entry.isSymbolicLink()) reasons.push(...await workspaceMigrationLayoutBlockers(db, workspace, input.writersStopped, input.onlineSource));
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
  const referencedRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    issueId: heartbeatRuns.nativeIssueId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId' = ${workspace.id}`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' in ('prepared', 'finalized')`,
  ));
  const legacyRecoverySources: LegacyWorkspaceRecoverySource[] = [];
  const onlineRecoveryAllowed = !input.writersStopped
    && Boolean(input.onlineSource || workspace.status === "archived" && archivedGitSource);
  for (const run of referencedRuns.filter(run => object(run.reference).state === "prepared").sort((a, b) => a.id.localeCompare(b.id))) {
    if (onlineRecoveryAllowed) {
      const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace, runId: run.id });
      if (source) legacyRecoverySources.push(source);
      else reasons.push("remote_copyback_unresolved");
      continue;
    }
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
    if (onlineRecoveryAllowed) {
      const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace, runId: row.id });
      if (source) { legacyRecoverySources.push(source); continue; }
    }
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
  const recoveryIssueIds = [...new Set([workspace.sourceIssueId, ...referencedRuns.map(run => run.issueId),
    ...legacyRecoverySources.map(source => source.issueId)].filter((id): id is string => Boolean(id)))];
  const recoveries = recoveryIssueIds.length ? await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, workspace.companyId), inArray(issueRecoveryActions.sourceIssueId, recoveryIssueIds),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )) : [];
  const finalizedRecoveryHolds: FinalizedWorkspaceRecoveryHold[] = [];
  const onlineRecoveryHolds: OnlineRecoveryHold[] = [];
  for (const recovery of recoveries.sort((a, b) => a.id.localeCompare(b.id))) {
    if (onlineRecoveryAllowed) {
      const held = await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace, recovery });
      if (!held) { reasons.push("workspace_recovery_unresolved"); continue; }
      onlineRecoveryHolds.push({ actionId: recovery.id, ...held });
      if (held.preparedSource && !legacyRecoverySources.some(source => source.runId === held.preparedSource!.runId))
        legacyRecoverySources.push(held.preparedSource);
      if (held.finalizedHold) {
        finalizedRecoveryHolds.push(held.finalizedHold);
        if (held.finalizedHold.source && !legacyRecoverySources.some(source => source.runId === held.finalizedHold!.source!.runId))
          legacyRecoverySources.push(held.finalizedHold.source);
      }
      continue;
    }
    if (!input.writersStopped || object(recovery.evidence?.systemRecovery).state === "running") {
      reasons.push("workspace_recovery_unresolved"); continue;
    }
    if (legacyRecoverySources.some(source => source.runId === recovery.evidence?.runId && source.reference?.state !== "finalized")) continue;
    const held = await inspectFinalizedWorkspaceRecoveryHold(db, { companyId: workspace.companyId,
      workspaceId: workspace.id, recovery });
    if (held) {
      finalizedRecoveryHolds.push(held);
      if (held.source && !legacyRecoverySources.some(source => source.runId === held.source!.runId)) legacyRecoverySources.push(held.source);
      continue;
    }
    // These warnings govern task disposition, not file authority. Keep them
    // unchanged while the offline owner saves the workspace. Unknown recovery
    // kinds and any declared file source still require explicit preservation.
    if (!["stranded_assigned_issue", "configuration_validation", "missing_disposition", "deliberate_wait_without_target"].includes(recovery.kind)
      || workspaceExportCauses.includes(recovery.cause)
      || ["workspaceRestoreRecovery", "workspaceRecovery", "historicalWorkspaceSource", "systemRecovery", "nativeFailureBlock"]
        .some(key => recovery.evidence?.[key] != null)) reasons.push("workspace_recovery_unresolved");
  }
  legacyRecoverySources.sort((a, b) => a.runId.localeCompare(b.runId));
  const repositories = await db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, workspace.companyId),
    eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id)));
  const archivedRepositoryIntents: RepositoryRequest[] = [];
  for (const repository of repositories.filter(repository => repository.state !== "ready")) {
    if (archivedGitSource?.recipe && isUnmaterializedRepositoryCandidate(repository)) { archivedRepositoryIntents.push(repository); continue; }
    if ((!input.writersStopped && !input.onlineSource) || !await isUnmaterializedRepositoryRequest(workspace, repository)) reasons.push("repository_preparation_unresolved");
  }
  const source: RemoteWorkspaceSource = workspace.repoUrl ? { kind: "git", repoUrl: workspace.repoUrl,
    ref: archivedGitSource?.commit ?? workspace.baseRef, branchName: workspace.branchName } : { kind: "empty" };
  const materialized = repositories.filter(repository => repository.state === "ready");
  if (materialized.length) source.repositories = materialized.map(repository => ({ id: repository.id, relativePath: repository.relativePath,
    repoUrl: repository.repoUrl, ref: repository.requestedRef, ...(repository.pinnedCommit ? { pinnedCommit: repository.pinnedCommit } : {}) }));
  return { workspace, reasons: [...new Set(reasons)], authority, marker, source, issueBinding: issue?.executionWorkspaceId ?? null, retainedDirectory, archivedGitSource, legacyRecoverySources, finalizedRecoveryHolds, onlineRecoveryHolds, archivedRepositoryIntents };
}

export async function inventoryRemoteWorkspaceMigration(db: Db, input: { companyId: string; workspaceId: string; writersStopped?: boolean }) {
  const [workspace] = !input.writersStopped ? await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))) : [];
  const onlineSource = workspace && !readRemoteWorkspaceAuthority(workspace.metadata)
    ? await inspectOnlineWorkspaceSource(db, workspace) ?? undefined : undefined;
  const result = await inspect(db, { ...input, onlineSource, onlineSourceUnproven: Boolean(workspace && !onlineSource
    && !readRemoteWorkspaceAuthority(workspace.metadata) && await requiresOnlineWorkspaceSource(workspace)) });
  return { companyId: input.companyId, workspaceId: input.workspaceId, eligible: result.reasons.length === 0,
    alreadyMigrated: Boolean(result.authority), reasons: result.reasons, localPath: result.workspace.cwd ?? result.workspace.providerRef,
    source: result.source, operationId: typeof result.marker.operationId === "string" ? result.marker.operationId : null,
    snapshotId: result.authority?.snapshotId ?? null };
}

type MigrationInput = {
  db: Db; storage: StorageService; companyId: string; workspaceId: string; apply?: boolean; source?: RemoteWorkspaceSource;
  writersStopped?: boolean; signal?: AbortSignal; sourceLockWaitMs?: number;
};
type MigrationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function resolveMigrationSource(input: Pick<MigrationInput, "db" | "companyId" | "workspaceId" | "writersStopped">) {
  const [sourceWorkspace] = !input.writersStopped ? await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))) : [];
  const onlineSource = sourceWorkspace && !readRemoteWorkspaceAuthority(sourceWorkspace.metadata)
    ? await inspectOnlineWorkspaceSource(input.db, sourceWorkspace) ?? undefined : undefined;
  if (sourceWorkspace && !onlineSource && !readRemoteWorkspaceAuthority(sourceWorkspace.metadata)
    && await requiresOnlineWorkspaceSource(sourceWorkspace)) {
    throw new Error("remote_workspace_migration_blocked:online_workspace_source_scope_unproven");
  }
  return onlineSource;
}

function recoverySourcesResumeIdentity(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(source => {
    if (!source || typeof source !== "object" || source.onlineProof == null) return source;
    const proof = object(source.onlineProof);
    if (proof.schema !== ONLINE_LEGACY_WORKSPACE_PRESERVATION || typeof proof.fingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(proof.fingerprint)) throw new Error("remote_workspace_migration_recovery_proof_invalid");
    return { ...source, onlineProof: { ...proof, fingerprint: null } };
  });
}

async function reserveMigration(input: MigrationInput, onlineSource?: OnlineWorkspaceSource, cohort?: WorkspaceMigrationCohort,
  expectedSourceFingerprint?: string) {
  return input.db.transaction(async tx => {
    const [selected] = await tx.select({ sourceIssueId: executionWorkspaces.sourceIssueId }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
    if (!selected) throw new Error("remote_workspace_migration_workspace_missing");
    await lockMigrationParents(tx, input.companyId, selected.sourceIssueId);
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
    if (!workspace) throw new Error("remote_workspace_migration_workspace_missing");
    if (workspace.sourceIssueId !== selected.sourceIssueId) throw new Error("remote_workspace_migration_source_changed");
    const current = await inspect(tx as unknown as Db, { ...input, onlineSource }, cohort);
    if (current.authority) return { workspace, authority: current.authority, operation: null, source: current.source, sourceFingerprint: "", issueBinding: current.issueBinding, retainedDirectory: null, archivedGitSource: null, legacyRecoverySources: [] as LegacyWorkspaceRecoverySource[], finalizedRecoveryHolds: [] as FinalizedWorkspaceRecoveryHold[], onlineRecoveryHolds: [] as OnlineRecoveryHold[], archivedRepositoryIntents: [] as RepositoryRequest[] };
    if (current.reasons.length) throw new Error(`remote_workspace_migration_blocked:${current.reasons.join(",")}`);
    const nativeSessionContinuity = await inspectNativeWorkspaceMigration(tx as unknown as Db, workspace);
    const source = remoteWorkspaceSourceSchema.parse(input.source ?? current.source);
    const sourceFingerprint = fingerprint(workspace);
    if (cohort && sourceFingerprint !== expectedSourceFingerprint) throw new Error("workspace_cohort_source_changed");
    const marker = current.marker;
    if (marker.schema === SCHEMA && typeof marker.operationId === "string") {
      if (marker.sourceFingerprint !== sourceFingerprint || canonical(marker.source) !== canonical(source)) throw new Error("remote_workspace_migration_source_changed");
      const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
        eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration")));
      if (!operation) throw new Error("remote_workspace_migration_operation_missing");
      if (canonical(operation.metadata?.cohortMigration ?? null) !== canonical(cohort ?? null)) throw new Error("remote_workspace_cohort_resume_required");
      if (canonical(operation.metadata?.nativeSessionContinuity ?? null) !== canonical(nativeSessionContinuity)) throw new Error("native_workspace_migration_source_changed");
      // Older operations only admitted the task's current workspace. Preserve
      // that binding when resuming an import journaled before this field existed.
      const issueBinding = Object.hasOwn(operation.metadata ?? {}, "sourceIssueBinding")
        ? operation.metadata!.sourceIssueBinding : workspace.id;
      if (issueBinding !== current.issueBinding) throw new Error("remote_workspace_migration_source_changed");
      if (Boolean(operation.metadata?.retainedDirectory) !== Boolean(current.retainedDirectory)) throw new Error("remote_workspace_migration_source_changed");
      if (canonical(operation.metadata?.archivedGitSource ?? null) !== canonical(gitSourceProof(current.archivedGitSource))) throw new Error("remote_workspace_migration_source_changed");
      if (canonical(operation.metadata?.finalizedRecoveryHolds ?? []) !== canonical(current.finalizedRecoveryHolds)) throw new Error("remote_workspace_migration_source_changed");
      if (canonical(recoverySourcesResumeIdentity(operation.metadata?.legacyRecoverySources ?? []))
        !== canonical(recoverySourcesResumeIdentity(current.legacyRecoverySources))) throw new Error("remote_workspace_migration_source_changed");
      if (canonical(operation.metadata?.onlineRecoveryHolds ?? []) !== canonical(current.onlineRecoveryHolds)) throw new Error("remote_workspace_migration_source_changed");
      return { workspace, authority: null, operation, source, sourceFingerprint, issueBinding, retainedDirectory: current.retainedDirectory, archivedGitSource: current.archivedGitSource, legacyRecoverySources: current.legacyRecoverySources, finalizedRecoveryHolds: current.finalizedRecoveryHolds, onlineRecoveryHolds: current.onlineRecoveryHolds, archivedRepositoryIntents: current.archivedRepositoryIntents };
    }
    let migrationSupersession;
    if (workspace.metadata?.remoteWorkspaceMigrationSupersession != null) {
      const predecessor = supersessionSchema.parse(workspace.metadata.remoteWorkspaceMigrationSupersession);
      if (predecessor.companyId !== workspace.companyId || predecessor.workspaceId !== workspace.id) throw new Error("migration_supersession_lineage_changed");
      const [latest] = await tx.select({ generation: sql<number>`coalesce(max(${executionWorkspaceSnapshots.generation}),0)` }).from(executionWorkspaceSnapshots)
        .where(and(eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id)));
      migrationSupersession = successorSchema.parse({ ...predecessor, generation: Number(latest.generation) + 1 });
    }
    const [operation] = await tx.insert(workspaceOperations).values({ ...(cohort ? { id: cohort.members.find(member => member.workspaceId === input.workspaceId)!.operationId } : {}), companyId: workspace.companyId, executionWorkspaceId: workspace.id,
      issueId: workspace.sourceIssueId, cwd: workspace.cwd ?? workspace.providerRef, phase: "remote_workspace_migration", status: "running",
      metadata: { schema: SCHEMA, sourceFingerprint, source, sourceIssueBinding: current.issueBinding,
        ...(cohort ? { cohortMigration: cohort } : {}),
        ...(migrationSupersession ? { migrationSupersession } : {}),
        ...(nativeSessionContinuity ? { nativeSessionContinuity } : {}),
        nestedWorkspaceScope: { version: 1, state: "pending" },
        ...(current.finalizedRecoveryHolds.length ? { finalizedRecoveryHolds: current.finalizedRecoveryHolds } : {}),
        ...(current.legacyRecoverySources.length ? { legacyRecoverySources: current.legacyRecoverySources } : {}),
        ...(current.onlineRecoveryHolds.length ? { onlineRecoveryHolds: current.onlineRecoveryHolds } : {}),
        ...(current.archivedGitSource ? { archivedGitSource: gitSourceProof(current.archivedGitSource) } : {}),
        ...(current.retainedDirectory ? { retainedDirectory: { restorePointId: current.retainedDirectory.restorePoint.id,
          generation: current.retainedDirectory.generation, digest: current.retainedDirectory.restorePoint.digest } } : {}) } }).returning();
    await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
    await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspaceMigration: {
      schema: SCHEMA, operationId: operation!.id, state: "running", sourceFingerprint, source,
    } }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
    return { workspace, authority: null, operation: operation!, source, sourceFingerprint, issueBinding: current.issueBinding, retainedDirectory: current.retainedDirectory, archivedGitSource: current.archivedGitSource, legacyRecoverySources: current.legacyRecoverySources, finalizedRecoveryHolds: current.finalizedRecoveryHolds, onlineRecoveryHolds: current.onlineRecoveryHolds, archivedRepositoryIntents: current.archivedRepositoryIntents };
  });
}
type ReservedMigration = Awaited<ReturnType<typeof reserveMigration>>;
type MigrationPlan = { input: MigrationInput; onlineSource?: OnlineWorkspaceSource; reserved: ReservedMigration };

async function lockMigrationRecovery(lock: MigrationTransaction, plans: MigrationPlan[], cohort?: WorkspaceMigrationCohort) {
  const online = plans.filter(plan => !plan.input.writersStopped
    && (plan.onlineSource || plan.reserved.workspace.status === "archived" && plan.reserved.archivedGitSource));
  if (!online.length) return;
  if (!await lockOnlineLegacyWorkspaceRecoverySources(lock as unknown as Db, { companyId: online[0].input.companyId,
    sources: online.flatMap(({ reserved, onlineSource }) => [...reserved.legacyRecoverySources, ...(onlineSource?.companions.flatMap(proof => proof.sources) ?? [])]),
    holds: online.flatMap(({ reserved, onlineSource }) => [...reserved.onlineRecoveryHolds, ...(onlineSource?.companions.flatMap(proof => proof.holds) ?? [])]) }))
    throw new Error("remote_workspace_migration_blocked:remote_copyback_owned");
  await mapCohortMembers(online, async ({ input, onlineSource, reserved }) => {
    const current = await inspect(input.db, { ...input, onlineSource, operationId: reserved.operation!.id }, cohort);
    if (current.reasons.length || canonical(current.legacyRecoverySources) !== canonical(reserved.legacyRecoverySources)
      || canonical(current.onlineRecoveryHolds) !== canonical(reserved.onlineRecoveryHolds))
      throw new Error("remote_workspace_migration_recovery_source_changed");
  }, online[0].input.signal);
}

function createMigrationChildVerifier(input: MigrationInput, onlineSource: OnlineWorkspaceSource | undefined, sourceLock: MigrationTransaction, cohort = false) {
  if (onlineSource?.kind !== "git") return undefined;
  const verifier = createNestedWorkspaceImportVerifier({ db: input.db, storage: input.storage, companyId: input.companyId,
    sourceLock, projectIds: onlineSource.projectIds, issueIds: onlineSource.issueIds, signal: input.signal, persistVerification: true });
  type Options = Parameters<typeof prepareNestedWorkspaceImports>[0];
  const initial = new Map<string, ReturnType<typeof prepareNestedWorkspaceImports>>(), final = new Map<string, ReturnType<typeof prepareNestedWorkspaceImports>>();
  let pending = Promise.resolve();
  const prepare = (options: Options) => {
    const work = pending.then(() => verifier.prepare(options));
    pending = work.then(() => undefined, () => undefined);
    return work;
  };
  const shared = async (options: Options, cache: typeof initial) => {
    await verifier.assertOwner();
    const root = options.workspace.cwd ?? options.workspace.providerRef;
    const key = canonical([root ? await fs.realpath(root) : null, [...(options.gitSourceRoots ?? [])].sort(), options.recordedChildren ?? null]);
    let work = cache.get(key);
    if (!work) { work = prepare(options); cache.set(key, work); }
    const result = await work;
    await verifier.assertOwner();
    return result;
  };
  return {
    prepare: (options: Options) => cohort ? shared(options, initial) : prepare(options),
    finalize: (options: Options) => shared(options, final),
    deferFinal: cohort,
    async close() { await pending; await verifier.close(); },
  };
}

async function captureMigration(input: MigrationInput, reserved: ReservedMigration, onlineSource?: OnlineWorkspaceSource,
  childVerifier?: ReturnType<typeof createMigrationChildVerifier>) {
  let operation = reserved.operation!;
  if (canonical(operation.metadata?.legacyRecoverySources ?? []) !== canonical(reserved.legacyRecoverySources)) {
    const [refreshed] = await input.db.update(workspaceOperations).set({ metadata: { ...operation.metadata,
      legacyRecoverySources: reserved.legacyRecoverySources }, updatedAt: new Date() }).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.workspaceId),
      eq(workspaceOperations.id, operation.id), eq(workspaceOperations.phase, "remote_workspace_migration"), eq(workspaceOperations.status, "running"),
      sql`${workspaceOperations.finishedAt} is null`, eq(workspaceOperations.metadata, operation.metadata!))).returning();
    if (!refreshed) throw new Error("remote_workspace_migration_operation_changed");
    operation = refreshed;
  }
  const predecessor = operation.metadata?.migrationSupersession == null ? null : successorSchema.parse(operation.metadata.migrationSupersession);
  if (predecessor && (predecessor.companyId !== input.companyId || predecessor.workspaceId !== input.workspaceId))
    throw new Error("migration_supersession_lineage_changed");
  const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.companyId, workspaceId: input.workspaceId,
    operationId: operation.id, generation: predecessor?.generation ?? 1, epoch: 1 });
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-migration-")));
  try {
    input.signal?.throwIfAborted();
    const retained = reserved.retainedDirectory?.restorePoint;
    const archivePath = path.join(scratch, "workspace.pcws");
    const recovered = reserved.archivedGitSource ? await recoverWorkspaceSnapshotArchive({
      db: input.db, storage: input.storage, companyId: input.companyId, workspaceId: input.workspaceId,
      snapshotId: snapshot.id, targetPath: archivePath, signal: input.signal,
    }) : null;
    const sourceRoot = recovered ? null : retained ? await materializeTaskDirectorySnapshot({
      payload: await loadTaskDirectoryRestorePoint({ storage: input.storage, workspace: reserved.workspace, ref: retained, recoverMissingEmpty: true, signal: input.signal }),
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
    const nested = (input.writersStopped || onlineSource?.kind === "git") && !retained && !reserved.archivedGitSource
      ? await (childVerifier?.prepare ?? prepareNestedWorkspaceImports)({ ...input, workspace: reserved.workspace, scratch, recordedChildren, gitSourceRoots: onlineSource?.gitSourceRoots }) : [];
    if (scope.state === "pending") {
      const [saved] = await input.db.update(workspaceOperations).set({ metadata: { ...operation.metadata,
        nestedWorkspaceScope: { version: 1, state: "fixed", children: nested } }, updatedAt: new Date() })
        .where(and(eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.id, operation.id),
          eq(workspaceOperations.status, "running"))).returning();
      if (!saved) throw new Error("remote_workspace_migration_operation_changed");
      operation = saved;
    }
    if (sourceRoot) await assertArchivedRepositoryIntents(sourceRoot, reserved.archivedRepositoryIntents);
    const exclude = nested.map(child => child.relativePath);
    const captured = recovered ?? await captureRemoteWorkspaceDirectory({ cwd: sourceRoot!, archivePath, exclude, requireNoGit: onlineSource?.kind === "ordinary", gitSourceRoots: onlineSource?.gitSourceRoots, signal: input.signal });
    const restoredArchive = path.join(scratch, "verified.pcws"), restored = path.join(scratch, "restored");
    const verifiedArchivePath = process.platform === "win32" ? undefined : restoredArchive;
    const ref = await uploadWorkspaceSnapshot({ db: input.db, storage: input.storage, snapshotId: snapshot.id,
      companyId: input.companyId, workspaceId: input.workspaceId, archivePath, manifestDigest: captured.manifestDigest, signal: input.signal,
      verifiedArchivePath,
      // Private Git reconstruction can change administrative bytes between
      // attempts. Its journaled logical recipe is checked at reservation and
      // again under source locks before authority publication below.
      ...(reserved.archivedGitSource ? { unpublishedRecapture: { sourceOperationId: operation.id } } : {}),
    });
    if (!verifiedArchivePath) await loadWorkspaceSnapshotArchive({ storage: input.storage, reference: ref,
      targetPath: restoredArchive, signal: input.signal });
    await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir: restored, expectedManifestDigest: ref.manifestDigest, signal: input.signal });
    await assertArchivedRepositoryIntents(restored, reserved.archivedRepositoryIntents);
    if (!recovered) {
      const currentArchive = path.join(scratch, "current.pcws");
      const current = await captureRemoteWorkspaceDirectory({ cwd: sourceRoot!, archivePath: currentArchive, exclude, requireNoGit: onlineSource?.kind === "ordinary", gitSourceRoots: onlineSource?.gitSourceRoots, signal: input.signal });
      if (current.manifestDigest !== captured.manifestDigest) throw new Error("remote_workspace_migration_source_changed");
    }
    if (nested.length && !childVerifier?.deferFinal) {
      const verifyScratch = path.join(scratch, "verify-nested"); await fs.mkdir(verifyScratch);
      const verified = await (childVerifier?.prepare ?? prepareNestedWorkspaceImports)({ ...input, workspace: reserved.workspace,
        scratch: verifyScratch, recordedChildren: nested, gitSourceRoots: onlineSource?.gitSourceRoots });
      if (canonical(verified) !== canonical(nested)) throw new Error("nested_workspace_source_changed");
    }
    input.signal?.throwIfAborted();
    return { operation, ref, nested, scratch, restored };
  } catch (error) { await removeTaskDirectoryTree(scratch); throw error; }
}
type CapturedMigration = Awaited<ReturnType<typeof captureMigration>>;

async function validateMigrationPublication(tx: MigrationTransaction, input: MigrationInput, reserved: ReservedMigration,
  captured: CapturedMigration, onlineSource?: OnlineWorkspaceSource, cohort?: WorkspaceMigrationCohort) {
  const { operation, ref, nested } = captured;
  if (cohort) {
    const [journal] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
      eq(workspaceOperations.id, operation.id), eq(workspaceOperations.executionWorkspaceId, input.workspaceId))).for("update", { noWait: true });
    if (!journal || journal.status !== "running" || journal.finishedAt !== null || journal.phase !== "remote_workspace_migration"
      || journal.issueId !== operation.issueId || journal.cwd !== operation.cwd
      || canonical(journal.metadata) !== canonical(operation.metadata)) throw new Error("workspace_cohort_journal_changed");
  }
  await lockMigrationParents(tx, input.companyId, reserved.workspace.sourceIssueId, onlineSource || reserved.archivedGitSource ? [
    ...reserved.legacyRecoverySources.map(source => source.issueId),
    ...(onlineSource?.companions.flatMap(proof => proof.sources.map(source => source.issueId)) ?? []),
  ] : []);
  for (const actionId of [...new Set([...reserved.finalizedRecoveryHolds, ...reserved.onlineRecoveryHolds].map(held => held.actionId))].sort()) {
    await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, actionId))).for("update", { noWait: true });
  }
  const protectedRunIds = [...new Set([...reserved.legacyRecoverySources.map(source => source.runId),
    ...reserved.finalizedRecoveryHolds.map(held => held.runId)])].sort();
  for (const runId of protectedRunIds) {
    await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, runId))).for("update", { noWait: true });
    await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId))).for("update", { noWait: true });
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
  if (reserved.archivedGitSource?.recipe) await tx.select({ id: executionWorkspaceRepositories.id }).from(executionWorkspaceRepositories)
    .where(and(eq(executionWorkspaceRepositories.companyId, input.companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, input.workspaceId)))
    .orderBy(executionWorkspaceRepositories.id).for("update", { noWait: true });
  const validation = await inspect(tx as unknown as Db, { ...input, operationId: operation.id, onlineSource }, cohort);
  if (!input.source && canonical(validation.source) !== canonical(reserved.source)) throw new Error("remote_workspace_migration_source_changed");
  if (validation.issueBinding !== reserved.issueBinding) throw new Error("remote_workspace_migration_source_changed");
  if (Boolean(validation.retainedDirectory) !== Boolean(reserved.retainedDirectory)) throw new Error("remote_workspace_migration_source_changed");
  if (canonical(gitSourceProof(validation.archivedGitSource)) !== canonical(gitSourceProof(reserved.archivedGitSource))) throw new Error("remote_workspace_migration_source_changed");
  if (validation.reasons.length) throw new Error(`remote_workspace_migration_blocked:${validation.reasons.join(",")}`);
  await assertArchivedRepositoryIntents(captured.restored, validation.archivedRepositoryIntents);
  if (reserved.archivedGitSource) await lockArchivedGitMigrationSources(tx as unknown as Db, workspace, reserved.archivedGitSource);
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
  if (canonical(validation.finalizedRecoveryHolds) !== canonical(reserved.finalizedRecoveryHolds)) throw new Error("remote_workspace_migration_source_changed");
  if (canonical(validation.onlineRecoveryHolds) !== canonical(reserved.onlineRecoveryHolds)) throw new Error("remote_workspace_migration_recovery_source_changed");
  if (canonical(validation.legacyRecoverySources) !== canonical(reserved.legacyRecoverySources)) throw new Error("remote_workspace_migration_source_changed");
  const continuity = await inspectNativeWorkspaceMigration(tx as unknown as Db, workspace);
  if (canonical(continuity) !== canonical(operation.metadata?.nativeSessionContinuity ?? null)) throw new Error("native_workspace_migration_source_changed");
  return { workspace, uploaded, continuity };
}
type ValidatedPublication = NonNullable<Awaited<ReturnType<typeof validateMigrationPublication>>>;

async function publishMigration(tx: MigrationTransaction, reserved: ReservedMigration, captured: CapturedMigration, validated: ValidatedPublication) {
  const { operation, ref, nested } = captured, { workspace, uploaded, continuity } = validated;
  const authority: RemoteWorkspaceAuthority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: ref.id,
    source: reserved.source, location: null, writerRunId: null, dirty: false };
  const metadata: Record<string, unknown> = { ...workspace.metadata, remoteWorkspace: authority }; delete metadata.remoteWorkspaceMigration;
  if (continuity) metadata.nativeWorkspaceMigration = nativeWorkspaceMigrationMarker(operation.id);
  if (reserved.legacyRecoverySources.length) {
    metadata.legacyWorkspaceRecoveryMigration = { schema: LEGACY_WORKSPACE_RECOVERY_MIGRATION, operationId: operation.id };
    for (const source of reserved.legacyRecoverySources) {
      const markerKey = source.reference?.state === "finalized"
        ? "finalizedWorkspaceRecoveryMigration" : "legacyWorkspaceRecoveryMigration";
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
          [markerKey]: { schema: LEGACY_WORKSPACE_RECOVERY_MIGRATION,
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
}

function publicationError(error: unknown): never {
  const failure = object(error), cause = object(failure.cause);
  if ((cause.code ?? failure.code) !== "55P03") throw error;
  throw new Error("remote_workspace_migration_blocked:execution_rows_busy", { cause: error });
}

/** Administrative import. The CLI enforces external deployment prerequisites. */
export async function migrateRemoteWorkspace(input: MigrationInput) {
  if (!input.apply) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: false };
  const onlineSource = await resolveMigrationSource(input);
  let committedPublication: Parameters<typeof publishActivity>[0] | undefined;
  const migrate = async (lock: MigrationTransaction) => {
    const reserved = await reserveMigration(input, onlineSource);
    if (reserved.authority) return { ...await inventoryRemoteWorkspaceMigration(input.db, input), applied: true, replayed: true };
    await lockMigrationRecovery(lock, [{ input, onlineSource, reserved }]);
    const childVerifier = createMigrationChildVerifier(input, onlineSource, lock);
    let scratch: string | undefined;
    try {
      const captured = await captureMigration(input, reserved, onlineSource, childVerifier);
      scratch = captured.scratch;
      await lock.execute(sql`select 1`);
      const publicationDb = onlineSource ? lock as unknown as Db : input.db;
      const publication = await publicationDb.transaction(async tx => {
        const validated = await validateMigrationPublication(tx, input, reserved, captured, onlineSource);
        return validated ? publishMigration(tx, reserved, captured, validated) : null;
      }).catch(publicationError);
      if (publication) { if (onlineSource) committedPublication = publication; else publishActivity(publication); }
      return { ...await inventoryRemoteWorkspaceMigration(publicationDb, input), applied: true, replayed: false };
    } finally { await childVerifier?.close(); if (scratch) await removeTaskDirectoryTree(scratch); }
  };
  if (onlineSource) {
    const sourceLocks = input.sourceLockWaitMs === undefined ? withWorkspaceSourceLocks : withIndependentWorkspaceSourceLocks;
    const result = await sourceLocks(input.db, {
      companyId: input.companyId, issueIds: onlineSource.issueIds,
      projectIds: onlineSource.projectIds,
    }, async lock => {
      for (const workspaceId of onlineSource.workspaceIds) {
        if (!await tryAcquireExecutionWorkspaceLifecycleLock(lock, workspaceId))
          throw new IsolatedRepositorySourceBusy("workspace_source_busy");
      }
      return migrate(lock);
    }, true, input.sourceLockWaitMs === undefined ? undefined : { waitMs: input.sourceLockWaitMs, signal: input.signal });
    if (committedPublication) publishActivity(committedPublication);
    return result;
  }
  return withExecutionWorkspaceLifecycleLock(input.db, input.workspaceId, migrate);
}

const cohortSchema = z.object({
  schema: z.literal("paperclip.remote-workspace-cohort.v1"), id: z.string().uuid(), companyId: z.string().uuid(),
  sourceProof: z.string().regex(/^[a-f0-9]{64}$/),
  members: z.array(z.object({ workspaceId: z.string().uuid(), operationId: z.string().uuid() }).strict()).min(1).max(32),
}).strict();

async function mapCohortMembers<T, R>(members: readonly T[], read: (member: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = [], cancellation = members.length > 8 ? signal : undefined;
  for (let start = 0; start < members.length; start += 8) {
    cancellation?.throwIfAborted();
    const readers = await Promise.allSettled(members.slice(start, start + 8).map((member, index) => read(member, start + index)));
    for (const reader of readers) {
      if (reader.status === "rejected") throw reader.reason;
      results.push(reader.value);
    }
    cancellation?.throwIfAborted();
  }
  return results;
}

export async function migrateRemoteWorkspaceCohort(input: {
  db: Db; storage: StorageService; companyId: string; workspaceIds: readonly string[];
  apply?: boolean; concurrency?: number; signal: AbortSignal; sourceLockWaitMs?: number;
}) {
  const companyId = z.string().uuid().parse(input.companyId).toLowerCase();
  const workspaceIds = z.array(z.string().uuid()).min(1).max(32).parse(input.workspaceIds).map(id => id.toLowerCase()).sort();
  const concurrency = z.number().int().min(1).max(8).parse(input.concurrency ?? 2);
  if (new Set(workspaceIds).size !== workspaceIds.length) throw new Error("workspace_cohort_duplicate_member");
  input.signal.throwIfAborted();
  const initial = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, workspaceIds))).orderBy(executionWorkspaces.id);
  if (initial.length !== workspaceIds.length) throw new Error("workspace_cohort_member_missing");
  const imported = initial.map(workspace => Boolean(readRemoteWorkspaceAuthority(workspace.metadata)));
  if (imported.every(Boolean)) {
    const snapshotIds = initial.flatMap(workspace => readRemoteWorkspaceAuthority(workspace.metadata)?.snapshotId ?? []);
    if (snapshotIds.length !== workspaceIds.length) throw new Error("workspace_cohort_membership_changed");
    const saved = await input.db.select({ snapshot: executionWorkspaceSnapshots, operation: workspaceOperations })
      .from(executionWorkspaceSnapshots).innerJoin(workspaceOperations, and(
        eq(workspaceOperations.companyId, executionWorkspaceSnapshots.companyId),
        eq(workspaceOperations.id, executionWorkspaceSnapshots.sourceOperationId)))
      .where(and(eq(executionWorkspaceSnapshots.companyId, companyId), inArray(executionWorkspaceSnapshots.id, snapshotIds),
        inArray(executionWorkspaceSnapshots.executionWorkspaceId, workspaceIds)));
    const parsed = cohortSchema.safeParse(saved[0]?.operation.metadata?.cohortMigration);
    if (!parsed.success) throw new Error("workspace_cohort_membership_changed");
    const cohort = parsed.data;
    if (saved.length !== workspaceIds.length || cohort.companyId !== companyId
      || canonical(cohort.members.map(member => member.workspaceId)) !== canonical(workspaceIds)
      || new Set(cohort.members.map(member => member.operationId)).size !== workspaceIds.length
      || saved.some(({ snapshot, operation }) => operation.status !== "succeeded" || operation.phase !== "remote_workspace_migration"
        || operation.executionWorkspaceId !== snapshot.executionWorkspaceId || !["committed", "superseded"].includes(snapshot.status)
        || operation.metadata?.snapshotId !== snapshot.id || operation.metadata?.manifestDigest !== snapshot.manifestDigest
        || cohort.members.find(member => member.workspaceId === snapshot.executionWorkspaceId)?.operationId !== operation.id
        || canonical(operation.metadata?.cohortMigration) !== canonical(cohort))) throw new Error("workspace_cohort_membership_changed");
    return { companyId, cohortId: cohort.id, applied: Boolean(input.apply), replayed: true,
      members: await mapCohortMembers(workspaceIds, workspaceId => inventoryRemoteWorkspaceMigration(input.db, { companyId, workspaceId }), input.signal) };
  }
  if (imported.some(Boolean)) throw new Error("workspace_cohort_membership_changed");
  const stop = new AbortController(), signal = AbortSignal.any([input.signal, stop.signal]);
  const members = await mapCohortMembers(workspaceIds, async workspaceId => {
    const memberInput: MigrationInput = { db: input.db, storage: input.storage, companyId, workspaceId, apply: true, signal };
    const onlineSource = await resolveMigrationSource(memberInput);
    if (!onlineSource) throw new Error("workspace_cohort_online_source_required");
    return { input: memberInput, onlineSource };
  }, signal);
  const scopeIdentity = (scope: OnlineWorkspaceSource) => canonical({ kind: scope.kind,
    projectIds: scope.projectIds, issueIds: scope.issueIds, workspaceIds: scope.workspaceIds });
  if (members.some(member => scopeIdentity(member.onlineSource) !== scopeIdentity(members[0].onlineSource)))
    throw new Error("workspace_cohort_source_scope_mismatch");
  if (members.length > 8 && members.some(member => member.onlineSource.root !== members[0].onlineSource.root))
    throw new Error("workspace_cohort_same_root_required");
  for (const member of members) for (const other of members) {
    if (member !== other && member.onlineSource.root !== other.onlineSource.root
      && member.onlineSource.root.startsWith(other.onlineSource.root + path.sep)) throw new Error("workspace_cohort_leaf_members_required");
  }
  const sourceProof = createHash("sha256").update(canonical({ scope: scopeIdentity(members[0].onlineSource),
    members: initial.map(workspace => ({ workspaceId: workspace.id, fingerprint: fingerprint(workspace) })) })).digest("hex");
  const pending = [];
  let unchangedMembers = true;
  for (const workspace of initial) {
    const marker = object(workspace.metadata?.remoteWorkspaceMigration);
    if (marker.schema !== SCHEMA || typeof marker.operationId !== "string") continue;
    const [operation] = await input.db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
      eq(workspaceOperations.id, marker.operationId), eq(workspaceOperations.phase, "remote_workspace_migration")));
    if (!operation?.metadata?.cohortMigration) throw new Error("workspace_cohort_foreign_journal");
    if (operation.status !== "running" || operation.finishedAt !== null) throw new Error("workspace_cohort_journal_changed");
    unchangedMembers &&= marker.sourceFingerprint === fingerprint(workspace)
      && operation.metadata.sourceFingerprint === marker.sourceFingerprint;
    pending.push(cohortSchema.parse(operation.metadata.cohortMigration));
  }
  let cohort: WorkspaceMigrationCohort = pending[0] ?? { schema: "paperclip.remote-workspace-cohort.v1", id: randomUUID(), companyId,
    sourceProof, members: workspaceIds.map(workspaceId => ({ workspaceId, operationId: randomUUID() })) };
  const refreshSourceProof = cohort.sourceProof !== sourceProof;
  if (cohort.companyId !== companyId || refreshSourceProof && (pending.length !== workspaceIds.length || !unchangedMembers)
    || canonical(cohort.members.map(member => member.workspaceId)) !== canonical(workspaceIds)
    || new Set(cohort.members.map(member => member.operationId)).size !== workspaceIds.length
    || pending.some(marker => canonical(marker) !== canonical(cohort))) throw new Error("workspace_cohort_membership_changed");
  const preflight = async (db: ReadDb) => {
    await mapCohortMembers(members, async member => {
      const current = await inspect(db, { ...member.input, onlineSource: member.onlineSource }, cohort);
      if (current.reasons.length) throw new Error(`remote_workspace_migration_blocked:${current.reasons.join(",")}`);
      if (fingerprint(current.workspace) !== fingerprint(initial.find(workspace => workspace.id === member.input.workspaceId)!))
        throw new Error("workspace_cohort_source_changed");
    }, signal);
  };
  if (!input.apply) { await preflight(input.db); return { companyId, cohortId: cohort.id, applied: false, eligible: true, workspaceIds }; }
  const publications: Parameters<typeof publishActivity>[0][] = [];
  const result = await withIndependentWorkspaceSourceLocks(input.db, { companyId,
    projectIds: members[0].onlineSource.projectIds, issueIds: members[0].onlineSource.issueIds }, async lock => {
    for (const workspaceId of members[0].onlineSource.workspaceIds) {
      if (!await tryAcquireExecutionWorkspaceLifecycleLock(lock, workspaceId)) throw new IsolatedRepositorySourceBusy("workspace_source_busy");
    }
    await preflight(input.db);
    const plans: MigrationPlan[] = await mapCohortMembers(members, async member => {
      const reserved = await reserveMigration(member.input, member.onlineSource, cohort,
        fingerprint(initial.find(workspace => workspace.id === member.input.workspaceId)!));
      if (reserved.authority) throw new Error("workspace_cohort_membership_changed");
      return { ...member, reserved };
    }, signal);
    await lockMigrationRecovery(lock, plans, cohort);
    if (refreshSourceProof) {
      const refreshedCohort = { ...cohort, sourceProof };
      const operations = await input.db.transaction(async tx => {
        await lockMigrationParents(tx, companyId, null, plans.flatMap(plan => [plan.reserved.workspace.sourceIssueId!,
          ...plan.reserved.legacyRecoverySources.map(source => source.issueId),
          ...plan.onlineSource!.companions.flatMap(proof => proof.sources.map(source => source.issueId))]));
        const locked = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId),
          inArray(executionWorkspaces.id, workspaceIds))).orderBy(executionWorkspaces.id).for("update");
        if (locked.length !== plans.length || plans.some(plan => {
          const workspace = locked.find(row => row.id === plan.input.workspaceId)!;
          return fingerprint(workspace) !== plan.reserved.sourceFingerprint
            || canonical(workspace.metadata?.remoteWorkspaceMigration) !== canonical(plan.reserved.workspace.metadata?.remoteWorkspaceMigration);
        })) throw new Error("workspace_cohort_source_changed");
        await preflight(tx);
        const updated = [];
        for (const plan of plans) {
          signal.throwIfAborted();
          const operation = plan.reserved.operation!;
          const [current] = await tx.update(workspaceOperations).set({ metadata: { ...operation.metadata,
            cohortMigration: refreshedCohort }, updatedAt: new Date() }).where(and(
            eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, plan.input.workspaceId),
            eq(workspaceOperations.id, operation.id), eq(workspaceOperations.phase, "remote_workspace_migration"),
            eq(workspaceOperations.status, "running"), sql`${workspaceOperations.finishedAt} is null`,
            sql`${workspaceOperations.issueId} is not distinct from ${operation.issueId}::uuid`,
            sql`${workspaceOperations.cwd} is not distinct from ${operation.cwd}`,
            eq(workspaceOperations.metadata, operation.metadata!))).returning();
          if (!current) throw new Error("workspace_cohort_journal_changed");
          updated.push(current);
        }
        await lock.execute(sql`select 1`);
        signal.throwIfAborted();
        return updated;
      });
      for (const [index, plan] of plans.entries()) plan.reserved.operation = operations[index];
      cohort = refreshedCohort;
    }
    const captures: Array<CapturedMigration | undefined> = Array(plans.length);
    const childVerifier = createMigrationChildVerifier(plans[0].input, plans[0].onlineSource, lock, true);
    let next = 0, failure: unknown;
    const worker = async () => {
      while (!signal.aborted && next < plans.length) {
        const index = next++, plan = plans[index];
        try {
          const captured = await captureMigration(plan.input, plan.reserved, plan.onlineSource, childVerifier);
          captures[index] = captured;
          if (plan.onlineSource && !plan.reserved.archivedRepositoryIntents.length) {
            for (const name of ["workspace.pcws", "verified.pcws", "current.pcws"])
              await fs.rm(path.join(captured.scratch, name), { force: true });
            await removeTaskDirectoryTree(captured.restored);
          }
        }
        catch (error) { failure ??= error; stop.abort(error); }
      }
    };
    try {
      const peers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
      for (const peer of peers) if (peer.status === "rejected") failure ??= peer.reason;
      if (failure) throw failure;
      signal.throwIfAborted();
      await mapCohortMembers(plans, async (plan, index) => {
        const captured = captures[index]!;
        if (!captured.nested.length) return;
        const scratch = path.join(captured.scratch, "verify-nested"); await fs.mkdir(scratch);
        const verified = await (childVerifier?.finalize ?? prepareNestedWorkspaceImports)({ ...plan.input, workspace: plan.reserved.workspace,
          scratch, recordedChildren: captured.nested, gitSourceRoots: plan.onlineSource?.gitSourceRoots });
        if (canonical(verified) !== canonical(captured.nested)) throw new Error("nested_workspace_source_changed");
      }, signal);
      await lock.execute(sql`select 1`);
      await lock.transaction(async tx => {
        await lockMigrationParents(tx, companyId, null, plans.flatMap(plan => [
          plan.reserved.workspace.sourceIssueId!, ...plan.reserved.legacyRecoverySources.map(source => source.issueId),
          ...plan.onlineSource!.companions.flatMap(proof => proof.sources.map(source => source.issueId)),
        ]));
        const validated = [];
        for (const [index, plan] of plans.entries()) {
          signal.throwIfAborted();
          const current = await validateMigrationPublication(tx, plan.input, plan.reserved, captures[index]!, plan.onlineSource, cohort);
          if (!current) throw new Error("workspace_cohort_publication_changed");
          validated.push(current);
        }
        for (const [index, plan] of plans.entries()) {
          signal.throwIfAborted();
          publications.push(await publishMigration(tx, plan.reserved, captures[index]!, validated[index]));
        }
        signal.throwIfAborted();
      }).catch(publicationError);
      const results = [];
      for (const workspaceId of workspaceIds) results.push(await inventoryRemoteWorkspaceMigration(lock as unknown as Db, { companyId, workspaceId }));
      return { companyId, cohortId: cohort.id, applied: true, replayed: false, members: results };
    } catch (error) { failure = error; throw error; }
    finally {
      await childVerifier?.close();
      const cleanup = await mapCohortMembers(captures.filter((capture): capture is CapturedMigration => Boolean(capture)),
        capture => removeTaskDirectoryTree(capture.scratch).then(() => [], error => [error]));
      const errors = cleanup.flat();
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, "workspace_cohort_cleanup_failed");
      if (!failure) signal.throwIfAborted();
    }
  }, true, input.sourceLockWaitMs === undefined ? undefined : { waitMs: input.sourceLockWaitMs, signal });
  for (const publication of publications) publishActivity(publication);
  return result;
}


export async function supersedeExpiredRemoteWorkspaceMigrationCohort(input: {
  db: Db; companyId: string; cohort: unknown; expiredWorkspaceIds: readonly string[]; signal: AbortSignal; sourceLockWaitMs?: number;
}) {
  const companyId = z.string().uuid().parse(input.companyId).toLowerCase(), cohort = cohortSchema.parse(input.cohort);
  const expired = z.array(z.string().uuid()).min(1).max(8).parse(input.expiredWorkspaceIds).map(id => id.toLowerCase()).sort();
  const ids = cohort.members.map(member => member.workspaceId), operationIds = cohort.members.map(member => member.operationId);
  if (cohort.companyId !== companyId || ids.length > 8 || new Set(ids).size !== ids.length
    || new Set(operationIds).size !== ids.length || canonical(ids) !== canonical([...ids].sort())
    || new Set(expired).size !== expired.length || expired.some(id => !ids.includes(id))) throw new Error("migration_supersession_membership_changed");
  input.signal.throwIfAborted();
  const readRows = async (db: ReadDb) => ({
    workspaces: await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, ids))).orderBy(executionWorkspaces.id),
    operations: await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, companyId), inArray(workspaceOperations.id, operationIds))).orderBy(workspaceOperations.id),
    snapshots: await db.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, companyId), inArray(executionWorkspaceSnapshots.sourceOperationId, operationIds))).orderBy(executionWorkspaceSnapshots.id),
  });
  const initial = await readRows(input.db);
  if (initial.workspaces.length !== ids.length || initial.operations.length !== ids.length
    || initial.operations.some(operation => operation.phase !== "remote_workspace_migration"
      || cohort.members.find(member => member.operationId === operation.id)?.workspaceId !== operation.executionWorkspaceId
      || canonical(operation.metadata?.cohortMigration) !== canonical(cohort))
    || initial.snapshots.some(snapshot => !["pending", "uploaded"].includes(snapshot.status)
      || cohort.members.find(member => member.operationId === snapshot.sourceOperationId)?.workspaceId !== snapshot.executionWorkspaceId))
    throw new Error("migration_supersession_journal_changed");
  const previous = object(initial.operations[0].metadata?.lastFailure);
  const receipt = (supersessionId: string, replayed: boolean) => ({ superseded: true, migrationCompleted: false, replayed,
    companyId, cohortId: cohort.id, supersessionId, members: cohort.members.map(member => ({ ...member,
      snapshotIds: initial.snapshots.filter(snapshot => snapshot.sourceOperationId === member.operationId).map(snapshot => snapshot.id) })) });
  if (initial.operations.every(operation => operation.status === "failed" && operation.finishedAt !== null
    && object(operation.metadata?.lastFailure).schema === SUPERSESSION
    && object(operation.metadata?.lastFailure).code === "source_expired_during_import"
    && object(operation.metadata?.lastFailure).operationId === operation.id
    && object(operation.metadata?.lastFailure).workspaceId === operation.executionWorkspaceId
    && object(operation.metadata?.lastFailure).companyId === companyId
    && object(operation.metadata?.lastFailure).cohortId === cohort.id
    && object(operation.metadata?.lastFailure).supersessionId === previous.supersessionId
    && canonical(object(operation.metadata?.lastFailure).expiredWorkspaceIds) === canonical(expired)
    && !Object.hasOwn(operation.metadata ?? {}, "retiredSave")) && typeof previous.supersessionId === "string") return receipt(previous.supersessionId, true);
  if (initial.operations.some(operation => operation.status !== "running" || operation.finishedAt !== null || operation.metadata?.uncertain === true
    || Object.hasOwn(operation.metadata ?? {}, "lastFailure") || Object.hasOwn(operation.metadata ?? {}, "retiredSave")))
    throw new Error("migration_supersession_journal_changed");
  const observe = async (db: ReadDb) => {
    const rows = await readRows(db), members = [];
    if (JSON.stringify(rows) !== JSON.stringify(initial)) throw new Error("migration_supersession_source_changed");
    for (const workspace of rows.workspaces) {
      input.signal.throwIfAborted();
      const operation = rows.operations.find(row => row.executionWorkspaceId === workspace.id)!, marker = object(workspace.metadata?.remoteWorkspaceMigration);
      if (readRemoteWorkspaceAuthority(workspace.metadata) || marker.schema !== SCHEMA || marker.operationId !== operation.id
        || marker.sourceFingerprint !== operation.metadata?.sourceFingerprint || canonical(marker.source) !== canonical(operation.metadata?.source)
        || workspace.metadata?.remoteWorkspaceMigrationSupersession != null || operation.issueId !== workspace.sourceIssueId
        || operation.cwd !== (workspace.cwd ?? workspace.providerRef)) throw new Error("migration_supersession_source_changed");
      const memberInput = { db: db as Db, companyId, workspaceId: workspace.id, signal: input.signal };
      const onlineSource = await resolveMigrationSource(memberInput), current = await inspect(db, { ...memberInput, onlineSource }, cohort);
      if (current.reasons.length) throw new Error(`remote_workspace_migration_blocked:${current.reasons.join(",")}`);
      if (expired.includes(workspace.id)) {
        const expiration = readGitCacheExpiration(workspace), recipe = current.archivedGitSource?.recipe;
        if (workspace.status !== "archived" || workspace.cleanupReason !== GIT_CACHE_EXPIRATION_REASON
          || !expiration?.completed || !expiration.workspaceRemoved || !recipe?.restorePoint || recipe.restoredAt
          || fingerprint(workspace) === marker.sourceFingerprint) throw new Error("migration_supersession_expiration_unverified");
      } else if (!onlineSource || fingerprint(workspace) !== marker.sourceFingerprint) throw new Error("migration_supersession_source_changed");
      members.push({ workspace, operation, onlineSource, current });
    }
    return members;
  };
  const observed = await observe(input.db), projectIds = [...new Set(observed.flatMap(member => member.onlineSource?.projectIds
    ?? (member.workspace.projectId ? [member.workspace.projectId] : [])))].sort();
  const issueIds = [...new Set(observed.flatMap(member => member.onlineSource?.issueIds ?? [member.workspace.sourceIssueId!]))].sort();
  const lifecycleIds = [...new Set(observed.flatMap(member => [member.workspace.id, ...(member.onlineSource?.workspaceIds ?? [])]))].sort();
  const publications: Parameters<typeof publishActivity>[0][] = [], supersessionId = randomUUID();
  await withIndependentWorkspaceSourceLocks(input.db, { companyId, projectIds, issueIds }, async lock => {
    for (const id of lifecycleIds) if (!await tryAcquireExecutionWorkspaceLifecycleLock(lock, id)) throw new IsolatedRepositorySourceBusy("workspace_source_busy");
    const current = await observe(input.db);
    if (canonical(current) !== canonical(observed)) throw new Error("migration_supersession_source_changed");
    const sources = current.flatMap(member => [...member.current.legacyRecoverySources,
      ...(member.onlineSource?.companions.flatMap(proof => proof.sources) ?? [])]);
    const holds = current.flatMap(member => [...member.current.onlineRecoveryHolds,
      ...(member.onlineSource?.companions.flatMap(proof => proof.holds) ?? [])]);
    if (!await lockOnlineLegacyWorkspaceRecoverySources(lock as unknown as Db, { companyId, sources, holds }))
      throw new Error("remote_workspace_migration_blocked:remote_copyback_owned");
    await lock.transaction(async tx => {
      await lockMigrationParents(tx, companyId, null, [...observed.map(member => member.workspace.sourceIssueId!),
        ...sources.map(source => source.issueId)]);
      await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, ids))).orderBy(executionWorkspaces.id).for("update", { noWait: true });
      await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, companyId), inArray(workspaceOperations.id, operationIds))).orderBy(workspaceOperations.id).for("update", { noWait: true });
      for (const snapshot of initial.snapshots) await tx.select().from(executionWorkspaceSnapshots).where(and(
        eq(executionWorkspaceSnapshots.companyId, companyId), eq(executionWorkspaceSnapshots.id, snapshot.id))).for("update", { noWait: true });
      const checked = await observe(tx);
      if (canonical(checked) !== canonical(current)) throw new Error("migration_supersession_source_changed");
      const at = new Date();
      for (const member of checked) {
        input.signal.throwIfAborted();
        if (member.current.archivedGitSource) await lockArchivedGitMigrationSources(tx, member.workspace, member.current.archivedGitSource);
        const snapshotIds = initial.snapshots.filter(snapshot => snapshot.sourceOperationId === member.operation.id).map(snapshot => snapshot.id);
        const lineage = { schema: SUPERSESSION, companyId, workspaceId: member.workspace.id, cohortId: cohort.id,
          operationId: member.operation.id, supersessionId, snapshotIds };
        const [operation] = await tx.update(workspaceOperations).set({ status: "failed", finishedAt: at, updatedAt: at,
          metadata: { ...member.operation.metadata, lastFailure: { ...lineage, code: "source_expired_during_import", at: at.toISOString(), expiredWorkspaceIds: expired } } }).where(and(
          eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, member.workspace.id), eq(workspaceOperations.id, member.operation.id),
          eq(workspaceOperations.phase, "remote_workspace_migration"), eq(workspaceOperations.status, "running"), sql`${workspaceOperations.finishedAt} is null`, eq(workspaceOperations.metadata, member.operation.metadata!))).returning();
        const metadata: Record<string, unknown> = { ...member.workspace.metadata, remoteWorkspaceMigrationSupersession: lineage }; delete metadata.remoteWorkspaceMigration;
        const [workspace] = await tx.update(executionWorkspaces).set({ metadata, updatedAt: at }).where(and(
          eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, member.workspace.id), eq(executionWorkspaces.metadata, member.workspace.metadata!))).returning();
        if (!operation || !workspace) throw new Error("migration_supersession_compare_and_swap_failed");
        publications.push((await persistActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "remote-workspace-migration",
          action: "workspace.migration_failed", entityType: "execution_workspace", entityId: workspace.id,
          details: { code: "source_expired_during_import", cohortId: cohort.id, operationId: operation.id, supersessionId, snapshotIds } })).publication);
      }
      await notifyRemoteWorkspaceSnapshots(tx, `cohort:${cohort.id}`);
      input.signal.throwIfAborted();
    });
  }, true, input.sourceLockWaitMs === undefined ? undefined : { waitMs: input.sourceLockWaitMs, signal: input.signal });
  for (const publication of publications) publishActivity(publication);
  return receipt(supersessionId, false);
}
