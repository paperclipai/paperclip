import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { projectWorkspaces, executionWorkspaceRepositoryAccess, executionWorkspaces, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { localRepositoryPath } from "./local-repository-path.js";

const execFile = promisify(execFileCallback);
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function canonicalRepositoryRoot(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalRepositoryRoot(parent), path.basename(absolute));
  }
}

export function repositoryRootsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

export async function legacyRepositoryRootMayMatch(cwd: string, candidate: string): Promise<boolean> {
  const absolute = path.resolve(cwd);
  let probe = absolute;
  let suffix = "";
  let inaccessiblePrefix: string | null = null;
  for (;;) {
    try {
      const canonical = await fs.realpath(probe);
      if (repositoryRootsOverlap(path.join(canonical, suffix), candidate)) return true;
      if (!inaccessiblePrefix) return false;
      const unresolved = path.join(canonical, path.relative(probe, inaccessiblePrefix));
      return repositoryRootsOverlap(candidate, unresolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(code ?? "")) throw error;
      if (code === "EACCES" || code === "EPERM") inaccessiblePrefix = probe;
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      suffix = path.join(path.basename(probe), suffix);
      probe = parent;
    }
  }
}

export async function configuredWorkspaceRoot(input: { cwd: string | null; repoUrl?: string | null }, scan: boolean): Promise<string | null> {
  const resolveDirectory = async (cwd: string): Promise<string | null> => {
    try {
      const entry = await fs.stat(cwd);
      if (!entry.isDirectory()) {
        if (scan) return null;
        throw forbidden("Workspace files cannot be detached from unverifiable provenance");
      }
      return await fs.realpath(cwd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || (scan && ["ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(code ?? ""))) return null;
      throw error;
    }
  };
  if (input.cwd) {
    const cwd = await resolveDirectory(input.cwd);
    if (cwd) return cwd;
  }
  let repositoryPath: string | null;
  try { repositoryPath = input.repoUrl ? localRepositoryPath(input.repoUrl) : null; }
  catch (error) { if (scan) return null; throw error; }
  return repositoryPath ? resolveDirectory(repositoryPath) : null;
}

export async function verifiedIsolatedWorktree(cwd: string, allowedOwnerRoots?: Set<string>): Promise<boolean> {
  try {
    const directory = await fs.lstat(cwd), marker = await fs.lstat(path.join(cwd, ".git"));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) return false;
    const git = async (args: string[]) => (await execFile("git", ["-C", cwd, ...args], {
      timeout: 30_000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    })).stdout.trim();
    const checkoutRoot = await fs.realpath(await git(["rev-parse", "--show-toplevel"]));
    if (checkoutRoot !== cwd) return false;
    const commonRoot = await fs.realpath(path.resolve(checkoutRoot, await git(["rev-parse", "--git-common-dir"])));
    const gitRoot = await fs.realpath(await git(["rev-parse", "--absolute-git-dir"]));
    if (gitRoot === commonRoot || (allowedOwnerRoots && !allowedOwnerRoots.has(commonRoot))) return false;
    const registrations = (await git(["worktree", "list", "--porcelain", "-z"])).split("\0");
    return registrations.includes(`worktree ${checkoutRoot}`);
  } catch { return false; }
}

export async function unusedIsolatedCopyTarget(cwd: string): Promise<boolean> {
  const entry = await fs.lstat(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return true;
  return entry.isDirectory() && !entry.isSymbolicLink() && (await fs.readdir(cwd)).length === 0;
}

export type WorkspaceSourceCopyKind = "linked_worktree" | "repository";

export async function isolatedWorkspaceSourceRoots(db: Db | DbTransaction, companyId: string, sourceCwd: string, copyKind: WorkspaceSourceCopyKind = "linked_worktree"): Promise<{ roots: string[]; commonRoot: string }> {
  const git = async (cwd: string, ...args: string[]) => (await execFile("git", ["-C", cwd, ...args], {
    timeout: 30_000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  })).stdout.trim();
  const localRoot = await fs.realpath(sourceCwd);
  if (copyKind === "repository" && await git(sourceCwd, "rev-parse", "--is-bare-repository") === "true") {
    const gitRoot = await fs.realpath(path.resolve(sourceCwd, await git(sourceCwd, "rev-parse", "--absolute-git-dir")));
    return { roots: [...new Set([localRoot, gitRoot])], commonRoot: gitRoot };
  }
  const checkoutRoot = await fs.realpath(path.resolve(await git(sourceCwd, "rev-parse", "--show-toplevel")));
  const commonRoot = await fs.realpath(path.resolve(checkoutRoot, await git(checkoutRoot, "rev-parse", "--git-common-dir")));
  const roots = new Set(copyKind === "repository" ? [localRoot, checkoutRoot, commonRoot] : [checkoutRoot, commonRoot]);
  let primaryIdentified = await fs.realpath(await git(checkoutRoot, "rev-parse", "--absolute-git-dir")) === commonRoot;
  const considerPrimary = async (candidatePath: string): Promise<boolean> => {
    const candidate = await fs.realpath(candidatePath).catch(() => null);
    if (!candidate || candidate === checkoutRoot || candidate === commonRoot) return false;
    try {
      const candidateGitRoot = await fs.realpath(await git(candidate, "rev-parse", "--absolute-git-dir"));
      if (candidateGitRoot !== commonRoot) return false;
      const candidateCheckout = await fs.realpath(await git(candidate, "rev-parse", "--show-toplevel"));
      const candidateCommon = await fs.realpath(path.resolve(candidate, await git(candidate, "rev-parse", "--git-common-dir")));
      const relative = path.relative(candidateCheckout, candidate);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && candidateCommon === commonRoot) {
        roots.add(candidateCheckout);
        return true;
      }
    } catch {   }
    return false;
  };
  if (!primaryIdentified) {
    const registrations = (await git(checkoutRoot, "worktree", "list", "--porcelain", "-z")).split("\0");
    for (const registration of registrations) {
      if (registration.startsWith("worktree ") && await considerPrimary(registration.slice("worktree ".length))) {
        primaryIdentified = true;
        break;
      }
    }
  }
  if (!primaryIdentified) {
    const candidates = new Set<string>();
    const configured = await db.select({ cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId));
    for (const workspace of configured) {
      const cwd = await configuredWorkspaceRoot(workspace, true);
      if (cwd) candidates.add(cwd);
    }
    const workspaces = await db.select({ cwd: executionWorkspaces.cwd }).from(executionWorkspaces).where(eq(executionWorkspaces.companyId, companyId));
    for (const workspace of workspaces) if (workspace.cwd) candidates.add(workspace.cwd);
    const retained = await db.select({ cwd: executionWorkspaceRepositoryAccess.canonicalCwd }).from(executionWorkspaceRepositoryAccess)
      .where(eq(executionWorkspaceRepositoryAccess.companyId, companyId));
    for (const entry of retained) candidates.add(entry.cwd);
    for (const candidate of candidates) await considerPrimary(candidate);
  }
  return { roots: [...roots], commonRoot };
}
