import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaceRestorePoints, executionWorkspaces, issueRecoveryActions, issues, nativeRunFinalizations,
  projectWorkspaces, withDedicatedDbConnection, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import type { StorageService } from "../storage/types.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { openRestorePoint, sealRestorePoint } from "./git-restore-point.js";
import { notifyGitRestorePointWork } from "./git-restore-point-ledger.js";
import { abandonGitRestorePoint, activateGitRestorePoints, readRestorePointObject, storeSealedRestorePoint } from "./git-restore-point-storage.js";
import { allocatedBytes, describeGitExpirationFailure, expirationScope, isGitWorkspaceExpirationEligible, type GitExpirationFailure } from "./git-workspace-expiration.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock } from "./isolated-remote-workspace-source.js";
import { logActivity } from "./activity-log.js";
import {
  captureTaskDirectorySnapshot,
  inspectTaskDirectory,
  materializeTaskDirectorySnapshot,
  newestTaskDirectoryMtime,
  removeTaskDirectoryTree,
  shortSiblingName,
  TASK_DIRECTORY_RETENTION_KEY,
  TaskDirectoryRestoreFailure,
  TaskDirectorySnapshotSkip,
  type TaskDirectorySnapshotLimits,
} from "./isolated-task-directory-snapshot.js";

export { TASK_DIRECTORY_RETENTION_KEY } from "./isolated-task-directory-snapshot.js";
export const TASK_DIRECTORY_RETENTION_SCHEMA = "paperclip.task-directory-retention.v1";
export const TASK_DIRECTORY_RESTORE_POINT_SCHEMA = "paperclip.task-directory-restore-point.v1";
export const TASK_DIRECTORY_RETENTION_REASON = "isolated task directory retention";
export const TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING = "The saved files of this task directory expired, so it was reopened as an empty directory. Files from before it was cleaned up are no longer available.";
export const TASK_DIRECTORY_RETRY_MS = 60 * 60 * 1000;
export const TASK_DIRECTORY_RECHECK_MS = 24 * 60 * 60 * 1000;
const TRASH_GRACE_MS = 60 * 60 * 1000;
const NAMESPACE = "git-restore-points";
const MAX_RESTORE_POINT_BYTES = 512 * 1024 * 1024;
const IDENTITY = /^[a-zA-Z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRASH = /^\.(expired|restoring)-[0-9a-f]{8,}$/;
const RETRYABLE_SKIPS = new Set(["source_busy", "lifecycle_busy", "workspace_changed", "live_or_unresolved_consumer",
  "task_directory_changed", "inspection_failed"]);

type Workspace = typeof executionWorkspaces.$inferSelect;

export type TaskDirectoryRestorePointRef = {
  schema: typeof TASK_DIRECTORY_RESTORE_POINT_SCHEMA;
  id: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  key: StoredSecretVersionMaterial;
  generation: number;
  digest: string;
  files: number;
  excluded: number;
  expiredAt?: string;
};

export type TaskDirectoryRetention = {
  schema: typeof TASK_DIRECTORY_RETENTION_SCHEMA;
  generation: number;
  removed: boolean;
  trash: string;
  restorePoint: TaskDirectoryRestorePointRef;
  removedAt?: string;
};

export type TaskDirectoryRestorePointOptions = { storage: StorageService; keyDurable: boolean; limits?: TaskDirectorySnapshotLimits };

export type TaskDirectoryRetentionResult = {
  candidate: boolean;
  expired: boolean;
  restorePoint: boolean;
  candidateBytes: number;
  reclaimedBytes: number;
  skipReason: string | null;
  failure?: GitExpirationFailure;
};

export function readTaskDirectoryRetention(workspace: { metadata?: Record<string, unknown> | null }): TaskDirectoryRetention | null {
  const state = workspace.metadata?.[TASK_DIRECTORY_RETENTION_KEY] as TaskDirectoryRetention | undefined;
  return state?.schema === TASK_DIRECTORY_RETENTION_SCHEMA ? state : null;
}

export function hasPendingTaskDirectoryRetention(workspace: Pick<Workspace, "metadata" | "status">) {
  const state = readTaskDirectoryRetention(workspace);
  return Boolean(state && !state.removed && ["archived", "cleanup_failed"].includes(workspace.status));
}

export function isRetryableTaskDirectorySkip(reason: string | null) {
  return reason !== null && RETRYABLE_SKIPS.has(reason);
}

async function instanceRoot() {
  return fs.realpath(resolvePaperclipInstanceRoot()).catch(() => null);
}

export async function isolatedTaskDirectoriesRoot() {
  const root = await instanceRoot();
  return root ? path.join(root, "isolated-workspaces") : null;
}

export async function canonicalTaskDirectory(companyId: string, issueId: string) {
  if (!IDENTITY.test(companyId) || !IDENTITY.test(issueId)) return null;
  const root = await isolatedTaskDirectoriesRoot();
  return root ? path.join(root, companyId, issueId) : null;
}

export function mayBeIsolatedTaskDirectoryWorkspace(workspace: Pick<Workspace, "sourceIssueId" | "strategyType" | "providerType" | "repoUrl" | "branchName" | "cwd" | "providerRef" | "mode">) {
  return Boolean(workspace.sourceIssueId && workspace.cwd) && workspace.strategyType === "project_primary"
    && workspace.providerType === "local_fs" && !workspace.repoUrl && !workspace.branchName
    && (workspace.providerRef === null || workspace.providerRef === workspace.cwd)
    && (workspace.mode === "isolated_workspace" || workspace.mode === "shared_workspace");
}

export async function isIsolatedTaskDirectoryWorkspace(workspace: Pick<Workspace, "companyId" | "sourceIssueId" | "strategyType" | "providerType" | "repoUrl" | "branchName" | "cwd" | "providerRef" | "mode">) {
  if (!mayBeIsolatedTaskDirectoryWorkspace(workspace)) return false;
  return workspace.cwd === await canonicalTaskDirectory(workspace.companyId, workspace.sourceIssueId!);
}

function restorePointObjectKey(companyId: string, workspaceId: string, generation: number, id: string) {
  return `${companyId}/${NAMESPACE}/${workspaceId}/${generation}/task-directory/${id}.pcrp`;
}

function validateRestorePointRef(ref: TaskDirectoryRestorePointRef | null | undefined, workspace: { companyId: string; id: string }) {
  if (!ref || ref.schema !== TASK_DIRECTORY_RESTORE_POINT_SCHEMA || typeof ref.id !== "string" || !UUID.test(ref.id)
    || !Number.isSafeInteger(ref.generation) || ref.generation < 1
    || ref.objectKey !== restorePointObjectKey(workspace.companyId, workspace.id, ref.generation, ref.id)
    || !/^[0-9a-f]{64}$/.test(ref.sha256) || !/^[0-9a-f]{64}$/.test(ref.digest)
    || !Number.isSafeInteger(ref.byteSize) || ref.byteSize <= 0 || ref.byteSize > MAX_RESTORE_POINT_BYTES
    || !ref.key || typeof ref.key !== "object" || Array.isArray(ref.key)) {
    throw new TaskDirectoryRestoreFailure("invalid_restore_point_reference");
  }
  return ref;
}

function skipReason(error: unknown) {
  if (error instanceof TaskDirectorySnapshotSkip) return error.reason;
  if (error instanceof IsolatedRepositorySourceBusy) return "source_busy";
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return "task_directory_changed";
  return error instanceof Error && /^[a-z][a-z_]+$/.test(error.message) ? error.message : "inspection_failed";
}

function recordSkip(result: { skipReason: string | null; failure?: GitExpirationFailure }, error: unknown) {
  result.skipReason = skipReason(error);
  if (result.skipReason === "inspection_failed") result.failure = describeGitExpirationFailure(error);
}

async function directoryState(target: string) {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return "missing" as const;
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(target) !== target) throw new Error("unsafe_task_directory");
  return "present" as const;
}

async function exists(target: string) {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function issueBoundToWorkspace(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], workspace: Workspace) {
  const [bound] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, workspace.companyId),
    eq(issues.id, workspace.sourceIssueId!), eq(issues.executionWorkspaceId, workspace.id)));
  return Boolean(bound);
}

async function storeTaskDirectoryRestorePoint(db: Db, storage: StorageService, workspace: Workspace, generation: number,
  captured: Awaited<ReturnType<typeof captureTaskDirectorySnapshot>>, signal?: AbortSignal) {
  const id = randomUUID();
  const sealed = await sealRestorePoint(captured.payload, { companyId: workspace.companyId, workspaceId: workspace.id, restorePointId: id, generation });
  const objectKey = restorePointObjectKey(workspace.companyId, workspace.id, generation, id);
  const ledgerId = await storeSealedRestorePoint({ db, storage, workspace: { companyId: workspace.companyId, id: workspace.id,
    sourceIssueId: workspace.sourceIssueId }, generation, checkoutName: "", objectKey, sealed, signal });
  const ref: TaskDirectoryRestorePointRef = { schema: TASK_DIRECTORY_RESTORE_POINT_SCHEMA, id, objectKey, sha256: sealed.sha256,
    byteSize: sealed.ciphertext.length, key: sealed.key, generation, digest: captured.digest, files: captured.files, excluded: captured.excluded };
  return { ledgerId, ref };
}

export async function expireIsolatedTaskDirectory(db: Db, snapshot: Workspace, options: {
  dryRun: boolean;
  now: Date;
  notBefore: Date;
  restorePoint?: TaskDirectoryRestorePointOptions;
  signal?: AbortSignal;
  beforeDelete?: (workspace: Workspace) => Promise<void>;
}): Promise<TaskDirectoryRetentionResult> {
  const result: TaskDirectoryRetentionResult = { candidate: false, expired: false, restorePoint: false, candidateBytes: 0, reclaimedBytes: 0, skipReason: null };
  let pending: string | null = null;
  if (!await isIsolatedTaskDirectoryWorkspace(snapshot)) return { ...result, skipReason: "not_task_directory" };
  const closed = ["archived", "cleanup_failed"].includes(snapshot.status);
  const existing = readTaskDirectoryRetention(snapshot);
  if (existing?.removed) return { ...result, skipReason: "already_removed" };
  if (!existing && options.now.getTime() < options.notBefore.getTime()) return { ...result, skipReason: "not_due" };
  if (!existing && !options.dryRun) {
    if (!options.restorePoint) return { ...result, skipReason: "restore_points_disabled" };
    if (!options.restorePoint.keyDurable) return { ...result, skipReason: "restore_point_key_not_durable" };
  }
  try {
    return await withIsolatedRepositorySourceLock(db, snapshot.companyId, snapshot.sourceIssueId!, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        const acquired = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${snapshot.id}`}, 0)) as locked`);
        if (!acquired[0]?.locked) throw new Error("lifecycle_busy");
        let [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id),
          eq(executionWorkspaces.companyId, snapshot.companyId)));
        if (!workspace || workspace.updatedAt.getTime() !== snapshot.updatedAt.getTime()) throw new Error("workspace_changed");
        if (!await issueBoundToWorkspace(tx, workspace)) throw new Error("issue_not_bound");
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now, undefined, { closedSiblingsAllowed: true })) {
          throw new Error("live_or_unresolved_consumer");
        }
        const cwd = workspace.cwd!;
        let state = readTaskDirectoryRetention(workspace);
        const present = await directoryState(cwd) === "present";
        if (!state) {
          if (!present) throw new Error("missing_task_directory");
          result.candidateBytes = await allocatedBytes(cwd, () => { options.signal?.throwIfAborted(); return true; });
          const captured = await captureTaskDirectorySnapshot(cwd, { limits: options.restorePoint?.limits, signal: options.signal });
          result.candidate = true;
          if (options.dryRun) return result;
          const generation = Number(workspace.metadata?.lifecycleGeneration ?? 0) + 1;
          const stored = await storeTaskDirectoryRestorePoint(db, options.restorePoint!.storage, workspace, generation, captured, options.signal);
          pending = stored.ledgerId;
          result.restorePoint = true;
          state = { schema: TASK_DIRECTORY_RETENTION_SCHEMA, generation, removed: false,
            trash: shortSiblingName(cwd, ".expired-"), restorePoint: stored.ref };
          if (await exists(state.trash)) throw new Error("unknown_task_directory_trash");
          const metadata = { ...workspace.metadata, lifecycleGeneration: generation, [TASK_DIRECTORY_RETENTION_KEY]: state };
          const archive = closed ? { metadata, updatedAt: options.now } : { status: "archived", closedAt: options.now,
            cleanupEligibleAt: options.now, cleanupReason: TASK_DIRECTORY_RETENTION_REASON, metadata, updatedAt: options.now };
          [workspace] = await db.transaction(async archiveTx => {
            const rows = await archiveTx.update(executionWorkspaces).set(archive).where(eq(executionWorkspaces.id, workspace!.id)).returning();
            await activateGitRestorePoints(archiveTx, { ledgerIds: [stored.ledgerId], workspaceId: workspace!.id, at: options.now });
            return rows;
          });
          pending = null;
          if (!closed) {
            await logActivity(db, {
              companyId: workspace!.companyId,
              actorType: "system",
              actorId: "workspace_terminality_reaper",
              action: "execution_workspace.task_directory_archived",
              entityType: "execution_workspace",
              entityId: workspace!.id,
              details: { sourceIssueId: workspace!.sourceIssueId, restorePointId: stored.ref.id, cleanupReason: TASK_DIRECTORY_RETENTION_REASON },
            });
          }
        } else {
          result.candidate = true;
          if (present) result.candidateBytes = await allocatedBytes(cwd, () => { options.signal?.throwIfAborted(); return true; });
          if (options.dryRun) return result;
        }
        if (!workspace) throw new Error("workspace_changed");
        await options.beforeDelete?.(workspace);
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now, undefined, { closedSiblingsAllowed: true })) {
          throw new Error("live_or_unresolved_consumer");
        }
        if (await directoryState(cwd) === "present") {
          const current = await inspectTaskDirectory(cwd, { limits: options.restorePoint?.limits, signal: options.signal })
            .catch((error: unknown) => {
              if (error instanceof TaskDirectorySnapshotSkip) return null;
              throw error;
            });
          if (!current || current.digest !== state.restorePoint.digest) {
            if (workspace.cleanupReason === TASK_DIRECTORY_RETENTION_REASON) {
              const metadata: Record<string, unknown> = { ...workspace.metadata, lifecycleGeneration: state.generation + 1 };
              delete metadata[TASK_DIRECTORY_RETENTION_KEY];
              await db.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupEligibleAt: null, cleanupReason: null,
                metadata, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
            } else {
              const metadata: Record<string, unknown> = { ...workspace.metadata };
              delete metadata[TASK_DIRECTORY_RETENTION_KEY];
              await db.update(executionWorkspaces).set({ metadata, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
            }
            await abandonTaskDirectoryRestorePoint(db, workspace.id, state.restorePoint.objectKey);
            throw new Error("task_directory_changed");
          }
          await fs.rename(cwd, state.trash);
        }
        if (await exists(state.trash)) {
          const bytes = await allocatedBytes(state.trash, () => { options.signal?.throwIfAborted(); return true; }).catch(() => result.candidateBytes);
          await removeTaskDirectoryTree(state.trash);
          result.reclaimedBytes = bytes;
        }
        const removedAt = new Date().toISOString();
        await db.update(executionWorkspaces).set({
          metadata: sql`jsonb_set(jsonb_set(${executionWorkspaces.metadata}, ${`{${TASK_DIRECTORY_RETENTION_KEY},removed}`}::text[], 'true'::jsonb),
            ${`{${TASK_DIRECTORY_RETENTION_KEY},removedAt}`}::text[], ${JSON.stringify(removedAt)}::jsonb)`,
          updatedAt: new Date(),
        }).where(and(eq(executionWorkspaces.id, workspace.id),
          sql`${executionWorkspaces.metadata}->${TASK_DIRECTORY_RETENTION_KEY}->'restorePoint'->>'objectKey' = ${state.restorePoint.objectKey}`));
        await logActivity(db, {
          companyId: workspace.companyId,
          actorType: "system",
          actorId: "workspace_terminality_reaper",
          action: "execution_workspace.task_directory_removed",
          entityType: "execution_workspace",
          entityId: workspace.id,
          details: { sourceIssueId: workspace.sourceIssueId, restorePointId: state.restorePoint.id, reclaimedBytes: result.reclaimedBytes,
            cleanupReason: TASK_DIRECTORY_RETENTION_REASON },
        });
        result.expired = true;
        return result;
      })), true);
  } catch (error) {
    if (pending) await abandonGitRestorePoint(db, pending).catch(() => undefined);
    options.signal?.throwIfAborted();
    recordSkip(result, error);
    return result;
  }
}

async function abandonTaskDirectoryRestorePoint(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], workspaceId: string, objectKey: string) {
  await db.transaction(async tx => {
    await notifyGitRestorePointWork(tx, `workspace:${workspaceId}`);
    await tx.update(executionWorkspaceRestorePoints).set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId), eq(executionWorkspaceRestorePoints.objectKey, objectKey),
        inArray(executionWorkspaceRestorePoints.status, ["pending", "active"])));
  });
}

export async function supersedeTaskDirectoryRestorePoint(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], workspace: { id: string; metadata?: Record<string, unknown> | null }) {
  const state = readTaskDirectoryRetention(workspace);
  if (state) await abandonTaskDirectoryRestorePoint(tx, workspace.id, state.restorePoint.objectKey);
}

export async function restoreIsolatedTaskDirectory(input: {
  storage: StorageService;
  workspace: Pick<Workspace, "id" | "companyId" | "sourceIssueId" | "strategyType" | "providerType" | "repoUrl" | "branchName" | "cwd" | "providerRef" | "mode" | "metadata">;
  signal?: AbortSignal;
}): Promise<{ restored: boolean; expired: boolean }> {
  const state = readTaskDirectoryRetention(input.workspace);
  if (!state) return { restored: false, expired: false };
  if (!await isIsolatedTaskDirectoryWorkspace(input.workspace)) throw new TaskDirectoryRestoreFailure("task_directory_identity_changed");
  const cwd = input.workspace.cwd!;
  const parent = path.dirname(cwd);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw new TaskDirectoryRestoreFailure("task_directory_identity_changed");
  const ref = validateRestorePointRef(state.restorePoint, input.workspace);
  if (await directoryState(cwd) === "present") {
    if (!state.removed) return { restored: false, expired: false };
    if ((await fs.readdir(cwd)).length === 0) await fs.rmdir(cwd);
    else {
      const current = await inspectTaskDirectory(cwd, { signal: input.signal }).catch(() => null);
      if (current?.digest === ref.digest) return { restored: false, expired: false };
      throw new TaskDirectoryRestoreFailure("task_directory_diverged");
    }
  }
  if (ref.expiredAt) {
    await fs.mkdir(cwd, { mode: 0o700 });
    return { restored: false, expired: true };
  }
  const ciphertext = await readRestorePointObject(input.storage, input.workspace.companyId, ref.objectKey, input.signal).catch(() => {
    throw new TaskDirectoryRestoreFailure("restore_point_unavailable");
  });
  if (ciphertext.length !== ref.byteSize) throw new TaskDirectoryRestoreFailure("ciphertext_size_mismatch");
  const payload = await openRestorePoint({ ciphertext, sha256: ref.sha256, key: ref.key,
    identity: { companyId: input.workspace.companyId, workspaceId: input.workspace.id, restorePointId: ref.id, generation: ref.generation } });
  const staging = await materializeTaskDirectorySnapshot({ payload, target: cwd, expectedDigest: ref.digest, signal: input.signal });
  try {
    await fs.rename(staging, cwd);
  } catch (error) {
    await removeTaskDirectoryTree(staging).catch(() => undefined);
    throw error;
  }
  return { restored: true, expired: false };
}

export type TaskDirectoryFolderResult = {
  companyId: string;
  issueId: string;
  outcome: "removed" | "preserved_and_removed" | "dry_run" | "skipped";
  reason: string | null;
  candidateBytes: number;
  reclaimedBytes: number;
  executionWorkspaceId?: string;
  retryAt?: number;
  walkRetryAt?: number;
  failure?: GitExpirationFailure;
};

type IssueTree = { exists: boolean; open: boolean; closedAt: Date | null };

async function issueTreeState(db: Db, companyId: string, issueId: string): Promise<IssueTree> {
  const rows = await db.execute<{ total: number; open: number; closed_at: string | Date | null }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id, status, completed_at, cancelled_at, updated_at FROM ${issues}
      WHERE company_id = ${companyId} AND id = ${issueId}
      UNION
      SELECT c.id, c.status, c.completed_at, c.cancelled_at, c.updated_at FROM ${issues} c
      JOIN tree p ON c.parent_id = p.id WHERE c.company_id = ${companyId}
    )
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::int AS open,
      max(CASE WHEN status = 'done' THEN coalesce(completed_at, updated_at)
        WHEN status = 'cancelled' THEN coalesce(cancelled_at, updated_at) END) AS closed_at
    FROM tree`);
  const state = rows[0];
  if (!state || state.total === 0) return { exists: false, open: false, closedAt: null };
  return { exists: true, open: state.open > 0, closedAt: state.closed_at ? new Date(state.closed_at) : null };
}

async function folderRows(db: Db, folder: string) {
  return db.select().from(executionWorkspaces).where(or(eq(executionWorkspaces.cwd, folder), eq(executionWorkspaces.providerRef, folder),
    sql`left(${executionWorkspaces.cwd}, length(${folder}) + 1) = ${folder} || '/'`,
    sql`left(${executionWorkspaces.providerRef}, length(${folder}) + 1) = ${folder} || '/'`));
}

async function orphanConsumer(db: Db, companyId: string, issueId: string, folder: string) {
  const scope = { companyId, sourceIssueId: issueId, id: "00000000-0000-0000-0000-000000000000", cwd: folder } as Workspace;
  const rows = await db.execute<{ reason: string | null }>(sql`${expirationScope(scope)}
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM ${projectWorkspaces} WHERE cwd = ${folder} OR left(cwd, length(${folder}) + 1) = ${folder} || '/') THEN 'project_workspace'
      WHEN EXISTS (SELECT 1 FROM ${workspaceRuntimeServices} WHERE status <> 'stopped'
        AND (cwd = ${folder} OR left(cwd, length(${folder}) + 1) = ${folder} || '/')) THEN 'live_runtime_service'
      WHEN EXISTS (SELECT 1 FROM relevant_runs WHERE status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
        OR finished_at IS NULL OR controller_lease_expires_at > now()) THEN 'live_run'
      WHEN EXISTS (SELECT 1 FROM ${nativeRunFinalizations} f WHERE f.company_id = ${companyId}
        AND (f.issue_id IN (SELECT id FROM tree) OR f.run_id IN (SELECT id FROM relevant_runs))
        AND (f.lease_owner IS NOT NULL OR f.phase NOT IN ('committed', 'terminal_failure'))) THEN 'unsettled_finalization'
      WHEN EXISTS (SELECT 1 FROM ${environmentLeases} l WHERE l.company_id = ${companyId}
        AND (l.heartbeat_run_id IN (SELECT id FROM relevant_runs) OR l.issue_id IN (SELECT id FROM tree)
          OR l.execution_workspace_id IN (SELECT w.id FROM ${executionWorkspaces} w WHERE w.cwd = ${folder} OR w.provider_ref = ${folder}
            OR left(w.cwd, length(${folder}) + 1) = ${folder} || '/' OR left(w.provider_ref, length(${folder}) + 1) = ${folder} || '/'))
        AND (l.status = 'pending_cleanup' OR l.cleanup_status = 'failed' OR l.metadata ? 'nativeWorkspaceExportResume'
          OR (l.released_at IS NULL AND NOT coalesce(l.status = 'retained' AND l.lease_policy = 'reuse_by_environment' AND l.cleanup_status = 'success', false)))) THEN 'live_lease'
      WHEN EXISTS (SELECT 1 FROM ${issueRecoveryActions} WHERE company_id = ${companyId}
        AND source_issue_id IN (SELECT id FROM tree) AND status IN ('active', 'escalated')) THEN 'recovery_action'
      ELSE NULL END AS reason`);
  return rows[0]?.reason ?? null;
}

async function listDirectory(target: string) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return [];
  return (await fs.readdir(target)).sort();
}

type FolderSweepOptions = {
  dryRun: boolean;
  now: Date;
  orphanGraceMs: number;
  terminalDelayMs: number;
  restorePoint?: TaskDirectoryRestorePointOptions;
  signal?: AbortSignal;
  beforeDelete?: (workspace: Workspace) => Promise<void>;
};

const CONSUMER_SKIPS = new Set(["live_workspace", "retention_pending", "project_workspace", "live_runtime_service", "live_run",
  "unsettled_finalization", "live_lease", "recovery_action"]);

async function inspectTaskDirectoryFolder(db: Db, companyId: string, name: string, options: FolderSweepOptions): Promise<TaskDirectoryFolderResult | null> {
  const nowMs = options.now.getTime();
  const root = await isolatedTaskDirectoriesRoot();
  if (!root) return null;
  const companyDir = path.join(root, companyId);
  const folder = path.join(companyDir, name);
  const result: TaskDirectoryFolderResult = { companyId, issueId: name, outcome: "skipped", reason: null, candidateBytes: 0, reclaimedBytes: 0 };
  const retry = (at: number) => { result.retryAt = result.retryAt === undefined ? at : Math.min(result.retryAt, at); };
  try {
    if (!UUID.test(name) || !UUID.test(companyId)) throw new Error("unrecognized_task_directory_name");
    const stat = await fs.lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_task_directory");
    const rows = await folderRows(db, folder);
    if (rows.some(row => !["archived", "cleanup_failed"].includes(row.status) || row.closedAt === null)) return null;
    if (rows.some(row => hasPendingTaskDirectoryRetention(row))) throw new Error("retention_pending");
    const [issue] = await db.select({ id: issues.id, executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, name)));
    const tree = issue ? await issueTreeState(db, companyId, name) : { exists: false, open: false, closedAt: null };
    if (tree.exists && (tree.open || !tree.closedAt)) throw new Error("issue_open");
    const bound = issue ? rows.find(row => row.id === issue.executionWorkspaceId) : undefined;
    if (bound) {
      if (bound.cwd !== folder || !await isIsolatedTaskDirectoryWorkspace(bound)) throw new Error("bound_workspace");
      result.executionWorkspaceId = bound.id;
      const dueAt = tree.closedAt!.getTime() + options.terminalDelayMs;
      if (dueAt > nowMs) { retry(dueAt); throw new Error("not_due"); }
      const expiration = await expireIsolatedTaskDirectory(db, bound, { dryRun: options.dryRun, now: options.now,
        notBefore: new Date(dueAt), restorePoint: options.restorePoint, signal: options.signal, beforeDelete: options.beforeDelete });
      result.candidateBytes = expiration.candidateBytes;
      result.reclaimedBytes = expiration.reclaimedBytes;
      result.reason = expiration.skipReason;
      if (expiration.failure) result.failure = expiration.failure;
      result.outcome = expiration.expired ? "preserved_and_removed" : options.dryRun && expiration.candidate ? "dry_run" : "skipped";
      if (isRetryableTaskDirectorySkip(expiration.skipReason)) retry(nowMs + TASK_DIRECTORY_RETRY_MS);
      return result;
    }
    if (tree.exists && tree.closedAt!.getTime() + options.orphanGraceMs > nowMs) {
      retry(tree.closedAt!.getTime() + options.orphanGraceMs);
      throw new Error("grace_pending");
    }
    const newest = await newestTaskDirectoryMtime(folder, options.signal);
    if (newest + options.orphanGraceMs > nowMs) {
      retry(newest + options.orphanGraceMs);
      throw new Error("recently_modified");
    }
    await withIsolatedRepositorySourceLock(db, companyId, name, async () => {
      if (await directoryState(folder) !== "present") throw new Error("task_directory_changed");
      const current = await folderRows(db, folder);
      if (current.some(row => !["archived", "cleanup_failed"].includes(row.status) || row.closedAt === null)) throw new Error("live_workspace");
      if (current.some(row => hasPendingTaskDirectoryRetention(row))) throw new Error("retention_pending");
      const [currentIssue] = await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, name)));
      if (Boolean(currentIssue) !== Boolean(issue) || (currentIssue && currentIssue.executionWorkspaceId !== issue!.executionWorkspaceId)) {
        throw new Error("task_directory_changed");
      }
      const consumer = await orphanConsumer(db, companyId, name, folder);
      if (consumer) throw new Error(consumer);
      if (tree.exists) {
        const latest = await issueTreeState(db, companyId, name);
        if (latest.open || !latest.closedAt || latest.closedAt.getTime() + options.orphanGraceMs > nowMs) throw new Error("issue_open");
      }
      result.candidateBytes = await allocatedBytes(folder, () => { options.signal?.throwIfAborted(); return true; }).catch(() => 0);
      if (options.dryRun) {
        result.outcome = "dry_run";
        return;
      }
      const trash = shortSiblingName(folder, ".expired-");
      await fs.rename(folder, trash);
      await removeTaskDirectoryTree(trash).catch(() => {
        result.walkRetryAt = nowMs + TASK_DIRECTORY_RETRY_MS;
        throw new Error("task_directory_trash_pending");
      });
      result.outcome = "removed";
      result.reclaimedBytes = result.candidateBytes;
    }, true);
  } catch (error) {
    options.signal?.throwIfAborted();
    result.reason = skipReason(error);
    if (result.reason === "inspection_failed") result.failure = describeGitExpirationFailure(error);
    if (isRetryableTaskDirectorySkip(result.reason) || CONSUMER_SKIPS.has(result.reason)) retry(nowMs + TASK_DIRECTORY_RETRY_MS);
  }
  return result;
}

export async function inspectIsolatedTaskDirectoryFolders(db: Db, folders: Array<{ companyId: string; issueId: string }>, options: FolderSweepOptions) {
  const results: TaskDirectoryFolderResult[] = [];
  for (const folder of folders) {
    options.signal?.throwIfAborted();
    if (!IDENTITY.test(folder.companyId) || !IDENTITY.test(folder.issueId)) continue;
    const result = await inspectTaskDirectoryFolder(db, folder.companyId, folder.issueId, options);
    if (result) results.push(result);
  }
  return results;
}

export async function sweepIsolatedTaskDirectories(db: Db, options: FolderSweepOptions & { after?: string | null; limit?: number }):
  Promise<{ results: TaskDirectoryFolderResult[]; next: string | null; retryAt: number | null }> {
  const results: TaskDirectoryFolderResult[] = [];
  const limit = options.limit ?? 8;
  const nowMs = options.now.getTime();
  let retryAt: number | null = null;
  const retry = (at: number) => { retryAt = retryAt === null ? at : Math.min(retryAt, at); };
  const root = await isolatedTaskDirectoriesRoot();
  if (!root) return { results, next: null, retryAt };
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return { results, next: null, retryAt };
  const [afterCompany, afterIssue] = options.after?.split("/") ?? [];
  let inspected = 0;
  let lastPosition: string | null = null;
  for (const companyId of await listDirectory(root)) {
    if (!IDENTITY.test(companyId)) continue;
    const companyDir = path.join(root, companyId);
    for (const name of await listDirectory(companyDir)) {
      options.signal?.throwIfAborted();
      if (afterCompany !== undefined && (companyId < afterCompany || (companyId === afterCompany && name <= afterIssue!))) continue;
      if (inspected >= limit) return { results, next: lastPosition, retryAt };
      inspected += 1;
      lastPosition = `${companyId}/${name}`;
      if (TRASH.test(name)) {
        const folder = path.join(companyDir, name);
        const stat = await fs.lstat(folder).catch(() => null);
        if (!stat || options.dryRun) continue;
        const touched = Math.max(stat.mtimeMs, stat.ctimeMs);
        if (touched + TRASH_GRACE_MS > nowMs) { retry(touched + TRASH_GRACE_MS); continue; }
        await removeTaskDirectoryTree(folder).catch(() => retry(nowMs + TASK_DIRECTORY_RETRY_MS));
        continue;
      }
      const result = await inspectTaskDirectoryFolder(db, companyId, name, options);
      if (result) results.push(result);
    }
  }
  return { results, next: null, retryAt };
}

export async function taskDirectoryFoldersForHints(db: Db, hints: { workspaceIds: string[]; issueIds: string[] }) {
  const folders = new Map<string, { companyId: string; issueId: string }>();
  const workspaceIds = hints.workspaceIds.filter(id => UUID.test(id));
  const issueIds = hints.issueIds.filter(id => UUID.test(id));
  if (workspaceIds.length > 0) {
    const rows = await db.select({ companyId: executionWorkspaces.companyId, sourceIssueId: executionWorkspaces.sourceIssueId })
      .from(executionWorkspaces).where(and(inArray(executionWorkspaces.id, workspaceIds),
        inArray(executionWorkspaces.status, ["archived", "cleanup_failed"]), eq(executionWorkspaces.strategyType, "project_primary")));
    for (const row of rows) if (row.sourceIssueId) folders.set(`${row.companyId}/${row.sourceIssueId}`, { companyId: row.companyId, issueId: row.sourceIssueId });
  }
  if (issueIds.length > 0) {
    const rows = await db.execute<{ id: string; company_id: string }>(sql`
      WITH RECURSIVE closed_up AS (
        SELECT id, parent_id, company_id, 0 AS depth FROM ${issues}
        WHERE id IN (${sql.join(issueIds.map(id => sql`${id}::uuid`), sql`, `)}) AND status IN ('done', 'cancelled')
        UNION
        SELECT p.id, p.parent_id, p.company_id, c.depth + 1 FROM ${issues} p
        JOIN closed_up c ON p.id = c.parent_id AND p.company_id = c.company_id WHERE c.depth < 64
      )
      SELECT DISTINCT id, company_id FROM closed_up`);
    for (const row of rows) folders.set(`${row.company_id}/${row.id}`, { companyId: row.company_id, issueId: row.id });
  }
  const present: Array<{ companyId: string; issueId: string }> = [];
  for (const folder of folders.values()) {
    const target = await canonicalTaskDirectory(folder.companyId, folder.issueId);
    if (target && await exists(target)) present.push(folder);
  }
  return present;
}

export function taskDirectoryCandidateFilter() {
  return and(inArray(executionWorkspaces.status, ["archived", "cleanup_failed"]),
    sql`${executionWorkspaces.metadata}->${TASK_DIRECTORY_RETENTION_KEY}->>'removed' = 'false'`);
}
