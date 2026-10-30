import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
import { conflict, forbidden } from "../errors.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { notifyCancelledWorkspacePreservation } from "./cancelled-workspace-preservation-notifications.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { persistActivity } from "./activity-log.js";
import {
  captureRemoteWorkspaceArchive, prepareRemoteWorkspaceDirectory, prepareRemoteRepository, remoteWorkspaceRepositoryPath,
  requireRemoteWorkspaceTarget, restoreRemoteWorkspaceDirectory,
} from "./remote-workspace-transport.js";
import {
  beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot,
} from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";

export { readRemoteWorkspaceAuthority, type RemoteWorkspaceAuthority, type RemoteWorkspaceSource } from "@paperclipai/shared";
export { remoteWorkspaceRepositoryPath } from "./remote-workspace-transport.js";
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "metadata" | "sourceIssueId" | "projectId" | "projectWorkspaceId">;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function shouldUseRemoteWorkspaces(input: {
  adapterType: string; environmentDriver: string | null; experimentalEnabled: boolean; existingWorkspace?: { metadata?: Record<string, unknown> | null } | null;
}) {
  const enrolled = readRemoteWorkspaceAuthority(input.existingWorkspace?.metadata) !== null;
  if (enrolled && (input.adapterType !== "paperclip_runner" || input.environmentDriver !== "sandbox")) {
    throw conflict("This workspace requires its native sandbox execution environment.", { code: "remote_workspace_execution_required" });
  }
  return enrolled || (input.experimentalEnabled && input.adapterType === "paperclip_runner" && input.environmentDriver === "sandbox");
}

function requireExternalPersistence(storage: StorageService) {
  if (storage.provider !== "s3" || !process.env.DATABASE_URL?.trim() || !process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim()) {
    throw conflict("Remote workspace storage requires external Postgres, object storage, and a stable configured encryption key.",
      { code: "remote_workspace_persistence_unavailable" });
  }
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
  requireExternalPersistence(input.storage ?? getStorageService());
  const source = remoteWorkspaceSourceSchema.parse(input.source);
  return input.db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    if (!issue || !run || run.agentId !== input.agentId || run.status !== "running" ||
      ![run.nativeIssueId, run.issueId, object(run.contextSnapshot).issueId].includes(input.issueId)) throw forbidden("Workspace preparation requires its current task execution.");
    if (input.fresh && (issue.executionWorkspaceId !== input.fresh.previousWorkspaceId
      || issue.workspaceBindingRevision !== input.fresh.expectedBindingRevision)) throw conflict("The task workspace selection changed.");
    let selected = input.fresh ? input.fresh.attemptId : input.existingWorkspaceId ?? issue.executionWorkspaceId;
    if (!selected && input.mode === "shared_workspace" && input.projectWorkspaceId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`remote-shared-workspace:${input.companyId}:${input.projectWorkspaceId}`}, 0))`);
      const [shared] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.projectWorkspaceId, input.projectWorkspaceId),
        eq(executionWorkspaces.mode, "shared_workspace"), eq(executionWorkspaces.status, "active"),
        sql`${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema' = 'paperclip.remote-workspace.v1'`,
      )).limit(1);
      selected = shared?.id ?? null;
    }
    const [selectedRow] = selected ? await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, selected))).for("update") : [];
    const existing = selectedRow ?? null;
    if (selected && !existing && !input.fresh) throw new Error("remote_workspace_missing");
    const authority = readRemoteWorkspaceAuthority(existing?.metadata);
    if (existing && !authority) throw conflict("Import this existing workspace before enabling remote storage.", { code: "remote_workspace_migration_required" });
    if (existing && authority) {
      if ((existing.sourceIssueId !== input.issueId && existing.mode !== "shared_workspace") || ["archived", "cleanup_failed"].includes(existing.status)) throw conflict("Workspace ownership changed.");
      if (existing.sourceIssueId !== input.issueId) await assertTaskWorkspaceExecutionAccess(tx, {
        type: "agent", source: "agent_jwt", companyId: input.companyId, agentId: input.agentId, runId: input.runId,
        onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId,
      }, input.companyId, { issueId: input.issueId, workspaceId: existing.id });
      if (authority.writerRunId && authority.writerRunId !== input.runId) {
        throw conflict("The workspace still has an unfinished writer or save operation.", { code: "remote_workspace_writer_pending" });
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
  const [run] = await tx.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update");
  if (!run) throw new Error("remote_workspace_run_missing");
  await notifyCancelledWorkspacePreservation(tx, { companyId, runId });
  await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...run.profile, remoteWorkspace: value }, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
}

/** The caller retains execution admission and provider ownership; this owns file authority. */
export async function prepareRemoteWorkspace(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  source?: RemoteWorkspaceSource; assertOwned?: () => Promise<void>;
  provisionCommand?: string | null; runtimeProvisionCommand?: string | null; storage?: StorageService;
}) {
  const target = requireRemoteWorkspaceTarget(input.target);
  const initial = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!initial || initial.writerRunId !== input.runId || !input.lease.environmentId || !input.lease.providerLeaseId
    || input.lease.companyId !== input.workspace.companyId) throw new Error("remote_workspace_binding_mismatch");
  await input.assertOwned?.();
  const sameAllocation = initial.location?.providerLeaseId === input.lease.providerLeaseId
    && initial.location?.environmentId === input.lease.environmentId;
  if (initial.location && !sameAllocation && initial.dirty) throw conflict("The prior workspace has unsaved work; recover it before replacing its allocation.");
  const remoteRoot = sameAllocation ? initial.location!.remoteCwd : path.posix.join(target.remoteCwd, ".paperclip-workspaces", input.workspace.id);
  if (!sameAllocation) {
    if (initial.snapshotId) {
      const snapshot = await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id, snapshotId: initial.snapshotId });
      if (!snapshot) throw new Error("remote_workspace_snapshot_missing");
      const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-restore-"));
      try {
        const archivePath = path.join(scratch, "workspace.pcws");
        await loadWorkspaceSnapshotArchive({ storage: input.storage ?? getStorageService(), reference: snapshot, targetPath: archivePath });
        await restoreRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, archivePath, manifestDigest: snapshot.manifestDigest });
      } finally { await rm(scratch, { recursive: true, force: true }); }
    } else {
      await prepareRemoteWorkspaceDirectory({ target, remoteCwd: remoteRoot, source: initial.source,
        resolveGitAuth: createGitRemoteAuthProvider(input.db, input.workspace.companyId, { issueId: input.workspace.sourceIssueId, heartbeatRunId: input.runId }) });
      for (const command of [input.provisionCommand, input.runtimeProvisionCommand]) if (command?.trim()) {
        await input.assertOwned?.();
        const result = await target.runner!.execute({ command: "bash", args: ["-lc", command], cwd: remoteRoot,
          timeoutMs: 300_000, bypassSession: true });
        if (result.exitCode !== 0 || result.timedOut) throw new Error("remote_workspace_provision_failed");
      }
    }
  }
  for (const repository of (input.source ?? initial.source).repositories ?? []) {
    await input.assertOwned?.();
    await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(remoteRoot, repository),
      repoUrl: repository.repoUrl, ref: repository.ref, pinnedCommit: repository.pinnedCommit,
      resolveGitAuth: createGitRemoteAuthProvider(input.db, input.workspace.companyId, {
        issueId: input.workspace.sourceIssueId, heartbeatRunId: input.runId,
      }) });
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
    const authority: RemoteWorkspaceAuthority = { ...current, dirty: true, location: { environmentId: input.lease.environmentId!,
      leaseId: input.lease.id, providerLeaseId: input.lease.providerLeaseId!, remoteCwd: remoteRoot } };
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, input.lease.id),
      eq(environmentLeases.companyId, workspace.companyId))).for("update");
    if (!lease || lease.providerLeaseId !== authority.location!.providerLeaseId) throw new Error("remote_workspace_lease_changed");
    const [savedLease] = await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteCwd: remoteRoot, remoteWorkspaceId: workspace.id }, updatedAt: new Date() })
      .where(eq(environmentLeases.id, lease.id)).returning();
    const [savedWorkspace] = await tx.update(executionWorkspaces).set({ cwd: remoteRoot, providerRef: remoteRoot,
      metadata: { ...workspace.metadata, remoteWorkspace: authority,
        ...(recoveredFiles.length ? { remoteWorkspaceRecoveredFiles: recoveredFiles } : {}) }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id)).returning();
    const runReference = reference(workspace.id, authority, "prepared");
    await persistRunReference(tx, workspace.companyId, input.runId, runReference);
    return { workspace: savedWorkspace!, lease: savedLease! as EnvironmentLease, remoteRoot, reference: runReference };
  });
  target.remoteCwd = remoteRoot;
  if (!initial.snapshotId) {
    await saveRemoteWorkspace({ ...input, workspace: prepared.workspace, lease: prepared.lease, target,
      assertOwned: input.assertOwned ?? (async () => undefined), boundary: "initial" });
    const [workspace] = await input.db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspace.id), eq(executionWorkspaces.companyId, input.workspace.companyId)));
    prepared.workspace = workspace!;
    prepared.reference = reference(workspace!.id, readRemoteWorkspaceAuthority(workspace!.metadata)!, "prepared");
  }
  return prepared;
}

export async function saveRemoteWorkspace(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  assertOwned: () => Promise<void>; storage?: StorageService; boundary?: string;
}) {
  const target = requireRemoteWorkspaceTarget(input.target), boundary = input.boundary ?? "final";
  const expected = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!expected?.location || expected.location.providerLeaseId !== input.lease.providerLeaseId || expected.location.leaseId !== input.lease.id) throw new Error("remote_workspace_save_binding_mismatch");
  await input.assertOwned();
  const operation = await input.db.transaction(async tx => {
    const workspace = await currentWorkspace(tx, input.workspace.companyId, input.workspace.id);
    const current = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!current || current.epoch !== expected.epoch || (current.writerRunId !== input.runId && current.dirty)) throw new Error("remote_workspace_authority_changed");
    const [previous] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
      eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), sql`${workspaceOperations.metadata}->>'boundary' = ${boundary}`,
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(current.epoch)}`)).limit(1);
    if (previous) return previous;
    const [parent] = current.snapshotId ? await tx.select({ generation: executionWorkspaceSnapshots.generation }).from(executionWorkspaceSnapshots)
      .where(and(eq(executionWorkspaceSnapshots.id, current.snapshotId), eq(executionWorkspaceSnapshots.companyId, workspace.companyId),
        eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id))) : [];
    const [created] = await tx.insert(workspaceOperations).values({ companyId: workspace.companyId, executionWorkspaceId: workspace.id,
      heartbeatRunId: input.runId, issueId: workspace.sourceIssueId, phase: "remote_workspace_snapshot", status: "running",
      metadata: { boundary, epoch: current.epoch, parentSnapshotId: current.snapshotId, generation: (parent?.generation ?? 0) + 1 },
    }).returning();
    return created!;
  });
  const snapshot = await beginWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId, workspaceId: input.workspace.id,
    operationId: operation.id, runId: input.runId, parentSnapshotId: operation.metadata?.parentSnapshotId as string | null,
    generation: operation.metadata?.generation as number, epoch: expected.epoch });
  if (operation.status === "succeeded" && snapshot.status === "committed") return { snapshotId: snapshot.id,
    generation: snapshot.generation, sha256: snapshot.sha256!, savedAt: snapshot.updatedAt.toISOString() };
  const existingUpload = snapshot.status === "uploaded" ? await getWorkspaceSnapshot(input.db, { companyId: input.workspace.companyId,
    workspaceId: input.workspace.id, snapshotId: snapshot.id }) : null;
  const captured = existingUpload ? null : await captureRemoteWorkspaceArchive({ target, remoteCwd: expected.location.remoteCwd, operationId: operation.id });
  try {
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
      await tx.update(executionWorkspaceSnapshots).set({ status: "committed", updatedAt: at }).where(and(eq(executionWorkspaceSnapshots.id, saved.id), eq(executionWorkspaceSnapshots.status, "uploaded")));
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: authority }, updatedAt: at }).where(eq(executionWorkspaces.id, workspace.id));
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: at, updatedAt: at,
        metadata: { ...operation.metadata, snapshotId: saved.id, sha256: saved.sha256 } }).where(eq(workspaceOperations.id, operation.id));
      await persistRunReference(tx, workspace.companyId, input.runId, reference(workspace.id, authority, boundary === "final" ? "saved" : "prepared"));
      await persistActivity(tx as unknown as Db, { companyId: workspace.companyId, actorType: "system", actorId: "remote-workspaces",
        action: "workspace.snapshot_saved", entityType: "execution_workspace", entityId: workspace.id, runId: input.runId,
        details: { snapshotId: saved.id, generation: saved.generation, epoch: current.epoch, boundary } });
      if (snapshot.parentSnapshotId) await tx.update(executionWorkspaceSnapshots).set({ status: "superseded",
        deleteAfter: new Date(at.getTime() + 7 * 86400_000), updatedAt: at }).where(and(eq(executionWorkspaceSnapshots.id, snapshot.parentSnapshotId),
        eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id)));
    });
    return { snapshotId: saved.id, generation: saved.generation, sha256: saved.sha256, savedAt: at.toISOString() };
  } finally { await captured?.cleanup(); }
}

export async function prepareRemoteWorkspaceRepository(input: {
  db: Db; workspace: Workspace; runId: string; lease: EnvironmentLease; target: AdapterExecutionTarget | null;
  repository: { id: string; relativePath: string; repoUrl: string; ref: string | null; pinnedCommit?: string; readOnly?: boolean };
  assertOwned?: () => Promise<void>; resolveGitAuth?: ReturnType<typeof createGitRemoteAuthProvider>; verifyOnly?: boolean;
}) {
  const authority = readRemoteWorkspaceAuthority(input.workspace.metadata);
  if (!authority?.location || authority.writerRunId !== input.runId || authority.location.leaseId !== input.lease.id
    || authority.location.providerLeaseId !== input.lease.providerLeaseId) throw new Error("remote_workspace_repository_binding_mismatch");
  await input.assertOwned?.();
  const target = requireRemoteWorkspaceTarget(input.target);
  const result = await prepareRemoteRepository({ target, remoteCwd: remoteWorkspaceRepositoryPath(authority.location.remoteCwd, input.repository),
    ...input.repository, verifyOnly: input.verifyOnly,
    resolveGitAuth: input.resolveGitAuth ?? createGitRemoteAuthProvider(input.db, input.workspace.companyId, {
      issueId: input.workspace.sourceIssueId, heartbeatRunId: input.runId,
    }) });
  await input.assertOwned?.();
  await saveRemoteWorkspace({ ...input, target, boundary: `repository:${input.repository.id}:${result.pinnedCommit}`,
    assertOwned: input.assertOwned ?? (async () => undefined) });
  return result;
}

export function createSavedWorkspaceLoader(db: Db, storage: StorageService = getStorageService()) {
  return async (input: { companyId: string; workspaceId: string; snapshotId: string }) => {
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, input.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspaceId), eq(executionWorkspaceSnapshots.id, input.snapshotId),
      eq(executionWorkspaceSnapshots.status, "committed")));
    const saved = row ? await getWorkspaceSnapshot(db, input) : null;
    if (!saved) throw new Error("remote_workspace_snapshot_unavailable");
    const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-files-"));
    try {
      const archive = path.join(scratch, "archive.pcws"), root = path.join(scratch, "files");
      await loadWorkspaceSnapshotArchive({ storage, reference: saved, targetPath: archive });
      await restoreRemoteWorkspaceArchive({ archivePath: archive, targetDir: root, expectedManifestDigest: saved.manifestDigest });
      return { root, savedAt: row!.updatedAt.toISOString(), cleanup: () => rm(scratch, { recursive: true, force: true }) };
    } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
  };
}
