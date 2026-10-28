import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces, type Db } from "@paperclipai/db";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import { acquireGitExpirationLocks, recoverGitExpirationLocks, type GitExpirationLockLocation } from "./git-workspace-expiration-locks.js";
import { allocatedBytes, withAnonymousGitFallback, type GitExpirationFailure } from "./git-workspace-expiration.js";
import { GIT_CACHE_RESTORATION_KEY, readGitCacheRestoration, type GitCacheRestoration } from "./git-workspace-restoration.js";
import { readManagedCheckoutContents, selectRestoredProjectRepositories } from "./git-workspace-contents.js";
import { applyRestorePoint, captureRestorePoint, currentRestorePointSnapshot, importRestorePoint } from "./git-restore-point.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import { createIssueGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { isNestedWorktreeBranchName, isVerifiedNestedRepositoryBase, moveNestedRepositoryWorktree, nestedRepositoryBaseCandidates, nestedWorktreeBranchPrefix,
  readLinkedNestedCheckout, removeStaleNestedRegistrations, trackNestedWorktreeUpstream, withNestedRepositoryBaseLock } from "./nested-repository-worktrees.js";
import { assertSafeBaseConfig, assertTransferredItems, historyKey, linkedCheckoutBases, moveTransferItems, presentCommits, returnTransferItems,
  sharedHistoryBoundary, snapshotKey, transferPlan, withWorkspaceMoveLocks, workspaceMoveEligible, workspaceMoveSkip } from "./isolated-repository-rehome.js";

const execFile = promisify(execFileCallback);
const SHA = /^[0-9a-f]{40}$/;
const OPEN_STATUSES = ["active", "idle", "in_review"];
const CHECKOUT_NAME = /^[A-Za-z0-9_-]+-[a-f0-9]{12}$/;
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const STAGING_SUFFIXES = { worktree: ".clone-migrating", aside: ".clone-standalone", trash: ".clone-trash" } as const;
const LOCAL_CONFIG = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\..+\.(remote|merge))$/;
const UNSUPPORTED_GIT_STATE = ["shallow", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer",
  "info/sparse-checkout", "info/attributes", "refs/replace", "modules", "lfs"];
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
export const NESTED_CLONE_MIGRATIONS_PER_SWEEP = 8;
export const NESTED_CLONE_MIGRATION_PENDING_KEY = "nestedCloneMigrationPending";
export const NESTED_CLONE_MIGRATION_RETRY_REASONS: ReadonlySet<string> = new Set(["lifecycle_busy", "source_busy", "live_or_unresolved_consumer",
  "worktree_git_busy", "workspace_changed"]);

type Workspace = typeof executionWorkspaces.$inferSelect;
type PlannedRef = { ref: string; commit: string; upstream: string | null };
type Paths = { checkout: string; worktree: string; aside: string; trash: string };
type Source = { repoUrl: string; base: string; candidates: string[]; source: { id: string; repoUrl: string; repoRef: string | null; cwd: string | null } };
export type NestedCloneMigrationPending = {
  base: string; head: string; branch: string | null; refs: PlannedRef[]; moves: string[]; phase: "transfer" | "swap" | "cleanup";
};
export type NestedCloneMigrationHooks = {
  beforeWorktreeAdd?: (input: { from: string; to: string }) => Promise<void>;
  beforeVerify?: (input: { from: string; to: string }) => Promise<void>;
  afterAside?: (input: { checkout: string; aside: string }) => Promise<void>;
  afterMove?: (input: { checkout: string; aside: string }) => Promise<void>;
  afterFinalize?: (input: { checkout: string; aside: string }) => Promise<void>;
};
export type NestedCloneMigrationResult = {
  name: string; outcome: "migrated" | "recovered" | "rolled_back" | "dry_run" | "skipped"; reason: string | null;
  branchName: string | null; candidateBytes: number; reclaimedBytes: number; failure?: GitExpirationFailure;
};
export type NestedCloneMigrationOptions = {
  dryRun?: boolean; signal?: AbortSignal; hooks?: NestedCloneMigrationHooks; resolveGitAuth?: GitRemoteAuthProvider;
};

async function git(cwd: string, args: string[], options: { signal?: AbortSignal; input?: string; timeout?: number; auth?: Awaited<ReturnType<GitRemoteAuthProvider>> } = {}) {
  const child = execFile("git", [...options.auth?.configArgs ?? [], "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    timeout: options.timeout ?? 120_000, signal: options.signal, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...options.auth?.env },
  });
  if (options.input !== undefined) child.child.stdin?.end(options.input);
  return (await child).stdout;
}

const shas = (output: string) => output.split("\n").map(line => line.trim()).filter(line => SHA.test(line));

async function exists(target: string) {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

async function canonicalPath(target: string) {
  return path.join(await fs.realpath(path.dirname(target)), path.basename(target));
}

export function isNestedCloneMigrationCandidate(workspace: Workspace) {
  return workspace.providerType !== "plugin" && OPEN_STATUSES.includes(workspace.status) && !workspace.closedAt
    && Boolean(workspace.cwd && workspace.projectId && workspace.sourceIssueId);
}

function canRecover(workspace: Workspace, name: string) {
  return workspace.providerType !== "plugin" && Boolean(workspace.cwd && workspace.projectId && workspace.sourceIssueId)
    && pendingRecords(workspace)[name] !== undefined;
}

function pendingRecords(workspace: Pick<Workspace, "metadata">) {
  const value = workspace.metadata?.[NESTED_CLONE_MIGRATION_PENDING_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function pendingNestedCloneMigrationNames(workspace: Pick<Workspace, "metadata">) {
  return Object.keys(pendingRecords(workspace)).filter(name => CHECKOUT_NAME.test(name));
}

export type NestedCloneMigrationRotation = { visited: ReadonlySet<string>; exhausted: string | null };

export function nextNestedCloneMigrationBatch(listed: string[], pending: string[], rotation: NestedCloneMigrationRotation | undefined,
  limit = NESTED_CLONE_MIGRATIONS_PER_SWEEP) {
  const listing = listed.join("\n");
  const visited = rotation?.visited ?? new Set<string>();
  const first = pending.filter(name => listed.includes(name));
  const rest = listed.filter(name => !first.includes(name));
  const names = [...first, ...rest.filter(name => !visited.has(name)), ...rest.filter(name => visited.has(name))].slice(0, limit);
  const seen = new Set([...[...visited].filter(name => listed.includes(name)), ...names]);
  const cycleOpen = listed.some(name => !seen.has(name));
  const overflow = listed.length > names.length;
  const exhausted = rotation?.exhausted === listing ? listing : !cycleOpen && overflow ? listing : null;
  return { names, overflow, retryOverflow: cycleOpen && rotation?.exhausted !== listing,
    rotation: { visited: cycleOpen ? seen : new Set<string>(), exhausted } satisfies NestedCloneMigrationRotation };
}

export function hasPendingNestedCloneMigration(workspace: Pick<Workspace, "metadata">) {
  return Object.keys(pendingRecords(workspace)).length > 0;
}

function readPending(workspace: Workspace, name: string, prefix: string): NestedCloneMigrationPending | null {
  const value = pendingRecords(workspace)[name] as NestedCloneMigrationPending | undefined;
  if (value === undefined) return null;
  const safeRelative = (item: unknown) => typeof item === "string" && item.length > 0 && !path.isAbsolute(item) && !item.split("/").includes("..");
  if (!value || typeof value !== "object" || typeof value.base !== "string" || !path.isAbsolute(value.base) || !SHA.test(value.head)
    || !(value.branch === null || typeof value.branch === "string") || !["transfer", "swap", "cleanup"].includes(value.phase)
    || !Array.isArray(value.moves) || !value.moves.every(safeRelative) || !Array.isArray(value.refs)
    || !value.refs.every(ref => ref && typeof ref.ref === "string" && ref.ref.startsWith(`refs/heads/${prefix}`) && SHA.test(ref.commit)
      && (ref.upstream === null || typeof ref.upstream === "string"))
    || (value.branch !== null && !value.refs.some(ref => ref.ref === `refs/heads/${value.branch}`))) throw new Error("invalid_nested_migration_record");
  return value;
}

async function writePending(db: Db, workspaceId: string, name: string, value: NestedCloneMigrationPending | null) {
  const key = NESTED_CLONE_MIGRATION_PENDING_KEY;
  await db.update(executionWorkspaces).set({ metadata: value
    ? sql`jsonb_set(coalesce(${executionWorkspaces.metadata}, '{}'::jsonb), ${`{${key}}`}::text[],
        coalesce(${executionWorkspaces.metadata}->${key}, '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(value)}::jsonb))`
    : sql`CASE WHEN (${executionWorkspaces.metadata}->${key}) - ${name}::text = '{}'::jsonb THEN ${executionWorkspaces.metadata} - ${key}::text
        ELSE ${executionWorkspaces.metadata} #- ${`{${key},${name}}`}::text[] END` }).where(eq(executionWorkspaces.id, workspaceId));
}

export async function listNestedCloneMigrationNames(db: Db, workspace: Workspace) {
  const names = new Set(Object.keys(pendingRecords(workspace)).filter(name => CHECKOUT_NAME.test(name)));
  if (!workspace.cwd || !isNestedCloneMigrationCandidate(workspace)) return [...names].sort();
  const root = path.join(workspace.cwd, PROJECT_REPOSITORIES_DIR);
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return [...names].sort();
  const rows = await db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef, cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId!)));
  let selected = rows;
  try {
    selected = selectRestoredProjectRepositories(rows, workspace.metadata?.[GIT_CACHE_RESTORATION_KEY] === undefined ? undefined : readGitCacheRestoration(workspace)?.contents);
  } catch { selected = rows; }
  const configured = new Set(selected.filter(row => row.repoUrl)
    .map(row => managedProjectCheckoutName({ id: row.id, repoUrl: row.repoUrl!, repoRef: row.repoRef, cwd: row.cwd })));
  for (const name of configured) {
    if ((await Promise.all(Object.values(STAGING_SUFFIXES).map(suffix => exists(path.join(root, `${name}${suffix}`))))).some(Boolean)) { names.add(name); continue; }
    const marker = await fs.lstat(path.join(root, name, ".git")).catch(() => null);
    if (marker?.isDirectory() && !marker.isSymbolicLink()) names.add(name);
  }
  return [...names].sort();
}

async function nestedCloneSource(db: Db, workspace: Workspace, name: string): Promise<Source> {
  const rows = await db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef, cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId!)));
  let selected: typeof rows;
  try {
    const contents = workspace.metadata?.[GIT_CACHE_RESTORATION_KEY] === undefined ? undefined : readGitCacheRestoration(workspace)?.contents;
    selected = selectRestoredProjectRepositories(rows, contents);
  } catch { throw new Error("invalid_restoration_recipe"); }
  const source = selected.find(row => row.repoUrl && managedProjectCheckoutName({ id: row.id, repoUrl: row.repoUrl, repoRef: row.repoRef, cwd: row.cwd }) === name);
  if (!source?.repoUrl) throw new Error("unknown_managed_checkout");
  if (source.cwd && source.cwd !== REPO_ONLY_CWD_SENTINEL && await fs.stat(source.cwd).then(entry => entry.isDirectory(), () => false)) {
    throw new Error("local_source_checkout");
  }
  const candidates = nestedRepositoryBaseCandidates({ companyId: workspace.companyId, projectId: workspace.projectId!, repoUrl: source.repoUrl });
  let mismatch = false;
  for (const candidate of candidates) {
    if (await isVerifiedNestedRepositoryBase(candidate, candidates, source.repoUrl)) {
      return { repoUrl: source.repoUrl, base: await fs.realpath(candidate), candidates, source: { ...source, repoUrl: source.repoUrl } };
    }
    if (await exists(path.join(candidate, ".git"))) mismatch = true;
  }
  throw new Error(mismatch ? "shared_base_repo_mismatch" : "no_shared_base");
}

async function excludeLines(gitDir: string) {
  return (await fs.readFile(path.join(gitDir, "info", "exclude"), "utf8").catch(() => "")).split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

async function inspectStandaloneClone(checkout: string, repoUrl: string, base: string, signal?: AbortSignal) {
  const stat = await fs.lstat(checkout).catch(() => null);
  if (!stat) throw new Error("missing_managed_checkout");
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unproven_managed_checkout");
  const marker = await fs.lstat(path.join(checkout, ".git")).catch(() => null);
  if (marker?.isFile()) throw new Error("already_worktree_backed");
  if (!marker?.isDirectory() || marker.isSymbolicLink()) throw new Error("unproven_managed_checkout");
  const real = await fs.realpath(checkout);
  if (real !== await canonicalPath(checkout) || await fs.realpath(path.join(checkout, ".git")) !== path.join(real, ".git")) throw new Error("unproven_managed_checkout");
  if ((await git(real, ["rev-parse", "--show-toplevel"], { signal })).trim() !== real
    || (await git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal })).trim() !== path.join(real, ".git")) {
    throw new Error("unproven_managed_checkout");
  }
  if (await git(real, ["config", "--local", "--null", "--get-all", "remote.origin.url"], { signal }).catch(() => "") !== `${repoUrl}\0`) throw new Error("foreign_origin");
  const keys = (await git(real, ["config", "--local", "--name-only", "--list"], { signal })).split("\n").map(key => key.trim()).filter(Boolean);
  if (keys.some(key => !LOCAL_CONFIG.test(key))) throw new Error("unsupported_local_git_config");
  if ((await git(real, ["worktree", "list", "--porcelain"], { signal })).split("\n").filter(line => line.startsWith("worktree ")).length !== 1) {
    throw new Error("nested_clone_has_worktrees");
  }
  for (const name of UNSUPPORTED_GIT_STATE) if (await exists(path.join(real, ".git", name))) throw new Error("unsupported_local_git_state");
  const hooks = await fs.readdir(path.join(real, ".git", "hooks")).catch(() => [] as string[]);
  if (hooks.some(hook => !hook.endsWith(".sample"))) throw new Error("nested_clone_has_hooks");
  const shared = new Set(await excludeLines(path.join(base, ".git")));
  if ((await excludeLines(path.join(real, ".git"))).some(line => !shared.has(line))) throw new Error("unsupported_info_exclude");
  if ((await git(real, ["for-each-ref", "--format=%(refname)", "refs/stash"], { signal })).trim()) throw new Error("nested_clone_has_stash");
  const refs = (await git(real, ["for-each-ref", "--format=%(refname)"], { signal })).split("\n").filter(Boolean);
  if (refs.some(ref => !/^refs\/(heads|tags|remotes\/origin)\//.test(ref))) throw new Error("unsupported_nested_clone_refs");
  if ((await git(real, ["ls-files", "-v"], { signal })).split("\n").some(line => /^[a-zS] /.test(line))) throw new Error("unsupported_index_flags");
  const head = (await git(real, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })).trim();
  const branch = (await git(real, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal }).catch(() => "")).trim() || null;
  return { checkout: real, admin: path.join(real, ".git"), head, branch };
}

async function onRemote(base: string, commit: string, signal?: AbortSignal) {
  const missing = await git(base, ["rev-list", "--max-count=1", commit, "--not", "--remotes=origin"], { signal }).catch(() => null);
  return missing !== null && missing.trim() === "";
}

async function upstreamOf(clone: string, branch: string) {
  const remote = (await git(clone, ["config", "--local", "--get", `branch.${branch}.remote`]).catch(() => "")).trim();
  const merge = (await git(clone, ["config", "--local", "--get", `branch.${branch}.merge`]).catch(() => "")).trim();
  return remote === "origin" && merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch;
}

async function planRefs(clone: { checkout: string; head: string; branch: string | null }, base: string, prefix: string, signal?: AbortSignal) {
  const planned: PlannedRef[] = [];
  if (clone.branch) planned.push({ ref: `refs/heads/${prefix}${clone.branch}`, commit: clone.head, upstream: await upstreamOf(clone.checkout, clone.branch) });
  const refs = (await git(clone.checkout, ["for-each-ref", "--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype) %(refname)", "refs/heads", "refs/tags", "refs/remotes/origin"], { signal }))
    .split("\n").filter(Boolean).map(line => line.split(" ")).filter(([, , , , ref]) => ref !== "refs/remotes/origin/HEAD");
  for (const [sha, type, peeled, peeledType, ref] of refs) {
    if (!ref || ref === `refs/heads/${clone.branch}`) continue;
    const commit = type === "commit" ? sha! : peeledType === "commit" ? peeled! : null;
    if (!commit || !SHA.test(commit)) throw new Error("unsupported_nested_clone_tag");
    if (await onRemote(base, commit, signal)) continue;
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length)
      : ref.startsWith("refs/tags/") ? `tags/${ref.slice("refs/tags/".length)}` : `remotes/${ref.slice("refs/remotes/".length)}`;
    planned.push({ ref: `refs/heads/${prefix}${name}`, commit, upstream: ref.startsWith("refs/heads/") ? await upstreamOf(clone.checkout, name) : null });
  }
  const names = new Set<string>();
  for (const { ref } of planned) {
    await git(base, ["check-ref-format", ref]).catch(() => { throw new Error("unsupported_branch_name"); });
    if (names.has(ref) || (await git(base, ["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim()) throw new Error("nested_clone_ref_conflict");
    names.add(ref);
  }
  return planned;
}

async function assertNoBranchOnlyReflogHistory(clone: { checkout: string; admin: string; head: string }, signal?: AbortSignal) {
  const local = (await git(clone.checkout, ["reflog", "show", "--all", "--format=%H %gD"], { signal }).catch(() => ""))
    .split("\n").map(line => line.trim().split(" ")).filter(([sha, selector]) => SHA.test(sha ?? "") && /^refs\/(heads|tags)\//.test(selector ?? "")).map(([sha]) => sha!);
  if (local.length === 0) return;
  const covered = [clone.head, ...shas(await git(clone.checkout, ["reflog", "show", "--format=%H", "HEAD"], { signal }).catch(() => "")),
    ...shas((await fs.readFile(path.join(clone.admin, "ORIG_HEAD"), "utf8").catch(() => ""))),
    ...shas(await git(clone.checkout, ["for-each-ref", "--format=%(objectname)", "refs/heads"], { signal })),
    ...shas(await git(clone.checkout, ["for-each-ref", "--format=%(*objectname)", "refs/tags"], { signal })),
    ...shas(await git(clone.checkout, ["for-each-ref", "--format=%(objectname)", "refs/tags"], { signal }))];
  const missing = await git(clone.checkout, ["rev-list", "--max-count=1", "--stdin"], { signal,
    input: [...new Set(local)].join("\n") + "\n" + [...new Set(covered)].map(sha => `^${sha}`).join("\n") + "\n--not\n--remotes\n" });
  if (missing.trim()) throw new Error("unique_branch_reflog_commits");
}

async function preservedCandidates(checkout: string, head: string, boundary: string[], planned: PlannedRef[], signal?: AbortSignal) {
  const candidates = [...new Set(planned.map(ref => ref.commit).filter(commit => commit !== head))];
  if (candidates.length === 0) return [];
  const unreachable = new Set(shas(await git(checkout, ["rev-list", "--stdin"], { signal,
    input: [...candidates, `^${head}`, ...boundary.map(commit => `^${commit}`)].join("\n") + "\n" })));
  return candidates.filter(commit => unreachable.has(commit));
}

function lockToken(workspaceId: string, name: string) {
  return createHash("sha256").update(`paperclip-nested-clone-migration:${workspaceId}:${name}`).digest("hex");
}

function cloneLockLocations(checkout: string, branch: string | null): GitExpirationLockLocation[] {
  return [...["index.lock", "HEAD.lock"].map(name => ({ root: checkout, relativePath: path.join(".git", name), checkout: null })),
    ...(branch ? [{ root: checkout, relativePath: path.join(".git", "refs", "heads", `${branch}.lock`), checkout: null }] : [])];
}

async function fetchBase(base: string, repoUrl: string, resolveGitAuth: GitRemoteAuthProvider, signal?: AbortSignal) {
  const auth = await resolveGitAuth(repoUrl).catch(() => null);
  await git(base, ["fetch", "--quiet", "--prune", "--no-write-fetch-head", "origin"], { auth, signal, timeout: FETCH_TIMEOUT_MS }).catch(() => undefined);
}

async function deletePlannedRefs(base: string, refs: PlannedRef[]) {
  const held = (await git(base, ["worktree", "list", "--porcelain"])).split("\n").filter(line => line.startsWith("branch ")).map(line => line.slice(7));
  for (const { ref, commit } of [...refs].reverse()) {
    if (held.includes(ref) || (await git(base, ["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim() !== commit) continue;
    await git(base, ["update-ref", "-d", ref, commit]);
    const branch = ref.slice("refs/heads/".length);
    for (const key of ["remote", "merge"]) await git(base, ["config", "--local", "--unset-all", `branch.${branch}.${key}`]).catch(() => undefined);
  }
}

async function rollBack(base: string, paths: Paths, pending: NestedCloneMigrationPending) {
  if (await exists(paths.worktree)) {
    const linked = await readLinkedNestedCheckout(paths.worktree).catch(() => null);
    if (!linked || linked.base !== base) throw new Error("nested_migration_recovery_conflict");
    await returnTransferItems(paths.checkout, paths.worktree, pending.moves, "nested_migration_rollback_conflict");
    await git(base, ["worktree", "remove", "--force", "--force", paths.worktree], { timeout: FETCH_TIMEOUT_MS });
  }
  await removeStaleNestedRegistrations(base, paths.worktree);
  await deletePlannedRefs(base, pending.refs);
}

async function forgetRemovedWorkspace(db: Db, row: Workspace, name: string) {
  const value = pendingRecords(row)[name] as NestedCloneMigrationPending | undefined;
  const base = value && typeof value.base === "string" ? value.base : null;
  if (base && Array.isArray(value!.refs) && await exists(path.join(base, ".git"))) {
    await withNestedRepositoryBaseLock(base, async () => {
      const root = path.join(row.cwd!, PROJECT_REPOSITORIES_DIR);
      for (const target of [path.join(root, name), path.join(root, `${name}${STAGING_SUFFIXES.worktree}`)]) {
        await removeStaleNestedRegistrations(base, target).catch(() => undefined);
      }
      const pushed: PlannedRef[] = [];
      for (const ref of value!.refs) {
        if (ref && typeof ref.ref === "string" && ref.ref.startsWith("refs/heads/") && isNestedWorktreeBranchName(ref.ref.slice("refs/heads/".length))
          && SHA.test(ref.commit) && await onRemote(base, ref.commit)) pushed.push(ref);
      }
      await deletePlannedRefs(base, pushed);
    });
  }
  await writePending(db, row.id, name, null);
}

function migratedRecipe(row: Workspace, name: string, contents: Awaited<ReturnType<typeof readManagedCheckoutContents>>): GitCacheRestoration | undefined {
  if (row.metadata?.[GIT_CACHE_RESTORATION_KEY] === undefined) return undefined;
  try {
    const recipe = readGitCacheRestoration(row);
    if (!recipe?.contents?.checkouts.some(checkout => checkout.name === name)) return undefined;
    const next: GitCacheRestoration = { ...recipe, contents: { ...recipe.contents, checkouts: recipe.contents.checkouts.map(checkout => checkout.name === name
      ? { ...checkout, commit: contents.commit, branchName: contents.branchName, worktree: contents.worktree } : checkout) } };
    readGitCacheRestoration({ ...row, metadata: { ...row.metadata, [GIT_CACHE_RESTORATION_KEY]: next } });
    return next;
  } catch { return undefined; }
}

async function finalize(db: Db, row: Workspace, name: string, paths: Paths, source: Source, pending: NestedCloneMigrationPending,
  hooks?: NestedCloneMigrationHooks) {
  if (pending.phase !== "cleanup") {
    const linked = await readLinkedNestedCheckout(paths.checkout, source.candidates).catch(() => null);
    if (!linked || linked.base !== source.base || linked.checkout !== paths.checkout) throw new Error("nested_migration_recovery_conflict");
    const contents = await readManagedCheckoutContents(paths.checkout, name, source.source);
    await db.transaction(async tx => {
      const [current] = await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, row.id)).for("update");
      if (!current) throw new Error("workspace_changed");
      const recipe = migratedRecipe(current, name, contents);
      const records = { ...pendingRecords(current), [name]: { ...pending, phase: "cleanup" } };
      await tx.update(executionWorkspaces).set({ metadata: { ...current.metadata, [NESTED_CLONE_MIGRATION_PENDING_KEY]: records,
        ...(recipe ? { [GIT_CACHE_RESTORATION_KEY]: recipe } : {}) } }).where(eq(executionWorkspaces.id, row.id));
    });
    await hooks?.afterFinalize?.({ checkout: paths.checkout, aside: paths.aside });
  }
  let reclaimed = 0;
  if (await exists(paths.aside)) {
    reclaimed += await allocatedBytes(paths.aside, () => true).catch(() => 0);
    if (await exists(paths.trash)) await fs.rm(paths.trash, { recursive: true, force: true });
    await fs.rename(paths.aside, paths.trash);
  }
  if (await exists(paths.trash)) {
    if (!reclaimed) reclaimed += await allocatedBytes(paths.trash, () => true).catch(() => 0);
    await fs.rm(paths.trash, { recursive: true, force: true });
  }
  await writePending(db, row.id, name, null);
  return reclaimed;
}

async function settle(db: Db, row: Workspace, name: string, paths: Paths, source: Source, pending: NestedCloneMigrationPending,
  hooks?: NestedCloneMigrationHooks): Promise<{ forward: boolean; reclaimed: number }> {
  if (pending.phase === "cleanup") return { forward: true, reclaimed: await finalize(db, row, name, paths, source, pending, hooks) };
  if (pending.phase === "swap" && await exists(paths.aside)) {
    if (!await exists(paths.checkout)) {
      const staged = await readLinkedNestedCheckout(paths.worktree).catch(() => null);
      if (!staged || staged.base !== source.base) throw new Error("nested_migration_recovery_conflict");
      await moveNestedRepositoryWorktree(source.base, paths.worktree, paths.checkout);
    } else if (await exists(paths.worktree)) throw new Error("nested_migration_recovery_conflict");
    return { forward: true, reclaimed: await finalize(db, row, name, paths, source, pending, hooks) };
  }
  if (await exists(paths.aside)) throw new Error("nested_migration_recovery_conflict");
  const marker = await fs.lstat(path.join(paths.checkout, ".git")).catch(() => null);
  if (!marker?.isDirectory() || marker.isSymbolicLink()) throw new Error("nested_migration_recovery_conflict");
  await rollBack(source.base, paths, pending);
  await writePending(db, row.id, name, null);
  return { forward: false, reclaimed: 0 };
}

export async function migrateNestedRepositoryClone(db: Db, snapshot: Workspace, name: string,
  options: NestedCloneMigrationOptions = {}): Promise<NestedCloneMigrationResult> {
  const result: NestedCloneMigrationResult = { name, outcome: "skipped", reason: null, branchName: null, candidateBytes: 0, reclaimedBytes: 0 };
  if ((!isNestedCloneMigrationCandidate(snapshot) && !canRecover(snapshot, name)) || !CHECKOUT_NAME.test(name)) return { ...result, reason: "not_candidate" };
  const { signal, hooks } = options;
  try {
    return await withWorkspaceMoveLocks(db, snapshot, async tx => {
      let [row] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id), eq(executionWorkspaces.companyId, snapshot.companyId)));
      if (!row || (!isNestedCloneMigrationCandidate(row) && !canRecover(row, name)) || row.cwd !== snapshot.cwd) throw new Error("workspace_changed");
      if (!isNestedCloneMigrationCandidate(row) && !await exists(row.cwd!)) {
        if (options.dryRun) return { ...result, outcome: "dry_run" as const, reason: "interrupted_migration_pending" };
        await forgetRemovedWorkspace(db, row, name);
        return { ...result, outcome: "rolled_back" as const, reason: "workspace_removed" };
      }
      const cwd = await fs.realpath(row.cwd!);
      const rootStat = await fs.lstat(path.join(cwd, PROJECT_REPOSITORIES_DIR)).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("missing_managed_checkout");
      const root = path.join(cwd, PROJECT_REPOSITORIES_DIR);
      const paths: Paths = { checkout: path.join(root, name), worktree: path.join(root, `${name}${STAGING_SUFFIXES.worktree}`),
        aside: path.join(root, `${name}${STAGING_SUFFIXES.aside}`), trash: path.join(root, `${name}${STAGING_SUFFIXES.trash}`) };
      const prefix = await nestedWorktreeBranchPrefix(paths.checkout);
      const source = await nestedCloneSource(db, row, name);
      const token = lockToken(row.id, name);
      const interrupted = readPending(row, name, prefix);
      if (interrupted) {
        if (interrupted.base !== source.base) throw new Error("invalid_nested_migration_record");
        if (options.dryRun) return { ...result, outcome: "dry_run" as const, reason: "interrupted_migration_pending", branchName: interrupted.branch };
        const settled = await withNestedRepositoryBaseLock(source.base, async () => {
          await recoverGitExpirationLocks(cloneLockLocations(paths.checkout, interrupted.branch?.slice(prefix.length) ?? null), token).catch(() => undefined);
          return settle(db, row!, name, paths, source, interrupted, hooks);
        });
        if (settled.forward) return { ...result, outcome: "recovered" as const, branchName: interrupted.branch, reclaimedBytes: settled.reclaimed };
        result.outcome = "rolled_back";
        [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, snapshot.id));
        if (!row) throw new Error("workspace_changed");
        if (!isNestedCloneMigrationCandidate(row)) return result;
      }
      if (await exists(paths.trash) && !options.dryRun) await fs.rm(paths.trash, { recursive: true, force: true });
      if (await exists(paths.aside) || await exists(paths.worktree)) throw new Error("nested_migration_staging_exists");
      if (!await workspaceMoveEligible(tx, row)) throw new Error("live_or_unresolved_consumer");
      const inspected = await inspectStandaloneClone(paths.checkout, source.repoUrl, source.base, signal);
      await recoverGitExpirationLocks(cloneLockLocations(inspected.checkout, inspected.branch), token).catch(() => undefined);
      result.branchName = inspected.branch ? `${prefix}${inspected.branch}` : null;
      result.candidateBytes = await allocatedBytes(inspected.admin, () => { signal?.throwIfAborted(); return true; }).catch(() => 0);
      if (options.dryRun) return { ...result, outcome: "dry_run" as const };
      return await withNestedRepositoryBaseLock(source.base, async () => {
        const base = source.base;
        await assertSafeBaseConfig(base, signal);
        await fetchBase(base, source.repoUrl, options.resolveGitAuth
          ?? withAnonymousGitFallback(createIssueGitRemoteAuthProvider(db, row!.companyId, row!.sourceIssueId!)), signal);
        await assertSafeBaseConfig(base, signal);
        await assertNoBranchOnlyReflogHistory(inspected, signal);
        const planned = await planRefs(inspected, base, prefix, signal);
        const moves = await transferPlan(inspected.checkout, signal);
        const linkedBases = await linkedCheckoutBases(inspected.checkout, moves);
        const locks = await acquireGitExpirationLocks(cloneLockLocations(inspected.checkout, inspected.branch), token)
          .catch(() => { throw new Error("worktree_git_busy"); });
        const pending: NestedCloneMigrationPending = { base, head: inspected.head, branch: result.branchName, refs: planned, moves, phase: "transfer" };
        let recorded = false, swapped = false;
        try {
          const before = await currentRestorePointSnapshot(inspected.checkout, signal);
          const beforeHistory = await historyKey(inspected.checkout, inspected.admin, signal);
          if (before.head !== inspected.head) throw new Error("head_changed");
          const boundary = await sharedHistoryBoundary(inspected.checkout, base, inspected.head, signal);
          const captured = await captureRestorePoint({ cwd: inspected.checkout, upstreamCommits: boundary, signal,
            preserveCommits: await preservedCandidates(inspected.checkout, inspected.head, boundary, planned, signal) });
          const manifest = captured ? await importRestorePoint({ repositoryCwd: base, payload: captured.payload, signal }) : null;
          const reflog = shas(await git(inspected.checkout, ["reflog", "show", "--format=%H", "HEAD"], { signal }).catch(() => ""));
          const original = (await fs.readFile(path.join(inspected.admin, "ORIG_HEAD"), "utf8").catch(() => "")).trim();
          const history = [inspected.head, ...reflog, ...(SHA.test(original) ? [original] : []), ...planned.map(ref => ref.commit)];
          const present = await presentCommits(base, history, signal);
          if (history.some(sha => !present.has(sha))) throw new Error("history_not_transferred");
          await writePending(db, row!.id, name, pending);
          recorded = true;
          for (const ref of planned) {
            await git(base, ["update-ref", ref.ref, ref.commit, ""], { signal });
            await trackNestedWorktreeUpstream(base, ref.ref.slice("refs/heads/".length), ref.upstream);
          }
          await hooks?.beforeWorktreeAdd?.({ from: inspected.checkout, to: paths.worktree });
          await assertSafeBaseConfig(base, signal);
          await git(base, ["worktree", "add", "--quiet", ...(result.branchName ? [paths.worktree, result.branchName] : ["--detach", paths.worktree, inspected.head])],
            { signal, timeout: FETCH_TIMEOUT_MS });
          const staged = await canonicalPath(paths.worktree);
          await assertSafeBaseConfig(base, signal);
          if (manifest) await applyRestorePoint({ cwd: staged, manifest, signal });
          const admin = (await git(staged, ["rev-parse", "--absolute-git-dir"], { signal })).trim();
          await fs.mkdir(path.join(admin, "logs"), { recursive: true });
          await fs.copyFile(path.join(inspected.admin, "logs", "HEAD"), path.join(admin, "logs", "HEAD")).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            await fs.rm(path.join(admin, "logs", "HEAD"), { force: true });
          });
          if (SHA.test(original)) await fs.copyFile(path.join(inspected.admin, "ORIG_HEAD"), path.join(admin, "ORIG_HEAD"));
          else await fs.rm(path.join(admin, "ORIG_HEAD"), { force: true });
          await assertSafeBaseConfig(base, signal);
          await moveTransferItems(inspected.checkout, staged, moves, linkedBases);
          await hooks?.beforeVerify?.({ from: inspected.checkout, to: staged });
          const after = await currentRestorePointSnapshot(inspected.checkout, signal);
          const moved = await currentRestorePointSnapshot(staged, signal);
          if (snapshotKey(after) !== snapshotKey(before) || snapshotKey(moved) !== snapshotKey(before)) throw new Error("snapshot_mismatch");
          if (await historyKey(inspected.checkout, inspected.admin, signal) !== beforeHistory || await historyKey(staged, admin, signal) !== beforeHistory) {
            throw new Error("history_mismatch");
          }
          const symbolic = (await git(staged, ["symbolic-ref", "--quiet", "HEAD"], { signal }).catch(() => "")).trim();
          if (symbolic !== (result.branchName ? `refs/heads/${result.branchName}` : "")) throw new Error("branch_identity_changed");
          for (const ref of planned) {
            if ((await git(base, ["rev-parse", "--verify", "-q", ref.ref], { signal }).catch(() => "")).trim() !== ref.commit) throw new Error("history_not_transferred");
          }
          await assertTransferredItems(inspected.checkout, staged, moves, linkedBases);
          const [current] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, row!.id));
          if (!current || current.updatedAt.getTime() !== row!.updatedAt.getTime() || current.cwd !== row!.cwd) throw new Error("workspace_changed");
          if (!await workspaceMoveEligible(tx, current)) throw new Error("live_or_unresolved_consumer");
          pending.phase = "swap";
          await writePending(db, row!.id, name, pending);
          await fs.rename(inspected.checkout, paths.aside);
          swapped = true;
          await hooks?.afterAside?.({ checkout: paths.checkout, aside: paths.aside });
          await moveNestedRepositoryWorktree(base, staged, paths.checkout);
          await hooks?.afterMove?.({ checkout: paths.checkout, aside: paths.aside });
          if ((await git(paths.checkout, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })).trim() !== inspected.head) throw new Error("head_changed");
          result.reclaimedBytes = await finalize(db, row!, name, paths, source, pending, hooks);
          result.outcome = "migrated";
          result.reason = null;
          return result;
        } finally {
          try {
            if (!swapped && recorded) {
              await rollBack(base, paths, pending);
              await writePending(db, row!.id, name, null);
            }
          } finally { await locks.release().catch(() => undefined); }
        }
      });
    });
  } catch (error) {
    signal?.throwIfAborted();
    const { reason, failure } = workspaceMoveSkip(error);
    if (result.outcome !== "rolled_back") result.outcome = "skipped";
    return { ...result, reason, ...(failure ? { failure } : {}) };
  }
}

export async function migrateNestedRepositoryClones(db: Db, workspace: Workspace, options: NestedCloneMigrationOptions = {}) {
  const results: NestedCloneMigrationResult[] = [];
  for (const name of await listNestedCloneMigrationNames(db, workspace)) results.push(await migrateNestedRepositoryClone(db, workspace, name, options));
  return results;
}
