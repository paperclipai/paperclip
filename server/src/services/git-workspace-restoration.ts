import { validateGitWorkspaceContents, type GitWorkspaceContents } from "./git-workspace-contents.js";
import { recoverGitExpirationLocks, type GitExpirationLockLocation } from "./git-workspace-expiration-locks.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { promisify } from "node:util";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { isRuntimeOwnedGitBranch } from "./execution-workspace-branch-ownership.js";
import { recordedIsolatedRemoteSource, verifiedRecordedIsolatedRemoteSource, materializeIsolatedRemoteWorkspaceSource } from "./isolated-remote-workspace-source.js";
import { findRegenerableWorkspaceDirs } from "./workspace-compaction.js";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";

const execFile = promisify(execFileCallback);
const shaPattern = /^[a-f0-9]{40}$/;
export const GIT_CACHE_RESTORATION_KEY = "gitCacheRestoration";
export const GIT_CACHE_EXPIRATION_REASON = "reproducible_git_cache_expired";
export type GitCacheRestoration = {
  schema: "paperclip.git-cache-restoration.v1";
  companyId: string;
  workspaceId: string;
  sourceIssueId: string;
  repoUrl: string;
  commit: string;
  branchName: string;
  sourceKind: "isolated_remote" | "managed_project";
  projectId: string | null;
  sourcePath: string;
  worktreePath: string;
  gitBranchOwnershipVersion: 1;
  verifiedAt: string;
  restoredAt?: string;
  contentsRestoredAt?: string | null;
  contents?: GitWorkspaceContents;
};
export type GitCacheExpiration = {
  schema: "paperclip.git-cache-expiration.v1"; generation: number; workspaceRemoved: boolean;
  worktreeTrash: string; worktreeAdmin: string; baseTrash: string | null; completed: boolean; lockToken?: string;
};
type Workspace = {
  id: string; companyId: string; projectId: string | null; sourceIssueId: string | null; repoUrl: string | null;
  mode: string | null; strategyType: string | null; branchName: string | null;
  cwd: string | null; providerRef: string | null; status?: string; metadata: Record<string, unknown> | null;
};

function managedSourcePaths(workspace: Workspace) {
  if (!workspace.projectId || !workspace.repoUrl) return [];
  let repoName: string | null = null;
  try { repoName = new URL(workspace.repoUrl).pathname.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/i, "") || null; } catch { return []; }
  const root = resolveManagedProjectWorkspaceDir({ companyId: workspace.companyId, projectId: workspace.projectId, repoName });
  return [root, `${root}-${createHash("sha256").update(workspace.repoUrl).digest("hex").slice(0, 12)}`];
}

async function verifiedGitCacheSource(workspace: Workspace, sourcePath: string) {
  const privateSource = recordedIsolatedRemoteSource(workspace);
  if (privateSource) {
    if (sourcePath !== privateSource) throw new GitCacheRestorationFailure();
    return (await verifiedRecordedIsolatedRemoteSource(workspace))!;
  }
  if (!managedSourcePaths(workspace).includes(sourcePath)) throw new GitCacheRestorationFailure();
  const root = resolvePaperclipInstanceRoot();
  const actual = await fs.realpath(sourcePath);
  if (actual !== path.join(await fs.realpath(root), path.relative(root, sourcePath))) throw new GitCacheRestorationFailure();
  const storage = await fs.lstat(path.join(actual, ".git"));
  if (!storage.isDirectory() || storage.isSymbolicLink()
    || (await gitCacheCommand(actual, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim() !== path.join(actual, ".git")
    || (await gitCacheCommand(actual, ["config", "--local", "--null", "--get-all", "remote.origin.url"])) !== `${workspace.repoUrl}\0`) throw new GitCacheRestorationFailure();
  return sourcePath;
}

export class GitCacheRestorationFailure extends Error {
  constructor() { super("The saved workspace commit could not be restored. Check repository access and retry."); }
}

export function readGitCacheRestoration(workspace: Workspace): GitCacheRestoration | null {
  const value = workspace.metadata?.[GIT_CACHE_RESTORATION_KEY];
  if (value === undefined) return null;
  const recipe = value as GitCacheRestoration | null;
  if (!recipe || recipe.schema !== "paperclip.git-cache-restoration.v1"
    || !isRuntimeOwnedGitBranch(workspace.metadata)
    || recipe.gitBranchOwnershipVersion !== 1
    || recipe.companyId !== workspace.companyId || recipe.workspaceId !== workspace.id
    || recipe.sourceIssueId !== workspace.sourceIssueId || recipe.repoUrl !== workspace.repoUrl
    || recipe.branchName !== workspace.branchName || recipe.worktreePath !== workspace.cwd
    || (workspace.providerRef && recipe.worktreePath !== workspace.providerRef)
    || recipe.projectId !== workspace.projectId
    || (recipe.sourceKind === "isolated_remote" ? recipe.sourcePath !== recordedIsolatedRemoteSource(workspace)
      : recipe.sourceKind !== "managed_project" || recordedIsolatedRemoteSource(workspace) !== null || !managedSourcePaths(workspace).includes(recipe.sourcePath))
    || !shaPattern.test(recipe.commit) || !Number.isFinite(Date.parse(recipe.verifiedAt))
    || (recipe.restoredAt !== undefined && !Number.isFinite(Date.parse(recipe.restoredAt)))
    || (recipe.contentsRestoredAt != null && !Number.isFinite(Date.parse(recipe.contentsRestoredAt)))) {
    throw new GitCacheRestorationFailure();
  }
  validateGitWorkspaceContents(recipe.contents);
  return recipe;
}

export async function gitCacheCommand(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await execFile("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    timeout: 60_000, signal, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

/** A fresh object store proves the object came from upstream, not our cache. */
export async function verifyRemoteGitCommit(repoUrl: string, commit: string, resolveGitAuth: GitRemoteAuthProvider, signal?: AbortSignal) {
  if (!shaPattern.test(commit)) throw new GitCacheRestorationFailure();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-proof-"));
  try {
    const auth = await resolveGitAuth(repoUrl);
    const env = { ...process.env, ...auth?.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
    const options = { timeout: 60_000, signal, maxBuffer: 1024 * 1024, env };
    await execFile("git", ["init", "--bare", temporary], options);
    await execFile("git", [...auth?.configArgs ?? [], "-C", temporary, "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", repoUrl, commit], options);
    const result = await execFile("git", ["-C", temporary, "rev-parse", "FETCH_HEAD^{commit}"], options);
    if (result.stdout.trim() !== commit) throw new GitCacheRestorationFailure();
  } catch { throw new GitCacheRestorationFailure(); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

let templateFiles: Promise<Map<string, Buffer>> | undefined;
async function stockGitFiles() {
  templateFiles ??= (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-template-"));
    const files = new Map<string, Buffer>();
    try {
      await execFile("git", ["init", "--bare", root], { timeout: 10_000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
      for (const name of ["description", "info/exclude", ...(await fs.readdir(path.join(root, "hooks"))).map(name => `hooks/${name}`)]) {
        files.set(name, await fs.readFile(path.join(root, name)));
      }
      return files;
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  })();
  return templateFiles;
}

export async function assertReproducibleBaseGitStorage(cwd: string, signal?: AbortSignal) {
  const root = path.join(cwd, ".git");
  const allowed = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "index", "config", "description", "hooks", "info", "refs", "objects", "logs", "packed-refs", "worktrees", "branches"]);
  if ((await fs.readdir(root)).some(name => !allowed.has(name))) throw new Error("unknown_base_git_files");
  const branches = path.join(root, "branches");
  const branchesStat = await fs.lstat(branches).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (branchesStat && (!branchesStat.isDirectory() || branchesStat.isSymbolicLink()
    || (await fs.readdir(branches)).length > 0)) throw new Error("custom_git_metadata");
  const templates = await stockGitFiles();
  for (const directory of ["hooks", "info"]) {
    for (const name of await fs.readdir(path.join(root, directory))) {
      const file = `${directory}/${name}`;
      const entry = await fs.lstat(path.join(root, file));
      if (!entry.isFile()) throw new Error("custom_git_metadata");
      const actual = await fs.readFile(path.join(root, file));
      const template = templates.get(file);
      const managedExclude = file === "info/exclude" && template
        ? Buffer.concat([template, Buffer.from(`\n/${PROJECT_REPOSITORIES_DIR}/\n`)]) : null;
      if (!template?.equals(actual) && !managedExclude?.equals(actual)) throw new Error("custom_git_metadata");
    }
  }
  if (!templates.get("description")?.equals(await fs.readFile(path.join(root, "description")))) throw new Error("custom_git_metadata");
  // A custom hook or metadata file inside object/ref storage must not disappear
  // merely because Git's object/ref enumeration does not mention it.
  async function walk(relative: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("unsupported_git_storage");
      if (entry.isDirectory()) { await walk(name); continue; }
      const valid = /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(name)
        || /^objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)$/.test(name)
        || /^(refs|logs\/refs)\/(heads|remotes\/origin)\//.test(name)
        || name === "logs/HEAD";
      if (!valid) throw new Error("unknown_git_storage_file");
    }
  }
  for (const directory of ["objects", "refs", "logs"]) await walk(directory);
}

const PAPERCLIP_CLAUDE_SETTINGS_FILE = ".claude/settings.local.json";

export type ManagedCheckoutProver = (checkoutPath: string, name: string, signal?: AbortSignal) => Promise<void>;

export async function assertReproducibleManagedCheckout(checkout: string, input: {
  repoUrl: string; resolveGitAuth: GitRemoteAuthProvider; signal?: AbortSignal;
}) {
  const { signal } = input;
  const gitDir = await fs.lstat(path.join(checkout, ".git")).catch(() => null);
  if (!gitDir?.isDirectory()) throw new Error("unproven_managed_checkout");
  if ((await gitCacheCommand(checkout, ["rev-parse", "--show-toplevel"], signal)).trim() !== await fs.realpath(checkout)) {
    throw new Error("unproven_managed_checkout");
  }
  const worktrees = (await gitCacheCommand(checkout, ["worktree", "list", "--porcelain"], signal))
    .split("\n").filter(line => line.startsWith("worktree "));
  if (worktrees.length !== 1) throw new Error("managed_checkout_has_worktrees");
  await assertReproducibleGitFiles(checkout, signal, { preserveSettings: true });
  await assertReproducibleBaseGitStorage(checkout, signal);
  const refs = (await gitCacheCommand(checkout, ["for-each-ref", "--format=%(refname)"], signal)).trim().split("\n").filter(Boolean);
  if (refs.some(ref => !/^refs\/(heads|tags|remotes\/origin)\//.test(ref))) throw new Error("unsupported_managed_checkout_refs");
  const localTips = new Set([
    ...(await gitCacheCommand(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).split("\n"),
    ...(await gitCacheCommand(checkout, ["for-each-ref", "--format=%(objectname)"], signal)).split("\n"),
    ...(await gitCacheCommand(checkout, ["reflog", "show", "--all", "--format=%H"], signal).catch(() => "")).split("\n"),
  ].map(line => line.trim()).filter(sha => shaPattern.test(sha)));
  if (localTips.size > MANAGED_CHECKOUT_LOCAL_TIP_LIMIT) throw new Error("managed_checkout_local_tip_budget");
  if (localTips.size && await hasCommitsMissingUpstream(checkout, [...localTips], input.repoUrl, input.resolveGitAuth, signal)) {
    throw new Error("unpushed_managed_checkout");
  }
  const unreachable = await gitCacheCommand(checkout, ["fsck", "--connectivity-only", "--unreachable", "--no-progress"], signal);
  if (unreachable.trim()) throw new Error("unreachable_managed_checkout_objects");
}

const MANAGED_CHECKOUT_LOCAL_TIP_LIMIT = 5_000;

async function hasCommitsMissingUpstream(checkout: string, localTips: string[], repoUrl: string,
  resolveGitAuth: GitRemoteAuthProvider, signal?: AbortSignal) {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-checkout-proof-"));
  try {
    const options = { timeout: 120_000, signal, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } };
    await execFile("git", ["init", "--bare", "--quiet", store], options);
    await fs.writeFile(path.join(store, "objects", "info", "alternates"), `${path.join(await fs.realpath(checkout), ".git", "objects")}\n`);
    try {
      const auth = await resolveGitAuth(repoUrl);
      await execFile("git", [...auth?.configArgs ?? [], "-C", store, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules",
        "--", repoUrl, "+refs/heads/*:refs/upstream/heads/*", "+refs/tags/*:refs/upstream/tags/*"],
        { ...options, env: { ...options.env, ...auth?.env } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("managed_checkout_upstream_unavailable");
    }
    const missing = await execFile("git", ["-C", store, "rev-list", "--max-count=1", ...localTips, "--not", "--glob=refs/upstream/*"], options);
    return missing.stdout.trim() !== "";
  } finally {
    await fs.rm(store, { recursive: true, force: true });
  }
}

async function assertReproducibleFetchHead(cwd: string, gitDir: string, signal?: AbortSignal,
  verifyFetchedCommit?: (commit: string, signal?: AbortSignal) => Promise<void>) {
  const target = path.join(gitDir, "FETCH_HEAD");
  const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return;
  const byteLimit = 64 * 1024;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > byteLimit) throw new Error("unsupported_worktree_fetch_head");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let contents: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > byteLimit) throw new Error("unsupported_worktree_fetch_head");
    const buffer = Buffer.alloc(byteLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > byteLimit) throw new Error("unsupported_worktree_fetch_head");
    contents = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents) || text && !text.endsWith("\n")) throw new Error("unsupported_worktree_fetch_head");
  const commits = new Set<string>();
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    const match = /^([a-f0-9]{40})\t(?:not-for-merge)?\t[^\t\r\n\0]*$/.exec(line);
    if (!match) throw new Error("unsupported_worktree_fetch_head");
    commits.add(match[1]!);
    if (commits.size > 32) throw new Error("worktree_fetch_head_budget");
  }
  for (const commit of commits) {
    signal?.throwIfAborted();
    const objectType = await gitCacheCommand(cwd, ["cat-file", "-t", commit], signal).catch(() => "");
    const ancestor = objectType.trim() === "commit" && await gitCacheCommand(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"], signal)
      .then(() => true, () => false);
    signal?.throwIfAborted();
    if (ancestor) continue;
    if (!verifyFetchedCommit) throw new Error("unverified_fetched_commit");
    await verifyFetchedCommit(commit, signal);
  }
}

export async function assertReproducibleGitFiles(cwd: string, signal?: AbortSignal, options: {
  proveManagedCheckout?: ManagedCheckoutProver;
  preserveSettings?: boolean;
  verifyFetchedCommit?: (commit: string, signal?: AbortSignal) => Promise<void>;
} = {}) {
  if ((await gitCacheCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], signal)).length) throw new Error("dirty_or_untracked_files");
  if ((await gitCacheCommand(cwd, ["ls-files", "-v"], signal)).split("\n").some(line => /^[a-zS] /.test(line))) throw new Error("unsupported_index_flags");
  const localConfig = await gitCacheCommand(cwd, ["config", "--local", "--name-only", "--list"], signal);
  if (localConfig.split("\n").filter(Boolean).some(key => !/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge))$/.test(key))) throw new Error("unsupported_local_git_config");
  const regenerable = await findRegenerableWorkspaceDirs(cwd, { signal });
  const ignored = (await gitCacheCommand(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], signal)).split("\0").filter(Boolean);
  const unexplained = ignored.filter(file => !(options.preserveSettings && file === PAPERCLIP_CLAUDE_SETTINGS_FILE) && !regenerable.some(dir => file.startsWith(`${dir}/`)));
  const checkouts = new Set<string>();
  for (const file of unexplained) {
    const [namespace, name, rest] = file.split("/", 3);
    if (namespace !== PROJECT_REPOSITORIES_DIR || !name || rest === undefined || !options.proveManagedCheckout
      || name.startsWith("task-repo-") || name.includes(".clone-")) throw new Error("unique_ignored_files");
    checkouts.add(name);
  }
  for (const name of checkouts) {
    const checkout = path.join(cwd, PROJECT_REPOSITORIES_DIR, name);
    const entry = await fs.lstat(checkout);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unique_ignored_files");
    await options.proveManagedCheckout!(checkout, name, signal);
  }
  const entries = await gitCacheCommand(cwd, ["ls-tree", "-r", "HEAD"], signal);
  if (/^160000 /m.test(entries)) throw new Error("unsupported_submodules");
  const gitDir = (await gitCacheCommand(cwd, ["rev-parse", "--absolute-git-dir"], signal)).trim();
  const common = (await gitCacheCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim();
  for (const root of new Set([gitDir, common])) {
    for (const name of ["shallow", "shallow.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer", "info/sparse-checkout", "objects/info/alternates", "refs/replace", "refs/stash", "modules", "lfs"]) {
      if (await fs.lstat(path.join(root, name)).then(() => true, (e: NodeJS.ErrnoException) => { if(e.code === "ENOENT") return false; throw e; })) throw new Error("unsupported_local_git_state");
    }
  }
  const original = await gitCacheCommand(cwd, ["rev-parse", "--verify", "ORIG_HEAD"], signal).catch(() => null);
  if (original) await gitCacheCommand(cwd, ["merge-base", "--is-ancestor", original.trim(), "HEAD"], signal)
    .catch(() => { throw new Error("unique_original_head"); });
  if (gitDir !== common) {
    const allowed = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "index", "commondir", "gitdir", "logs", "refs", "COMMIT_EDITMSG", "index.lock", "HEAD.lock"]);
    if ((await fs.readdir(gitDir)).some(name => !allowed.has(name))) throw new Error("unknown_worktree_git_files");
    await assertReproducibleFetchHead(cwd, gitDir, signal, options.verifyFetchedCommit);
    async function assertEmptyRefs(root: string): Promise<void> {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) throw new Error("unique_worktree_refs");
        await assertEmptyRefs(path.join(root, entry.name));
      }
    }
    await assertEmptyRefs(path.join(gitDir, "refs"));
    const message = await fs.readFile(path.join(gitDir, "COMMIT_EDITMSG"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (message !== null && message.trim() !== (await gitCacheCommand(cwd, ["log", "-1", "--format=%B"], signal)).trim()) throw new Error("uncommitted_git_message");
    const logs = await fs.readdir(path.join(gitDir, "logs")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    if (logs.some(name => name !== "HEAD")) throw new Error("unknown_worktree_git_logs");
  }
  // Packed stashes/replacement refs are just as important as loose refs.
  if ((await gitCacheCommand(cwd, ["for-each-ref", "--format=%(refname)", "refs/stash", "refs/replace"], signal)).trim()) throw new Error("unique_git_refs");
  // Rewrites can leave commits reachable only from this worktree's reflog.
  for (const commit of new Set((await gitCacheCommand(cwd, ["reflog", "show", "--format=%H", "HEAD"], signal)).split("\n").filter(Boolean))) {
    await gitCacheCommand(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"], signal).catch(() => { throw new Error("unique_reflog_commits"); });
  }
  return regenerable;
}

export async function inspectGitCacheRecipe(workspace: Workspace, resolveGitAuth: GitRemoteAuthProvider, signal?: AbortSignal,
  options: { proveManagedCheckout?: ManagedCheckoutProver } = {}): Promise<GitCacheRestoration> {
  if (workspace.mode !== "isolated_workspace" || workspace.strategyType !== "git_worktree"
    || !isRuntimeOwnedGitBranch(workspace.metadata) || !workspace.sourceIssueId || !workspace.repoUrl
    || !workspace.cwd || !workspace.branchName || (workspace.providerRef && workspace.providerRef !== workspace.cwd)) throw new Error("unproven_workspace_ownership");
  let source = await verifiedRecordedIsolatedRemoteSource(workspace);
  if (!source) {
    const common = (await gitCacheCommand(workspace.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim();
    for (const candidate of managedSourcePaths(workspace)) {
      if (await fs.realpath(path.join(candidate, ".git")).catch(() => null) === common) {
        source = await verifiedGitCacheSource(workspace, candidate); break;
      }
    }
  }
  if (!source) throw new Error("unproven_source_ownership");
  const stat = await fs.lstat(workspace.cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(workspace.cwd) !== path.join(await fs.realpath(path.dirname(workspace.cwd)), path.basename(workspace.cwd))) throw new Error("unsafe_worktree_path");
  if (!(await fs.lstat(path.join(workspace.cwd, ".git"))).isFile()) throw new Error("not_linked_worktree");
  if ((await gitCacheCommand(workspace.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim() !== path.join(await fs.realpath(source), ".git")) throw new Error("source_identity_changed");
  if ((await gitCacheCommand(workspace.cwd, ["symbolic-ref", "--short", "HEAD"], signal)).trim() !== workspace.branchName) throw new Error("branch_identity_changed");
  await assertReproducibleGitFiles(workspace.cwd, signal, { ...options, preserveSettings: true,
    verifyFetchedCommit: (commit, verificationSignal) => verifyRemoteGitCommit(workspace.repoUrl!, commit, resolveGitAuth, verificationSignal) });
  const commit = (await gitCacheCommand(workspace.cwd, ["rev-parse", "HEAD"], signal)).trim();
  await verifyRemoteGitCommit(workspace.repoUrl, commit, resolveGitAuth, signal);
  return { schema: "paperclip.git-cache-restoration.v1", companyId: workspace.companyId, workspaceId: workspace.id,
    sourceIssueId: workspace.sourceIssueId, repoUrl: workspace.repoUrl, commit, branchName: workspace.branchName,
    sourceKind: recordedIsolatedRemoteSource(workspace) ? "isolated_remote" : "managed_project", projectId: workspace.projectId,
    sourcePath: source, worktreePath: workspace.cwd, gitBranchOwnershipVersion: 1, verifiedAt: new Date().toISOString() };
}

export function readGitCacheExpiration(workspace: Workspace): GitCacheExpiration | null {
  const state = workspace.metadata?.gitCacheExpiration as GitCacheExpiration | undefined;
  if (!state) return null;
  const recipe = readGitCacheRestoration(workspace);
  if (!recipe || state.schema !== "paperclip.git-cache-expiration.v1" || !Number.isSafeInteger(state.generation)
    || state.generation !== workspace.metadata?.lifecycleGeneration
    || (state.lockToken !== undefined && !/^[a-f0-9]{64}$/.test(state.lockToken))
    || state.worktreeTrash !== path.join(path.dirname(recipe.worktreePath), `.expired-git-worktree-${workspace.id}-${state.generation}`)
    || path.dirname(state.worktreeAdmin) !== path.join(recipe.sourcePath, ".git", "worktrees")
    || (state.baseTrash !== null && state.baseTrash !== path.join(path.dirname(recipe.sourcePath), `.expired-git-base-${workspace.id}-${state.generation}`))) {
    throw new GitCacheRestorationFailure();
  }
  return state;
}

export function gitCacheExpirationLockLocations(workspace: Workspace): GitExpirationLockLocation[] {
  const state = readGitCacheExpiration(workspace);
  const recipe = readGitCacheRestoration(workspace);
  if (!state || !recipe || !state.lockToken || state.completed) return [];
  const branchPath = (branch: string) => {
    if (!branch || branch.split("/").some(part => !part || part === "." || part === "..") || branch.includes("\\")) throw new GitCacheRestorationFailure();
    return `refs/heads/${branch}.lock`;
  };
  const locations: GitExpirationLockLocation[] = [
    ...["index.lock", "HEAD.lock"].map(name => ({ root: recipe.sourcePath,
      relativePath: path.relative(recipe.sourcePath, path.join(state.worktreeAdmin, name)), checkout: null })),
    { root: recipe.sourcePath, relativePath: path.join(".git", branchPath(recipe.branchName)), checkout: null },
  ];
  for (const checkout of recipe.contents?.checkouts ?? []) {
    for (const name of ["index.lock", "HEAD.lock", ...(checkout.branchName ? [branchPath(checkout.branchName)] : [])]) {
      locations.push({ root: recipe.worktreePath, relativePath: path.join(PROJECT_REPOSITORIES_DIR, checkout.name, ".git", name), checkout: checkout.name });
    }
  }
  return locations;
}

export async function recoverGitCacheExpirationLocks(workspace: Workspace) {
  const state = readGitCacheExpiration(workspace);
  if (!state?.lockToken || state.completed || !["archived", "cleanup_failed"].includes(workspace.status ?? "")) return;
  const recipe = readGitCacheRestoration(workspace)!;
  if (await fs.lstat(recipe.sourcePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) await verifiedGitCacheSource(workspace, recipe.sourcePath);
  await recoverGitExpirationLocks(gitCacheExpirationLockLocations(workspace), state.lockToken);
}

// Both restart recovery and reopening finish only recorded, uniquely named trash.
// No directory scan or age heuristic can authorize deleting an arbitrary path.
export async function finishGitCacheTrash(workspace: Workspace) {
  const state = readGitCacheExpiration(workspace);
  if (!state) return;
  const recipe = readGitCacheRestoration(workspace)!;
  const exists = (target: string) => fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false; throw error;
  });
  for (const target of [state.worktreeTrash, state.baseTrash]) {
    if (!target || !await exists(target)) continue;
    const entry = await fs.lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || await fs.realpath(target) !== path.join(await fs.realpath(path.dirname(target)), path.basename(target))) throw new GitCacheRestorationFailure();
    await fs.rm(target, { recursive: true, force: true });
  }
  if (!await exists(recipe.worktreePath) && await exists(state.worktreeAdmin)) {
    await verifiedGitCacheSource(workspace, recipe.sourcePath);
    const entry = await fs.lstat(state.worktreeAdmin);
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || await fs.realpath(state.worktreeAdmin) !== path.join(await fs.realpath(recipe.sourcePath), ".git", "worktrees", path.basename(state.worktreeAdmin))) {
      throw new GitCacheRestorationFailure();
    }
    const pointer = (await fs.readFile(path.join(state.worktreeAdmin, "gitdir"), "utf8")).trim();
    const expected = path.join(await fs.realpath(path.dirname(recipe.worktreePath)), path.basename(recipe.worktreePath), ".git");
    if (pointer !== expected) throw new GitCacheRestorationFailure();
    await fs.rm(state.worktreeAdmin, { recursive: true, force: true });
  }
}

/** Called only after authorization and while holding the source/lifecycle fences. */
export async function restoreGitCacheBase(workspace: Workspace, recipe: GitCacheRestoration, resolveGitAuth: GitRemoteAuthProvider) {
  if (readGitCacheRestoration(workspace)?.commit !== recipe.commit) throw new GitCacheRestorationFailure();
  try {
    await finishGitCacheTrash(workspace);
    const present = await fs.lstat(recipe.sourcePath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!present && recipe.sourceKind === "managed_project") {
      const root = resolvePaperclipInstanceRoot();
      let parent = await fs.realpath(root);
      for (const segment of path.relative(root, path.dirname(recipe.sourcePath)).split(path.sep)) {
        parent = path.join(parent, segment);
        await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        const entry = await fs.lstat(parent);
        if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(parent) !== parent) throw new GitCacheRestorationFailure();
      }
    }
    const cwd = present ? await verifiedGitCacheSource(workspace, recipe.sourcePath)
      : recipe.sourceKind === "isolated_remote"
        ? await materializeIsolatedRemoteWorkspaceSource({ companyId: recipe.companyId, issueId: recipe.sourceIssueId,
          repoUrl: recipe.repoUrl, resolveGitAuth })
        : (await materializeManagedProjectWorkspace(recipe.sourcePath, { repoUrl: recipe.repoUrl, resolveGitAuth })).cwd;
    await verifiedGitCacheSource(workspace, recipe.sourcePath);
    if (!cwd) throw new GitCacheRestorationFailure();
    await ensureSavedGitCommit(cwd, recipe.repoUrl, recipe.commit, resolveGitAuth);
    return cwd;
  } catch { throw new GitCacheRestorationFailure(); }
}

export async function ensureSavedGitCommit(cwd: string, repoUrl: string, commit: string, resolveGitAuth: (url: string) => Promise<{ configArgs: string[]; env: Record<string, string> } | null>) {
  if (!shaPattern.test(commit)) throw new GitCacheRestorationFailure();
  if (await gitCacheCommand(cwd, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false)) return;
  try {
    const auth = await resolveGitAuth(repoUrl);
    await execFile("git", [...auth?.configArgs ?? [], "-C", cwd, "fetch", "--no-tags", "--no-recurse-submodules", "--", repoUrl, commit], {
      timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, ...auth?.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if ((await gitCacheCommand(cwd, ["rev-parse", `${commit}^{commit}`])).trim() !== commit) throw new GitCacheRestorationFailure();
  } catch { throw new GitCacheRestorationFailure(); }
}

/** Runtime callers must bind the recipe to the selected workspace and base. */
export function savedGitWorkspaceRestoration(input: { metadata?: Record<string, unknown> | null; companyId: string;
  workspaceId?: string | null; cwd: string; baseCwd: string; repoUrl: string | null; branchName: string | null }) {
  const raw = input.metadata?.[GIT_CACHE_RESTORATION_KEY];
  if (raw === undefined) return null;
  const value = raw as GitCacheRestoration | null;
  if (!value || value.schema !== "paperclip.git-cache-restoration.v1" || !shaPattern.test(value.commit)
    || value.companyId !== input.companyId || value.workspaceId !== input.workspaceId
    || value.worktreePath !== input.cwd || value.sourcePath !== input.baseCwd
    || value.repoUrl !== input.repoUrl || value.branchName !== input.branchName
    || !isRuntimeOwnedGitBranch(input.metadata)
    || (value.restoredAt !== undefined && !Number.isFinite(Date.parse(value.restoredAt)))
    || (value.contentsRestoredAt != null && !Number.isFinite(Date.parse(value.contentsRestoredAt)))) throw new GitCacheRestorationFailure();
  validateGitWorkspaceContents(value.contents);
  return { commit: value.commit, restored: value.restoredAt !== undefined, contents: value.contents,
    contentsRestored: value.contentsRestoredAt === undefined ? value.restoredAt !== undefined : value.contentsRestoredAt !== null };
}
