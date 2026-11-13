import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { deriveRepoNameFromRepoUrl } from "./managed-project-checkout-name.js";
import { scrubGitCredentialText, type GitRemoteAuthProvider } from "./git-credentials.js";
import { sanitizeRuntimeServiceBaseEnv } from "./runtime-service-env.js";

const execFile = promisify(execFileCallback);
const NESTED_WORKTREE_GIT_TIMEOUT_MS = 10 * 60 * 1000;
const NESTED_WORKTREE_BRANCH = /^paperclip\/[a-f0-9]{12}\/./;
export const OWNED_NESTED_REF_LIMIT = 64;
export const DETACHED_REPOSITORIES_DIR = path.join(".paperclip-runtime", "detached-repositories");

export type LinkedNestedCheckout = { checkout: string; base: string; gitDir: string; admin: string; branchPrefix: string };
type GitInvocation = { configArgs?: string[]; env?: Record<string, string>; timeout?: number };

async function git(cwd: string, args: string[], options: GitInvocation = {}) {
  const result = await execFile("git", [...options.configArgs ?? [], "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...sanitizeRuntimeServiceBaseEnv(process.env), GIT_TERMINAL_PROMPT: "0", ...options.env },
  });
  return result.stdout;
}

async function missing(target: string) {
  return fs.lstat(target).then(() => false, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return true;
    throw error;
  });
}

async function canonicalPath(target: string) {
  return path.join(await fs.realpath(path.dirname(target)), path.basename(target));
}

const WORKTREE_POINTER_LIMIT = 4096;

export async function readWorktreePointer(admin: string) {
  const target = path.join(admin, "gitdir");
  const entry = await fs.lstat(target);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > WORKTREE_POINTER_LIMIT) throw new Error("unproven_managed_checkout");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > WORKTREE_POINTER_LIMIT) throw new Error("unproven_managed_checkout");
    const buffer = Buffer.alloc(WORKTREE_POINTER_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > WORKTREE_POINTER_LIMIT) throw new Error("unproven_managed_checkout");
    return buffer.subarray(0, length).toString("utf8").trim();
  } finally { await handle.close(); }
}

export function nestedRepositoryBaseCandidates(input: { companyId: string; projectId: string; repoUrl: string }) {
  const root = resolveManagedProjectWorkspaceDir({ companyId: input.companyId, projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl) });
  return [root, `${root}-${createHash("sha256").update(input.repoUrl).digest("hex").slice(0, 12)}`];
}

async function looseCanonicalPath(target: string): Promise<string> {
  const real = await fs.realpath(target).catch(() => null);
  if (real) return real;
  const parent = path.dirname(target);
  return parent === target ? target : path.join(await looseCanonicalPath(parent), path.basename(target));
}

export async function recordedNestedRepositoryBase(recorded: string, candidates: string[]) {
  for (const candidate of candidates) if (await looseCanonicalPath(candidate) === recorded) return candidate;
  return null;
}

export async function nestedWorktreeBranchPrefix(checkout: string) {
  const id = createHash("sha256").update(await canonicalPath(checkout)).digest("hex").slice(0, 12);
  return `paperclip/${id}/`;
}

export function isNestedWorktreeBranchName(name: string) {
  return NESTED_WORKTREE_BRANCH.test(name);
}

export async function isVerifiedNestedRepositoryBase(base: string, candidates: string[], repoUrl: string) {
  const real = await fs.realpath(base).catch(() => null);
  if (!real) return false;
  const allowed = await Promise.all(candidates.map(candidate => fs.realpath(candidate).catch(() => null)));
  if (!allowed.includes(real)) return false;
  const storage = await fs.lstat(path.join(real, ".git")).catch(() => null);
  if (!storage?.isDirectory() || storage.isSymbolicLink()) return false;
  const common = (await git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
  if (common !== path.join(real, ".git")) return false;
  return (await git(real, ["config", "--local", "--null", "--get-all", "remote.origin.url"]).catch(() => "")) === `${repoUrl}\0`;
}

export async function readLinkedNestedCheckout(checkout: string, baseCandidates?: string[]): Promise<LinkedNestedCheckout | null> {
  const marker = await fs.lstat(path.join(checkout, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker || marker.isDirectory()) return null;
  if (!marker.isFile()) throw new Error("unproven_managed_checkout");
  const real = await canonicalPath(checkout);
  if (await fs.realpath(checkout) !== real) throw new Error("unproven_managed_checkout");
  const gitDir = await fs.realpath((await git(real, ["rev-parse", "--absolute-git-dir"])).trim());
  const common = await fs.realpath((await git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  if (path.basename(common) !== ".git" || path.dirname(gitDir) !== path.join(common, "worktrees")) throw new Error("unproven_managed_checkout");
  const pointer = await readWorktreePointer(gitDir);
  if (path.basename(pointer) !== ".git" || path.join(await fs.realpath(path.dirname(pointer)).catch(() => ""), ".git") !== path.join(real, ".git")) {
    throw new Error("unproven_managed_checkout");
  }
  if ((await git(real, ["rev-parse", "--show-toplevel"])).trim() !== real) throw new Error("unproven_managed_checkout");
  const base = path.dirname(common);
  const storage = await fs.lstat(common);
  if (!storage.isDirectory() || storage.isSymbolicLink()) throw new Error("unproven_managed_checkout");
  if (baseCandidates) {
    const allowed = await Promise.all(baseCandidates.map(candidate => fs.realpath(candidate).catch(() => null)));
    if (!allowed.includes(base)) throw new Error("unproven_managed_checkout");
  }
  return { checkout: real, base, gitDir, admin: path.basename(gitDir), branchPrefix: await nestedWorktreeBranchPrefix(real) };
}

const heldBaseLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const baseLocks = new Map<string, Promise<void>>();

export async function withNestedRepositoryBaseLock<T>(base: string, action: () => Promise<T>): Promise<T> {
  const key = await looseCanonicalPath(path.resolve(base));
  const held = heldBaseLocks.getStore() ?? new Set<string>();
  if (held.has(key)) return action();
  const previous = baseLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
  baseLocks.set(key, current);
  await previous;
  try {
    return await heldBaseLocks.run(new Set([...held, key]), action);
  } finally {
    release();
    if (baseLocks.get(key) === current) baseLocks.delete(key);
  }
}

export async function removeStaleNestedRegistrations(base: string, checkout: string) {
  const expected = path.join(checkout, ".git");
  const root = path.join(base, ".git", "worktrees");
  for (const admin of await fs.readdir(root).catch(() => [] as string[])) {
    const directory = path.join(root, admin);
    const entry = await fs.lstat(directory).catch(() => null);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
    const pointer = await readWorktreePointer(directory).catch(() => "");
    if (pointer !== expected || !await missing(checkout)) continue;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function checkedOutBranches(base: string) {
  return new Set((await git(base, ["worktree", "list", "--porcelain"])).split("\n")
    .filter(line => line.startsWith("branch ")).map(line => line.slice("branch ".length)));
}

async function resolveStartPoint(base: string, repoRef: string | null) {
  const commit = async (ref: string) => (await git(base, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).catch(() => "")).trim();
  const ref = repoRef?.trim().replace(/^refs\/heads\//, "") || null;
  if (ref) {
    if (await commit(`refs/remotes/origin/${ref}`)) return { branch: ref, start: `refs/remotes/origin/${ref}` };
    const detached = await commit(ref);
    if (!detached) throw new Error(`Repository ref "${ref}" was not found`);
    return { branch: null, start: detached };
  }
  const remoteHead = (await git(base, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const fallback = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  const branch = remoteHead.startsWith("refs/remotes/origin/") ? remoteHead.slice("refs/remotes/origin/".length) : fallback;
  if (branch && await commit(`refs/remotes/origin/${branch}`)) return { branch, start: `refs/remotes/origin/${branch}` };
  return { branch: null, start: await commit("HEAD") };
}

class NestedWorktreeAuthorizationFailure extends Error {
  constructor(readonly cause: unknown) { super("nested_worktree_authorization_failed"); }
}

export async function addNestedRepositoryWorktree(input: {
  base: string;
  cwd: string;
  repoUrl: string;
  repoRef: string | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
  beforeAdd?: () => Promise<void>;
}): Promise<{ branchName: string | null }> {
  try {
    return await withNestedRepositoryBaseLock(input.base, async () => {
      const auth = input.resolveGitAuth ? await input.resolveGitAuth(input.repoUrl) : null;
      await git(input.base, ["fetch", "--quiet", "--prune", "--no-write-fetch-head", "origin"], { configArgs: auth?.configArgs,
        env: auth?.env, timeout: NESTED_WORKTREE_GIT_TIMEOUT_MS });
      if (!input.repoRef?.trim()) {
        await git(input.base, ["remote", "set-head", "origin", "--auto"], { configArgs: auth?.configArgs, env: auth?.env }).catch(() => undefined);
      }
      const { branch, start } = await resolveStartPoint(input.base, input.repoRef);
      if (!start) throw new Error("Repository has no commit to check out");
      const cwd = await canonicalPath(input.cwd);
      await removeStaleNestedRegistrations(input.base, cwd);
      await input.beforeAdd?.().catch((error: unknown) => { throw new NestedWorktreeAuthorizationFailure(error); });
      if (!branch) {
        await git(input.base, ["worktree", "add", "--quiet", "--detach", cwd, start], { timeout: NESTED_WORKTREE_GIT_TIMEOUT_MS });
        return { branchName: null };
      }
      const prefix = await nestedWorktreeBranchPrefix(cwd);
      const held = await checkedOutBranches(input.base);
      let owned = `${prefix}${branch}`;
      for (let attempt = 2; held.has(`refs/heads/${owned}`); attempt += 1) owned = `${prefix}r${attempt}/${branch}`;
      await git(input.base, ["check-ref-format", "--branch", owned]);
      const existing = (await git(input.base, ["rev-parse", "--verify", "-q", `refs/heads/${owned}`]).catch(() => "")).trim();
      await git(input.base, existing ? ["worktree", "add", "--quiet", cwd, owned]
        : ["worktree", "add", "--quiet", "--track", "-b", owned, cwd, start],
      { timeout: NESTED_WORKTREE_GIT_TIMEOUT_MS });
      return { branchName: owned };
    });
  } catch (error) {
    if (error instanceof NestedWorktreeAuthorizationFailure) throw error.cause;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(scrubGitCredentialText(`Failed to prepare managed worktree for "${input.repoUrl}" at "${input.cwd}": ${reason}`));
  }
}

export async function restoreNestedRepositoryWorktree(input: {
  base: string;
  cwd: string;
  commit: string;
  branchName: string | null;
  repoRef: string | null;
  preserved?: readonly string[];
  afterAdd: (cwd: string) => Promise<void>;
}) {
  await withNestedRepositoryBaseLock(input.base, async () => {
    const cwd = await canonicalPath(input.cwd);
    const prefix = await nestedWorktreeBranchPrefix(cwd);
    if (input.branchName && !input.branchName.startsWith(prefix)) throw new Error("unowned_nested_worktree_branch");
    await removeStaleNestedRegistrations(input.base, cwd);
    const existing = input.branchName
      ? (await git(input.base, ["rev-parse", "--verify", "-q", `refs/heads/${input.branchName}`]).catch(() => "")).trim() : "";
    if (existing && existing !== input.commit) throw new Error("nested_worktree_branch_moved");
    await git(input.base, ["worktree", "add", "--quiet", "--detach", cwd, input.commit], { timeout: NESTED_WORKTREE_GIT_TIMEOUT_MS });
    try {
      for (const commit of input.preserved ?? []) {
        await git(cwd, ["update-ref", "--no-deref", "-m", "paperclip: restore preserved history", "HEAD", commit]);
      }
      if (input.preserved?.length) await git(cwd, ["update-ref", "--no-deref", "-m", "paperclip: restore saved commit", "HEAD", input.commit]);
      if (input.branchName) {
        await git(cwd, existing ? ["checkout", "--quiet", input.branchName] : ["checkout", "--quiet", "-b", input.branchName]);
        const rest = input.branchName.slice(prefix.length);
        const { branch: upstream } = await resolveStartPoint(input.base, input.repoRef).catch(() => ({ branch: null }));
        if (upstream && (rest === upstream || rest.replace(/^r\d+\//, "") === upstream)) {
          await git(cwd, ["branch", "--quiet", `--set-upstream-to=origin/${upstream}`, input.branchName]);
        }
      }
      await input.afterAdd(cwd);
    } catch (error) {
      await git(input.base, ["worktree", "remove", "--force", cwd]).catch(() => undefined);
      await removeStaleNestedRegistrations(input.base, cwd).catch(() => undefined);
      if (input.branchName && !existing) {
        await git(input.base, ["update-ref", "-d", `refs/heads/${input.branchName}`, input.commit]).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function forgetExpiredNestedRepositoryWorktree(input: {
  base: string; checkout: string; admin: string; branchName: string | null; commit: string;
}) {
  await withNestedRepositoryBaseLock(input.base, async () => {
    const admin = path.join(input.base, ".git", "worktrees", input.admin);
    const entry = await fs.lstat(admin).catch(() => null);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error("unproven_worktree_admin");
    if (entry && await missing(input.checkout)
      && await readWorktreePointer(admin).catch(() => "") === path.join(input.checkout, ".git")) {
      await fs.rm(admin, { recursive: true, force: true });
    }
    if (input.branchName && await missing(input.checkout)) {
      await git(input.base, ["update-ref", "-d", `refs/heads/${input.branchName}`, input.commit]).catch(() => undefined);
    }
  });
}

export async function collectNestedRepositoryWorktrees(taskCwd: string): Promise<LinkedNestedCheckout[]> {
  const found: LinkedNestedCheckout[] = [];
  for (const parent of [PROJECT_REPOSITORIES_DIR, DETACHED_REPOSITORIES_DIR]) {
    const root = path.join(taskCwd, parent);
    const rootEntry = await fs.lstat(root).catch(() => null);
    if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) continue;
    for (const name of await fs.readdir(root)) {
      const linked = await readLinkedNestedCheckout(path.join(root, name)).catch(() => null);
      if (!linked) continue;
      const head = (await git(linked.checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
      found.push(isNestedWorktreeBranchName(head) ? { ...linked, branchPrefix: head.split("/").slice(0, 2).join("/") + "/" } : linked);
    }
  }
  return found;
}

export async function releaseNestedRepositoryWorktrees(worktrees: LinkedNestedCheckout[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const worktree of worktrees) {
    try {
      await withNestedRepositoryBaseLock(worktree.base, async () => {
        if (!await missing(worktree.checkout)) return;
        await removeStaleNestedRegistrations(worktree.base, worktree.checkout);
        const refs = (await git(worktree.base, ["for-each-ref", "--format=%(objectname) %(refname)", `refs/heads/${worktree.branchPrefix}`]))
          .split("\n").map(line => line.trim().split(" ")).filter(([sha, ref]) => /^[a-f0-9]{40}$/.test(sha ?? "") && ref);
        const held = await checkedOutBranches(worktree.base);
        for (const [sha, ref] of refs) {
          if (held.has(ref!)) continue;
          const unpushed = (await git(worktree.base, ["rev-list", "--max-count=1", sha!, "--not", "--remotes=origin"])).trim();
          if (unpushed) continue;
          await git(worktree.base, ["update-ref", "-d", ref!, sha!]);
        }
      });
    } catch (error) {
      warnings.push(`Could not release nested repository worktree "${worktree.checkout}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}

export async function repairMovedNestedRepositoryWorktree(base: string, moved: string) {
  await withNestedRepositoryBaseLock(base, () => git(base, ["worktree", "repair", moved]));
}

export async function moveNestedRepositoryWorktree(base: string, from: string, to: string) {
  await withNestedRepositoryBaseLock(base, async () => {
    await git(base, ["worktree", "move", from, to], { timeout: NESTED_WORKTREE_GIT_TIMEOUT_MS });
    await git(base, ["worktree", "repair", to]);
  });
}

export async function trackNestedWorktreeUpstream(base: string, branchName: string, upstream: string | null) {
  if (!upstream || !(await git(base, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${upstream}^{commit}`]).catch(() => "")).trim()) return;
  await git(base, ["branch", "--quiet", `--set-upstream-to=origin/${upstream}`, branchName]);
}
