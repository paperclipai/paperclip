import { realpath } from "node:fs/promises";
import { isVerifiedNestedRepositoryBase, nestedRepositoryBaseCandidates } from "./nested-repository-worktrees.js";

/** Resolve only registered sources; never infer a base from the task's target directory. */
export async function resolveWorkspaceRuntimeBase(input: {
  companyId: string;
  projectId: string | null;
  projectWorkspace: { cwd: string | null; repoUrl: string | null } | null;
  workspaceCwd: string;
}): Promise<string> {
  const source = input.projectWorkspace;
  if (!source) return input.workspaceCwd;
  if (source.cwd?.trim()) return source.cwd;
  if (input.projectId && source.repoUrl) {
    const candidates = nestedRepositoryBaseCandidates({
      companyId: input.companyId,
      projectId: input.projectId,
      repoUrl: source.repoUrl,
    });
    for (const candidate of candidates) {
      if (await realpath(candidate).catch(() => null) === candidate
        && await isVerifiedNestedRepositoryBase(candidate, candidates, source.repoUrl)) return candidate;
    }
  }
  throw new Error("Workspace runtime requires a verified registered base project checkout.");
}
