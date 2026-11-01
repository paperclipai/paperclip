import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces, workspaceRuntimeServices, heartbeatRuns, nativeRunFinalizations, environmentLeases,
  withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import { IsolatedRepositorySourceBusy, isolatedRemoteSourcePath, verifiedRecordedIsolatedRemoteSource, withIsolatedRepositorySourceLock } from "./isolated-remote-workspace-source.js";
import { acquireGitExpirationLocks, recoverGitExpirationLocks, type GitExpirationLockLocation } from "./git-workspace-expiration-locks.js";
import { allocatedBytes, describeGitExpirationFailure, expirationScope, gitExpirationSkipReason, withAnonymousGitFallback, type GitExpirationFailure } from "./git-workspace-expiration.js";
import { finishGitCacheTrash, hasCommitsMissingUpstream, managedSourcePaths, readGitCacheExpiration, readGitCacheRestoration, verifiedGitCacheSource,
  GIT_CACHE_RESTORATION_KEY, type GitCacheRestoration } from "./git-workspace-restoration.js";
import { applyRestorePoint, captureRestorePoint, currentRestorePointSnapshot, importRestorePoint, restorePointSavesIgnoredFile,
  RestorePointRestoreFailure, RestorePointSkip, type RestorePointLimits, type RestorePointSnapshot } from "./git-restore-point.js";
import { findRegenerableWorkspaceDirs, REGENERABLE_WORKSPACE_DIR_NAMES, WORKSPACE_COMPACTION_TRASH_DIR } from "./workspace-compaction.js";
import { ensureManagedRepositoriesIgnored } from "./managed-repository-checkout.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";
import { canonicalRepositoryRoot } from "./execution-workspace-source-roots.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { loadGitRestorePoint } from "./git-restore-point-storage.js";
import { nestedWorktreeBranchPrefix, readLinkedNestedCheckout, repairMovedNestedRepositoryWorktree, withNestedRepositoryBaseLock } from "./nested-repository-worktrees.js";
import { getStorageService } from "../storage/index.js";
import { createIssueGitRemoteAuthProvider } from "./git-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFile = promisify(execFileCallback);
const SHA = /^[0-9a-f]{40}$/;
const OPEN_STATUSES = ["active", "idle", "in_review"];
const CLOSED_STATUSES = ["archived", "cleanup_failed"];
const ADMIN_ENTRIES = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "index", "commondir", "gitdir", "logs", "refs", "COMMIT_EDITMSG"]);
const MAX_BOUNDARY_COMMITS = 64;
const CLONE_HISTORY_BUDGET = 5_000;
const CLONE_DIRECTORY_BUDGET = 1_000;
const UNSAFE_BASE_CONFIG = /^(filter\.|include\.|includeif\.|core\.(fsmonitor|hookspath|attributesfile|worktree|gitproxy|sshcommand|askpass|editor|pager|alternaterefscommand)$|extensions\.worktreeconfig$)/;
const GIB = 1024 * 1024 * 1024;
const COMPACTION_TRASH_PATH = `.paperclip/worktrees/${WORKSPACE_COMPACTION_TRASH_DIR}`;
const SOURCE_ID = /^[a-zA-Z0-9_-]+$/;
const ORPHAN_HANDLED_ELSEWHERE = new Set(["base_has_consumers", "rehome_pending", "rehome_cleanup_pending"]);
const SOURCE_TRASH = /^\.(rehomed-checkout|rehomed-worktree|orphaned-checkout)-[a-zA-Z0-9_-]+$/;
export const ISOLATED_REHOME_RESTORE_POINT_LIMITS: RestorePointLimits = {
  maxFiles: 500_000, maxFileBytes: GIB, maxTotalBytes: GIB, maxCommits: 1_000_000, maxBundleBytes: 1.5 * GIB,
};
export const ISOLATED_REPOSITORY_REHOME_KEY = "isolatedRepositoryRehome";
export const ISOLATED_REPOSITORY_REHOME_PENDING_KEY = "isolatedRepositoryRehomePending";

type Workspace = typeof executionWorkspaces.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type IsolatedRepositoryRehomeRecord = { at: string; from: string; to: string; cleanedAt: string | null; cloneRetained?: string };
export type IsolatedRepositoryRehomePending = { base: string; from: string; target: string; branch: string; head: string; previousTip: string | null; moves: string[] };
export type IsolatedRepositoryRehomeHooks = {
  beforeWorktreeAdd?: (input: { from: string; to: string }) => Promise<void>;
  beforeVerify?: (input: { from: string; to: string }) => Promise<void>;
  afterDatabaseUpdate?: (workspace: Workspace) => Promise<void>;
};
export type IsolatedRepositoryRehomeResult = {
  outcome: "rehomed" | "dry_run" | "skipped" | "cleaned" | "clone_kept";
  rehomed: boolean; cloneRemoved: boolean; reason: string | null; cloneKeptReason: string | null; cloneKeptPaths?: string[];
  candidateBytes: number; reclaimedBytes: number; from: string | null; to: string | null; failure?: GitExpirationFailure;
};

export function isIsolatedRepositoryRehomeCandidate(workspace: Workspace) {
  return workspace.providerType !== "plugin" && workspace.mode === "isolated_workspace" && workspace.strategyType === "git_worktree"
    && OPEN_STATUSES.includes(workspace.status) && !workspace.closedAt && workspace.metadata?.isolatedRemoteSource !== undefined;
}

function readRehome(workspace: Pick<Workspace, "metadata">) {
  const value = workspace.metadata?.[ISOLATED_REPOSITORY_REHOME_KEY] as IsolatedRepositoryRehomeRecord | undefined;
  return value && typeof value === "object" && typeof value.from === "string" && typeof value.to === "string" ? value : null;
}

export function hasPendingIsolatedRepositoryRehomeCleanup(workspace: Workspace) {
  const rehome = readRehome(workspace);
  return Boolean(rehome && !rehome.cleanedAt && workspace.providerType !== "plugin");
}

async function git(cwd: string, args: string[], options: { signal?: AbortSignal; input?: string; timeout?: number } = {}) {
  const child = execFile("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    timeout: options.timeout ?? 120_000, signal: options.signal, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (options.input !== undefined) child.child.stdin?.end(options.input);
  return (await child).stdout;
}

const shas = (output: string) => output.split("\n").map(line => line.trim()).filter(line => SHA.test(line));
const nul = (output: string) => output.split("\0").filter(Boolean);

async function exists(target: string) {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

export async function presentCommits(cwd: string, commits: Iterable<string>, signal?: AbortSignal) {
  const unique = [...new Set(commits)].filter(sha => SHA.test(sha));
  if (unique.length === 0) return new Set<string>();
  const output = await git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { signal, input: unique.join("\n") + "\n" });
  return new Set(output.split("\n").map(line => line.split(" ")).filter(([sha, type]) => SHA.test(sha ?? "") && type === "commit").map(([sha]) => sha!));
}

function lockToken(workspaceId: string) {
  return createHash("sha256").update(`paperclip-isolated-repository-rehome:${workspaceId}`).digest("hex");
}

async function recoverRehomeLocks(clone: string, branch: string | null, workspaceId: string) {
  const worktrees = path.join(clone, ".git", "worktrees");
  const admins = await fs.readdir(worktrees).catch(() => [] as string[]);
  await recoverGitExpirationLocks(rehomeLockLocations(clone, admins, branch), lockToken(workspaceId)).catch(() => undefined);
}

function rehomeLockLocations(clone: string, admins: string[], branch: string | null): GitExpirationLockLocation[] {
  const locations: GitExpirationLockLocation[] = admins.flatMap(admin => ["index.lock", "HEAD.lock"]
    .map(name => ({ root: clone, relativePath: path.join(".git", "worktrees", admin, name), checkout: null })));
  if (branch) locations.push({ root: clone, relativePath: path.join(".git", "refs", "heads", `${branch}.lock`), checkout: null });
  return locations;
}

export async function workspaceMoveEligible(tx: Db | Tx, workspace: Workspace) {
  if (workspace.metadata?.reopenPendingConsumption === true) return false;
  const rows = await tx.execute<{ allowed: boolean }>(sql`${expirationScope(workspace)}
    SELECT (
      NOT EXISTS (SELECT 1 FROM ${executionWorkspaces} other WHERE other.id <> ${workspace.id}
        AND (other.cwd = ${workspace.cwd} OR other.provider_ref = ${workspace.cwd}
          OR left(other.cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/'))
      AND NOT EXISTS (SELECT 1 FROM relevant_runs WHERE status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
        OR finished_at IS NULL OR controller_lease_expires_at > now())
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
    ) AS allowed`);
  return rows[0]?.allowed === true;
}

async function sharedManagedBase(workspace: Workspace) {
  if (!workspace.projectId || !workspace.repoUrl) throw new Error("no_shared_base");
  let mismatch = false;
  for (const candidate of managedSourcePaths(workspace)) {
    if (!await exists(path.join(candidate, ".git"))) continue;
    try { return await verifiedGitCacheSource({ ...workspace, metadata: null }, candidate); } catch { mismatch = true; }
  }
  throw new Error(mismatch ? "shared_base_repo_mismatch" : "no_shared_base");
}

function standardWorktreeSuffix(branch: string) {
  if (!branch || branch.split("/").some(part => !part || part === "." || part === "..") || branch.includes("\\")) throw new Error("unsupported_branch_name");
  return path.join(".paperclip", "worktrees", branch);
}

async function targetWorktree(db: Db | Tx, workspace: Workspace, base: string, branch: string, signal?: AbortSignal) {
  const target = path.join(await fs.realpath(base), standardWorktreeSuffix(branch));
  if (await exists(target)) throw new Error("target_worktree_exists");
  const [other] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(ne(executionWorkspaces.id, workspace.id),
    sql`(${executionWorkspaces.cwd} = ${target} OR ${executionWorkspaces.providerRef} = ${target})`)).limit(1);
  if (other) throw new Error("target_worktree_exists");
  const checkedOut = (await git(base, ["worktree", "list", "--porcelain"], { signal })).split("\n").includes(`branch refs/heads/${branch}`);
  if (checkedOut) throw new Error("base_branch_checked_out");
  return target;
}

export async function assertSafeBaseConfig(base: string, signal?: AbortSignal) {
  const keys = (await git(base, ["config", "--local", "--name-only", "--list"], { signal })).split("\n").map(key => key.trim().toLowerCase()).filter(Boolean);
  if (keys.some(key => UNSAFE_BASE_CONFIG.test(key))) throw new Error("unsupported_base_git_config");
  if (await exists(path.join(base, ".git", "info", "attributes"))) throw new Error("unsupported_base_git_config");
}

async function inspectWorktree(workspace: Workspace, clone: string, signal?: AbortSignal) {
  const cwd = workspace.cwd;
  if (!cwd || !workspace.branchName || !workspace.repoUrl || (workspace.providerRef && workspace.providerRef !== cwd)) throw new Error("unproven_workspace_ownership");
  const stat = await fs.lstat(cwd).catch(() => null);
  if (!stat) throw new Error("missing_worktree");
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_worktree_path");
  const real = await fs.realpath(cwd);
  const cloneReal = await fs.realpath(clone);
  if (real !== path.join(cloneReal, standardWorktreeSuffix(workspace.branchName))) throw new Error("nonstandard_worktree_location");
  if (!(await fs.lstat(path.join(real, ".git"))).isFile()) throw new Error("not_linked_worktree");
  const common = (await git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal })).trim();
  if (common !== path.join(cloneReal, ".git")) throw new Error("source_identity_changed");
  if ((await git(real, ["symbolic-ref", "--short", "HEAD"], { signal })).trim() !== workspace.branchName) throw new Error("branch_identity_changed");
  const admin = (await git(real, ["rev-parse", "--absolute-git-dir"], { signal })).trim();
  if (path.dirname(admin) !== path.join(common, "worktrees")) throw new Error("unproven_worktree_admin");
  if ((await fs.readdir(admin)).some(name => !ADMIN_ENTRIES.has(name))) throw new Error("unsupported_worktree_git_state");
  const refs = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) throw new Error("unique_worktree_refs");
      await refs(path.join(dir, entry.name));
    }
  };
  await refs(path.join(admin, "refs"));
  if ((await fs.readdir(path.join(admin, "logs")).catch(() => [] as string[])).some(name => name !== "HEAD")) throw new Error("unknown_worktree_git_logs");
  if (await exists(path.join(common, "shallow"))) throw new Error("unsupported_local_git_state");
  if ((await git(real, ["for-each-ref", "--format=%(refname)", "refs/stash", "refs/replace"], { signal })).trim()) throw new Error("unique_git_refs");
  if ((await git(real, ["ls-files", "-v"], { signal })).split("\n").some(line => /^[a-zS] /.test(line))) throw new Error("unsupported_index_flags");
  return { cwd: real, admin, head: (await git(real, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })).trim() };
}

export async function transferPlan(cwd: string, signal?: AbortSignal) {
  const regenerable = await findRegenerableWorkspaceDirs(cwd, { signal });
  const nestedRoot = path.join(cwd, PROJECT_REPOSITORIES_DIR);
  const nestedStat = await fs.lstat(nestedRoot).catch(() => null);
  if (nestedStat && (!nestedStat.isDirectory() || nestedStat.isSymbolicLink())) throw new Error("untransferable_managed_checkouts");
  const nested = nestedStat ? (await fs.readdir(nestedRoot)).map(name => path.posix.join(PROJECT_REPOSITORIES_DIR, name)) : [];
  const covered = (file: string) => file === `${PROJECT_REPOSITORIES_DIR}/` || file.startsWith(`${PROJECT_REPOSITORIES_DIR}/`)
    || regenerable.some(dir => file.startsWith(`${dir}/`));
  const env = (file: string) => /^\.env(\..*)?$/.test(path.posix.basename(file));
  const untracked = nul(await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], { signal }));
  const ignored = nul(await git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { signal }));
  const files = [...new Set([...untracked.filter(file => !covered(file) && env(file)),
    ...ignored.filter(file => !covered(file) && (env(file) || file === ".claude/settings.local.json"))])].sort();
  if (ignored.some(file => !covered(file) && !files.includes(file) && !restorePointSavesIgnoredFile(file))) throw new Error("untransferable_ignored_files");
  if (files.some(file => file.endsWith("/"))) throw new Error("untransferable_ignored_files");
  const plan = [...regenerable, ...nested, ...files];
  return plan.filter(item => !plan.some(other => other !== item && item.startsWith(`${other}/`)));
}

export async function sharedHistoryBoundary(cwd: string, base: string, head: string, signal?: AbortSignal) {
  const remoteTips = async (repo: string) => shas(await git(repo, ["for-each-ref", "--format=%(objectname)", "--sort=-committerdate", "refs/remotes"], { signal }));
  const candidates = [head, ...await remoteTips(base), ...await remoteTips(cwd)];
  const inBase = await presentCommits(base, candidates, signal);
  const inClone = await presentCommits(cwd, candidates, signal);
  return [...new Set(candidates)].filter(sha => inBase.has(sha) && inClone.has(sha)).slice(0, MAX_BOUNDARY_COMMITS);
}

export function snapshotKey(snapshot: RestorePointSnapshot) {
  return JSON.stringify([snapshot.head, snapshot.index, snapshot.worktree, snapshot.ignored, snapshot.modes]);
}

export async function historyKey(cwd: string, admin: string, signal?: AbortSignal) {
  const reflog = await git(cwd, ["reflog", "show", "--format=%H", "HEAD"], { signal }).catch(() => "");
  const original = await fs.readFile(path.join(admin, "ORIG_HEAD"), "utf8").catch(() => "");
  return JSON.stringify([shas(reflog), original.trim()]);
}

async function repairLinkedCheckout(checkout: string) {
  const marker = await fs.lstat(path.join(checkout, ".git")).catch(() => null);
  if (!marker?.isFile()) return;
  const common = (await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  await repairMovedNestedRepositoryWorktree(path.dirname(common), checkout);
}

async function retargetNestedBranch(checkout: string, from: string) {
  const marker = await fs.lstat(path.join(checkout, ".git")).catch(() => null);
  if (!marker?.isFile()) return;
  const head = (await git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  const previous = await nestedWorktreeBranchPrefix(from);
  if (!head.startsWith(previous)) return;
  const next = `${await nestedWorktreeBranchPrefix(checkout)}${head.slice(previous.length)}`;
  if (next === head) return;
  const base = path.dirname((await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  await withNestedRepositoryBaseLock(base, async () => {
    if ((await git(base, ["rev-parse", "--verify", "-q", `refs/heads/${next}`]).catch(() => "")).trim()) throw new Error("nested_branch_conflict");
    await git(checkout, ["branch", "-m", head, next]);
  });
}

export async function linkedCheckoutBases(cwd: string, moves: string[]) {
  const bases = new Map<string, string>();
  for (const relative of moves.filter(item => item.startsWith(`${PROJECT_REPOSITORIES_DIR}/`))) {
    const linked = await readLinkedNestedCheckout(path.join(cwd, relative)).catch(() => { throw new Error("untransferable_managed_checkouts"); });
    if (linked) bases.set(relative, linked.base);
  }
  return bases;
}

function readPending(workspace: Workspace) {
  const value = workspace.metadata?.[ISOLATED_REPOSITORY_REHOME_PENDING_KEY] as IsolatedRepositoryRehomePending | undefined;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || ![value.base, value.from, value.target, value.branch, value.head].every(item => typeof item === "string")
    || !SHA.test(value.head) || (value.previousTip !== null && !SHA.test(value.previousTip)) || !Array.isArray(value.moves)
    || value.moves.some(item => typeof item !== "string" || !item || path.isAbsolute(item) || item.split("/").includes(".."))) throw new Error("invalid_rehome_record");
  return value;
}

async function writePending(db: Db, workspaceId: string, value: IsolatedRepositoryRehomePending | null) {
  await db.update(executionWorkspaces).set({ metadata: value
    ? sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object(${ISOLATED_REPOSITORY_REHOME_PENDING_KEY}::text, ${JSON.stringify(value)}::jsonb)`
    : sql`${executionWorkspaces.metadata} - ${ISOLATED_REPOSITORY_REHOME_PENDING_KEY}::text` }).where(eq(executionWorkspaces.id, workspaceId));
}

async function provenTarget(db: Db | Tx, workspaceId: string, pending: IsolatedRepositoryRehomePending) {
  const stat = await fs.lstat(pending.target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !(await fs.lstat(path.join(pending.target, ".git")).catch(() => null))?.isFile()) return false;
  const common = (await git(pending.target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
  if (common !== path.join(await fs.realpath(pending.base), ".git")) return false;
  if ((await git(pending.target, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim() !== `refs/heads/${pending.branch}`) return false;
  const [other] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(ne(executionWorkspaces.id, workspaceId),
    sql`(${executionWorkspaces.cwd} = ${pending.target} OR ${executionWorkspaces.providerRef} = ${pending.target})`)).limit(1);
  return !other;
}

export async function returnTransferItems(original: string, moved: string, moves: string[], conflict: string) {
  for (const relative of moves) {
    if (await exists(path.join(moved, relative)) && await exists(path.join(original, relative))) throw new Error(conflict);
  }
  for (const relative of [...moves].reverse()) {
    const from = path.join(moved, relative), to = path.join(original, relative);
    if (!await exists(from) || await exists(to)) continue;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    await repairLinkedCheckout(to).catch(() => undefined);
    await retargetNestedBranch(to, from).catch(() => undefined);
  }
}

export async function moveTransferItems(from: string, to: string, moves: string[], linkedBases: Map<string, string>) {
  if (moves.some(item => item.startsWith(`${PROJECT_REPOSITORIES_DIR}/`))) await ensureManagedRepositoriesIgnored(to);
  for (const relative of moves) {
    const destination = path.join(to, relative);
    if (await exists(destination)) throw new Error("transfer_conflict");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(path.join(from, relative), destination);
    if (linkedBases.has(relative)) {
      await repairLinkedCheckout(destination);
      await retargetNestedBranch(destination, path.join(from, relative));
    }
  }
}

export async function assertTransferredItems(from: string, to: string, moves: string[], linkedBases: Map<string, string>) {
  for (const relative of moves) {
    if (!await exists(path.join(to, relative)) || await exists(path.join(from, relative))) throw new Error("transfer_incomplete");
    const base = linkedBases.get(relative);
    if (!base) continue;
    const linked = await readLinkedNestedCheckout(path.join(to, relative)).catch(() => null);
    const head = linked ? (await git(linked.checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() : "";
    if (linked?.base !== base || (head.startsWith("paperclip/") && !head.startsWith(linked.branchPrefix))) throw new Error("transfer_incomplete");
  }
}

async function undoMove(db: Db | Tx, workspaceId: string, pending: IsolatedRepositoryRehomePending, ownsTarget?: boolean) {
  if (ownsTarget ?? await provenTarget(db, workspaceId, pending)) {
    await returnTransferItems(pending.from, pending.target, pending.moves, "rehome_rollback_conflict");
    await git(pending.base, ["worktree", "remove", "--force", "--force", pending.target]).catch(() => undefined);
    await fs.rm(pending.target, { recursive: true, force: true });
    await git(pending.base, ["worktree", "prune"]).catch(() => undefined);
  }
  const branchRef = `refs/heads/${pending.branch}`;
  const tip = (await git(pending.base, ["rev-parse", "--verify", "-q", `${branchRef}^{commit}`]).catch(() => "")).trim();
  if (tip !== pending.head || (await git(pending.base, ["worktree", "list", "--porcelain"])).split("\n").includes(`branch ${branchRef}`)) return;
  if (pending.previousTip) await git(pending.base, ["update-ref", branchRef, pending.previousTip, pending.head]);
  else {
    await git(pending.base, ["update-ref", "-d", branchRef, pending.head]);
    for (const key of ["remote", "merge"]) await git(pending.base, ["config", "--local", "--unset-all", `branch.${pending.branch}.${key}`]).catch(() => undefined);
  }
}

export function withWorkspaceMoveLocks<T>(db: Db, workspace: Workspace, work: (tx: Tx) => Promise<T>) {
  return withIsolatedRepositorySourceLock(db, workspace.companyId, workspace.sourceIssueId!, () =>
    withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
      const rows = await tx.execute<{ locked: boolean; idle_timeout_ms: string | number | null }>(sql`select
        pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspace.id}`}, 0)) as locked,
        (select setting::bigint from pg_settings where name = 'idle_in_transaction_session_timeout') as idle_timeout_ms`);
      if (!rows[0]?.locked) throw new Error("lifecycle_busy");
      return withWorkspaceLockKeepalive(tx, Number(rows[0]?.idle_timeout_ms), () => work(tx));
    })), true);
}

function emptyResult(): IsolatedRepositoryRehomeResult {
  return { outcome: "skipped", rehomed: false, cloneRemoved: false, reason: null, cloneKeptReason: null,
    candidateBytes: 0, reclaimedBytes: 0, from: null, to: null };
}

export function workspaceMoveSkip(error: unknown): { reason: string; failure?: GitExpirationFailure } {
  const reason = error instanceof IsolatedRepositorySourceBusy ? "source_busy" : error instanceof RestorePointSkip ? error.reason
    : error instanceof RestorePointRestoreFailure ? error.reason : gitExpirationSkipReason(error);
  return reason === "inspection_failed" ? { reason, failure: describeGitExpirationFailure(error) } : { reason };
}

function skip(result: IsolatedRepositoryRehomeResult, error: unknown) {
  const { reason, failure } = workspaceMoveSkip(error);
  if (failure) result.failure = failure;
  return reason;
}

export async function rehomeIsolatedRepositoryWorkspace(db: Db, snapshot: Workspace, options: {
  dryRun?: boolean; now?: Date; signal?: AbortSignal; limits?: Partial<RestorePointLimits>; hooks?: IsolatedRepositoryRehomeHooks;
} = {}): Promise<IsolatedRepositoryRehomeResult> {
  const result = emptyResult();
  const candidate = isIsolatedRepositoryRehomeCandidate(snapshot);
  if (!snapshot.sourceIssueId || (!candidate && !hasPendingIsolatedRepositoryRehomeCleanup(snapshot))) return { ...result, reason: "not_candidate" };
  try {
    return await withWorkspaceMoveLocks(db, snapshot, async tx => {
      const [row] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id), eq(executionWorkspaces.companyId, snapshot.companyId)));
      if (!row || row.updatedAt.getTime() !== snapshot.updatedAt.getTime()) throw new Error("workspace_changed");
      if (!candidate) return await cleanupRehomedSource(db, tx, row, result, options);
      if (!await workspaceMoveEligible(tx, row)) throw new Error("live_or_unresolved_consumer");
      let recipe: GitCacheRestoration | null = null;
      try { recipe = row.metadata?.[GIT_CACHE_RESTORATION_KEY] === undefined ? null : readGitCacheRestoration(row); }
      catch { throw new Error("invalid_restoration_recipe"); }
      if (recipe && recipe.sourceKind !== "isolated_remote") throw new Error("unsupported_restoration_recipe");
      const clone = (await verifiedRecordedIsolatedRemoteSource(row))!;
      await recoverRehomeLocks(clone, row.branchName, row.id);
      const old = await inspectWorktree(row, clone, options.signal);
      const base = await sharedManagedBase(row);
      const branch = row.branchName!;
      const branchRef = `refs/heads/${branch}`;
      const interrupted = readPending(row);
      if (interrupted) {
        if (interrupted.base !== base || interrupted.from !== old.cwd || interrupted.branch !== branch
          || interrupted.target !== path.join(await fs.realpath(base), standardWorktreeSuffix(branch))) throw new Error("invalid_rehome_record");
        if (options.dryRun) return { ...result, outcome: "dry_run" as const, reason: "interrupted_rehome_pending", from: row.cwd, to: interrupted.target };
        await undoMove(tx, row.id, interrupted);
        await writePending(db, row.id, null);
      }
      const target = await targetWorktree(tx, row, base, branch, options.signal);
      await assertSafeBaseConfig(base, options.signal);
      const previousTip = (await git(base, ["rev-parse", "--verify", "-q", `${branchRef}^{commit}`], { signal: options.signal }).catch(() => "")).trim() || null;
      if (previousTip && !await git(old.cwd, ["merge-base", "--is-ancestor", previousTip, "HEAD"], { signal: options.signal }).then(() => true, () => false)) {
        throw new Error("base_branch_diverged");
      }
      const moves = await transferPlan(old.cwd, options.signal);
      const linkedBases = await linkedCheckoutBases(old.cwd, moves);
      result.from = row.cwd; result.to = target;
      result.candidateBytes = await allocatedBytes(clone, () => { options.signal?.throwIfAborted(); return true; }).catch(() => 0);
      if (options.dryRun) return { ...result, outcome: "dry_run" as const };
      const admins = [path.basename(old.admin)];
      const locks = await acquireGitExpirationLocks(rehomeLockLocations(clone, admins, branch), lockToken(row.id))
        .catch(() => { throw new Error("worktree_git_busy"); });
      const pending: IsolatedRepositoryRehomePending = { base, from: old.cwd, target, branch, head: old.head, previousTip, moves };
      let recorded = false, ownsTarget = false, committed = false;
      try {
        const before = await currentRestorePointSnapshot(old.cwd, options.signal);
        const beforeHistory = await historyKey(old.cwd, old.admin, options.signal);
        if (before.head !== old.head) throw new Error("head_changed");
        const captured = await captureRestorePoint({ cwd: old.cwd, upstreamCommits: await sharedHistoryBoundary(old.cwd, base, old.head, options.signal),
          limits: options.limits ?? ISOLATED_REHOME_RESTORE_POINT_LIMITS, signal: options.signal });
        const manifest = captured ? await importRestorePoint({ repositoryCwd: base, payload: captured.payload, signal: options.signal }) : null;
        const reflog = shas(await git(old.cwd, ["reflog", "show", "--format=%H", "HEAD"], { signal: options.signal }).catch(() => ""));
        const original = (await fs.readFile(path.join(old.admin, "ORIG_HEAD"), "utf8").catch(() => "")).trim();
        const history = [old.head, ...reflog, ...(SHA.test(original) ? [original] : [])];
        const present = await presentCommits(base, history, options.signal);
        if (history.some(sha => !present.has(sha))) throw new Error("history_not_transferred");
        await writePending(db, row.id, pending);
        recorded = true;
        if (previousTip) await git(base, ["update-ref", branchRef, old.head, previousTip], { signal: options.signal });
        else {
          await git(base, ["update-ref", branchRef, old.head, ""], { signal: options.signal });
          for (const key of ["remote", "merge"]) {
            const value = (await git(old.cwd, ["config", "--local", "--get", `branch.${branch}.${key}`]).catch(() => "")).trim();
            if (value) await git(base, ["config", "--local", `branch.${branch}.${key}`, value], { signal: options.signal });
          }
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await assertSafeBaseConfig(base, options.signal);
        await options.hooks?.beforeWorktreeAdd?.({ from: old.cwd, to: target });
        if (await exists(target)) throw new Error("target_worktree_exists");
        await git(base, ["worktree", "add", target, branch], { signal: options.signal, timeout: 15 * 60_000 });
        ownsTarget = true;
        if (manifest) await applyRestorePoint({ cwd: target, manifest, signal: options.signal });
        const newAdmin = (await git(target, ["rev-parse", "--absolute-git-dir"], { signal: options.signal })).trim();
        await fs.mkdir(path.join(newAdmin, "logs"), { recursive: true });
        await fs.copyFile(path.join(old.admin, "logs", "HEAD"), path.join(newAdmin, "logs", "HEAD")).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          await fs.rm(path.join(newAdmin, "logs", "HEAD"), { force: true });
        });
        if (original) await fs.copyFile(path.join(old.admin, "ORIG_HEAD"), path.join(newAdmin, "ORIG_HEAD"));
        await moveTransferItems(old.cwd, target, moves, linkedBases);
        await options.hooks?.beforeVerify?.({ from: old.cwd, to: target });
        const after = await currentRestorePointSnapshot(old.cwd, options.signal);
        const moved = await currentRestorePointSnapshot(target, options.signal);
        if (snapshotKey(after) !== snapshotKey(before) || snapshotKey(moved) !== snapshotKey(before)) throw new Error("snapshot_mismatch");
        if (await historyKey(old.cwd, old.admin, options.signal) !== beforeHistory || await historyKey(target, newAdmin, options.signal) !== beforeHistory) {
          throw new Error("history_mismatch");
        }
        if ((await git(target, ["symbolic-ref", "--short", "HEAD"], { signal: options.signal })).trim() !== branch) throw new Error("branch_identity_changed");
        await assertTransferredItems(old.cwd, target, moves, linkedBases);
        const at = (options.now ?? new Date()).toISOString();
        await db.transaction(async updateTx => {
          const [current] = await updateTx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, row.id)).for("update");
          if (!current || current.updatedAt.getTime() !== row.updatedAt.getTime()) throw new Error("workspace_changed");
          if (!await workspaceMoveEligible(updateTx, current)) throw new Error("live_or_unresolved_consumer");
          const metadata: Record<string, unknown> = { ...current.metadata };
          delete metadata.isolatedRemoteSource;
          delete metadata.gitCacheExpiration;
          delete metadata[ISOLATED_REPOSITORY_REHOME_PENDING_KEY];
          if (recipe) metadata[GIT_CACHE_RESTORATION_KEY] = { ...recipe, sourceKind: "managed_project", sourcePath: base, worktreePath: target };
          metadata[ISOLATED_REPOSITORY_REHOME_KEY] = { at, from: current.cwd ?? old.cwd, to: target, cleanedAt: null } satisfies IsolatedRepositoryRehomeRecord;
          await updateTx.update(executionWorkspaces).set({ cwd: target, providerRef: current.providerRef ? target : null, metadata, updatedAt: new Date() })
            .where(eq(executionWorkspaces.id, row.id));
        });
        committed = true;
      } finally {
        try {
          if (!committed && recorded) {
            await undoMove(tx, row.id, pending, ownsTarget);
            await writePending(db, row.id, null);
          }
        } finally { await locks.release().catch(() => undefined); }
      }
      result.rehomed = true;
      result.outcome = "rehomed";
      const [updated] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, row.id));
      await options.hooks?.afterDatabaseUpdate?.(updated!);
      return await cleanupRehomedSource(db, tx, updated!, result, options);
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    result.reason = skip(result, error);
    return result;
  }
}

async function cloneConsumers(db: Db | Tx, companyId: string, issueId: string, excludeId: string | null, clone: string) {
  const others = await db.select().from(executionWorkspaces).where(and(excludeId ? ne(executionWorkspaces.id, excludeId) : undefined,
    sql`((${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'companyId' = ${companyId}
      AND ${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'issueId' = ${issueId})
      OR ${executionWorkspaces.cwd} = ${clone} OR ${executionWorkspaces.providerRef} = ${clone}
      OR left(${executionWorkspaces.cwd}, length(${clone}) + 1) = ${clone} || '/')`));
  const expired = (row: Workspace) => {
    try { return CLOSED_STATUSES.includes(row.status) && Boolean(readGitCacheRestoration(row)) && Boolean(readGitCacheExpiration(row)?.workspaceRemoved); }
    catch { return false; }
  };
  if (others.some(row => !expired(row))) return "base_has_consumers";
  const [project] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(sql`${projectWorkspaces.cwd} = ${clone}
    OR left(${projectWorkspaces.cwd}, length(${clone}) + 1) = ${clone} || '/'`).limit(1);
  if (project) return "base_has_consumers";
  const [service] = await db.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(sql`
    ${workspaceRuntimeServices.status} <> 'stopped' AND (${workspaceRuntimeServices.cwd} = ${clone}
      OR left(${workspaceRuntimeServices.cwd}, length(${clone}) + 1) = ${clone} || '/')`).limit(1);
  return service ? "base_has_live_services" : null;
}

function reproducibleCheckoutPath(file: string) {
  const parts = file.split("/").filter(Boolean);
  const directories = file.endsWith("/") ? parts : parts.slice(0, -1);
  return directories.some(part => REGENERABLE_WORKSPACE_DIR_NAMES.has(part))
    || file === `${COMPACTION_TRASH_PATH}/` || file.startsWith(`${COMPACTION_TRASH_PATH}/`);
}

type CloneCheck = { reason: string | null; paths: string[] };
type MissingUpstream = (commits: string[], covered: string[]) => Promise<boolean>;

async function cloneDisposable(clone: string, base: string | null, missingUpstream: MissingUpstream, signal?: AbortSignal): Promise<CloneCheck> {
  const kept = (reason: string, paths: string[] = []): CloneCheck => ({ reason, paths: paths.slice(0, 5) });
  try {
    await git(clone, ["worktree", "prune"], { signal });
    const worktrees = (await git(clone, ["worktree", "list", "--porcelain"], { signal })).split("\n").filter(line => line.startsWith("worktree "));
    if (worktrees.length !== 1) return kept("base_has_worktrees", worktrees.slice(1).map(line => line.slice(9)));
    const tracked = nul(await git(clone, ["status", "--porcelain=v1", "-z", "--untracked-files=no"], { signal }));
    if (tracked.length) return kept("clone_checkout_has_files", tracked.map(entry => entry.slice(3)));
    const untracked = nul(await git(clone, ["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"], { signal }))
      .filter(file => file !== `${COMPACTION_TRASH_PATH}/` && !file.startsWith(`${COMPACTION_TRASH_PATH}/`));
    if (untracked.length) return kept("clone_checkout_has_files", untracked);
    const ignored = nul(await git(clone, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], { signal }))
      .filter(entry => !reproducibleCheckoutPath(entry));
    const ignoredFiles = ignored.filter(entry => !entry.endsWith("/"));
    if (ignoredFiles.length) return kept("clone_checkout_has_files", ignoredFiles);
    const ignoredDirectories = ignored.filter(entry => entry.endsWith("/"));
    if (ignoredDirectories.length > CLONE_DIRECTORY_BUDGET) return kept("clone_file_budget");
    if (ignoredDirectories.length) {
      const unexplained = nul(await git(clone, ["--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...ignoredDirectories], { signal }))
        .filter(file => !reproducibleCheckoutPath(file));
      if (unexplained.length) return kept("clone_checkout_has_files", unexplained);
    }
    const refs = (await git(clone, ["for-each-ref", `--count=${CLONE_HISTORY_BUDGET + 1}`, "--format=%(objectname) %(refname)"], { signal })).split("\n").filter(Boolean);
    if (refs.length > CLONE_HISTORY_BUDGET) return kept("clone_history_budget");
    const unexpected = refs.filter(ref => !/^[0-9a-f]{40} refs\/(heads|tags|remotes)\//.test(ref));
    if (unexpected.length) return kept("unsupported_clone_refs", unexpected.map(ref => ref.slice(41)));
    const reflog = (await git(clone, ["reflog", "show", "--all", "-n", String(CLONE_HISTORY_BUDGET + 1), "--format=%H %gD"], { signal }).catch(() => ""))
      .split("\n").map(line => line.trim().split(" ")).filter(([sha]) => SHA.test(sha ?? ""));
    if (reflog.length > CLONE_HISTORY_BUDGET) return kept("clone_history_budget");
    const original = (await fs.readFile(path.join(clone, ".git", "ORIG_HEAD"), "utf8").catch(() => "")).trim();
    const head = (await git(clone, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { signal }).catch(() => "")).trim();
    const tips = [...new Set([...refs.filter(ref => !/ refs\/remotes\//.test(ref)).map(ref => ref.split(" ")[0]!),
      ...reflog.filter(([, selector]) => !(selector ?? "").startsWith("refs/remotes/")).map(([sha]) => sha!), ...(SHA.test(original) ? [original] : []), ...(SHA.test(head) ? [head] : [])])];
    const tipsInBase = base ? await presentCommits(base, tips, signal) : new Set<string>();
    const pending = tips.filter(sha => !tipsInBase.has(sha));
    if (pending.length === 0) return { reason: null, paths: [] };
    const unique = shas(await git(clone, ["rev-list", `--max-count=${CLONE_HISTORY_BUDGET + 1}`, "--stdin"], { signal,
      input: [...pending, "--not", "--remotes", ...tipsInBase].join("\n") + "\n" }));
    if (unique.length > CLONE_HISTORY_BUDGET) return kept("clone_history_budget");
    const uniqueInBase = base ? await presentCommits(base, unique, signal) : new Set<string>();
    const missing = unique.filter(sha => !uniqueInBase.has(sha));
    if (missing.length === 0) return { reason: null, paths: [] };
    return await missingUpstream(missing, [...tipsInBase, ...uniqueInBase]) ? kept("unique_clone_history", missing) : { reason: null, paths: [] };
  } catch (error) {
    signal?.throwIfAborted();
    return kept(gitExpirationSkipReason(error));
  }
}

async function worktreeOfClone(worktree: string, cloneReal: string, signal?: AbortSignal) {
  const admins = path.join(cloneReal, ".git", "worktrees");
  const common = (await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }).catch(() => "")).trim();
  if (common) return common === path.join(cloneReal, ".git");
  const marker = await fs.lstat(path.join(worktree, ".git")).catch(() => null);
  if (!marker?.isFile() || marker.size > 4096) return false;
  const pointer = /^gitdir: (.+)\n?$/.exec(await fs.readFile(path.join(worktree, ".git"), "utf8"))?.[1];
  if (!pointer) return false;
  return path.dirname(await canonicalRepositoryRoot(path.resolve(worktree, pointer))) === admins;
}

function upstreamCheck(db: Db, companyId: string, issueId: string, clone: string, repoUrl: string, signal?: AbortSignal): MissingUpstream {
  const auth = withAnonymousGitFallback(createIssueGitRemoteAuthProvider(db, companyId, issueId));
  return (commits, covered) => hasCommitsMissingUpstream(clone, commits, repoUrl, auth, signal, covered);
}

async function cleanupRehomedSource(db: Db, tx: Tx, row: Workspace, result: IsolatedRepositoryRehomeResult,
  options: { dryRun?: boolean; now?: Date; signal?: AbortSignal }): Promise<IsolatedRepositoryRehomeResult> {
  const rehome = readRehome(row);
  if (!rehome || rehome.cleanedAt) return result;
  result.from ??= rehome.from; result.to ??= rehome.to;
  if (row.cwd !== rehome.to || !row.sourceIssueId) throw new Error("workspace_changed");
  const clone = isolatedRemoteSourcePath(row.companyId, row.sourceIssueId);
  const parent = path.dirname(clone);
  const worktreeTrash = path.join(parent, `.rehomed-worktree-${row.id}`);
  const cloneTrash = path.join(parent, `.rehomed-checkout-${row.id}`);
  const base = await sharedManagedBase(row);
  const from = await canonicalRepositoryRoot(rehome.from);
  const cloneReal = await exists(clone) ? await fs.realpath(clone) : null;
  const keep = async (reason: string, retained: boolean) => {
    result.cloneKeptReason = reason;
    if (!result.rehomed) result.outcome = "clone_kept";
    if (retained && !options.dryRun) await markCleaned(db, row.id, options.now, reason);
    return result;
  };
  if (cloneReal && path.relative(cloneReal, from).startsWith("..")) return keep("unproven_worktree_admin", false);
  if (options.dryRun) {
    if (cloneReal) result.candidateBytes = await allocatedBytes(clone, () => { options.signal?.throwIfAborted(); return true; }).catch(() => 0);
    result.outcome = "dry_run";
    return result;
  }
  if (!await workspaceMoveEligible(tx, row)) return keep("live_or_unresolved_consumer", false);
  if (cloneReal) {
    await recoverRehomeLocks(clone, row.branchName, row.id);
    const fromStat = await fs.lstat(from).catch(() => null);
    if (fromStat) {
      if (!fromStat.isDirectory() || fromStat.isSymbolicLink()) return keep("unsafe_worktree_path", false);
      if (!await worktreeOfClone(from, cloneReal, options.signal)) return keep("source_identity_changed", false);
      result.reclaimedBytes += await allocatedBytes(from, () => true).catch(() => 0);
      if (await exists(worktreeTrash)) await fs.rm(worktreeTrash, { recursive: true, force: true });
      await fs.rename(from, worktreeTrash);
    }
    await git(clone, ["worktree", "prune"], { signal: options.signal });
  }
  if (await exists(worktreeTrash)) await fs.rm(worktreeTrash, { recursive: true, force: true });
  if (cloneReal) {
    const consumer = await cloneConsumers(tx, row.companyId, row.sourceIssueId, row.id, clone);
    if (consumer) return keep(consumer, consumer === "base_has_consumers");
    const repoUrl = (await git(clone, ["config", "--local", "--get", "remote.origin.url"], { signal: options.signal }).catch(() => "")).trim();
    if (repoUrl !== row.repoUrl) return keep("source_identity_changed", false);
    const disposable = await cloneDisposable(clone, base, upstreamCheck(db, row.companyId, row.sourceIssueId, clone, repoUrl, options.signal), options.signal);
    if (disposable.reason) {
      result.cloneKeptPaths = disposable.paths;
      return keep(disposable.reason, false);
    }
    const bytes = await allocatedBytes(clone, () => true).catch(() => 0);
    if (await exists(cloneTrash)) await fs.rm(cloneTrash, { recursive: true, force: true });
    await fs.rename(clone, cloneTrash);
    result.reclaimedBytes += bytes;
  }
  if (await exists(cloneTrash)) {
    await fs.rm(cloneTrash, { recursive: true, force: true });
    result.cloneRemoved = true;
  }
  await fs.rmdir(parent).catch(() => undefined);
  if (!result.rehomed) result.outcome = "cleaned";
  await markCleaned(db, row.id, options.now);
  return result;
}

async function markCleaned(db: Db, workspaceId: string, now?: Date, retained?: string) {
  const patch = { cleanedAt: (now ?? new Date()).toISOString(), ...(retained ? { cloneRetained: retained } : {}) };
  await db.update(executionWorkspaces).set({
    metadata: sql`jsonb_set(${executionWorkspaces.metadata}, ${`{${ISOLATED_REPOSITORY_REHOME_KEY}}`}::text[],
      (${executionWorkspaces.metadata}->${ISOLATED_REPOSITORY_REHOME_KEY}) || ${JSON.stringify(patch)}::jsonb)`,
  }).where(eq(executionWorkspaces.id, workspaceId));
}

export async function rehomeExpiredIsolatedRestoration(db: Db, snapshot: Workspace): Promise<Workspace> {
  if (!CLOSED_STATUSES.includes(snapshot.status) || snapshot.metadata?.isolatedRemoteSource === undefined || !snapshot.branchName) return snapshot;
  try {
    const recipe = readGitCacheRestoration(snapshot);
    if (!recipe || recipe.sourceKind !== "isolated_remote" || !readGitCacheExpiration(snapshot)?.workspaceRemoved || await exists(recipe.worktreePath)) return snapshot;
    if (await canonicalRepositoryRoot(recipe.worktreePath) !== path.join(await canonicalRepositoryRoot(recipe.sourcePath), standardWorktreeSuffix(recipe.branchName))) return snapshot;
    const base = await sharedManagedBase(snapshot);
    const target = await targetWorktree(db, snapshot, base, recipe.branchName);
    const tip = (await git(base, ["rev-parse", "--verify", "-q", `refs/heads/${recipe.branchName}^{commit}`]).catch(() => "")).trim();
    if (tip && tip !== recipe.commit) return snapshot;
    if ((recipe.contents?.checkouts ?? []).some(checkout => checkout.worktree && checkout.branchName)) return snapshot;
    if (recipe.restorePoint && !recipe.restorePoint.headOnRemote && !recipe.restorePoint.expiredAt) {
      const { manifest } = await loadGitRestorePoint({ storage: getStorageService(), workspace: { companyId: snapshot.companyId, id: snapshot.id }, ref: recipe.restorePoint });
      const present = await presentCommits(base, manifest.prerequisites);
      if (manifest.prerequisites.some(sha => !present.has(sha))) return snapshot;
    }
    await finishGitCacheTrash(snapshot);
    return await withExecutionWorkspaceLifecycleLock(db, snapshot.id, async tx => {
      const [row] = await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, snapshot.id)).for("update");
      if (!row || row.updatedAt.getTime() !== snapshot.updatedAt.getTime()) return row ?? snapshot;
      const metadata: Record<string, unknown> = { ...row.metadata };
      delete metadata.isolatedRemoteSource;
      delete metadata.gitCacheExpiration;
      metadata[GIT_CACHE_RESTORATION_KEY] = { ...recipe, sourceKind: "managed_project", sourcePath: base, worktreePath: target } satisfies GitCacheRestoration;
      metadata[ISOLATED_REPOSITORY_REHOME_KEY] = { at: new Date().toISOString(), from: recipe.worktreePath, to: target, cleanedAt: null } satisfies IsolatedRepositoryRehomeRecord;
      const [updated] = await tx.update(executionWorkspaces).set({ cwd: target, providerRef: row.providerRef ? target : null, metadata, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, row.id)).returning();
      return updated ?? row;
    });
  } catch { return snapshot; }
}

export type OrphanedIsolatedSourceResult = {
  companyId: string; issueId: string; removed: boolean; reason: string | null; paths: string[];
  candidateBytes: number; reclaimedBytes: number; failure?: GitExpirationFailure;
};

async function sourceDirectories(parent: string) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && SOURCE_ID.test(entry.name)).map(entry => entry.name).sort();
}

export async function sweepOrphanedIsolatedRepositorySources(db: Db, options: { dryRun?: boolean; signal?: AbortSignal; after?: string | null; limit?: number } = {}) {
  const root = path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources");
  const results: OrphanedIsolatedSourceResult[] = [];
  const limit = options.limit ?? 8;
  let inspected = 0;
  let lastPosition: string | null = null;
  const [afterCompany, afterIssue] = options.after?.split("/") ?? [];
  for (const companyId of await sourceDirectories(root)) {
    for (const issueId of await sourceDirectories(path.join(root, companyId))) {
      options.signal?.throwIfAborted();
      if (afterCompany !== undefined && (companyId < afterCompany || (companyId === afterCompany && issueId <= afterIssue!))) continue;
      if (inspected >= limit) return { results, next: lastPosition };
      inspected += 1;
      lastPosition = `${companyId}/${issueId}`;
      const result: OrphanedIsolatedSourceResult = { companyId, issueId, removed: false, reason: null, paths: [], candidateBytes: 0, reclaimedBytes: 0 };
      try {
        await withIsolatedRepositorySourceLock(db, companyId, issueId, async () => {
          const clone = isolatedRemoteSourcePath(companyId, issueId);
          const parent = path.dirname(clone);
          for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
            if (!options.dryRun && entry.isDirectory() && SOURCE_TRASH.test(entry.name)) await fs.rm(path.join(parent, entry.name), { recursive: true, force: true });
          }
          const stat = await fs.lstat(clone).catch(() => null);
          if (!stat) return;
          const storage = await fs.lstat(path.join(clone, ".git")).catch(() => null);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !storage?.isDirectory() || storage.isSymbolicLink()
            || await fs.realpath(clone) !== path.join(await fs.realpath(parent), "checkout")) throw new Error("source_identity_changed");
          const consumer = await cloneConsumers(db, companyId, issueId, null, clone);
          if (consumer) throw new Error(consumer);
          const rows = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), or(eq(executionWorkspaces.sourceIssueId, issueId),
            sql`${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'issueId' = ${issueId}`)));
          if (rows.some(row => row.metadata?.[ISOLATED_REPOSITORY_REHOME_PENDING_KEY] !== undefined)) throw new Error("rehome_pending");
          if (rows.some(row => hasPendingIsolatedRepositoryRehomeCleanup(row))) throw new Error("rehome_cleanup_pending");
          const recorded = new Set(rows.map(row => (row.metadata?.isolatedRemoteSource as { repoUrl?: unknown } | undefined)?.repoUrl ?? row.repoUrl)
            .filter((url): url is string => typeof url === "string" && url.length > 0));
          if (recorded.size !== 1) throw new Error("unproven_repository");
          const repoUrl = [...recorded][0]!;
          if ((await git(clone, ["config", "--local", "--null", "--get-all", "remote.origin.url"], { signal: options.signal }).catch(() => "")) !== `${repoUrl}\0`) {
            throw new Error("source_identity_changed");
          }
          const anchor = rows.find(row => row.projectId && row.repoUrl === repoUrl);
          const base = anchor ? await sharedManagedBase(anchor).catch(() => null) : null;
          const check = await cloneDisposable(clone, base, upstreamCheck(db, companyId, issueId, clone, repoUrl, options.signal), options.signal);
          if (check.reason) {
            result.paths = check.paths;
            throw new Error(check.reason);
          }
          result.candidateBytes = await allocatedBytes(clone, () => { options.signal?.throwIfAborted(); return true; }).catch(() => 0);
          if (options.dryRun) return;
          const trash = path.join(parent, `.orphaned-checkout-${randomBytes(8).toString("hex")}`);
          await fs.rename(clone, trash);
          await fs.rm(trash, { recursive: true, force: true });
          result.removed = true;
          result.reclaimedBytes = result.candidateBytes;
          await fs.rmdir(parent).catch(() => undefined);
          await fs.rmdir(path.dirname(parent)).catch(() => undefined);
        }, true);
      } catch (error) {
        options.signal?.throwIfAborted();
        result.reason = error instanceof IsolatedRepositorySourceBusy ? "source_busy" : gitExpirationSkipReason(error);
        if (result.reason === "inspection_failed") result.failure = describeGitExpirationFailure(error);
      }
      if (result.reason && ORPHAN_HANDLED_ELSEWHERE.has(result.reason)) continue;
      if (result.removed || result.reason || result.candidateBytes) results.push(result);
    }
  }
  return { results, next: null };
}
