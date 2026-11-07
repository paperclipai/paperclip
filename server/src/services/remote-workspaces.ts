import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { workspaceAllocationFiles } from "./remote-workspace-allocation.js";
import { readNativeWorkspaceMigration } from "./native-runtime/native-workspace-migration.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companies, environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, workspaceOperations, type Db,
} from "@paperclipai/db";
import {
  readRemoteWorkspaceAuthority, remoteWorkspaceSourceSchema,
  type RemoteWorkspaceAuthority, type RemoteWorkspaceRunReference, type RemoteWorkspaceSource,
  type EnvironmentLease,
} from "@paperclipai/shared";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getStorageService, type StorageService } from "../storage/index.js";
import { loadConfig } from "../config.js";
import { conflict, forbidden, HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { notifyCancelledWorkspacePreservation } from "./cancelled-workspace-preservation-notifications.js";
import { assertExecutionWorkspaceRecordAccess, assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { readRemoteWorkspaceWriterHold, type RemoteWorkspaceWriter } from "./remote-workspace-writer-hold.js";
import { persistActivity } from "./activity-log.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import {
  captureRemoteWorkspaceArchive, cleanupRemoteWorkspaceArchive, prepareRemoteWorkspaceDirectory, prepareRemoteRepository, remoteWorkspaceRepositoryPath,
  RemoteWorkspaceOperationTimeoutError, RemoteWorkspacePreparationTimeoutError, remoteWorkspaceFailureCause, hasRemoteRecoveryAttachment,
  requireRemoteWorkspaceTarget, restoreRemoteWorkspaceDirectory, RemoteWorkspaceRestoreError, type RemoteWorkspaceRestoreStep,
  type RemoteWorkspaceSavePhaseTiming,
} from "./remote-workspace-transport.js";
import {
  beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot,
} from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive, readRemoteWorkspaceArchiveDirectories } from "./remote-workspace-snapshot-archive.js";
import { removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";
import { attachPreservedRemoteWorkspaceSnapshots, retainRemoteRecoveryAttachments } from "./remote-workspace-recovery-attachments.js";
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
const SAVE_TIMING_SCHEMA = "paperclip.remote-workspace-save-timing.v1";

/** Per-phase durations of the latest settled save invocation, kept in the operation's local metadata. */
type RemoteWorkspaceSaveTiming = RemoteWorkspaceSavePhaseTiming & {
  /** Encrypt, hash, and store the archive (zero work when a prior upload is reused). */
  uploadMs?: number;
  /** Read the archive manifest and commit the saved authority. */
  publishMs?: number;
  reusedUpload?: boolean;
};
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

export function assertEphemeralWorkspaceExecution(input: {
  externalConversation: boolean; adapterType: string;
  pluginTaskWorkspace: boolean; remoteAuthority: boolean;
}) {
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER !== "true" || input.externalConversation) return;
  // Runtime selection has not promoted a fresh run yet. Validate storage here;
  if (input.adapterType !== "paperclip_runner"
    || (!input.pluginTaskWorkspace && !input.remoteAuthority)) {
    throw unprocessable("Volume-free servers require native Paperclip Runner execution with remote workspace storage.",
      { code: "ephemeral_execution_configuration_required" });
  }
}

export function assertEphemeralNativeRuntime(native: boolean) {
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER === "true" && !native) {
    throw unprocessable("Volume-free servers require native Paperclip Runner execution with remote workspace storage.",
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

async function lockWorkspaceRunParents(tx: Transaction, companyId: string, runId: string, expectedIssueId?: string | null) {
  const fields = { nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
    contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'` };
  const [selected] = await tx.select(fields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  if (!selected) throw new Error("remote_workspace_run_missing");
  const issueId = selected.nativeIssueId ?? selected.issueId ?? (typeof selected.contextIssueId === "string" ? selected.contextIssueId : null);
  if (expectedIssueId !== undefined && issueId !== expectedIssueId) throw new Error("remote_workspace_run_binding_changed");
  const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share");
  if (!company) throw new Error("remote_workspace_run_missing");
  if (issueId) {
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
    if (!issue) throw new Error("remote_workspace_run_binding_changed");
  }
  const [current] = await tx.select(fields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update");
  const currentIssueId = current?.nativeIssueId ?? current?.issueId ?? (typeof current?.contextIssueId === "string" ? current.contextIssueId : null);
  if (!current || currentIssueId !== issueId) throw new Error("remote_workspace_run_binding_changed");
  return issueId;
}

export class RemoteWorkspaceWriterActiveError extends HttpError {
  constructor(
    readonly workspaceId: string,
    readonly writer: RemoteWorkspaceWriter,
  ) {
    super(409, "The workspace still has an unfinished writer or save operation.", { code: "remote_workspace_writer_pending" });
  }
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
  // Provisioning rows proven settled commit even when a later reservation
  // check (such as a live writer hold) rejects this attempt.
  const provenProvisions: string[] = [];
  return input.db.transaction(async tx => {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for("key share");
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
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
      if (["archived", "cleanup_failed"].includes(existing.status)) throw conflict("Workspace ownership changed.");
      if (existing.sourceIssueId !== input.issueId) {
        const actor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
          agentId: input.agentId, runId: input.runId,
          onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId } as const;
        await assertTaskWorkspaceExecutionAccess(tx, actor, input.companyId, selectedSharedSource
          ? { issueId: input.issueId, projectWorkspaceId: input.projectWorkspaceId }
          : { issueId: input.issueId, workspaceId: existing.id });
        await assertExecutionWorkspaceRecordAccess(tx, actor, input.companyId, existing.id);
      }
      const uncertain = await tx.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, existing.id),
        eq(workspaceOperations.phase, "remote_workspace_provision"), sql`${workspaceOperations.metadata}->>'uncertain' = 'true'`,
        sql`${workspaceOperations.heartbeatRunId} is distinct from ${input.runId}::uuid`,
      )).for("update");
      for (const operation of uncertain) {
        if (!await provisionOwnerProvenStopped(tx as unknown as Db, operation)) {
          throw conflict("A provisioning command from an earlier run may still be running in its sandbox, so this workspace cannot "
            + "run again until that sandbox is stopped. Stop the earlier run's sandbox, or set the task's Workspace to "
            + "\"New isolated workspace\" to continue in a fresh one.",
          { code: "remote_workspace_provision_unverified", operationId: operation.id, runId: operation.heartbeatRunId });
        }
        await settleUnverifiedProvision(tx as unknown as Db, operation, input.runId);
        provenProvisions.push(operation.id);
      }
      const hold = await readRemoteWorkspaceWriterHold(tx as unknown as Db, { companyId: input.companyId, authority, runId: input.runId });
      if (hold.kind === "held") throw new RemoteWorkspaceWriterActiveError(existing.id, hold.writer);
      if (hold.kind === "unattributed") throw conflict("The workspace still has an unfinished writer or save operation.", { code: "remote_workspace_writer_pending" });
      if (authority.writerRunId === input.runId) return existing;
      const next: RemoteWorkspaceAuthority = { ...authority, source, epoch: authority.epoch + 1, writerRunId: input.runId };
      const [saved] = await tx.update(executionWorkspaces).set({ metadata: { ...existing.metadata, remoteWorkspace: next,
        ...(authority.snapshotId && existing.metadata?.remoteWorkspaceSnapshotRepositories === undefined
          ? { remoteWorkspaceSnapshotRepositories: { snapshotId: authority.snapshotId, repositories: authority.source.repositories ?? [] } } : {}),
      }, updatedAt: new Date() })
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
  }).catch(async (error: unknown) => {
    if (provenProvisions.length > 0) await settleProvenProvisions(input.db, input.companyId, provenProvisions, input.runId);
    throw error;
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
      let lastError: string | null = null;
      try {
        await cleanupRemoteWorkspaceArchive({ target: input.target,
          remoteCwd: row.phase === "remote_workspace_restore" ? path.posix.dirname(input.location.remoteCwd) : input.location.remoteCwd,
          operationId: row.id });
        cleaned = true;
      } catch (error) {
        lastError = error instanceof RemoteWorkspaceOperationTimeoutError ? error.message : "remote_workspace_export_cleanup_failed";
      }
      await input.assertOwned();
      await input.db.update(workspaceOperations).set({ metadata: sql`jsonb_set(coalesce(${workspaceOperations.metadata}, '{}'::jsonb),
        '{exportCleanup}', coalesce(${workspaceOperations.metadata}->'exportCleanup', '{}'::jsonb) ||
        ${JSON.stringify({ state: cleaned ? "cleaned" : "pending", lastError })}::jsonb)`,
        updatedAt: new Date() })
        .where(and(eq(workspaceOperations.id, row.id), eq(workspaceOperations.companyId, input.companyId),
          inArray(workspaceOperations.status, ["succeeded", "failed"])));
      if (!cleaned) return false;
    }
  }
}

/** The caller retains execution admission and provider ownership; this owns file authority. */
function isSavedWorkspaceRepository(workspace: Workspace, authority: RemoteWorkspaceAuthority,
  repository: NonNullable<RemoteWorkspaceSource["repositories"]>[number]) {
  if (authority.snapshotId === null) return false;
  const receipt = workspace.metadata?.remoteWorkspaceSnapshotRepositories;
  let repositories = authority.source.repositories ?? [];
  if (receipt !== undefined) {
    const saved = object(receipt);
    if (saved.snapshotId !== authority.snapshotId || !Array.isArray(saved.repositories)) throw new Error("remote_workspace_snapshot_source_mismatch");
    repositories = remoteWorkspaceSourceSchema.parse({ kind: "empty", repositories: saved.repositories }).repositories ?? [];
  }
  return repositories.some(saved =>
    saved.id === repository.id && saved.relativePath === repository.relativePath && saved.repoUrl === repository.repoUrl
    && (saved.ref ?? "HEAD") === (repository.ref ?? "HEAD") && saved.pinnedCommit === repository.pinnedCommit
    && (saved.readOnly ?? false) === (repository.readOnly ?? false));
}

function publishedWorkspaceDirectory(workspace: Workspace & Pick<typeof executionWorkspaces.$inferSelect, "providerRef">,
  authority: RemoteWorkspaceAuthority) {
  const publishedRoot = authority.snapshotId && (authority.location?.remoteCwd ?? workspace.providerRef);
  if (!publishedRoot) return null;
  const directory = path.posix.basename(publishedRoot);
  const suffix = directory.slice(workspace.id.length);
  if (!path.posix.isAbsolute(publishedRoot) || path.posix.basename(path.posix.dirname(publishedRoot)) !== ".paperclip-workspaces"
    || !directory.startsWith(workspace.id) || (suffix !== "" && !/^-[1-9][0-9]*-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(suffix))) {
    throw new Error("remote_workspace_published_path_invalid");
  }
  return directory;
}

/**
 * Whether the root at `remoteRoot` on this lease's sandbox is this workspace's
 * own earlier allocation whose last use ended in a completed final save. A
 * retained sandbox keeps that root after the workspace moves on, for example
 * when child tasks inherit the workspace and save newer work elsewhere. Its
 * files are then already part of the saved lineage being restored.
 */
async function isRetiredOwnAllocation(db: Db, workspace: Workspace, lease: EnvironmentLease, remoteRoot: string, epoch: number) {
  if (!lease.environmentId || !lease.providerLeaseId) return false;
  const rows = await db.select({ id: workspaceOperations.id, phase: workspaceOperations.phase, status: workspaceOperations.status,
    metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    inArray(workspaceOperations.phase, ["remote_workspace_snapshot", "remote_workspace_restore"]),
    sql`${workspaceOperations.metadata}->'exportCleanup'->>'environmentId' = ${lease.environmentId}`,
    sql`${workspaceOperations.metadata}->'exportCleanup'->>'providerLeaseId' = ${lease.providerLeaseId}`,
    sql`${workspaceOperations.metadata}->'exportCleanup'->>'remoteCwd' = ${remoteRoot}`));
  const epochOf = (metadata: Record<string, unknown> | null) => Number(metadata?.epoch);
  if (!rows.length || rows.some(row => !Number.isSafeInteger(epochOf(row.metadata)))) return false;
  // Every later writer must have used another allocation.
  const last = Math.max(...rows.map(row => epochOf(row.metadata)));
  if (last >= epoch) return false;
  const lastUse = rows.filter(row => epochOf(row.metadata) === last);
  const saves = lastUse.filter(row => row.phase === "remote_workspace_snapshot" && object(row.metadata?.retiredSave).schema !== RETIRED_SAVE_SCHEMA);
  if (saves.some(row => row.status !== "succeeded" && row.status !== "failed")) return false;
  const generation = (row: typeof rows[number]) => Number(row.metadata?.generation);
  const final = saves.filter(row => row.status === "succeeded").sort((a, b) => generation(b) - generation(a))[0];
  const work = readSaveWork(final?.metadata);
  if (!final || final.metadata?.boundary !== "final" || !work || work.unknown || work.activeIds.length
    || saves.some(row => row !== final && !(generation(row) < generation(final)))) return false;
  const [snapshot] = await db.select({ status: executionWorkspaceSnapshots.status }).from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
    eq(executionWorkspaceSnapshots.sourceOperationId, final.id)));
  return Boolean(snapshot && !["pending", "uploaded"].includes(snapshot.status));
}

export async function prepareRemoteWorkspace(input: {
  db: Db; workspace: Workspace & Pick<typeof executionWorkspaces.$inferSelect, "providerRef">;
  runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
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
  const migration = input.workspace.metadata?.nativeWorkspaceMigration
    ? await readNativeWorkspaceMigration(input.db, input.workspace) : null;
  if (migration && migration.remoteCwd !== target.remoteCwd) throw new Error("native_workspace_migration_target_changed");
  const remoteRoot = sameAllocation ? initial.location!.remoteCwd : migration?.remoteCwd ?? path.posix.join(target.remoteCwd, ".paperclip-workspaces",
    publishedWorkspaceDirectory(input.workspace, initial) ?? `${input.workspace.id}-${initial.epoch}-${input.lease.id}`);
  const preparationIdentity = createHash("sha256").update(JSON.stringify([input.workspace.companyId, input.workspace.id,
    input.runId, initial.epoch, input.lease.id, input.lease.providerLeaseId, remoteRoot, initial.source])).digest("hex");
  let restoredExport: Awaited<ReturnType<typeof restoreRemoteWorkspaceDirectory>> | null = null;
  if (sameAllocation && !await cleanupSavedExports({ db: input.db, companyId: input.workspace.companyId,
    workspaceId: input.workspace.id, location: initial.location!, target,
    assertOwned: input.assertOwned ?? (async () => undefined) })) throw new Error("remote_workspace_export_cleanup_pending");
  if (!sameAllocation) {
    if (initial.snapshotId) {
      let step: RemoteWorkspaceRestoreStep = "snapshot_lookup";
      try {
        const snapshot = await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id, snapshotId: initial.snapshotId });
        if (!snapshot) throw new Error("remote_workspace_snapshot_missing");
        const replaceRetiredRoot = migration === null && !initial.dirty
          && await isRetiredOwnAllocation(input.db, input.workspace, input.lease, remoteRoot, initial.epoch);
        const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-restore-"));
        try {
          const archivePath = path.join(scratch, "workspace.pcws");
          step = "snapshot_download";
          await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: snapshot, targetPath: archivePath });
          step = "sandbox_restore";
          restoredExport = await restoreRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, archivePath, manifestDigest: snapshot.manifestDigest,
            restorationIdentity: preparationIdentity, restorationEpoch: initial.epoch, allowEmptyRoot: migration !== null,
            allocationFiles: migration ? workspaceAllocationFiles(input.lease, remoteRoot) : [],
            replaceRetiredRoot });
        } finally { await rm(scratch, { recursive: true, force: true }); }
      } catch (error) {
        // Cancellation keeps its own handling, as do lookup refusals.
        if ((error instanceof Error && error.name === "AbortError") || (error instanceof HttpError && step === "snapshot_lookup")) throw error;
        // Storage reports a missing saved object as 404. Retrying cannot restore it.
        const objectMissing = error instanceof HttpError && step === "snapshot_download" && error.status === 404;
        if (objectMissing) throw new RemoteWorkspaceRestoreError(step, false, new Error("remote_workspace_snapshot_object_missing"));
        // A missing saved version cannot be fixed by retrying. Otherwise a retry
        // is offered only while this run still owns the same unchanged, clean
        // saved version; a failed restore never publishes over existing files.
        // A sandbox refusal that names its reason (an occupied folder, a changed
        // owner, a rejected archive) repeats on retry, so it goes to the board.
        let retryable = false;
        const refused = error instanceof Error && / (?:reason|archive)=[a-z_]+/.test(error.message)
          && !(step === "sandbox_restore" && /; remote_workspace_restore_failed: stage=restore_lock reason=restore_lock_busy$/.test(error.message));
        if (step !== "snapshot_lookup" && !refused) {
          const [latest] = await input.db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
            .where(and(eq(executionWorkspaces.companyId, input.workspace.companyId), eq(executionWorkspaces.id, input.workspace.id)));
          const current = readRemoteWorkspaceAuthority(latest?.metadata);
          retryable = Boolean(current && current.epoch === initial.epoch && current.writerRunId === input.runId
            && !current.dirty && current.snapshotId === initial.snapshotId);
        }
        throw new RemoteWorkspaceRestoreError(step, retryable, error);
      }
    } else {
      try {
        await prepareRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, source: initial.source,
          preparationIdentity,
          resolveGitAuth: await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
      } catch (error) {
        if (error instanceof RemoteWorkspaceOperationTimeoutError && error.operation === "prepare"
          && !initial.dirty && !initial.location) {
          const [latest] = await input.db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
            .where(and(eq(executionWorkspaces.companyId, input.workspace.companyId), eq(executionWorkspaces.id, input.workspace.id)));
          const current = readRemoteWorkspaceAuthority(latest?.metadata);
          if (current && current.epoch === initial.epoch && current.writerRunId === input.runId
            && !current.dirty && !current.location && !current.snapshotId) {
            throw new RemoteWorkspacePreparationTimeoutError(error);
          }
        }
        throw error;
      }
    }
  }
  for (const repository of (input.source ?? initial.source).repositories ?? []) {
    await input.assertOwned?.();
    // Only repositories already owned by the saved authority may rely on the
    // archive when their old local origin was intentionally omitted. New source
    // descriptors still follow normal acquisition and origin verification.
    await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(remoteRoot, repository),
      repoUrl: repository.repoUrl, ref: repository.ref, pinnedCommit: repository.pinnedCommit,
      savedArchive: isSavedWorkspaceRepository(input.workspace, initial, repository),
      resolveGitAuth: await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
  }
  const recoveredFiles: Array<{ operationId: string; sourceRunId: string; path: string; provenance: string }> = [];
  if (!sameAllocation) {
    // Shared and inherited workspaces retain their original source task. The
    // current writer's task owns its recovery attachments, including a child's
    // preserved files recorded during migration of an ancestor's workspace.
    const [run] = await input.db.select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.workspace.companyId), eq(heartbeatRuns.id, input.runId)));
    const retainedSources = input.workspace.metadata?.remoteWorkspaceRecoverySourceRunIds;
    const recoverySourceRunIds = [...new Set([
      ...(Array.isArray(retainedSources) ? retainedSources.filter((id): id is string => typeof id === "string") : []),
      ...(typeof run?.context?.taskRetryRequestId === "string" || run?.context?.explicitUserContinuation
        ? [input.runId] : []),
    ])];
    const issueId = run?.nativeIssueId ?? run?.issueId ?? run?.context?.issueId;
    if (typeof issueId !== "string") throw new Error("remote_workspace_recovery_task_missing");
    if (recoverySourceRunIds.length) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-recovery-import-"));
      try {
        const scope = { db: input.db, companyId: input.workspace.companyId, issueId, sourceRunIds: recoverySourceRunIds,
          cwd: scratch, storage: input.storage };
        const recovered = [
          ...await attachPreservedWorkspaceSnapshots(scope),
          ...await attachPreservedRemoteWorkspaceSnapshots({ ...scope, runId: input.runId, workspaceId: input.workspace.id }),
        ];
        for (const item of recovered) {
          const relative = `.paperclip-recovered/${item.operationId}`;
          await input.assertOwned?.();
          const provenance = await readFile(path.join(item.path, "provenance.json"), "utf8");
          const exists = await hasRemoteRecoveryAttachment({ target, remoteCwd: remoteRoot, operationId: item.operationId,
            provenance });
          if (!exists) await target.runner!.syncIn!([{ operationId: randomUUID(), files: [{
              kind: "directory", sourcePath: item.path, targetPath: path.posix.join(remoteRoot, relative),
            }] }]);
          recoveredFiles.push({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: relative, provenance });
        }
      } finally { await removeTaskDirectoryTree(scratch); }
    }
  }
  await retainRemoteRecoveryAttachments({ db: input.db, workspace: input.workspace, runId: input.runId,
    remoteRoot, target, recoveredFiles, assertOwned: input.assertOwned, storage: input.storage });
  await input.assertOwned?.();
  const prepared = await input.db.transaction(async tx => {
    await lockWorkspaceRunParents(tx, input.workspace.companyId, input.runId);
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
        ...(recoveredFiles.length || workspace.metadata?.remoteWorkspaceRecoveredFiles !== undefined
          ? { remoteWorkspaceRecoveredFiles: recoveredFiles } : {}) }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id)).returning();
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
    // A save that already ended as failed is retired the same way, so its
    // export staging is still cleaned once the final save commits.
    inArray(workspaceOperations.status, ["running", "pending", "failed"]), sql`${workspaceOperations.metadata}->>'epoch' = ${String(epoch)}`)).for("update");
  for (const candidate of candidates) {
    if (candidate.status === "failed" && (object(candidate.metadata?.retiredSave).schema === RETIRED_SAVE_SCHEMA
      || !candidate.metadata?.lastFailure)) continue;
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

/**
 * The redacted reason a save invocation failed: a server-built remote cause, an
 * internal snake_case code, or a fixed fallback. Provider text is never kept.
 */
export function remoteWorkspaceSaveFailure(error: unknown): { code: string; cause?: string } {
  const cause = remoteWorkspaceFailureCause(error);
  const message = error instanceof Error ? error.message.trim() : "";
  const code = cause ? cause.split(":")[0]! : /^[a-z][a-z0-9_]{2,80}$/.test(message) ? message : "remote_workspace_save_failed";
  return cause ? { code, cause } : { code };
}

function saveTimingRecord(timing: RemoteWorkspaceSaveTiming & { startedAt: number }, outcome: "succeeded" | "failed", at: Date) {
  const { startedAt, ...phases } = timing;
  return { schema: SAVE_TIMING_SCHEMA, outcome, totalMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...phases, at: at.toISOString() };
}

async function settleSaveInvocation(input: { db: Db; workspace: Workspace; runId: string; epoch: number;
  location: NonNullable<RemoteWorkspaceAuthority["location"]>; operationId: string; invocationId: string;
  failure?: { code: string; cause?: string }; timing?: RemoteWorkspaceSaveTiming & { startedAt: number } }) {
  return input.db.transaction(async tx => {
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, input.operationId),
      eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
      eq(workspaceOperations.heartbeatRunId, input.runId), sql`${workspaceOperations.metadata}->>'epoch' = ${String(input.epoch)}`)).for("update");
    const work = readSaveWork(operation?.metadata);
    if (!operation || !work || !work.activeIds.includes(input.invocationId)) return false;
    const activeIds = work.activeIds.filter(id => id !== input.invocationId);
    if (!activeIds.length && !work.unknown) await notifyRemoteWorkspaceSnapshots(tx, `workspace:${workspace.id}`);
    const now = new Date();
    // The last settled invocation of a failed save ends the operation. A later
    // retry of the same boundary reopens it; a success still records "succeeded".
    const failure = input.failure;
    const failed = Boolean(failure) && operation.status === "running" && !activeIds.length && !work.unknown;
    await tx.update(workspaceOperations).set({ metadata: { ...operation.metadata,
      saveWork: { ...work, activeIds, quiescedAt: activeIds.length ? null : now.toISOString() },
      ...(input.timing ? { saveTiming: saveTimingRecord(input.timing, input.failure ? "failed" : "succeeded", now) } : {}),
      ...(failed && failure ? { lastFailure: { ...failure, at: now.toISOString() } } : {}) },
      ...(failed && failure ? { status: "failed", exitCode: 1, finishedAt: now,
        stderrExcerpt: `${[failure.code, failure.cause].filter(Boolean).join("\n")}\n` } : {}),
      updatedAt: now })
      .where(eq(workspaceOperations.id, operation.id));
    await retireQuiescedSaves(tx, workspace, input.runId, input.epoch, input.location);
    return true;
  });
}

export async function saveRemoteWorkspace(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  assertOwned: () => Promise<void>; storage?: StorageService; boundary?: string;
  repositories?: NonNullable<RemoteWorkspaceSource["repositories"]>;
}) {
  const saveStarted = performance.now();
  const target = requireRemoteWorkspaceTarget(input.target), boundary = input.boundary ?? "final";
  const expected = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!expected?.location || expected.location.providerLeaseId !== input.lease.providerLeaseId || expected.location.leaseId !== input.lease.id) throw new Error("remote_workspace_save_binding_mismatch");
  await input.assertOwned();
  const invocationId = randomUUID();
  const operation = await input.db.transaction(async tx => {
    const issueId = await lockWorkspaceRunParents(tx, input.workspace.companyId, input.runId);
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const current = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!current || current.epoch !== expected.epoch || (current.writerRunId !== input.runId && current.dirty)) throw new Error("remote_workspace_authority_changed");
    const [previous] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
      eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), sql`${workspaceOperations.metadata}->>'boundary' = ${boundary}`,
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(current.epoch)}`)).limit(1).for("update");
    if (previous) {
      if (previous.issueId !== issueId) throw new Error("remote_workspace_run_binding_changed");
      if (object(previous.metadata?.retiredSave).schema === RETIRED_SAVE_SCHEMA) throw new Error("remote_workspace_snapshot_retired");
      const work = readSaveWork(previous.metadata);
      // A retry of a failed save reopens that boundary's operation.
      const reopened = previous.status === "failed" ? { status: "running", finishedAt: null, exitCode: null } : {};
      const [registered] = await tx.update(workspaceOperations).set({ ...reopened, metadata: { ...previous.metadata,
        saveWork: { schema: SAVE_WORK_SCHEMA, activeIds: [...(work?.activeIds ?? []), invocationId],
          unknown: work?.unknown ?? true, quiescedAt: null } }, updatedAt: new Date() }).where(eq(workspaceOperations.id, previous.id)).returning();
      return registered!;
    }
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
  let publicationScratch: string | undefined;
  let failure: { code: string; cause?: string } | undefined;
  const timing: RemoteWorkspaceSaveTiming & { startedAt: number } = { startedAt: saveStarted };
  // A replay of an already-committed save measures no phase; it keeps the
  // original save's timing instead of overwriting it with an empty record.
  let replayedCommittedSave = false;
  try {
    const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id,
      operationId: operation.id, runId: input.runId, parentSnapshotId: operation.metadata?.parentSnapshotId as string | null,
      generation: operation.metadata?.generation as number, epoch: expected.epoch });
    if (operation.status === "succeeded" && ["committed", "superseded"].includes(snapshot.status)) {
      replayedCommittedSave = true;
      return { snapshotId: snapshot.id, generation: snapshot.generation, sha256: snapshot.sha256!, savedAt: snapshot.updatedAt.toISOString() };
    }
    const existingUpload = snapshot.status === "uploaded" ? await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId,
      workspaceId: input.workspace.id, snapshotId: snapshot.id }) : null;
    if (existingUpload) timing.reusedUpload = true;
    captured = existingUpload ? null : await captureRemoteWorkspaceArchive({ target, remoteCwd: expected.location.remoteCwd,
      operationId: operation.id, timing });
    await input.assertOwned();
    const uploadStarted = performance.now();
    const saved = await uploadWorkspaceSnapshot({ db: input.db, storage: input.storage ?? getStorageService(), snapshotId: snapshot.id,
      companyId: input.workspace.companyId, workspaceId: input.workspace.id, archivePath: captured?.archivePath ?? "",
      manifestDigest: existingUpload?.manifestDigest ?? captured!.manifestDigest });
    timing.uploadMs = Math.max(0, Math.round(performance.now() - uploadStarted));
    await input.assertOwned();
    const publishStarted = performance.now();
    let publicationArchive = captured?.archivePath;
    if (!publicationArchive) {
      publicationScratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-publication-"));
      publicationArchive = path.join(publicationScratch, "workspace.pcws");
      await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: saved, targetPath: publicationArchive });
    }
    const capturedDirectories = await readRemoteWorkspaceArchiveDirectories(publicationArchive, saved.manifestDigest);
    const at = new Date();
    await input.db.transaction(async tx => {
      await lockWorkspaceRunParents(tx, input.workspace.companyId, input.runId, operation.issueId);
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
      if (boundary === "final") {
        await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionReplacement);
      }
      const receipt = object(workspace.metadata?.remoteWorkspaceSnapshotRepositories);
      const priorRepositories = receipt.snapshotId === current.snapshotId && Array.isArray(receipt.repositories)
        ? remoteWorkspaceSourceSchema.parse({ kind: "empty", repositories: receipt.repositories }).repositories ?? [] : [];
      const repositories = [...new Map([
        ...priorRepositories, ...(expected.source.repositories ?? []), ...(input.repositories ?? []),
      ].map(repository => [repository.id, repository])).values()]
        .filter(repository => !repository.readOnly && capturedDirectories.has(repository.relativePath));
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: authority,
        remoteWorkspaceSnapshotRepositories: { snapshotId: saved.id, repositories },
      }, updatedAt: at }).where(eq(executionWorkspaces.id, workspace.id));
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
    timing.publishMs = Math.max(0, Math.round(performance.now() - publishStarted));
    return { snapshotId: saved.id, generation: saved.generation, sha256: saved.sha256, savedAt: at.toISOString() };
  } catch (error) {
    failure = remoteWorkspaceSaveFailure(error);
    throw error;
  } finally {
    // Every upload/capture promise has settled before its durable token clears.
    // Missing completion evidence remains pinned; cleanup never masks the save error.
    if (publicationScratch) await rm(publicationScratch, { recursive: true, force: true }).catch(() => undefined);
    try { await captured?.cleanup(); }
    catch { logger.warn({ runId: input.runId, operationId: operation.id }, "Remote workspace local archive cleanup failed"); }
    try {
      if (await settleSaveInvocation({ db: input.db, workspace: input.workspace, runId: input.runId, epoch: expected.epoch,
        location: expected.location, operationId: operation.id, invocationId, failure,
        timing: replayedCommittedSave ? undefined : timing })) {
        await cleanupSavedExports({ db: input.db, companyId: input.workspace.companyId, workspaceId: input.workspace.id,
          location: expected.location, target, assertOwned: input.assertOwned });
      }
    } catch { logger.warn({ runId: input.runId, operationId: operation.id }, "Remote workspace save settlement or export cleanup remains pending"); }
  }
}

export async function prepareRemoteWorkspaceRepository(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  repository: { id: string; relativePath: string; repoUrl: string; ref: string | null; pinnedCommit?: string; readOnly?: boolean };
  assertOwned?: () => Promise<void>; resolveGitAuth?: ReturnType<typeof createGitRemoteAuthProvider>; verifyOnly?: boolean; storage?: StorageService; deferSave?: boolean;
}) {
  input = { ...input, workspace: await input.db.transaction(tx => currentWorkspace(tx, input.workspace.companyId, input.workspace.id)) };
  const authority = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!authority?.location || authority.writerRunId !== input.runId || authority.location.leaseId !== input.lease.id
    || authority.location.providerLeaseId !== input.lease.providerLeaseId) throw new Error("remote_workspace_repository_binding_mismatch");
  await input.assertOwned?.();
  const target = requireRemoteWorkspaceTarget(input.target);
  const result = await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(authority.location.remoteCwd, input.repository),
    ...input.repository, verifyOnly: input.verifyOnly, savedArchive: isSavedWorkspaceRepository(input.workspace, authority, input.repository),
    resolveGitAuth: input.resolveGitAuth ?? await createRemoteWorkspaceGitAuth(input.db, input.workspace.companyId, input.runId) });
  await input.assertOwned?.();
  const descriptor = { ...input.repository, pinnedCommit: result.pinnedCommit };
  const requiresSave = !isSavedWorkspaceRepository(input.workspace, authority, descriptor);
  if (requiresSave && !input.deferSave) {
    const receipt = object(input.workspace.metadata?.remoteWorkspaceSnapshotRepositories);
    const prior = receipt.snapshotId === authority.snapshotId && Array.isArray(receipt.repositories)
      ? remoteWorkspaceSourceSchema.parse({ kind: "empty", repositories: receipt.repositories }).repositories ?? []
      : authority.source.repositories ?? [];
    await saveRemoteWorkspace({ ...input, target, boundary: `repository:${input.repository.id}:${result.pinnedCommit}`,
      repositories: [...prior.filter(repository => repository.id !== descriptor.id), descriptor],
      assertOwned: input.assertOwned ?? (async () => undefined) });
  }
  return { ...result, requiresSave };
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

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

/**
 * True only with proof that an uncertain provisioning command can no longer
 * run: its run is terminal, and every sandbox allocation of that run carries a
 * provider stop or destroy receipt bound to that lease and run. Run status,
 * age, or a dead server process alone never proves it, because the command
 * runs in the sandbox, not in the server.
 */
async function provisionOwnerProvenStopped(db: Db, operation: typeof workspaceOperations.$inferSelect): Promise<boolean> {
  if (!operation.heartbeatRunId) return false;
  const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, operation.companyId), eq(heartbeatRuns.id, operation.heartbeatRunId)));
  if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, operation.companyId), eq(environmentLeases.heartbeatRunId, operation.heartbeatRunId)));
  return leases.length > 0 && leases.every(lease => hasRemoteTerminationReceipt(lease) || hasRecoveredCleanupStopReceipt(lease));
}

/** The command's effect is still unknown, so the row is settled as failed,
 * never as succeeded. The next writer provisions in its own epoch. */
async function settleUnverifiedProvision(db: Db, operation: typeof workspaceOperations.$inferSelect, reservingRunId: string) {
  const now = new Date();
  await db.update(workspaceOperations).set({ status: "failed", finishedAt: now, updatedAt: now,
    metadata: { ...operation.metadata, uncertain: false, settledBy: "owner_sandbox_stopped" } })
    .where(eq(workspaceOperations.id, operation.id));
  await persistActivity(db, { companyId: operation.companyId, actorType: "system", actorId: "remote-workspaces",
    action: "workspace.remote_provision_settled", entityType: "execution_workspace",
    entityId: operation.executionWorkspaceId ?? operation.id, runId: reservingRunId, issueId: operation.issueId ?? undefined,
    details: { operationId: operation.id, ownerRunId: operation.heartbeatRunId,
      reason: "The earlier run ended and its sandbox was stopped, so its provisioning command cannot still be running. Its effect is unknown." } });
}

/** Re-proves and settles provisioning rows after the reservation that found
 * them rolled back, so a proven row never blocks again. */
async function settleProvenProvisions(db: Db, companyId: string, operationIds: string[], reservingRunId: string) {
  try {
    await db.transaction(async tx => {
      const rows = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.id, operationIds), sql`${workspaceOperations.metadata}->>'uncertain' = 'true'`)).for("update");
      for (const operation of rows) {
        if (await provisionOwnerProvenStopped(tx as unknown as Db, operation)) {
          await settleUnverifiedProvision(tx as unknown as Db, operation, reservingRunId);
        }
      }
    });
  } catch (error) {
    // The next reservation proves and settles them again.
    logger.warn({ err: error, companyId, operationIds }, "remote workspace provisioning settlement will retry");
  }
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
      const issueId = await lockWorkspaceRunParents(tx, input.companyId, input.runId);
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
        heartbeatRunId: input.runId, issueId, phase: "remote_workspace_provision", status: "running",
        metadata: { epoch: input.epoch, index, commandSha256: digest, uncertain: true } }).returning();
      return created!;
    });
    if (!operation) continue;
    await input.assertOwned?.();
    const result = await input.target.runner!.execute({ command: "bash", args: ["-lc", command], cwd: input.remoteCwd,
      timeoutMs: 300_000, bypassSession: true });
    if (result.exitCode !== 0 || result.timedOut) {
      // A reported non-zero exit is a finished command, not an ambiguous one.
      // A timeout stays uncertain: the runner may not have stopped it.
      if (!result.timedOut) await input.db.update(workspaceOperations).set({ status: "failed", finishedAt: new Date(),
        updatedAt: new Date(), metadata: { ...operation.metadata, uncertain: false, exitCode: result.exitCode } })
        .where(and(eq(workspaceOperations.id, operation.id), eq(workspaceOperations.status, "running")));
      throw new Error("remote_workspace_provision_unverified");
    }
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
