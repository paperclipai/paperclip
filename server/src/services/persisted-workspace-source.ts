import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { inspectManagedGitWorktreeBranch, WorkspaceRuntimeValidationFailure } from "./workspace-runtime.js";
import type { ManagedGitInspectionDiagnostic, PersistedWorkspaceSourceReasonCode } from "./workspace-validation-diagnostics.js";

const exec = promisify(execFile);
type SourceWorkspace = Pick<ExecutionWorkspace,
  "id" | "companyId" | "projectId" | "projectWorkspaceId" | "repoUrl" | "baseRef" | "cwd" | "providerRef"
>;

function fail(workspace: SourceWorkspace, reasonCode: PersistedWorkspaceSourceReasonCode): never {
  throw new WorkspaceRuntimeValidationFailure(
    "The selected execution workspace's original repository could not be verified. "
      + "Restore its original project source. Before intentionally clearing the task's existing-workspace binding to choose another repository, review and preserve its retained work.",
    { workspaceValidation: { reason: "persisted_workspace_source_conflict", reasonCode, executionWorkspaceId: workspace.id } },
  );
}

function failInspection(workspace: SourceWorkspace, diagnostic: ManagedGitInspectionDiagnostic): never {
  throw new WorkspaceRuntimeValidationFailure(
    "The original repository's complete Git worktree registration could not be inspected. Inspect the source before retrying; its workspace binding was preserved.",
    { workspaceValidation: { reason: "git_worktree_not_reusable", reasonCode: "git_inspection_failed",
      executionWorkspaceId: workspace.id, inspectionDiagnostic: diagnostic } },
  );
}

async function canonicalDirectory(value: string): Promise<string | null> {
  try {
    const resolved = await fs.realpath(value);
    return (await fs.stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// Read the stored identity, not `remote get-url` which expands transport-only
// insteadOf settings (including the managed SSH-to-HTTPS credential rewrite).
async function readOrigin(cwd: string): Promise<string | null> {
  return exec("git", ["config", "--local", "--null", "--get-all", "remote.origin.url"], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000, maxBuffer: 16 * 1024,
  }).then(result => {
    const urls = result.stdout.split("\0");
    if (urls.at(-1) === "") urls.pop();
    // Fetch uses the first URL, while a scalar config read can select the last.
    // Ambiguous origins are not proof that this is the recorded repository.
    return urls.length === 1 ? urls[0]!.trim() || null : null;
  }).catch(() => null);
}

async function gitDirectory(cwd: string, flag: "--absolute-git-dir" | "--git-common-dir"): Promise<string | null> {
  const directory = await exec("git", ["rev-parse", "--path-format=absolute", flag], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000, maxBuffer: 16 * 1024,
  }).then(result => result.stdout.trim() || null).catch(() => null);
  return directory ? canonicalDirectory(directory) : null;
}

async function hasLinkedWorktreeStorage(cwd: string, owner: string): Promise<boolean> {
  const [storage, common, ownerCommon] = await Promise.all([
    gitDirectory(cwd, "--absolute-git-dir"), gitDirectory(cwd, "--git-common-dir"), gitDirectory(owner, "--git-common-dir"),
  ]);
  if (!storage || !common || common !== ownerCommon) return false;
  const worktrees = await canonicalDirectory(path.join(common, "worktrees"));
  if (!worktrees || path.dirname(storage) !== worktrees) return false;
  try {
    const backlinkPath = path.join(storage, "gitdir");
    if ((await fs.stat(backlinkPath)).size > 16 * 1024) return false;
    const backlink = (await fs.readFile(backlinkPath, "utf8")).trim();
    return await fs.realpath(backlink) === await fs.realpath(path.join(cwd, ".git"));
  } catch {
    return false;
  }
}

async function resolveBoundLocalOwner(cwd: string): Promise<string | null> {
  const root = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000, maxBuffer: 16 * 1024,
  }).then(result => result.stdout.trim() || null).catch(() => null);
  return root ? canonicalDirectory(root) : null;
}

async function canMaterializeManagedCandidate(root: string, candidate: string): Promise<boolean> {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  if (!await canonicalDirectory(root)) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

/** Source candidates come from scoped project state and the instance's managed path generator, never Git output. */
export async function resolvePersistedGitWorkspaceSource(input: {
  companyId: string;
  projectId: string | null;
  explicitProjectWorkspaceId: string | null;
  workspace: SourceWorkspace;
  boundProjectWorkspace: { id: string; companyId: string; projectId: string; cwd: string | null } | null;
  candidateBaseCwds: string[];
  managedSourceRoot: string;
  materializeOriginalRepository?: () => Promise<string>;
}): Promise<string> {
  const workspace = input.workspace;
  if (workspace.companyId !== input.companyId || workspace.projectId !== input.projectId) {
    fail(workspace, "source_scope_mismatch");
  }
  const binding = input.boundProjectWorkspace;
  if ((workspace.projectWorkspaceId && !binding) || (binding && (binding.id !== workspace.projectWorkspaceId
    || binding.companyId !== input.companyId || binding.projectId !== workspace.projectId))) {
    fail(workspace, "source_scope_mismatch");
  }
  if (input.explicitProjectWorkspaceId && input.explicitProjectWorkspaceId !== workspace.projectWorkspaceId) {
    fail(workspace, "explicit_project_workspace_conflict");
  }
  const cwd = workspace.providerRef ?? workspace.cwd;
  if (!cwd || (workspace.cwd && workspace.providerRef && path.resolve(workspace.cwd) !== path.resolve(workspace.providerRef))) {
    fail(workspace, "source_path_unproven");
  }
  const roots = async () => {
    const canonicalRoot = await canonicalDirectory(input.managedSourceRoot);
    if (!canonicalRoot) return new Set<string>();
    const candidates = await Promise.all(input.candidateBaseCwds.map(async candidate => {
      const relative = path.relative(input.managedSourceRoot, candidate);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      const resolved = await canonicalDirectory(candidate);
      // The configured instance root may be a symlink. A project or repository
      // below it may not redirect the scoped managed identity elsewhere.
      return resolved === path.join(canonicalRoot, relative) ? resolved : null;
    }));
    return new Set(candidates.filter((value): value is string => value !== null));
  };
  const knownRoots = await roots();
  if (binding?.cwd) {
    // A configured local path may be a repository subfolder or another linked
    // checkout. Resolve its Git owner as the old restore path already did.
    const localOwner = await resolveBoundLocalOwner(binding.cwd);
    if (localOwner) knownRoots.add(localOwner);
  }
  const existing = await canonicalDirectory(cwd);
  const sourceEntry = await fs.lstat(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    return fail(workspace, "source_path_unproven");
  });
  if (sourceEntry && !existing) fail(workspace, "source_path_unproven");
  if (existing) {
    // An independent clone (including a stand-alone checkout with separate Git
    // storage) is not a linked worktree authorized by the persisted binding.
    const dotGit = await fs.lstat(path.join(existing, ".git")).catch(() => null);
    if (!dotGit?.isFile()) fail(workspace, "source_registration_unproven");
    let repositoryMismatch = false;
    let failedInspection: ManagedGitInspectionDiagnostic | null = null;
    for (const owner of knownRoots) {
      if (owner === existing) continue;
      const inspection = await inspectManagedGitWorktreeBranch({ worktreePath: existing, repoRoot: owner, expectedBranchName: null });
      if (inspection.inspectionDiagnostic) failedInspection ??= inspection.inspectionDiagnostic;
      if (!inspection.valid || !await hasLinkedWorktreeStorage(existing, owner)) continue;
      if (workspace.repoUrl && await readOrigin(owner) !== workspace.repoUrl.trim()) {
        repositoryMismatch = true;
        continue;
      }
      return owner;
    }
    if (failedInspection) failInspection(workspace, failedInspection);
    fail(workspace, repositoryMismatch ? "source_repository_mismatch" : "source_registration_unproven");
  }

  // A mutable local project cwd alone cannot prove the repository that owned a
  // now-missing worktree. Do not reconstruct historical work from its new cwd.
  if (!workspace.repoUrl) fail(workspace, "source_repository_unavailable");

  // Reconstruct only from a source authorized by the old binding. A new project
  // primary is never a fallback for a missing historical worktree.
  let failedInspection: ManagedGitInspectionDiagnostic | null = null;
  for (const candidate of knownRoots) {
    if (workspace.repoUrl && await readOrigin(candidate) !== workspace.repoUrl.trim()) continue;
    const inspection = await inspectManagedGitWorktreeBranch({ worktreePath: candidate, repoRoot: candidate, expectedBranchName: null });
    if (inspection.valid) return candidate;
    if (inspection.inspectionDiagnostic) failedInspection ??= inspection.inspectionDiagnostic;
  }
  if (failedInspection) failInspection(workspace, failedInspection);
  if (workspace.repoUrl && input.materializeOriginalRepository) {
    if (input.candidateBaseCwds.length === 0 || !(await Promise.all(input.candidateBaseCwds.map(
      candidate => canMaterializeManagedCandidate(input.managedSourceRoot, candidate),
    ))).every(Boolean)) fail(workspace, "source_repository_unavailable");
    const materialized = await input.materializeOriginalRepository();
    const owner = await canonicalDirectory(materialized);
    const expectedRoots = await roots();
    if (owner && expectedRoots.has(owner) && await readOrigin(owner) === workspace.repoUrl.trim()) return owner;
  }
  fail(workspace, "source_repository_unavailable");
}
