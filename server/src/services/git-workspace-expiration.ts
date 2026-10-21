import { captureGitWorkspaceContents, assertGitWorkspaceContentsUnchanged, readManagedCheckoutContents, selectRestoredProjectRepositories, type ManagedCheckoutContents } from "./git-workspace-contents.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireGitExpirationLocks } from "./git-workspace-expiration-locks.js";
import { and, eq, ne, sql } from "drizzle-orm";
import { executionWorkspaces, issues, heartbeatRuns, nativeRunFinalizations, environmentLeases,
  workspaceRuntimeServices, issueRecoveryActions, projectWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { withIsolatedRepositorySourceLock, verifiedRecordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { assertReproducibleGitFiles, assertReproducibleBaseGitStorage, assertReproducibleManagedCheckout, inspectGitCacheRecipe, readGitCacheRestoration,
  verifyRemoteGitCommit, gitCacheExpirationLockLocations, recoverGitCacheExpirationLocks, GitCacheRestorationFailure, type ManagedCheckoutProver, gitCacheCommand, readGitCacheExpiration, finishGitCacheTrash, type GitCacheExpiration, GIT_CACHE_RESTORATION_KEY, GIT_CACHE_EXPIRATION_REASON } from "./git-workspace-restoration.js";

async function allocatedBytes(target: string, shouldContinue: () => boolean): Promise<number> {
  if (!shouldContinue()) throw new Error("scan_stopped");
  const entry = await fs.lstat(target);
  if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) throw new Error("unsupported_filesystem_entry");
  let bytes = entry.blocks * 512;
  if (entry.isDirectory()) for (const name of await fs.readdir(target)) bytes += await allocatedBytes(path.join(target, name), shouldContinue);
  return bytes;
}
export function gitExpirationSkipReason(error: unknown) {
  if (error instanceof GitCacheRestorationFailure) return "upstream_commit_unverified";
  return error instanceof Error && /^[a-z][a-z_]+$/.test(error.message) ? error.message : "inspection_failed";
}
const skipReason = gitExpirationSkipReason;

export function withAnonymousGitFallback(provider: GitRemoteAuthProvider): GitRemoteAuthProvider {
  return async (remoteUrl) => provider(remoteUrl).catch(() => null);
}

function expirationGitAuth(db: Db, workspace: Workspace) {
  return withAnonymousGitFallback(createGitRemoteAuthProvider(db, workspace.companyId, { issueId: workspace.sourceIssueId! }));
}

const EXPIRATION_KEY = "gitCacheExpiration";
const DAY_MS = 24 * 60 * 60 * 1000;
type Workspace = typeof executionWorkspaces.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Expiration = GitCacheExpiration;
export type GitExpirationResult = { candidate: boolean; expired: boolean; reclaimedBytes: number;
  candidateBytes: number; baseExpired: boolean; skipReason: string | null };

/** Re-read the whole tree and every runtime/recovery consumer immediately before deletion. */
export async function isGitWorkspaceExpirationEligible(tx: Tx, workspace: Workspace, now: Date) {
  if (workspace.metadata?.reopenPendingConsumption === true) return false;
  const rows = await tx.execute<{ allowed: boolean }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id, status, completed_at, cancelled_at, updated_at FROM ${issues}
      WHERE company_id = ${workspace.companyId} AND id = ${workspace.sourceIssueId}
      UNION
      SELECT c.id, c.status, c.completed_at, c.cancelled_at, c.updated_at FROM ${issues} c
      JOIN tree p ON c.parent_id = p.id WHERE c.company_id = ${workspace.companyId}
    ), relevant_runs AS (
      SELECT r.* FROM ${heartbeatRuns} r WHERE r.company_id = ${workspace.companyId} AND (
        r.issue_id IN (SELECT id FROM tree) OR r.native_issue_id IN (SELECT id FROM tree)
        OR r.context_snapshot->>'issueId' IN (SELECT id::text FROM tree)
        OR r.context_snapshot->>'taskId' IN (SELECT id::text FROM tree)
        OR r.context_snapshot->>'executionWorkspaceId' = ${workspace.id}
        OR r.id IN (SELECT unnest(ARRAY[checkout_run_id, execution_run_id]) FROM ${issues}
          WHERE company_id = ${workspace.companyId} AND execution_workspace_id = ${workspace.id})
      )
    ) SELECT CASE WHEN
      EXISTS (SELECT 1 FROM ${executionWorkspaces} other WHERE other.id <> ${workspace.id}
        AND (other.cwd = ${workspace.cwd} OR other.provider_ref = ${workspace.cwd}
          OR left(other.cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/'))
      OR EXISTS (SELECT 1 FROM ${projectWorkspaces} WHERE cwd = ${workspace.cwd}
        OR left(cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/')
    THEN false ELSE (
      EXISTS (SELECT 1 FROM tree)
      AND NOT EXISTS (SELECT 1 FROM tree WHERE status NOT IN ('done', 'cancelled')
        OR coalesce(CASE WHEN status = 'done' THEN completed_at ELSE cancelled_at END, updated_at) > ${new Date(now.getTime() - DAY_MS).toISOString()}::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM ${issues} WHERE company_id = ${workspace.companyId}
        AND execution_workspace_id = ${workspace.id} AND status NOT IN ('done', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM relevant_runs WHERE status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
        OR finished_at IS NULL OR controller_lease_expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM ${issueRecoveryActions} WHERE company_id = ${workspace.companyId}
        AND source_issue_id IN (SELECT id FROM tree) AND status IN ('active', 'escalated'))
      AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations} f WHERE f.company_id = ${workspace.companyId}
        AND (f.issue_id IN (SELECT id FROM tree) OR f.run_id IN (SELECT id FROM relevant_runs))
        AND (f.phase <> 'committed' OR f.lease_owner IS NOT NULL OR f.recovery_state IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM ${environmentLeases} l WHERE l.company_id = ${workspace.companyId}
        AND (l.execution_workspace_id = ${workspace.id} OR l.heartbeat_run_id IN (SELECT id FROM relevant_runs))
        AND (l.status = 'pending_cleanup' OR l.cleanup_status = 'failed' OR l.metadata ? 'nativeWorkspaceExportResume'
          OR (l.released_at IS NULL AND NOT coalesce(l.status = 'retained' AND l.lease_policy = 'reuse_by_environment' AND l.cleanup_status = 'success', false))))
      AND NOT EXISTS (SELECT 1 FROM ${workspaceRuntimeServices} WHERE company_id = ${workspace.companyId}
        AND (execution_workspace_id = ${workspace.id} OR cwd = ${workspace.cwd}
          OR left(cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/') AND status <> 'stopped')

    ) END AS allowed`);
  return rows[0]?.allowed === true;
}

export function hasPendingGitExpiration(workspace: Workspace) {
  const state = workspace.metadata?.[EXPIRATION_KEY] as Expiration | undefined;
  return state?.schema === "paperclip.git-cache-expiration.v1" && !state.completed;
}

async function exists(target: string) {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

/** Each ref/reflog object must be recoverable, and no other checkout may consume the base. */
async function inspectBase(db: Db, workspace: Workspace, signal?: AbortSignal, allowCurrentWorktree = false) {
  const recipe = readGitCacheRestoration(workspace)!;
  if (recipe.sourceKind !== "isolated_remote") throw new Error("shared_base_preserved");
  const other = await db.select().from(executionWorkspaces).where(and(ne(executionWorkspaces.id, workspace.id),
    sql`(${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'companyId' = ${workspace.companyId}
      AND ${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'issueId' = ${workspace.sourceIssueId})
      OR ${executionWorkspaces.cwd} = ${recipe.sourcePath} OR ${executionWorkspaces.providerRef} = ${recipe.sourcePath}`));
  if (other.some(row => !["archived", "cleanup_failed"].includes(row.status)
    || !readGitCacheRestoration(row) || !readGitCacheExpiration(row)?.workspaceRemoved)) throw new Error("base_has_consumers");
  const [projectConsumer] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.cwd, recipe.sourcePath)).limit(1);
  if (projectConsumer) throw new Error("base_has_consumers");
  const [service] = await db.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(sql`
    ${workspaceRuntimeServices.status} <> 'stopped' AND (${workspaceRuntimeServices.cwd} = ${recipe.sourcePath}
      OR left(${workspaceRuntimeServices.cwd}, length(${recipe.sourcePath}) + 1) = ${recipe.sourcePath} || '/')`).limit(1);
  if (service) throw new Error("base_has_live_services");
  await verifiedRecordedIsolatedRemoteSource(workspace);
  const worktrees = (await gitCacheCommand(recipe.sourcePath, ["worktree", "list", "--porcelain"], signal))
    .split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
  const allowed = [await fs.realpath(recipe.sourcePath), ...(allowCurrentWorktree ? [await fs.realpath(recipe.worktreePath)] : [])];
  if (worktrees.some(cwd => !allowed.includes(cwd))) throw new Error("base_has_worktrees");
  await assertReproducibleGitFiles(recipe.sourcePath, signal);
  await assertReproducibleBaseGitStorage(recipe.sourcePath, signal);
  const refs = (await gitCacheCommand(recipe.sourcePath, ["for-each-ref", "--format=%(objectname) %(refname)"], signal)).trim().split("\n").filter(Boolean);
  if (refs.some(ref => !/^[a-f0-9]{40} refs\/(heads|remotes\/origin)\//.test(ref))) throw new Error("unsupported_base_refs");
  const commits = new Set([...refs.map(ref => ref.split(" ")[0]!),
    ...(await gitCacheCommand(recipe.sourcePath, ["reflog", "show", "--all", "--format=%H"], signal)).trim().split("\n").filter(Boolean)]);
  if (commits.size > 50) throw new Error("base_ref_verification_budget");
  const auth = expirationGitAuth(db, workspace);
  for (const commit of commits) await verifyRemoteGitCommit(recipe.repoUrl, commit, auth, signal);
  // Unreachable objects may contain unique rewritten work not present in a reflog.
  const unreachable = await gitCacheCommand(recipe.sourcePath, ["fsck", "--no-reflogs", "--unreachable", "--no-progress"], signal);
  if (unreachable.trim()) throw new Error("unreachable_base_objects");
  return allocatedBytes(recipe.sourcePath, () => { signal?.throwIfAborted(); return true; });
}

function managedCheckoutProver(db: Db, workspace: Workspace, auth: GitRemoteAuthProvider, checkouts: Map<string, ManagedCheckoutContents>): ManagedCheckoutProver {
  let rows: Promise<Array<{ id: string; repoUrl: string | null; repoRef: string | null; cwd: string | null }>> | undefined;
  return async (checkoutPath, name, signal) => {
    if (!workspace.projectId) throw new Error("unknown_managed_checkout");
    rows ??= db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef,
      cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId)));
    const source = selectRestoredProjectRepositories(await rows, readGitCacheRestoration(workspace)?.contents).find(row => row.repoUrl
      && managedProjectCheckoutName({ id: row.id, repoUrl: row.repoUrl, repoRef: row.repoRef, cwd: row.cwd }) === name);
    if (!source?.repoUrl) throw new Error("unknown_managed_checkout");
    await assertReproducibleManagedCheckout(checkoutPath, { repoUrl: source.repoUrl, resolveGitAuth: auth, signal });
    checkouts.set(name, await readManagedCheckoutContents(checkoutPath, name, { ...source, repoUrl: source.repoUrl }, signal));
  };
}

export async function expireReconstructableGitWorkspace(db: Db, snapshot: Workspace, options: {
  dryRun: boolean; expireBase: boolean; now: Date; signal?: AbortSignal;
  beforeDelete?: (workspace: Workspace) => Promise<void>;
}): Promise<GitExpirationResult> {
  const result: GitExpirationResult = { candidate: false, expired: false, reclaimedBytes: 0,
    candidateBytes: 0, baseExpired: false, skipReason: null };
  if (!snapshot.sourceIssueId) return { ...result, skipReason: "missing_source_issue" };
  try {
    return await withIsolatedRepositorySourceLock(db, snapshot.companyId, snapshot.sourceIssueId, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        const acquired = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${snapshot.id}`}, 0)) as locked`);
        if (!acquired[0]?.locked) throw new Error("lifecycle_busy");
        let workspace = (await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id), eq(executionWorkspaces.companyId, snapshot.companyId))))[0];
        if (!workspace || workspace.updatedAt.getTime() !== snapshot.updatedAt.getTime()) throw new Error("workspace_changed");
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now)) throw new Error("live_or_unresolved_consumer");
        let state = ["active", "idle", "in_review"].includes(workspace.status) ? null : readGitCacheExpiration(workspace);
        // A restored active workspace starts a new expiration cycle and records its new HEAD.
        if (!hasPendingGitExpiration(workspace) && !["active", "idle", "in_review"].includes(workspace.status)) throw new Error("not_expirable");
        if (["active", "idle", "in_review"].includes(workspace.status)) state = null;
        const auth = expirationGitAuth(db, workspace);
        const checkouts = new Map<string, ManagedCheckoutContents>();
        const identity = { companyId: workspace.companyId, workspaceId: workspace.id };
        const proveManagedCheckout = managedCheckoutProver(db, workspace, auth, checkouts);
        let recipe = state ? readGitCacheRestoration(workspace)! : await inspectGitCacheRecipe(workspace,
          auth, options.signal, { proveManagedCheckout });
        if (!state) recipe.contents = await captureGitWorkspaceContents(recipe.worktreePath, identity, [...checkouts.values()]);
        const present = await exists(recipe.worktreePath);
        if (!state && !present) throw new Error("missing_unverified_worktree");
        result.candidate = true;
        if (present) result.candidateBytes = await allocatedBytes(recipe.worktreePath, () => { options.signal?.throwIfAborted(); return true; });
        if (options.dryRun) {
          if (options.expireBase) {
            try { result.candidateBytes += await inspectBase(db, { ...workspace,
              metadata: { ...workspace.metadata, [GIT_CACHE_RESTORATION_KEY]: recipe } }, options.signal, present); }
            catch (error) { result.skipReason = skipReason(error); }
          }
          return result;
        }
        if (!state) {
          const generation = Number(workspace.metadata?.lifecycleGeneration ?? 0) + 1;
          const rawAdmin = (await gitCacheCommand(recipe.worktreePath, ["rev-parse", "--absolute-git-dir"], options.signal)).trim();
          const worktreeAdmin = path.join(recipe.sourcePath, ".git", "worktrees", path.basename(rawAdmin));
          const canonicalAdmin = path.join(await fs.realpath(recipe.sourcePath), ".git", "worktrees", path.basename(rawAdmin));
          if (await fs.realpath(worktreeAdmin) !== canonicalAdmin || await fs.realpath(rawAdmin) !== canonicalAdmin) {
            throw new Error("unproven_worktree_admin");
          }
          state = { schema: "paperclip.git-cache-expiration.v1", generation, workspaceRemoved: false,
            worktreeTrash: path.join(path.dirname(recipe.worktreePath), `.expired-git-worktree-${workspace.id}-${generation}`),
            worktreeAdmin, baseTrash: null, completed: false, lockToken: randomBytes(32).toString("hex") };
          if (await exists(state.worktreeTrash)) throw new Error("unknown_worktree_trash");
          // Commit the immutable restoration recipe BEFORE touching disk. The separate
          // lifecycle-lock connection remains held through deletion and final state.
          [workspace] = await db.update(executionWorkspaces).set({ status: "archived", closedAt: options.now,
            cleanupEligibleAt: options.now, cleanupReason: GIT_CACHE_EXPIRATION_REASON, updatedAt: options.now,
            metadata: { ...workspace.metadata, lifecycleGeneration: generation, [GIT_CACHE_RESTORATION_KEY]: recipe, [EXPIRATION_KEY]: state },
          }).where(eq(executionWorkspaces.id, workspace.id)).returning();
        }
        if (!workspace) throw new Error("workspace_changed");
        const persist = async () => {
          [workspace] = await db.update(executionWorkspaces).set({ metadata: { ...workspace!.metadata, [EXPIRATION_KEY]: state }, updatedAt: new Date() })
            .where(eq(executionWorkspaces.id, snapshot.id)).returning();
        };
        if (!state.lockToken) {
          state.lockToken = randomBytes(32).toString("hex");
          await persist();
        }
        await recoverGitCacheExpirationLocks(workspace!);
        const lockLocations = gitCacheExpirationLockLocations(workspace!);
        await options.beforeDelete?.(workspace!);
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now)) throw new Error("live_or_unresolved_consumer");
        if (!state.workspaceRemoved && present) {
          const locks = [await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === null), state.lockToken)];
          try {
            try {
              checkouts.clear();
              await assertReproducibleGitFiles(recipe.worktreePath, options.signal, { proveManagedCheckout, preserveSettings: true,
                verifyFetchedCommit: (commit, signal) => verifyRemoteGitCommit(recipe.repoUrl, commit, auth, signal) });
              for (const checkout of checkouts.values()) {
                const cwd = path.join(recipe.worktreePath, ".paperclip-repositories", checkout.name);
                locks.push(await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === checkout.name), state.lockToken));
                if ((await gitCacheCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], options.signal)).length) throw new Error("managed_checkouts_changed");
                checkouts.set(checkout.name, await readManagedCheckoutContents(cwd, checkout.name, checkout.source, options.signal));
              }
              await assertGitWorkspaceContentsUnchanged(recipe.worktreePath, identity, recipe.contents, [...checkouts.values()]);
              if ((await gitCacheCommand(recipe.worktreePath, ["symbolic-ref", "--short", "HEAD"], options.signal)).trim() !== recipe.branchName) throw new Error("branch_identity_changed");
              if ((await gitCacheCommand(recipe.worktreePath, ["rev-parse", "HEAD"], options.signal)).trim() !== recipe.commit) throw new Error("head_changed");
            } catch (error) {
              for (const lock of [...locks].reverse()) await lock.release();
              const metadata: Record<string, unknown> = { ...workspace.metadata, lifecycleGeneration: state.generation + 1,
                [GIT_CACHE_RESTORATION_KEY]: { ...recipe, restoredAt: new Date().toISOString() } };
              delete metadata[EXPIRATION_KEY];
              await db.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupEligibleAt: null,
                cleanupReason: null, metadata, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
              throw error;
            }
            await fs.rename(recipe.worktreePath, state.worktreeTrash);
            await finishGitCacheTrash(workspace);
            result.reclaimedBytes += result.candidateBytes;
          } finally { for (const lock of locks.reverse()) await lock.release(); }
        }
        await finishGitCacheTrash(workspace);
        state.workspaceRemoved = true;
        await persist();
        result.expired = true;
        if (options.expireBase) {
          try {
            if ((!state.baseTrash || !await exists(state.baseTrash)) && await exists(recipe.sourcePath)) {
              const bytes = await inspectBase(db, workspace!, options.signal);
              if (!await isGitWorkspaceExpirationEligible(tx, workspace!, options.now)) throw new Error("live_or_unresolved_consumer");
              const trash = path.join(path.dirname(recipe.sourcePath), `.expired-git-base-${snapshot.id}-${state.generation}`);
              if (await exists(trash)) throw new Error("unknown_base_trash");
              state.baseTrash = trash;
              await persist();
              await fs.rename(recipe.sourcePath, trash);
              result.candidateBytes += bytes;
            }
            if (state.baseTrash && await exists(state.baseTrash)) {
              const stat = await fs.lstat(state.baseTrash);
              if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_base_trash");
              const bytes = await allocatedBytes(state.baseTrash, () => { options.signal?.throwIfAborted(); return true; });
              await fs.rm(state.baseTrash, { recursive: true, force: true });
              result.reclaimedBytes += bytes;
              result.baseExpired = true;
            }
          } catch (error) { result.skipReason = skipReason(error); }
        }
        state.completed = recipe.sourceKind !== "isolated_remote" || !options.expireBase || (result.baseExpired || !await exists(recipe.sourcePath)) && (!state.baseTrash || !await exists(state.baseTrash));
        await persist();
        return result;
      })), true);
  } catch (error) {
    options.signal?.throwIfAborted();
    result.skipReason = skipReason(error);
    return result;
  }
}
