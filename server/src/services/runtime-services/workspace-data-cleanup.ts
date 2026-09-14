import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { executionWorkspaces } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { readWorktreeInstancePointer } from "../workspace-instance-cleanup.js";

const exec = promisify(execFile);
const absolutePath = z.string().refine(path.isAbsolute, "Expected an absolute workspace path");
const fileIdentityPart = z.string().regex(/^\d+$/);
const directorySchema = z.object({ path: absolutePath, dev: fileIdentityPart, ino: fileIdentityPart }).strict();
export const taskWorkspaceDataTargetSchema = z.object({
  version: z.literal(1), companyId: z.string().guid(), workspaceId: z.string().guid(),
  providerType: z.enum(["git_worktree", "local_fs"]), originalPath: absolutePath,
  root: directorySchema, parent: directorySchema, protectedRoots: z.array(absolutePath).min(1),
  git: z.object({ common: directorySchema, admin: directorySchema, head: z.string(), branch: z.string().nullable() }).strict().nullable(),
}).strict().refine((target) => (target.providerType === "git_worktree") === (target.git !== null), "Git workspace cleanup requires its ownership record");
export type TaskWorkspaceDataTarget = z.infer<typeof taskWorkspaceDataTargetSchema>;
type Directory = z.infer<typeof directorySchema>;
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "mode" | "providerType" | "cwd" | "providerRef" | "branchName" | "metadata">;

async function statDirectory(value: string): Promise<Directory | null> {
  const stat = await fs.lstat(value, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict("The task workspace directory changed identity");
  return { path: value, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function sameDirectory(current: Directory | null, expected: Directory) {
  return current?.dev === expected.dev && current?.ino === expected.ino;
}
function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function git(cwd: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
async function gitIdentity(root: string) {
  const marker = await fs.lstat(path.join(root, ".git"));
  if (!marker.isFile() || marker.isSymbolicLink()) throw conflict("The workspace is not a linked Git worktree");
  const commonPath = await fs.realpath(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const adminPath = await fs.realpath(await git(root, ["rev-parse", "--absolute-git-dir"]));
  if (commonPath === adminPath || !contains(path.join(commonPath, "worktrees"), adminPath)) throw conflict("The workspace does not have a linked-worktree ownership record");
  const common = await statDirectory(commonPath), admin = await statDirectory(adminPath);
  if (!common || !admin) throw conflict("The workspace Git ownership record is unavailable");
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error) => {
    if (error.code === 1) return null;
    throw error;
  });
  return { common, admin, head, branch };
}
async function assertNoManagedInstance(root: string) {
  if (await readWorktreeInstancePointer(root)) throw conflict("This task workspace contains a managed instance; its instance cleanup must be included before deleting workspace data");
}

/** Capture from an authorized database row, never caller-supplied paths. The
 * enclosing durable job must review consumers and hold workspace admission and
 * lifecycle locks before invoking removal. This primitive alone grants nothing. */
export async function captureTaskWorkspaceDataTarget(workspace: Workspace, protectedProjectRoots: string[]): Promise<TaskWorkspaceDataTarget> {
  if (workspace.mode !== "isolated_workspace" || !["git_worktree", "local_fs"].includes(workspace.providerType)) throw conflict("Only an isolated task workspace can be removed by this cleanup");
  if (workspace.providerType === "local_fs" && workspace.metadata?.createdByRuntime !== true) throw conflict("This local directory was not created by the workspace runtime");
  if (workspace.metadata?.worktreeInstanceRoot) throw conflict("The task workspace's managed instance cleanup must be reviewed before deleting workspace data");
  const originalPath = workspace.providerRef ?? workspace.cwd;
  if (!originalPath || !path.isAbsolute(originalPath) || (!protectedProjectRoots.length && workspace.providerType !== "git_worktree")) throw conflict("The task workspace ownership path is unavailable");
  const original = await fs.lstat(originalPath);
  if (!original.isDirectory() || original.isSymbolicLink()) throw conflict("The task workspace must be an owned directory, not a symbolic link");
  const rootPath = await fs.realpath(originalPath);
  const identity = workspace.providerType === "git_worktree" ? await gitIdentity(rootPath) : null;
  const protectedRoots = [...new Set([...await Promise.all(protectedProjectRoots.map((value) => fs.realpath(value))), ...(identity ? [identity.common.path] : [])])];
  if (path.dirname(rootPath) === rootPath || protectedRoots.some((value) => contains(rootPath, value))) throw conflict("Deleting this task workspace would remove project workspace infrastructure");
  const root = await statDirectory(rootPath), parent = await statDirectory(path.dirname(rootPath));
  if (!root || !parent) throw conflict("The task workspace is unavailable");
  await assertNoManagedInstance(rootPath);
  if (identity && workspace.branchName !== identity.branch) throw conflict("The task workspace branch no longer matches its ownership record");
  const gitMarker = !identity ? await fs.lstat(path.join(rootPath, ".git")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  if (gitMarker && !gitMarker.isDirectory()) throw conflict("A linked Git worktree must use the Git workspace cleanup contract");
  return taskWorkspaceDataTargetSchema.parse({ version: 1, companyId: workspace.companyId, workspaceId: workspace.id, providerType: workspace.providerType,
    originalPath, root, parent, protectedRoots, git: identity });
}

function quarantinePath(target: TaskWorkspaceDataTarget, deletionId: string) {
  return path.join(target.parent.path, ".paperclip-service-deletions", deletionId, target.workspaceId);
}

async function ensureQuarantineParent(target: TaskWorkspaceDataTarget, parent: string) {
  for (const directory of [path.join(target.parent.path, ".paperclip-service-deletions"), parent]) {
    let current = await statDirectory(directory);
    if (!current) {
      await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      current = await statDirectory(directory);
    }
    if (!current || await fs.realpath(directory) !== directory) throw conflict("The task deletion directory changed identity");
  }
}

/** Re-entrant after a crash at rename, Git repair, or removal. Source and branch
 * history outside this workspace are retained. New/replaced directories are never
 * removed using the captured directory's authorization. */
export async function removeTaskWorkspaceData(input: {
  companyId: string; workspaceId: string; deletionId: string; target: TaskWorkspaceDataTarget;
  assertAuthorized: () => Promise<void>;
}) {
  const target = taskWorkspaceDataTargetSchema.parse(input.target);
  z.string().guid().parse(input.deletionId);
  if (target.companyId !== input.companyId || target.workspaceId !== input.workspaceId) throw conflict("Task workspace deletion identity does not match");
  if (!path.isAbsolute(target.root.path) || path.dirname(target.root.path) !== target.parent.path || target.protectedRoots.some((value) => contains(target.root.path, value))) throw conflict("Task workspace deletion path is invalid");
  await input.assertAuthorized();
  if (await fs.realpath(target.parent.path) !== target.parent.path || !sameDirectory(await statDirectory(target.parent.path), target.parent)) throw conflict("The task workspace parent directory changed identity");
  const current = await statDirectory(target.originalPath);
  const canonical = await statDirectory(target.root.path);
  if (canonical && (!current || !sameDirectory(canonical, target.root))) throw conflict("The task workspace ownership path changed after review");
  if (current && (await fs.realpath(target.originalPath) !== target.root.path || !sameDirectory(current, target.root))) throw conflict("The task workspace was replaced after deletion was requested");
  const quarantine = quarantinePath(target, input.deletionId);
  const parent = path.dirname(quarantine);
  await ensureQuarantineParent(target, parent);
  const moved = await statDirectory(quarantine);
  if (moved && !sameDirectory(moved, target.root)) throw conflict("The quarantined task workspace does not match its deletion receipt");
  if (current && moved) throw conflict("The task workspace was recreated during deletion");
  const removeMissingGitRecord = async () => {
    if (!target.git) return;
    await input.assertAuthorized();
    if (await fs.realpath(target.git.common.path) !== target.git.common.path || !sameDirectory(await statDirectory(target.git.common.path), target.git.common)) throw conflict("The task workspace Git repository changed identity");
    const admin = await statDirectory(target.git.admin.path);
    if (!admin) return;
    if (await fs.realpath(admin.path) !== admin.path || !sameDirectory(admin, target.git.admin)) throw conflict("The task workspace Git ownership record was replaced");
    const registered = (await fs.readFile(path.join(admin.path, "gitdir"), "utf8")).trim();
    if (![path.join(target.root.path, ".git"), path.join(target.originalPath, ".git"), path.join(quarantine, ".git")].includes(registered)) throw conflict("The task workspace Git record now belongs to another directory");
    const head = await git(target.git.common.path, ["--git-dir", admin.path, "rev-parse", "--verify", "HEAD"]);
    const branch = await git(target.git.common.path, ["--git-dir", admin.path, "symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error) => { if (error.code === 1) return null; throw error; });
    if (head !== target.git.head || branch !== target.git.branch) throw conflict("The task workspace Git history changed after review");
    // A process can die after removing files but before Git removes its exact
    // administrative record. Never use repository-wide worktree prune here.
    await git(target.git.common.path, ["--git-dir", target.git.common.path, "worktree", "remove", "--force", path.dirname(registered)]);
    if (await statDirectory(admin.path)) throw conflict("The task workspace Git cleanup could not be confirmed");
  };
  const assertCaptured = async (root: string) => {
    await input.assertAuthorized();
    if (await fs.realpath(parent) !== parent || !sameDirectory(await statDirectory(root), target.root)) throw conflict("The captured task workspace changed during deletion");
    await assertNoManagedInstance(root);
    if (!target.git) {
      const marker = await fs.lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (marker && !marker.isDirectory()) throw conflict("The task workspace acquired a linked Git ownership record after review");
    }
    if (target.git) {
      const actual = await gitIdentity(root);
      if (JSON.stringify(actual) !== JSON.stringify(target.git)) throw conflict("The task workspace Git identity changed after review");
      const registered = (await fs.readFile(path.join(actual.admin.path, "gitdir"), "utf8")).trim();
      if (![path.join(target.root.path, ".git"), path.join(target.originalPath, ".git"), path.join(quarantine, ".git")].includes(registered)) throw conflict("The task workspace Git record now belongs to another directory");
    }
  };
  if (current) {
    await assertCaptured(target.root.path);
    await fs.rename(target.root.path, quarantine);
  }
  if (!await statDirectory(quarantine)) {
    await removeMissingGitRecord();
    return { state: "deleted" as const, workspaceId: target.workspaceId };
  }
  await assertCaptured(quarantine);
  if (target.git) {
    // Rename is filesystem-atomic. Repair only the captured linked-worktree
    // record before using the established worktree removal implementation.
    await git(quarantine, ["worktree", "repair", quarantine]);
    await assertCaptured(quarantine);
  }
  const { cleanupExecutionWorkspaceArtifacts } = await import("../workspace-runtime.js");
  const result = await cleanupExecutionWorkspaceArtifacts({
    workspace: { id: target.workspaceId, cwd: quarantine, providerRef: quarantine, providerType: target.providerType,
      branchName: null, repoUrl: null, baseRef: null, projectId: null, projectWorkspaceId: null, sourceIssueId: null, metadata: { createdByRuntime: target.providerType === "local_fs" } },
    projectWorkspace: { cwd: target.git ? path.dirname(target.git.common.path) : target.protectedRoots[0]!, cleanupCommand: null },
    runCleanupCommands: false, forceWorktreeRemoval: true, assertSafeToCleanup: () => assertCaptured(quarantine),
  });
  if (!result.cleaned || result.warnings.length || await statDirectory(quarantine)) throw conflict("Task workspace data deletion could not be confirmed");
  await removeMissingGitRecord();
  return { state: "deleted" as const, workspaceId: target.workspaceId };
}
