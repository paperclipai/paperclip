import fs from "node:fs/promises";
import path from "node:path";

import { inspectWorkspaceGitReadiness } from "./workspace-path-readiness.js";

export type ProjectWorkspaceRef = {
  id: string;
  name: string;
  sourceType: string;
  cwd: string | null;
};

export type ExecutionWorkspaceRef = {
  id: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
  cwd: string | null;
};

export type ExecutionWorkspaceFindingKind =
  | "sibling_cwd"
  | "missing_workspace_path"
  | "workspace_volume_not_mounted"
  | "missing_git_metadata";

export type ExecutionWorkspaceFinding = {
  kind: ExecutionWorkspaceFindingKind;
  executionWorkspaceId: string;
  issueId: string | null;
  cwd: string | null;
  projectWorkspaceId: string | null;
  projectWorkspaceName: string | null;
  detail: string;
};

export const EXECUTION_WORKSPACE_FINDING_HEADLINES: Record<
  ExecutionWorkspaceFindingKind,
  string
> = {
  sibling_cwd:
    "cwd belongs to a different workspace of the same project (LUN-7697 signature)",
  missing_workspace_path: "cwd does not exist",
  workspace_volume_not_mounted: "cwd is on an unmounted external volume",
  missing_git_metadata: "cwd is not a git repository",
};

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Audit one execution workspace against the project workspace its own row
 * names, and against that workspace's siblings.
 *
 * `null` means nothing to report, including the two cases that are healthy by
 * design: a row with no declared project workspace at all (it runs in a
 * Paperclip-managed `_default` folder, non-git on purpose) and a row with no
 * cwd yet.
 *
 * The order matters. `sibling_cwd` is checked first because it is the *cause* —
 * a row whose cwd was borrowed from a sibling usually also trips the git check,
 * and reporting the git symptom is what sent LUN-7697 looking for a broken
 * repository instead of a crossed workspace.
 */
export async function auditExecutionWorkspaceRow(input: {
  row: ExecutionWorkspaceRef;
  linkedWorkspace: ProjectWorkspaceRef | null;
  projectWorkspaces: ProjectWorkspaceRef[];
}): Promise<ExecutionWorkspaceFinding | null> {
  const { row, linkedWorkspace, projectWorkspaces } = input;
  if (!linkedWorkspace && projectWorkspaces.length === 0) return null;
  const cwd = row.cwd?.trim() || null;
  if (!cwd) return null;

  const base = {
    executionWorkspaceId: row.id,
    issueId: row.issueId,
    cwd,
    projectWorkspaceId: row.projectWorkspaceId,
    projectWorkspaceName: linkedWorkspace?.name ?? null,
  };

  if (linkedWorkspace?.cwd && !samePath(cwd, linkedWorkspace.cwd)) {
    const borrowedFrom = projectWorkspaces.find(
      (sibling) =>
        sibling.id !== linkedWorkspace.id &&
        sibling.cwd &&
        samePath(cwd, sibling.cwd),
    );
    if (borrowedFrom) {
      return {
        ...base,
        kind: "sibling_cwd",
        detail: `names workspace "${linkedWorkspace.name}" (${linkedWorkspace.cwd}) but runs in "${borrowedFrom.name}" (${borrowedFrom.cwd}, ${borrowedFrom.sourceType})`,
      };
    }
  }

  if (linkedWorkspace?.sourceType === "git_repo") {
    const readiness = await inspectWorkspaceGitReadiness(cwd);
    if (readiness.ok) return null;
    return { ...base, kind: readiness.reason, detail: readiness.detail };
  }

  const exists = await fs
    .stat(path.resolve(cwd))
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  if (exists) return null;
  return { ...base, kind: "missing_workspace_path", detail: "does not exist" };
}
