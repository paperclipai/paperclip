import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { readIsolatedTaskPath, resolveIsolatedTaskDirectory } from "./isolated-task-paths.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** A repository-free sandbox task needs isolation, but has no Git base. */
export function shouldUseIsolatedTaskDirectory(input: {
  trustPreset: string;
  environmentDriver: string | null;
  mode: string;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
}): boolean {
  return input.trustPreset === "low_trust_review"
    && input.environmentDriver === "sandbox"
    && input.mode === "isolated_workspace"
    && !input.hasProjectWorkspace
    && !input.projectWorkspaceId
    // Never discard an explicit repository/branch requirement or setup hook.
    && input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0);
}

/** Stable across turns, separate from project roots and shared agent homes. */
export async function materializeIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  attemptId?: string;
  /** Validate retained files in place; never recreate a missing directory. */
  reuseCwd?: string;
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  const identities = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  if (!input.reuseCwd) await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  let segments: string[];
  if (input.reuseCwd) {
    const identity = readIsolatedTaskPath(cwd, input.reuseCwd);
    if (input.attemptId || path.resolve(input.reuseCwd) !== input.reuseCwd || !identity || identity.rest.length !== 0 ||
        identity.companyId !== input.companyId || identity.issueId !== input.issueId) {
      throw new Error("Isolated task workspace path is not this task's directory");
    }
    segments = path.relative(cwd, input.reuseCwd).split(path.sep);
  } else segments = path.relative(cwd, await resolveIsolatedTaskDirectory(cwd, input)).split(path.sep);
  // A retry is a sibling namespace, never a descendant of the retained root.
  // An old copyback operation must not be able to overwrite its replacement.
  for (const segment of segments) {
    cwd = path.join(cwd, segment);
    if (!input.reuseCwd) await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}

export async function isBoundIsolatedTaskDirectory(input: {
  companyId: string; issueId: string; workspaceId: string | null;
  workspace: Pick<ExecutionWorkspace, "id" | "companyId" | "sourceIssueId" | "status" | "mode" | "strategyType" | "providerType" | "cwd" | "repoUrl" | "branchName"> | null;
}): Promise<boolean> {
  const workspace = input.workspace;
  if (!workspace || workspace.id !== input.workspaceId || workspace.companyId !== input.companyId ||
      workspace.sourceIssueId !== input.issueId || workspace.status !== "active" ||
      workspace.mode !== "isolated_workspace" || workspace.strategyType !== "project_primary" ||
      workspace.providerType !== "local_fs" || !workspace.cwd || workspace.repoUrl || workspace.branchName) return false;
  try {
    await materializeIsolatedTaskDirectory({ companyId: input.companyId, issueId: input.issueId, reuseCwd: workspace.cwd });
    return true;
  } catch {
    return false;
  }
}
