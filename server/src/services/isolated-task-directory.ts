import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseObject } from "../adapters/utils.js";
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
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  const identities = [input.companyId, input.issueId];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  for (const segment of ["isolated-workspaces", ...identities]) {
    cwd = path.join(cwd, segment);
    await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}
