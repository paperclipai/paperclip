import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, workspaceOperations, type Db,
} from "@paperclipai/db";
import {
  readRemoteWorkspaceAuthority, remoteWorkspaceSourceSchema,
  type RemoteWorkspaceAuthority, type RemoteWorkspaceRunReference, type RemoteWorkspaceSource,
  type EnvironmentLease,
} from "@paperclipai/shared";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getStorageService, type StorageService } from "../storage/index.js";
import { loadConfig } from "../config.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { notifyCancelledWorkspacePreservation } from "./cancelled-workspace-preservation-notifications.js";
import { assertExecutionWorkspaceRecordAccess, assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { persistActivity } from "./activity-log.js";
import {
  captureRemoteWorkspaceArchive, cleanupRemoteWorkspaceArchive, prepareRemoteWorkspaceDirectory, prepareRemoteRepository, remoteWorkspaceRepositoryPath,
  requireRemoteWorkspaceTarget, restoreRemoteWorkspaceDirectory,
} from "./remote-workspace-transport.js";
import {
  beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot,
} from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";
import { notifyTerminalWorkspaceWork } from "./terminal-workspace-work.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";

export { readRemoteWorkspaceAuthority, type RemoteWorkspaceAuthority, type RemoteWorkspaceSource } from "@paperclipai/shared";
export { remoteWorkspaceRepositoryPath } from "./remote-workspace-transport.js";
export { clearRemoteWorkspaceLocationForReleasedLease } from "./remote-workspace-snapshot-retention.js";
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "metadata" | "sourceIssueId" | "projectId" | "projectWorkspaceId">;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const SAVE_WORK_SCHEMA = "paperclip.remote-workspace-save-work.v1";
const RETIRED_SAVE_SCHEMA = "paperclip.remote-workspace-retired-save.v1";
type SaveWork = { schema: typeof SAVE_WORK_SCHEMA; activeIds: string[]; unknown: boolean; quiescedAt: string | null };
function readSaveWork(metadata: Record<string, unknown> | null | undefined): SaveWork | null {
  const work = object(metadata?.saveWork);
  return work.schema === SAVE_WORK_SCHEMA && Array.isArray(work.activeIds)
    && work.activeIds.every(id => typeof id === "string") && new Set(work.activeIds).size === work.activeIds.length
    && typeof work.unknown === "boolean" && (work.quiescedAt === null
      || typeof work.quiescedAt === "string" && Number.isFinite(Date.parse(work.quiescedAt)))
    ? work as SaveWork : null;
}
function sameExportLocation(value: unknown, location: NonNullable<RemoteWorkspaceAuthority["location"]>) {
  const recorded = object(value);
  return (["environmentId", "leaseId", "providerLeaseId", "remoteCwd"] as const).every(key => recorded[key] === location[key]);
}

export function shouldUseRemoteWorkspaces(input: {
  adapterType: string; environmentDriver: string | null; experimentalEnabled: boolean; existingWorkspace?: { metadata?: Record<string, unknown> | null } | null;
}) {
  const enrolled = readRemoteWorkspaceAuthority(input.existingWorkspace?.metadata) !== null;
  if (enrolled && (input.adapterType !== "paperclip_runner" || input.environmentDriver !== "sandbox")) {
    throw conflict("This workspace requires its native sandbox execution environment.", { code: "remote_workspace_execution_required" });
  }
  if (enrolled) return true;
  // Existing host authority changes only through the explicit import workflow.
  if (input.existingWorkspace || !input.experimentalEnabled || input.adapterType !== "paperclip_runner"
    || input.environmentDriver !== "sandbox") return false;
  return configuredRemoteWorkspacePersistence() !== null;
}

/** Deployment profile admission belongs beside workspace authority. A warm
 * remote controller may replace its local projection; host-owned execution
 * cannot make that promise. External conversation providers own no task disk. */
export function assertEphemeralWorkspaceExecution(input: {
  externalConversation: boolean; adapterType: string;
  pluginTaskWorkspace: boolean; remoteAuthority: boolean;
}) {
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER !== "true" || input.externalConversation) return;
  // Runtime selection has not promoted a fresh run yet. Validate storage here;
  // the runtime selector separately admits only its resolved warm native policy.
  if (input.adapterType !== "paperclip_runner"
    || (!input.pluginTaskWorkspace && !input.remoteAuthority)) {
    throw unprocessable("Volume-free servers require warm Paperclip Runner execution with remote workspace storage.",
      { code: "ephemeral_execution_configuration_required" });
  }
}

/** The runtime selector calls this after environment, credentials and saved
 * execution policy have resolved. Raw agent settings are not lifecycle authority. */
export function assertEphemeralNativeLifecycle(mode: "warm" | "per_turn" | undefined) {
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER === "true" && mode !== "warm") {
    throw unprocessable("Volume-free servers require warm Paperclip Runner execution with remote workspace storage.",
      { code: "ephemeral_execution_configuration_required" });
  }
}

function configuredRemoteWorkspacePersistence(storage?: StorageService) {
  const config = loadConfig();
  const databaseUrl = config.databaseUrl?.trim();
  const keyFilePath = process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim() ? null : config.secretsMasterKeyFilePath;
  if ((storage?.provider ?? config.storageProvider) !== "s3" || !databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)
    || (keyFilePath !== null && !existsSync(keyFilePath))) {
    return null;
  }
  return { databaseUrl, keyFilePath };
}

export function assertRemoteWorkspacePersistence(storage: StorageService = getStorageService()) {
  const persistence = configuredRemoteWorkspacePersistence(storage);
  if (!persistence) throw conflict("Remote workspace storage requires external Postgres, object storage, and a stable configured encryption key.",
    { code: "remote_workspace_persistence_unavailable" });
  return persistence;
}

function reference(workspaceId: string, authority: RemoteWorkspaceAuthority, state: "prepared" | "saved"): RemoteWorkspaceRunReference {
  if (!authority.location) throw new Error("remote_workspace_location_missing");
  return { schema: "paperclip.remote-workspace-run.v1", workspaceId, epoch: authority.epoch,
    leaseId: authority.location.leaseId, providerLeaseId: authority.location.providerLeaseId,
    remoteCwd: authority.location.remoteCwd, state, snapshotId: authority.snapshotId };
}

async function currentWorkspace(tx: Transaction, companyId: string, workspaceId: string) {
  const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId),
    eq(executionWorkspaces.companyId, companyId))).for("update");
  if (!workspace) throw new Error("remote_workspace_missing");
  return workspace;
}

export async function reserveRemoteWorkspace(input: {
  db: Db; companyId: string; issueId: string; runId: string; agentId: string; environmentId: string;
  projectId: string | null; projectWorkspaceId: string | null; existingWorkspaceId: string | null;
  source: RemoteWorkspaceSource; storage?: StorageService;
  mode?: string;
  fresh?: { attemptId: string; previousWorkspaceId: string | null; expectedBindingRevision: number };
  recoverySourceRunIds?: string[];
}) {
  assertRemoteWorkspacePersistence(input.storage ?? getStorageService());
  const source = remoteWorkspaceSourceSchema.parse(input.source);
  return input.db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    if (!issue || !run || run.agentId !== input.agentId || run.status !== "running" ||
      ![run.nativeIssueId, run.issueId, object(run.contextSnapshot).issueId].includes(input.issueId)) throw forbidden("Workspace preparation requires its current task execution.");
    if (input.fresh && (issue.executionWorkspaceId !== input.fresh.previousWorkspaceId
      || issue.workspaceBindingRevision !== input.fresh.expectedBindingRevision)) throw conflict("The task workspace selection changed.");
    let selected = input.fresh ? input.fresh.attemptId : input.existingWorkspaceId ?? issue.executionWorkspaceId;
    let selectedSharedSource = false;
    if (!selected && input.mode === "shared_workspace" && input.projectWorkspaceId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`remote-shared-workspace:${input.companyId}:${input.projectWorkspaceId}`}, 0))`);
      const [shared] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.projectWorkspaceId, input.projectWorkspaceId),
        eq(executionWorkspaces.mode, "shared_workspace"), eq(executionWorkspaces.status, "active"),
        sql`${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema' = 'paperclip.remote-workspace.v1'`,
      )).limit(1);
      selected = shared?.id ?? null;
      selectedSharedSource = selected !== null;
    }
    const [selectedRow] = selected ? await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, selected))).for("update") : [];
    const existing = selectedRow ?? null;
    if (selected && !existing && !input.fresh) throw new Error("remote_workspace_missing");
    const authority = readRemoteWorkspaceAuthority(existing?.metadata);
    if (existing && !authority) throw conflict("Import this existing workspace before enabling remote storage.", { code: "remote_workspace_migration_required" });
    if (existing && authority) {
      if ((existing.sourceIssueId !== input.issueId && existing.mode !== "shared_workspace") || ["archived", "cleanup_failed"].includes(existing.status)) throw conflict("Workspace ownership changed.");
      if (existing.sourceIssueId !== input.issueId) {
        const actor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
          agentId: input.agentId, runId: input.runId,
          onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId } as const;
        await assertTaskWorkspaceExecutionAccess(tx, actor, input.companyId, selectedSharedSource
          ? { issueId: input.issueId, projectWorkspaceId: input.projectWorkspaceId }
          : { issueId: input.issueId, workspaceId: existing.id });
        await assertExecutionWorkspaceRecordAccess(tx, actor, input.companyId, existing.id);
      }
      const [uncertain] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, existing.id),
        eq(workspaceOperations.phase, "remote_workspace_provision"), sql`${workspaceOperations.metadata}->>'uncertain' = 'true'`,
        sql`${workspaceOperations.heartbeatRunId} is distinct from ${input.runId}::uuid`,
      )).limit(1);
      if (uncertain) throw conflict("The prior provisioning operation needs verification before this workspace can run again.", { code: "remote_workspace_provision_unverified" });
      if (authority.writerRunId && authority.writerRunId !== input.runId) {
        const [prior] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, authority.writerRunId)));
        const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.heartbeatRunId, authority.writerRunId)));
        const unusedReservation = !authority.dirty && prior && ["failed", "cancelled", "interrupted", "timed_out", "succeeded"].includes(prior.status)
          && leases.every(hasRemoteTerminationReceipt);
        if (!unusedReservation) throw conflict("The workspace still has an unfinished writer or save operation.", { code: "remote_workspace_writer_pending" });
      }
      if (authority.writerRunId === input.runId) return existing;
      const next: RemoteWorkspaceAuthority = { ...authority, source, epoch: authority.epoch + 1, writerRunId: input.runId };
      const [saved] = await tx.update(executionWorkspaces).set({ metadata: { ...existing.metadata, remoteWorkspace: next }, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, existing.id)).returning();
      if (issue.executionWorkspaceId !== existing.id) await tx.update(issues).set({ executionWorkspaceId: existing.id,
        executionWorkspacePreference: "reuse_existing", workspaceBindingRevision: issue.workspaceBindingRevision + 1,
        updatedAt: new Date() }).where(eq(issues.id, issue.id));
      return saved!;
    }
    const id = input.fresh?.attemptId ?? randomUUID();
    const initial: RemoteWorkspaceAuthority = { schema: "paperclip.remote-workspace.v1", epoch: 1,
      snapshotId: null, source, location: null, writerRunId: input.runId, dirty: false };
    const [workspace] = await tx.insert(executionWorkspaces).values({ id, companyId: input.companyId, sourceIssueId: input.issueId,
      projectId: input.projectId, projectWorkspaceId: input.projectWorkspaceId, mode: input.mode ?? "isolated_workspace",
      strategyType: source.kind === "git" ? "git_worktree" : "project_primary", name: "Task workspace", status: "active",
      providerType: "cloud_sandbox", cwd: `/workspaces/${id}`, repoUrl: source.kind === "git" ? source.repoUrl : null,
      baseRef: source.kind === "git" ? source.ref : null, branchName: source.kind === "git" ? source.branchName ?? null : null,
      metadata: { remoteWorkspace: initial, ...(input.recoverySourceRunIds?.length
        ? { remoteWorkspaceRecoverySourceRunIds: input.recoverySourceRunIds } : {}) },
    }).returning();
    await tx.update(issues).set({ executionWorkspaceId: id, executionWorkspacePreference: "reuse_existing",
      workspaceBindingRevision: issue.workspaceBindingRevision + 1, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "remote-workspaces",
      action: "workspace.remote_created", entityType: "execution_workspace", entityId: id, runId: input.runId,
      issueId: input.issueId, details: { authority: "sandbox", epoch: initial.epoch } });
    return workspace!;
  });
}

async function persistRunReference(tx: Transaction, companyId: string, runId: string, value: RemoteWorkspaceRunReference) {
  const [run] = await tx.select({ profile: heartbeatRuns.runnerProfileJson, nativeIssueId: heartbeatRuns.nativeIssueId,
    issueId: heartbeatRuns.issueId, contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update");
  if (!run) throw new Error("remote_workspace_run_missing");
  await notifyCancelledWorkspacePreservation(tx, { companyId, runId });
  await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...run.profile, remoteWorkspace: value }, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  return run.nativeIssueId ?? run.issueId ?? (typeof run.contextIssueId === "string" ? run.contextIssueId : null);
}

/** Retry acknowledged or explicitly retired exports, never active captures. */
async function cleanupSavedExports(input: { db: Db; companyId: string; workspaceId: string;
  location: NonNullable<RemoteWorkspaceAuthority["location"]>; target: ReturnType<typeof requireRemoteWorkspaceTarget>;
  assertOwned: () => Promise<void> }) {
  for (;;) {
    const rows = await input.db.select({ id: workspaceOperations.id, metadata: workspaceOperations.metadata,
      phase: workspaceOperations.phase }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, input.workspaceId),
      inArray(workspaceOperations.phase, ["remote_workspace_snapshot", "remote_workspace_restore"]),
      sql`(${workspaceOperations.status} = 'succeeded' or (${workspaceOperations.status} = 'failed'
        and ${workspaceOperations.metadata}->'retiredSave'->>'schema' = ${RETIRED_SAVE_SCHEMA}))`,
      sql`(${workspaceOperations.metadata}->'saveWork'->>'schema' is distinct from ${SAVE_WORK_SCHEMA}
        or (${workspaceOperations.metadata}#>'{saveWork,unknown}' = 'false'::jsonb and case when jsonb_typeof(${workspaceOperations.metadata}#>'{saveWork,activeIds}') = 'array'
          then jsonb_array_length(${workspaceOperations.metadata}#>'{saveWork,activeIds}') = 0 else false end))`,
      sql`${workspaceOperations.metadata}->'exportCleanup'->>'state' = 'pending'`,
      sql`${workspaceOperations.metadata}->'exportCleanup'->>'environmentId' = ${input.location.environmentId}`,
      sql`${workspaceOperations.metadata}->'exportCleanup'->>'providerLeaseId' = ${input.location.providerLeaseId}`,
      sql`${workspaceOperations.metadata}->'exportCleanup'->>'remoteCwd' = ${input.location.remoteCwd}`,
    )).limit(20);
    if (!rows.length) return true;
    for (const row of rows) {
      await input.assertOwned();
      let cleaned = false;
      try {
        await cleanupRemoteWorkspaceArchive({ target: input.target,
          remoteCwd: row.phase === "remote_workspace_restore" ? path.posix.dirname(input.location.remoteCwd) : input.location.remoteCwd,
          operationId: row.id });
        cleaned = true;
      } catch { /* Keep a durable retry obligation; the acknowledged snapshot is safe. */ }
      await input.assertOwned();
      await input.db.update(workspaceOperations).set({ metadata: sql`jsonb_set(coalesce(${workspaceOperations.metadata}, '{}'::jsonb),
        '{exportCleanup}', coalesce(${workspaceOperations.metadata}->'exportCleanup', '{}'::jsonb) ||
        ${JSON.stringify({ state: cleaned ? "cleaned" : "pending", lastError: cleaned ? null : "remote_workspace_export_cleanup_failed" })}::jsonb)`,
        updatedAt: new Date() })
        .where(and(eq(workspaceOperations.id, row.id), eq(workspaceOperations.companyId, input.companyId),
          inArray(workspaceOperations.status, ["succeeded", "failed"])));
      if (!cleaned) return false;
    }
  }
}

/** The caller retains execution admission and provider ownership; this owns file authority. */
function isSavedWorkspaceRepository(authority: RemoteWorkspaceAuthority,
  repository: NonNullable<RemoteWorkspaceSource["repositories"]>[number]) {
  return authority.snapshotId !== null && (authority.source.repositories ?? []).some(saved =>
    saved.id === repository.id && saved.relativePath === repository.relativePath && saved.repoUrl === repository.repoUrl
    && (saved.ref ?? "HEAD") === (repository.ref ?? "HEAD") && saved.pinnedCommit === repository.pinnedCommit
    && (saved.readOnly ?? false) === (repository.readOnly ?? false));
}

export async function prepareRemoteWorkspace(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  source?: RemoteWorkspaceSource; assertOwned?: () => Promise<void>;
  provisionCommand?: string | null; runtimeProvisionCommand?: string | null; storage?: StorageService;
}) {
  const target = requireRemoteWorkspaceTarget(input.target);
  const initial = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if ((input.source ?? initial?.source)?.repositories?.some(repository => repository.readOnly)) {
    throw conflict("The selected native sandbox cannot enforce read-only referenced project roots.",
      { code: "remote_workspace_readonly_sources_unsupported" });
  }
  if (!initial || initial.writerRunId !== input.runId || !input.lease.environmentId || !input.lease.providerLeaseId
    || input.lease.companyId !== input.workspace.companyId || input.lease.heartbeatRunId !== input.runId) throw new Error("remote_workspace_binding_mismatch");
  await input.assertOwned?.();
  const sameAllocation = initial.location?.providerLeaseId === input.lease.providerLeaseId
    && initial.location?.environmentId === input.lease.environmentId;
  if (initial.location && !sameAllocation && initial.dirty) throw conflict("The prior workspace has unsaved work; recover it before replacing its allocation.");
  const remoteRoot = sameAllocation ? initial.location!.remoteCwd : path.posix.join(target.remoteCwd, ".paperclip-workspaces", input.workspace.id);
  const preparationIdentity = createHash("sha256").update(JSON.stringify([input.workspace.companyId, input.workspace.id,
    input.runId, initial.epoch, input.lease.id, input.lease.providerLeaseId, remoteRoot, initial.source])).digest("hex");
  let restoredExport: Awaited<ReturnType<typeof restoreRemoteWorkspaceDirectory>> | null = null;
  if (sameAllocation && !await cleanupSavedExports({ db: input.db, companyId: input.workspace.companyId,
    workspaceId: input.workspace.id, location: initial.location!, target,
    assertOwned: input.assertOwned ?? (async () => undefined) })) throw new Error("remote_workspace_export_cleanup_pending");
  if (!sameAllocation) {
    if (initial.snapshotId) {
      const snapshot = await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id, snapshotId: initial.snapshotId });
      if (!snapshot) throw new Error("remote_workspace_snapshot_missing");
      const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-restore-"));
      try {
        const archivePath = path.join(scratch, "workspace.pcws");
        await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: snapshot, targetPath: archivePath });
        restoredExport = await restoreRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, archivePath, manifestDigest: snapshot.manifestDigest,
          restorationIdentity: preparationIdentity });
      } finally { await rm(scratch, { recursive: true, force: true }); }
    } else {
      await prepareRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, source: initial.source,
        preparationIdentity,
        resolveGitAuth: await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
    }
  }
  for (const repository of (input.source ?? initial.source).repositories ?? []) {
    await input.assertOwned?.();
    // Only repositories already owned by the saved authority may rely on the
    // archive when their old local origin was intentionally omitted. New source
    // descriptors still follow normal acquisition and origin verification.
    await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(remoteRoot, repository),
      repoUrl: repository.repoUrl, ref: repository.ref, pinnedCommit: repository.pinnedCommit,
      savedArchive: isSavedWorkspaceRepository(initial, repository),
      resolveGitAuth: await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
  }
  const recoveredFiles: Array<{ operationId: string; sourceRunId: string; path: string }> = [];
  const recoverySourceRunIds = input.workspace.metadata?.remoteWorkspaceRecoverySourceRunIds;
  if (!sameAllocation && Array.isArray(recoverySourceRunIds) && recoverySourceRunIds.length && input.workspace.sourceIssueId) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-recovery-import-"));
    try {
      const recovered = await attachPreservedWorkspaceSnapshots({ db: input.db, companyId: input.workspace.companyId,
        issueId: input.workspace.sourceIssueId, sourceRunIds: recoverySourceRunIds as string[], cwd: scratch });
      for (const item of recovered) {
        const relative = `.paperclip-recovered/${item.operationId}`;
        await target.runner!.syncIn!([{ operationId: randomUUID(), files: [{
          kind: "directory", sourcePath: item.path, targetPath: path.posix.join(remoteRoot, relative),
        }] }]);
        recoveredFiles.push({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: relative });
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  await input.assertOwned?.();
  const prepared = await input.db.transaction(async tx => {
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const current = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!current || current.epoch !== initial.epoch || current.writerRunId !== input.runId) throw new Error("remote_workspace_authority_changed");
    // The same run can retry with a different allocation and stale preparation
    // input. Its controller lease alone cannot replace already-published dirty files.
    if (current.dirty && current.location && (current.location.environmentId !== input.lease.environmentId
      || current.location.providerLeaseId !== input.lease.providerLeaseId || current.location.leaseId !== input.lease.id
      || current.location.remoteCwd !== remoteRoot)) throw new Error("remote_workspace_authority_changed");
    const authority: RemoteWorkspaceAuthority = { ...current, dirty: true, location: { environmentId: input.lease.environmentId!,
      leaseId: input.lease.id, providerLeaseId: input.lease.providerLeaseId!, remoteCwd: remoteRoot } };
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, input.lease.id),
      eq(environmentLeases.companyId, workspace.companyId))).for("update");
    if (!lease || lease.status !== "active" || lease.environmentId !== input.lease.environmentId
      || lease.providerLeaseId !== authority.location!.providerLeaseId || lease.heartbeatRunId !== input.runId
      || (lease.executionWorkspaceId && lease.executionWorkspaceId !== workspace.id)) throw new Error("remote_workspace_lease_changed");
    const [savedLease] = await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteCwd: remoteRoot, remoteWorkspaceId: workspace.id }, updatedAt: new Date() })
      .where(eq(environmentLeases.id, lease.id)).returning();
    const [savedWorkspace] = await tx.update(executionWorkspaces).set({ cwd: remoteRoot, providerRef: remoteRoot,
      metadata: { ...workspace.metadata, remoteWorkspace: authority,
        ...(recoveredFiles.length ? { remoteWorkspaceRecoveredFiles: recoveredFiles } : {}) }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id)).returning();
    const runReference = reference(workspace.id, authority, "prepared");
    const issueId = await persistRunReference(tx, workspace.companyId, input.runId, runReference);
    if (restoredExport) {
      const [existing] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, restoredExport.operationId)).for("update");
      if (existing && (existing.companyId !== workspace.companyId || existing.executionWorkspaceId !== workspace.id
        || existing.heartbeatRunId !== input.runId || existing.phase !== "remote_workspace_restore")) throw new Error("remote_workspace_restore_receipt_changed");
      const metadata = { epoch: authority.epoch, snapshotId: initial.snapshotId,
        exportCleanup: { ...authority.location, stagingRoot: restoredExport.stagingRoot,
          state: restoredExport.cleanupPending ? "pending" : "cleaned" } };
      if (existing) await tx.update(workspaceOperations).set({ status: "succeeded", metadata, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceOperations.id, existing.id));
      else await tx.insert(workspaceOperations).values({ id: restoredExport.operationId, companyId: workspace.companyId,
        executionWorkspaceId: workspace.id, heartbeatRunId: input.runId, issueId,
        phase: "remote_workspace_restore", status: "succeeded", metadata, finishedAt: new Date() });
    }
    return { workspace: savedWorkspace!, lease: savedLease! as EnvironmentLease, remoteRoot, reference: runReference };
  });
  target.remoteCwd = remoteRoot;
  if (restoredExport?.cleanupPending) await cleanupSavedExports({ db: input.db, companyId: input.workspace.companyId,
    workspaceId: input.workspace.id, location: readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.location!, target,
    assertOwned: input.assertOwned ?? (async () => undefined) });
  try {
    await provisionRemoteWorkspace({ db: input.db, companyId: input.workspace.companyId, workspaceId: input.workspace.id,
      runId: input.runId, epoch: initial.epoch, remoteCwd: remoteRoot, target, assertOwned: input.assertOwned,
      commands: [!initial.snapshotId ? input.provisionCommand : null, input.runtimeProvisionCommand] });
    if (!initial.snapshotId) {
      await saveRemoteWorkspace({ ...input, workspace: prepared.workspace, lease: prepared.lease, target,
        assertOwned: input.assertOwned ?? (async () => undefined), boundary: "initial" });
      const [workspace] = await input.db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspace.id), eq(executionWorkspaces.companyId, input.workspace.companyId)));
      prepared.workspace = workspace!;
      prepared.reference = reference(workspace!.id, readRemoteWorkspaceAuthority(workspace!.metadata)!, "prepared");
    }
  } catch (error) {
    // A first save can fail before runtime selection. Its already-published
    // authority is still a file obligation, independent of native admission.
    await preserveRemoteWorkspacePreparationFailure(input.db, prepared.lease, { assertOwned: input.assertOwned })
      .catch(preservationError => logger.error({ err: preservationError, runId: input.runId }, "Remote workspace preparation recovery was deferred; source remains protected"));
    throw error;
  }
  return prepared;
}

/** The workspace lock fences new invocations while completed final authority
 * retires only attempts whose every registered invocation has settled. */
async function retireQuiescedSaves(tx: Transaction, workspace: Workspace, runId: string, epoch: number,
  location: NonNullable<RemoteWorkspaceAuthority["location"]>) {
  const authority = readRemoteWorkspaceAuthority(workspace.metadata);
  if (!authority || authority.epoch !== epoch || authority.dirty || authority.writerRunId !== null
    || !authority.snapshotId || !sameExportLocation(authority.location, location)) return;
  const [final] = await tx.select({ id: executionWorkspaceSnapshots.id, generation: executionWorkspaceSnapshots.generation,
    operationId: workspaceOperations.id, metadata: workspaceOperations.metadata }).from(executionWorkspaceSnapshots)
    .innerJoin(workspaceOperations, and(eq(workspaceOperations.id, executionWorkspaceSnapshots.sourceOperationId),
      eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
      eq(workspaceOperations.heartbeatRunId, runId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
      eq(workspaceOperations.status, "succeeded"), sql`${workspaceOperations.metadata}->>'boundary' = 'final'`,
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(epoch)}`))
    .where(and(eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
      eq(executionWorkspaceSnapshots.id, authority.snapshotId), eq(executionWorkspaceSnapshots.sourceRunId, runId),
      eq(executionWorkspaceSnapshots.epoch, epoch), eq(executionWorkspaceSnapshots.status, "committed"))).limit(1);
  if (!final || final.metadata?.snapshotId !== final.id || !sameExportLocation(final.metadata?.exportCleanup, location)) return;
  const candidates = await tx.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.heartbeatRunId, runId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
    inArray(workspaceOperations.status, ["running", "pending"]), sql`${workspaceOperations.metadata}->>'epoch' = ${String(epoch)}`)).for("update");
  for (const candidate of candidates) {
    const work = readSaveWork(candidate.metadata), generation = Number(candidate.metadata?.generation);
    if (!work || work.unknown || work.activeIds.length || !work.quiescedAt || candidate.metadata?.boundary === "final"
      || !Number.isSafeInteger(generation) || generation >= final.generation
      || !sameExportLocation(candidate.metadata?.exportCleanup, location)) continue;
    const [snapshot] = await tx.select({ status: executionWorkspaceSnapshots.status, generation: executionWorkspaceSnapshots.generation,
      epoch: executionWorkspaceSnapshots.epoch, runId: executionWorkspaceSnapshots.sourceRunId }).from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
      eq(executionWorkspaceSnapshots.sourceOperationId, candidate.id))).for("update");
    if (snapshot && (!["pending", "uploaded"].includes(snapshot.status) || snapshot.generation !== generation
      || snapshot.epoch !== epoch || snapshot.runId !== runId)) continue;
    const at = new Date();
    await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
    await tx.update(workspaceOperations).set({ status: "failed", finishedAt: at, updatedAt: at,
      metadata: { ...candidate.metadata, retiredSave: { schema: RETIRED_SAVE_SCHEMA, snapshotId: final.id,
        operationId: final.operationId, retiredAt: at.toISOString() } } }).where(eq(workspaceOperations.id, candidate.id));
  }
}

async function settleSaveInvocation(input: { db: Db; workspace: Workspace; runId: string; epoch: number;
  location: NonNullable<RemoteWorkspaceAuthority["location"]>; operationId: string; invocationId: string }) {
  return input.db.transaction(async tx => {
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, input.operationId),
      eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
      eq(workspaceOperations.heartbeatRunId, input.runId), sql`${workspaceOperations.metadata}->>'epoch' = ${String(input.epoch)}`)).for("update");
    const work = readSaveWork(operation?.metadata);
    if (!operation || !work || !work.activeIds.includes(input.invocationId)) return false;
    const activeIds = work.activeIds.filter(id => id !== input.invocationId);
    if (!activeIds.length && !work.unknown) await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
    await tx.update(workspaceOperations).set({ metadata: { ...operation.metadata,
      saveWork: { ...work, activeIds, quiescedAt: activeIds.length ? null : new Date().toISOString() } }, updatedAt: new Date() })
      .where(eq(workspaceOperations.id, operation.id));
    await retireQuiescedSaves(tx, workspace, input.runId, input.epoch, input.location);
    return true;
  });
}

export async function saveRemoteWorkspace(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  assertOwned: () => Promise<void>; storage?: StorageService; boundary?: string;
}) {
  const target = requireRemoteWorkspaceTarget(input.target), boundary = input.boundary ?? "final";
  const expected = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!expected?.location || expected.location.providerLeaseId !== input.lease.providerLeaseId || expected.location.leaseId !== input.lease.id) throw new Error("remote_workspace_save_binding_mismatch");
  await input.assertOwned();
  const invocationId = randomUUID();
  const operation = await input.db.transaction(async tx => {
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const current = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!current || current.epoch !== expected.epoch || (current.writerRunId !== input.runId && current.dirty)) throw new Error("remote_workspace_authority_changed");
    const [previous] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
      eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), sql`${workspaceOperations.metadata}->>'boundary' = ${boundary}`,
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(current.epoch)}`)).limit(1).for("update");
    if (previous) {
      if (object(previous.metadata?.retiredSave).schema === RETIRED_SAVE_SCHEMA) throw new Error("remote_workspace_snapshot_retired");
      const work = readSaveWork(previous.metadata);
      const [registered] = await tx.update(workspaceOperations).set({ metadata: { ...previous.metadata,
        saveWork: { schema: SAVE_WORK_SCHEMA, activeIds: [...(work?.activeIds ?? []), invocationId],
          unknown: work?.unknown ?? true, quiescedAt: null } }, updatedAt: new Date() }).where(eq(workspaceOperations.id, previous.id)).returning();
      return registered!;
    }
    const [run] = await tx.select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, input.runId)));
    if (!run) throw new Error("remote_workspace_run_missing");
    const issueId = run.nativeIssueId ?? run.issueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
    // The workspace lock serializes generation reservations. Failed/deleted
    // snapshots still own their generation, and an operation can be committed
    // before beginWorkspaceSnapshot creates its ledger row. Count both journals
    // across epochs while retaining the last committed snapshot as the parent.
    const [reservation] = await tx.execute(sql`select greatest(
      coalesce((select max(${executionWorkspaceSnapshots.generation}) from ${executionWorkspaceSnapshots}
        where ${executionWorkspaceSnapshots.companyId} = ${workspace.companyId}
          and ${executionWorkspaceSnapshots.executionWorkspaceId} = ${workspace.id}), 0),
      coalesce((select max(case when ${workspaceOperations.metadata}->>'generation' ~ '^[0-9]+$'
        then (${workspaceOperations.metadata}->>'generation')::numeric else 0 end) from ${workspaceOperations}
        where ${workspaceOperations.companyId} = ${workspace.companyId}
          and ${workspaceOperations.executionWorkspaceId} = ${workspace.id}
          and ${workspaceOperations.phase} = 'remote_workspace_snapshot'), 0)
    ) as generation`);
    const generation = Number(reservation?.generation) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("remote_workspace_snapshot_generation_invalid");
    const [created] = await tx.insert(workspaceOperations).values({ companyId: workspace.companyId, executionWorkspaceId: workspace.id,
      heartbeatRunId: input.runId, issueId, phase: "remote_workspace_snapshot", status: "running",
      metadata: { boundary, epoch: current.epoch, parentSnapshotId: current.snapshotId, generation,
        saveWork: { schema: SAVE_WORK_SCHEMA, activeIds: [invocationId], unknown: false, quiescedAt: null },
        exportCleanup: { ...current.location, state: "pending" } },
    }).returning();
    return created!;
  });
  let captured: Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>> | null = null;
  try {
    const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id,
      operationId: operation.id, runId: input.runId, parentSnapshotId: operation.metadata?.parentSnapshotId as string | null,
      generation: operation.metadata?.generation as number, epoch: expected.epoch });
    if (operation.status === "succeeded" && ["committed", "superseded"].includes(snapshot.status)) {
      return { snapshotId: snapshot.id, generation: snapshot.generation, sha256: snapshot.sha256!, savedAt: snapshot.updatedAt.toISOString() };
    }
    const existingUpload = snapshot.status === "uploaded" ? await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId,
      workspaceId: input.workspace.id, snapshotId: snapshot.id }) : null;
    captured = existingUpload ? null : await captureRemoteWorkspaceArchive({ target, remoteCwd: expected.location.remoteCwd, operationId: operation.id });
    await input.assertOwned();
    const saved = await uploadWorkspaceSnapshot({ db: input.db, storage: input.storage ?? getStorageService(), snapshotId: snapshot.id,
      companyId: input.workspace.companyId, workspaceId: input.workspace.id, archivePath: captured?.archivePath ?? "",
      manifestDigest: existingUpload?.manifestDigest ?? captured!.manifestDigest });
    await input.assertOwned();
    const at = new Date();
    await input.db.transaction(async tx => {
      const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
      const current = readRemoteWorkspaceAuthority(workspace.metadata);
      if (!current || current.epoch !== expected.epoch || current.writerRunId !== input.runId || current.snapshotId !== snapshot.parentSnapshotId) {
        if (current?.epoch === expected.epoch && current.snapshotId === saved.id) return;
        throw new Error("remote_workspace_publication_fenced");
      }
      const authority: RemoteWorkspaceAuthority = { ...current, snapshotId: saved.id,
        dirty: boundary !== "final", writerRunId: boundary !== "final" ? input.runId : null };
      const [committed] = await tx.update(executionWorkspaceSnapshots).set({ status: "committed", updatedAt: at }).where(and(
        eq(executionWorkspaceSnapshots.id, saved.id), eq(executionWorkspaceSnapshots.companyId, workspace.companyId),
        eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id), eq(executionWorkspaceSnapshots.status, "uploaded"))).returning({ id: executionWorkspaceSnapshots.id });
      if (!committed) throw new Error("remote_workspace_snapshot_publication_changed");
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
      if (boundary === "final") await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: authority }, updatedAt: at }).where(eq(executionWorkspaces.id, workspace.id));
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: at, updatedAt: at,
        metadata: sql`coalesce(${workspaceOperations.metadata}, '{}'::jsonb) || ${JSON.stringify({ snapshotId: saved.id, sha256: saved.sha256 })}::jsonb` })
        .where(eq(workspaceOperations.id, operation.id));
      await persistRunReference(tx, workspace.companyId, input.runId, reference(workspace.id, authority, boundary === "final" ? "saved" : "prepared"));
      await persistActivity(tx as unknown as Db, { companyId: workspace.companyId, actorType: "system", actorId: "remote-workspaces",
        action: "workspace.snapshot_saved", entityType: "execution_workspace", entityId: workspace.id, runId: input.runId,
        details: { snapshotId: saved.id, generation: saved.generation, epoch: current.epoch, boundary } });
      if (snapshot.parentSnapshotId) await tx.update(executionWorkspaceSnapshots).set({ status: "superseded",
        deleteAfter: new Date(at.getTime() + 7 * 86400_000), updatedAt: at }).where(and(eq(executionWorkspaceSnapshots.id, snapshot.parentSnapshotId),
        eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id)));
    });
    return { snapshotId: saved.id, generation: saved.generation, sha256: saved.sha256, savedAt: at.toISOString() };
  } finally {
    // Every upload/capture promise has settled before its durable token clears.
    // Missing completion evidence remains pinned; cleanup never masks the save error.
    try { await captured?.cleanup(); }
    catch { logger.warn({ runId: input.runId, operationId: operation.id }, "Remote workspace local archive cleanup failed"); }
    try {
      if (await settleSaveInvocation({ db: input.db, workspace: input.workspace, runId: input.runId, epoch: expected.epoch,
        location: expected.location, operationId: operation.id, invocationId })) {
        await cleanupSavedExports({ db: input.db, companyId: input.workspace.companyId, workspaceId: input.workspace.id,
          location: expected.location, target, assertOwned: input.assertOwned });
      }
    } catch { logger.warn({ runId: input.runId, operationId: operation.id }, "Remote workspace save settlement or export cleanup remains pending"); }
  }
}

export async function prepareRemoteWorkspaceRepository(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  repository: { id: string; relativePath: string; repoUrl: string; ref: string | null; pinnedCommit?: string; readOnly?: boolean };
  assertOwned?: () => Promise<void>; resolveGitAuth?: ReturnType<typeof createGitRemoteAuthProvider>; verifyOnly?: boolean; storage?: StorageService;
}) {
  const authority = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!authority?.location || authority.writerRunId !== input.runId || authority.location.leaseId !== input.lease.id
    || authority.location.providerLeaseId !== input.lease.providerLeaseId) throw new Error("remote_workspace_repository_binding_mismatch");
  await input.assertOwned?.();
  const target = requireRemoteWorkspaceTarget(input.target);
  const result = await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(authority.location.remoteCwd, input.repository),
    ...input.repository, verifyOnly: input.verifyOnly, savedArchive: isSavedWorkspaceRepository(authority, input.repository),
    resolveGitAuth: input.resolveGitAuth ?? await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
  await input.assertOwned?.();
  await saveRemoteWorkspace({ ...input, target, boundary: `repository:${input.repository.id}:${result.pinnedCommit}`,
    assertOwned: input.assertOwned ?? (async () => undefined) });
  return result;
}

type SavedWorkspaceFileLimits = {
  maxOpen: number; maxArchiveBytes: number; maxScratchBytes: number; maxEntries: number; maxManifestBytes: number; freeSpaceMarginBytes: number;
};
const SAVED_WORKSPACE_FILE_LIMITS: SavedWorkspaceFileLimits = {
  maxOpen: 2, maxArchiveBytes: 512 * 1024 * 1024, maxScratchBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 10_000, maxManifestBytes: 4 * 1024 * 1024, freeSpaceMarginBytes: 256 * 1024 * 1024,
};
let savedWorkspaceFileOpen = 0, savedWorkspaceFileReservedBytes = 0;

export function createSavedWorkspaceLoader(db: Db, storage: StorageService = getStorageService(), options: {
  limits?: Partial<SavedWorkspaceFileLimits>; availableBytes?: () => Promise<bigint>;
} = {}) {
  const limits = { ...SAVED_WORKSPACE_FILE_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as Array<keyof SavedWorkspaceFileLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === "freeSpaceMarginBytes" ? 0 : 1)
      || limits[key] > SAVED_WORKSPACE_FILE_LIMITS[key]) throw new Error("invalid_saved_workspace_file_limits");
  }
  const availableBytes = options.availableBytes ?? (async () => {
    const disk = await statfs(os.tmpdir(), { bigint: true });
    return disk.bavail * disk.bsize;
  });
  return async (input: { companyId: string; workspaceId: string; snapshotId: string; signal?: AbortSignal }) => {
    input.signal?.throwIfAborted();
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, input.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspaceId), eq(executionWorkspaceSnapshots.id, input.snapshotId),
      eq(executionWorkspaceSnapshots.status, "committed")));
    const saved = row ? await getWorkspaceSnapshot(db, input) : null;
    input.signal?.throwIfAborted();
    if (!saved) throw new Error("remote_workspace_snapshot_unavailable");
    if (saved.byteSize > limits.maxArchiveBytes) throw unprocessable("Saved workspace is too large for Files", { code: "too_large" });
    // Decryption can hold ciphertext, plaintext, and its atomic publication at
    // once. Bound filesystem allocation overhead even for many tiny entries.
    const reservation = 3 * saved.byteSize + limits.maxEntries * 16 * 1024;
    if (savedWorkspaceFileOpen >= limits.maxOpen || reservation > limits.maxScratchBytes - savedWorkspaceFileReservedBytes) {
      throw unprocessable("Saved workspace file extraction capacity is unavailable", { code: "workspace_unavailable" });
    }
    savedWorkspaceFileOpen++; savedWorkspaceFileReservedBytes += reservation;
    let scratch: string | undefined, released = false, cleaning: Promise<void> | undefined;
    // Source modes stay intact while reading. Cleanup changes only private directories and skips symlinks.
    const cleanup = async () => {
      if (released) return;
      if (!cleaning) cleaning = (async () => {
        if (scratch) await removeTaskDirectoryTree(scratch);
        released = true; savedWorkspaceFileOpen--; savedWorkspaceFileReservedBytes -= reservation;
      })();
      try { await cleaning; } catch (error) { cleaning = undefined; throw error; }
    };
    try {
      // Existing reservations may not have written their bytes yet. Keep them
      // deducted from free space until their owned directories are removed.
      if (await availableBytes() < BigInt(savedWorkspaceFileReservedBytes + limits.freeSpaceMarginBytes)) {
        throw unprocessable("Insufficient temporary disk space for saved workspace Files", { code: "workspace_unavailable" });
      }
      input.signal?.throwIfAborted();
      scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-files-"));
      const archive = path.join(scratch, "archive.pcws"), root = path.join(scratch, "files");
      await loadWorkspaceSnapshotArchive({ storage, reference: saved, targetPath: archive, signal: input.signal, temporaryParent: scratch });
      await restoreRemoteWorkspaceArchive({ archivePath: archive, targetDir: root, expectedManifestDigest: saved.manifestDigest,
        signal: input.signal, maxEntries: limits.maxEntries, maxManifestBytes: limits.maxManifestBytes });
      return { root, savedAt: row!.updatedAt.toISOString(), cleanup };
    } catch (error) {
      try { await cleanup(); } catch {
        logger.warn({ workspaceId: input.workspaceId }, "Failed to remove saved workspace extraction; capacity remains reserved");
      }
      if (error instanceof Error && ["remote_workspace_archive_entry_limit", "remote_workspace_archive_manifest_too_large"].includes(error.message)) {
        throw unprocessable("Saved workspace manifest exceeds Files extraction limits", { code: "too_large" });
      }
      throw error;
    }
  };
}

/** Bind credentials to the current run's identity, including shared workspace users. */
export async function createRemoteWorkspaceGitAuth(db: Db, companyId: string, runId: string,
  create: typeof createGitRemoteAuthProvider = createGitRemoteAuthProvider) {
  const [run] = await db.select({ agentId: heartbeatRuns.agentId, responsibleUserId: heartbeatRuns.responsibleUserId,
    nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
    contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  const issueId = run?.nativeIssueId ?? run?.issueId ?? run?.contextIssueId;
  if (!run || run.status !== "running" || typeof issueId !== "string"
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(issueId)) throw new Error("remote_workspace_git_run_unavailable");
  return create(db, companyId, { issueId, heartbeatRunId: runId, agentId: run.agentId,
    responsibleUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId });
}

/** Arbitrary provisioning commands cannot be replayed after an ambiguous reply. */
export async function provisionRemoteWorkspace(input: {
  db: Db; companyId: string; workspaceId: string; runId: string; epoch: number;
  remoteCwd: string; target: ReturnType<typeof requireRemoteWorkspaceTarget>; commands: Array<string | null | undefined>;
  assertOwned?: () => Promise<void>;
}) {
  for (const [index, command] of input.commands.entries()) {
    if (!command?.trim()) continue;
    await input.assertOwned?.();
    const digest = createHash("sha256").update(command).digest("hex");
    const operation = await input.db.transaction(async tx => {
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
      const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
      if (!authority || authority.epoch !== input.epoch || authority.writerRunId !== input.runId || run?.status !== "running") throw new Error("remote_workspace_provision_fenced");
      const [existing] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
        eq(workspaceOperations.executionWorkspaceId, input.workspaceId), eq(workspaceOperations.heartbeatRunId, input.runId),
        eq(workspaceOperations.phase, "remote_workspace_provision"), sql`${workspaceOperations.metadata}->>'index' = ${String(index)}`,
        sql`${workspaceOperations.metadata}->>'epoch' = ${String(input.epoch)}`)).limit(1);
      if (existing) {
        if (existing.metadata?.commandSha256 !== digest || existing.status !== "succeeded") throw new Error("remote_workspace_provision_unverified");
        return null;
      }
      const [created] = await tx.insert(workspaceOperations).values({ companyId: input.companyId, executionWorkspaceId: input.workspaceId,
        heartbeatRunId: input.runId, issueId: workspace!.sourceIssueId, phase: "remote_workspace_provision", status: "running",
        metadata: { epoch: input.epoch, index, commandSha256: digest, uncertain: true } }).returning();
      return created!;
    });
    if (!operation) continue;
    await input.assertOwned?.();
    const result = await input.target.runner!.execute({ command: "bash", args: ["-lc", command], cwd: input.remoteCwd,
      timeoutMs: 300_000, bypassSession: true });
    if (result.exitCode !== 0 || result.timedOut) throw new Error("remote_workspace_provision_unverified");
    await input.assertOwned?.();
    await input.db.transaction(async tx => {
      const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
      if (authority?.epoch !== input.epoch || authority.writerRunId !== input.runId) throw new Error("remote_workspace_provision_fenced");
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
        metadata: { ...operation.metadata, uncertain: false } }).where(eq(workspaceOperations.id, operation.id));
    });
  }
}
