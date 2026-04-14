import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExecutionWorkspace,
  IssueCommentPublicationStatus,
  IssueMergeStatus,
  ProjectExecutionWorkspacePolicy,
} from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

type MergeSnapshot = {
  state?: IssueMergeStatus["state"];
  targetBranch?: string | null;
  sourceBranch?: string | null;
  repoRoot?: string | null;
  reason?: string | null;
  mergedCommit?: string | null;
  mergedAt?: string | Date | null;
  lastAttemptedAt?: string | Date | null;
};

type BranchProvenanceSnapshot = {
  source?: string | null;
  branchName?: string | null;
  baseRef?: string | null;
  recordedAt?: string | Date | null;
};

type MergeStatusInput = {
  issueStatus: string;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  executionWorkspace: ExecutionWorkspace | null;
  qaCanShip: boolean;
  lastIssueCommentStatus?: IssueCommentPublicationStatus | null;
};

type GitExec = (cwd: string, args: string[]) => Promise<string>;

type TargetBranchSpec = {
  sourceRef: string;
  localBranch: string;
  remoteName: string | null;
  remoteBranch: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTargetBranchSpec(targetBranch: string): TargetBranchSpec {
  if (targetBranch.startsWith("refs/remotes/")) {
    const trimmed = targetBranch.replace(/^refs\/remotes\//, "");
    const [remoteName, ...rest] = trimmed.split("/");
    const remoteBranch = rest.join("/");
    return {
      sourceRef: targetBranch,
      localBranch: remoteBranch,
      remoteName: remoteName || null,
      remoteBranch: remoteBranch || null,
    };
  }
  if (/^[^/]+\/.+/.test(targetBranch) && !targetBranch.startsWith("refs/heads/")) {
    const [remoteName, ...rest] = targetBranch.split("/");
    const remoteBranch = rest.join("/");
    return {
      sourceRef: targetBranch,
      localBranch: remoteBranch,
      remoteName: remoteName || null,
      remoteBranch: remoteBranch || null,
    };
  }
  return {
    sourceRef: targetBranch,
    localBranch: targetBranch.replace(/^refs\/heads\//, ""),
    remoteName: null,
    remoteBranch: null,
  };
}

function resolveTargetBranch(policy: ProjectExecutionWorkspacePolicy | null, workspace: ExecutionWorkspace): TargetBranchSpec {
  const configured =
    readNonEmptyString(policy?.branchPolicy?.targetBranch)
    ?? readNonEmptyString(workspace.baseRef)
    ?? "master";
  return parseTargetBranchSpec(configured);
}

function readMergeSnapshot(metadata: Record<string, unknown> | null | undefined): MergeSnapshot | null {
  const merge = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata.merge as Record<string, unknown> | undefined)
    : undefined;
  if (!merge || typeof merge !== "object" || Array.isArray(merge)) return null;
  return merge as MergeSnapshot;
}

function readBranchProvenanceSnapshot(metadata: Record<string, unknown> | null | undefined): BranchProvenanceSnapshot | null {
  const provenance = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata.branchProvenance as Record<string, unknown> | undefined)
    : undefined;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  return provenance as BranchProvenanceSnapshot;
}

function buildStatus(input: {
  enabled: boolean;
  state: IssueMergeStatus["state"];
  workspace: ExecutionWorkspace | null;
  targetBranch: string | null;
  sourceBranch: string | null;
  repoRoot: string | null;
  reason?: string | null;
  mergedCommit?: string | null;
  mergedAt?: Date | null;
  lastAttemptedAt?: Date | null;
  lastIssueCommentStatus?: IssueCommentPublicationStatus | null;
}): IssueMergeStatus {
  const provenance =
    input.workspace?.branchProvenance
    ?? readBranchProvenanceSnapshot(input.workspace?.metadata ?? null);
  return {
    enabled: input.enabled,
    state: input.state,
    targetBranch: input.targetBranch,
    sourceBranch: input.sourceBranch,
    repoRoot: input.repoRoot,
    reason: input.reason ?? null,
    mergedCommit: input.mergedCommit ?? null,
    mergedAt: input.mergedAt ?? null,
    lastAttemptedAt: input.lastAttemptedAt ?? null,
    lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    createdByRuntime:
      input.workspace?.metadata?.createdByRuntime === true
        ? true
        : input.workspace?.metadata?.createdByRuntime === false
          ? false
          : null,
    branchProvenanceSource: readNonEmptyString(provenance?.source) ?? null,
  };
}

async function runGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return result.stdout.trim();
}

async function resolveRepoRoot(workspace: ExecutionWorkspace, gitExec: GitExec) {
  const workspacePath = readNonEmptyString(workspace.providerRef) ?? readNonEmptyString(workspace.cwd);
  if (!workspacePath) return { workspacePath: null, repoRoot: null };
  try {
    return {
      workspacePath,
      repoRoot: await gitExec(workspacePath, ["rev-parse", "--show-toplevel"]),
    };
  } catch {
    return { workspacePath, repoRoot: null };
  }
}

async function branchExists(repoRoot: string, branch: string, gitExec: GitExec) {
  try {
    await gitExec(repoRoot, ["rev-parse", "--verify", branch]);
    return true;
  } catch {
    return false;
  }
}

async function resolvePushTarget(repoRoot: string, target: TargetBranchSpec, gitExec: GitExec) {
  try {
    const upstream = await gitExec(repoRoot, ["for-each-ref", `refs/heads/${target.localBranch}`, "--format=%(upstream:short)"]);
    const normalizedUpstream = readNonEmptyString(upstream);
    if (normalizedUpstream && /^[^/]+\/.+/.test(normalizedUpstream)) {
      const [remoteName, ...rest] = normalizedUpstream.split("/");
      return { remoteName, remoteBranch: rest.join("/") };
    }
  } catch {
    // Ignore missing upstream; fall back to remote target from the configured ref.
  }
  if (target.remoteName && target.remoteBranch) {
    return {
      remoteName: target.remoteName,
      remoteBranch: target.remoteBranch,
    };
  }
  return null;
}

export async function getIssueMergeStatus(input: MergeStatusInput): Promise<IssueMergeStatus | null> {
  const enabled = input.projectPolicy?.enabled === true && input.projectPolicy.pullRequestPolicy?.mergeOnQaPass === true;
  if (!enabled) return null;

  const workspace = input.executionWorkspace;
  const snapshot = readMergeSnapshot(workspace?.metadata ?? null);
  const sourceBranch = readNonEmptyString(workspace?.branchName) ?? readNonEmptyString(snapshot?.sourceBranch) ?? null;
  const targetSpec = workspace ? resolveTargetBranch(input.projectPolicy, workspace) : null;
  const targetBranch = targetSpec?.localBranch ?? readNonEmptyString(snapshot?.targetBranch) ?? null;

  if (snapshot?.state === "merged") {
    return buildStatus({
      enabled,
      state: "merged",
      workspace,
      targetBranch,
      sourceBranch,
      repoRoot: readNonEmptyString(snapshot.repoRoot) ?? null,
      reason: readNonEmptyString(snapshot.reason) ?? null,
      mergedCommit: readNonEmptyString(snapshot.mergedCommit) ?? null,
      mergedAt: readDate(snapshot.mergedAt),
      lastAttemptedAt: readDate(snapshot.lastAttemptedAt),
      lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    });
  }

  if (!workspace) {
    return buildStatus({
      enabled,
      state: "blocked",
      workspace: null,
      targetBranch,
      sourceBranch,
      repoRoot: null,
      reason: "Merge-on-QA is enabled but this issue has no persisted execution workspace.",
      lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    });
  }

  if (!sourceBranch) {
    return buildStatus({
      enabled,
      state: "blocked",
      workspace,
      targetBranch,
      sourceBranch: null,
      repoRoot: null,
      reason: "Merge-on-QA is enabled but the execution workspace has no source branch metadata.",
      lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    });
  }

  const { repoRoot } = await resolveRepoRoot(workspace, runGit);
  if (!repoRoot) {
    return buildStatus({
      enabled,
      state: "blocked",
      workspace,
      targetBranch,
      sourceBranch,
      repoRoot: null,
      reason: "Merge-on-QA is enabled but Orchestrero could not resolve the workspace repo root.",
      lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    });
  }

  return buildStatus({
    enabled,
    state: input.qaCanShip ? "ready" : "pending",
    workspace,
    targetBranch,
    sourceBranch,
    repoRoot,
    reason: input.qaCanShip ? null : `Waiting for QA release markers while issue remains ${input.issueStatus}.`,
    lastIssueCommentStatus: input.lastIssueCommentStatus ?? null,
    lastAttemptedAt: readDate(snapshot?.lastAttemptedAt),
  });
}

export async function attemptQaPassAutoMerge(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  executionWorkspace: ExecutionWorkspace | null;
}): Promise<
  | { outcome: "not_applicable"; status: IssueMergeStatus | null }
  | { outcome: "blocked"; status: IssueMergeStatus }
  | { outcome: "merged"; status: IssueMergeStatus }
> {
  const currentStatus = await getIssueMergeStatus({
    issueStatus: "in_review",
    projectPolicy: input.projectPolicy,
    executionWorkspace: input.executionWorkspace,
    qaCanShip: true,
    lastIssueCommentStatus: null,
  });
  if (!currentStatus) {
    return { outcome: "not_applicable", status: null };
  }
  if (currentStatus.state === "merged") {
    return { outcome: "merged", status: currentStatus };
  }
  if (currentStatus.state !== "ready") {
    return { outcome: "blocked", status: currentStatus };
  }

  const workspace = input.executionWorkspace;
  if (!workspace || !currentStatus.repoRoot || !currentStatus.sourceBranch || !currentStatus.targetBranch) {
    return {
      outcome: "blocked",
      status: buildStatus({
        enabled: true,
        state: "blocked",
        workspace,
        targetBranch: currentStatus.targetBranch,
        sourceBranch: currentStatus.sourceBranch,
        repoRoot: currentStatus.repoRoot,
        reason: "Merge-on-QA is enabled but the merge context is incomplete.",
      }),
    };
  }

  const repoRoot = currentStatus.repoRoot;
  const sourceBranch = currentStatus.sourceBranch;
  const targetSpec = resolveTargetBranch(input.projectPolicy, workspace);
  const targetBranch = targetSpec.localBranch;

  if (sourceBranch === targetBranch) {
    return {
      outcome: "blocked",
      status: buildStatus({
        enabled: true,
        state: "blocked",
        workspace,
        targetBranch,
        sourceBranch,
        repoRoot,
        reason: "Source and target branches resolve to the same branch; nothing can be merged.",
      }),
    };
  }

  const now = new Date();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-qa-merge-"));
  let worktreeAdded = false;

  try {
    const sourceExists = await branchExists(repoRoot, sourceBranch, runGit);
    if (!sourceExists) {
      return {
        outcome: "blocked",
        status: buildStatus({
          enabled: true,
          state: "blocked",
          workspace,
          targetBranch,
          sourceBranch,
          repoRoot,
          reason: `Source branch "${sourceBranch}" no longer exists.`,
          lastAttemptedAt: now,
        }),
      };
    }

    const targetExists = await branchExists(repoRoot, targetSpec.sourceRef, runGit);
    if (!targetExists) {
      return {
        outcome: "blocked",
        status: buildStatus({
          enabled: true,
          state: "blocked",
          workspace,
          targetBranch,
          sourceBranch,
          repoRoot,
          reason: `Target branch "${targetSpec.sourceRef}" does not exist.`,
          lastAttemptedAt: now,
        }),
      };
    }

    try {
      await runGit(repoRoot, ["merge-base", "--is-ancestor", sourceBranch, targetSpec.sourceRef]);
      const mergedCommit = await runGit(repoRoot, ["rev-parse", targetSpec.sourceRef]);
      return {
        outcome: "merged",
        status: buildStatus({
          enabled: true,
          state: "merged",
          workspace,
          targetBranch,
          sourceBranch,
          repoRoot,
          mergedCommit,
          mergedAt: now,
          lastAttemptedAt: now,
        }),
      };
    } catch {
      // Not already merged; continue.
    }

    await runGit(repoRoot, ["worktree", "add", "--detach", tempDir, targetSpec.sourceRef]);
    worktreeAdded = true;

    try {
      await runGit(tempDir, ["merge", "--no-ff", "--no-edit", sourceBranch]);
    } catch (error) {
      await runGit(tempDir, ["merge", "--abort"]).catch(() => undefined);
      return {
        outcome: "blocked",
        status: buildStatus({
          enabled: true,
          state: "blocked",
          workspace,
          targetBranch,
          sourceBranch,
          repoRoot,
          reason: `Auto-merge into ${targetBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
          lastAttemptedAt: now,
        }),
      };
    }

    const mergedCommit = await runGit(tempDir, ["rev-parse", "HEAD"]);
    const pushTarget = await resolvePushTarget(repoRoot, targetSpec, runGit);

    let updatedLocalTarget = false;
    try {
      await runGit(repoRoot, ["branch", "-f", targetBranch, mergedCommit]);
      updatedLocalTarget = true;
    } catch (error) {
      if (!pushTarget) {
        return {
          outcome: "blocked",
          status: buildStatus({
            enabled: true,
            state: "blocked",
            workspace,
            targetBranch,
            sourceBranch,
            repoRoot,
            reason: `Merged commit was created, but Orchestrero could not update local branch "${targetBranch}": ${error instanceof Error ? error.message : String(error)}`,
            lastAttemptedAt: now,
          }),
        };
      }
    }

    if (pushTarget) {
      try {
        await runGit(tempDir, ["push", pushTarget.remoteName, `HEAD:${pushTarget.remoteBranch}`]);
      } catch (error) {
        return {
          outcome: "blocked",
          status: buildStatus({
            enabled: true,
            state: "blocked",
            workspace,
            targetBranch,
            sourceBranch,
            repoRoot,
            reason: `Merged commit was created, but push to ${pushTarget.remoteName}/${pushTarget.remoteBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
            mergedCommit,
            lastAttemptedAt: now,
          }),
        };
      }
    } else if (!updatedLocalTarget) {
      return {
        outcome: "blocked",
        status: buildStatus({
          enabled: true,
          state: "blocked",
          workspace,
          targetBranch,
          sourceBranch,
          repoRoot,
          reason: `Merge created ${mergedCommit}, but Orchestrero had no safe way to publish it to "${targetBranch}".`,
          mergedCommit,
          lastAttemptedAt: now,
        }),
      };
    }

    if (
      workspace.metadata?.createdByRuntime === true
      && input.projectPolicy?.pullRequestPolicy?.deleteBranchAfterMerge !== false
    ) {
      await runGit(repoRoot, ["branch", "-d", sourceBranch]).catch(() => undefined);
    }

    return {
      outcome: "merged",
      status: buildStatus({
        enabled: true,
        state: "merged",
        workspace,
        targetBranch,
        sourceBranch,
        repoRoot,
        mergedCommit,
        mergedAt: now,
        lastAttemptedAt: now,
      }),
    };
  } finally {
    if (worktreeAdded) {
      await runGit(repoRoot, ["worktree", "remove", "--force", tempDir]).catch(() => undefined);
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function issueMergeService() {
  return {
    getIssueMergeStatus,
    attemptQaPassAutoMerge,
  };
}
