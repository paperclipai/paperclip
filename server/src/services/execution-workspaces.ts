import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, heartbeatRuns, issueComments, issues, projects, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceSummary,
  ExecutionWorkspaceCloseAction,
  ExecutionWorkspaceCloseGitReadiness,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  WorkspaceOverviewResponse,
  WorkspaceOverviewItem,
  WorkspaceOverviewLinkedIssue,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeService,
  WorkspaceOverviewPrimaryService,
  WorkspaceOverviewQuery,
  GitWorktreeBranchAncestryVerdict,
  IssueRecoveryAction,
} from "@paperclipai/shared";
import { deriveProjectUrlKey, WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import {
  listCurrentRuntimeServicesForExecutionWorkspaces,
  listCurrentRuntimeServicesForProjectWorkspaces,
} from "./workspace-runtime-read-model.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeServiceReadDb = Pick<Db, "select">;
const execFileAsync = promisify(execFile);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const WORKSPACE_VALIDATION_RECOVERY_CAUSE = "workspace_validation_failed";

export type ExecutionWorkspaceBranchReconcileMode = "forward" | "override" | "quarantine_restore";

export type ExecutionWorkspaceBranchReconcileActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

export type ExecutionWorkspaceBranchReconcileInspection = {
  fingerprint: string;
  worktreePath: string;
  repoRoot: string;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  cleanliness: "clean" | "dirty" | "unknown";
  statusEntryCount: number | null;
  plainLanguageReason: string;
};

export type ExecutionWorkspaceBranchReconcileResult = {
  workspace: ExecutionWorkspace;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  recoveryAction: IssueRecoveryAction | null;
  auditCommentId: string | null;
  rescueRef: {
    branchName: string;
    commitSha: string;
    fileCount: number;
    sourceAuditCommentId: string | null;
    claimantAuditCommentId: string | null;
  } | null;
  restoredSourceIssue: {
    id: string;
    companyId: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
  sourceIssueStatusChanged: boolean;
};

export type ExecutionWorkspaceGitWorktreeContention = {
  claimedByWorkspaceId: string;
  claimedByIssueId: string | null;
  claimedByIssueIdentifier: string | null;
  activeRun: {
    id: string;
    status: "queued" | "running";
    issueId: string | null;
    issueIdentifier: string | null;
  } | null;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

function assigneeMatchesExecutionPrincipal(input: {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}, principal: { type: string; agentId?: string | null; userId?: string | null } | null): boolean {
  if (!principal) return false;
  if (principal.type === "agent") {
    return input.assigneeAgentId === principal.agentId && input.assigneeUserId === null;
  }
  if (principal.type === "user") {
    return input.assigneeAgentId === null && input.assigneeUserId === principal.userId;
  }
  return false;
}

function quarantineRestoreRequestedSourceStatus(input: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: unknown;
}): "todo" | undefined {
  const state = parseIssueExecutionState(input.executionState);
  if (
    state?.status === "pending" &&
    input.status === "in_review" &&
    assigneeMatchesExecutionPrincipal(input, state.currentParticipant)
  ) {
    return undefined;
  }
  return "todo";
}

function readDesiredState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

function readServiceStates(value: unknown): ExecutionWorkspaceConfig["serviceStates"] {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([, state]) =>
    state === "running" || state === "stopped" || state === "manual"
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as ExecutionWorkspaceConfig["serviceStates"]
    : null;
}

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function readGitStdout(args: string[], cwd: string): Promise<string | null> {
  const output = await runGit(args, cwd);
  return output.stdout.trim() || null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

function fingerprintWorkspaceBranchIncoherence(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: WORKSPACE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  try {
    await runGit(["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha], input.repoRoot);
    return "ancestor";
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    return code === 1 ? "diverged" : "unknown";
  }
}

function explainGitWorktreeBranchReconcileInspection(input: {
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  if (!input.fromSha || !input.toSha) {
    return `Paperclip could not determine branch ancestry because "${input.fromBranch}" or "${input.toBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.fromSha === input.toSha) {
    return `The recorded branch "${input.fromBranch}" and checked-out branch "${input.toBranch}" resolve to the same commit.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.fromBranch}" is an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.fromBranch}" is not an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  return `Paperclip could not determine whether "${input.toBranch}" is forward of "${input.fromBranch}".`;
}

async function inspectExecutionWorkspaceBranchForReconcile(
  workspace: Pick<ExecutionWorkspace, "id" | "sourceIssueId" | "cwd" | "providerRef" | "branchName">,
): Promise<ExecutionWorkspaceBranchReconcileInspection> {
  const fromBranch = readNullableString(workspace.branchName);
  if (!fromBranch) {
    throw unprocessable("Execution workspace has no recorded branch to reconcile");
  }

  const worktreePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  if (!worktreePath) {
    throw unprocessable("Execution workspace needs a local worktree path before Paperclip can reconcile its branch record");
  }

  const repoRoot = await readGitStdout(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!repoRoot) {
    throw unprocessable("Execution workspace path is not inside a git repository");
  }

  const toBranch = await readGitStdout(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath).catch(() => null);
  if (!toBranch) {
    throw unprocessable("Execution workspace is detached; Paperclip cannot reconcile it to a branch name");
  }

  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath)
    .then((output) => output.stdout)
    .catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanliness: ExecutionWorkspaceBranchReconcileInspection["cleanliness"] =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";

  const fromSha = await readGitStdout(["rev-parse", "--verify", `refs/heads/${fromBranch}^{commit}`], repoRoot)
    .catch(() => null);
  const toSha = await readGitStdout(["rev-parse", "HEAD"], worktreePath).catch(() => null);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot,
    expectedHeadSha: fromSha,
    actualHeadSha: toSha,
  });

  return {
    fingerprint: fingerprintWorkspaceBranchIncoherence({
      sourceIssueId: workspace.sourceIssueId ?? null,
      executionWorkspaceId: workspace.id,
      worktreePath,
      expectedBranch: fromBranch,
      actualBranch: toBranch,
      cleanliness,
      expectedHeadSha: fromSha,
      actualHeadSha: toSha,
    }),
    worktreePath: path.resolve(worktreePath),
    repoRoot: path.resolve(repoRoot),
    fromBranch,
    toBranch,
    fromSha,
    toSha,
    ancestryVerdict,
    cleanliness,
    statusEntryCount: statusLines?.length ?? null,
    plainLanguageReason: explainGitWorktreeBranchReconcileInspection({
      fromBranch,
      toBranch,
      fromSha,
      toSha,
      ancestryVerdict,
    }),
  };
}

function formatBranchReconcileAuditComment(input: {
  mode: ExecutionWorkspaceBranchReconcileMode;
  reason: string | null;
  workspaceId: string;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  recoveryActionId: string | null;
  rescueRef: ExecutionWorkspaceBranchReconcileResult["rescueRef"];
}) {
  return [
    "Execution workspace branch reconciled.",
    "",
    `- Workspace: \`${input.workspaceId}\``,
    `- Mode: \`${input.mode}\``,
    `- From branch: \`${formatBranchForMessage(input.inspection.fromBranch)}\``,
    `- To branch: \`${formatBranchForMessage(input.inspection.toBranch)}\``,
    `- From SHA: \`${input.inspection.fromSha ?? "unknown"}\``,
    `- To SHA: \`${input.inspection.toSha ?? "unknown"}\``,
    `- Verdict: \`${input.inspection.ancestryVerdict}\``,
    `- Fingerprint: \`${input.inspection.fingerprint}\``,
    `- Recovery action: ${input.recoveryActionId ? `\`${input.recoveryActionId}\`` : "none matched"}`,
    ...(input.rescueRef
      ? [
          `- Rescue ref: \`${input.rescueRef.branchName}\``,
          `- Rescue commit: \`${input.rescueRef.commitSha}\``,
          `- Rescued file count: \`${input.rescueRef.fileCount}\``,
        ]
      : []),
    ...(input.reason ? [`- Operator reason: ${input.reason}`] : []),
  ].join("\n");
}

function isWorkspaceRuntimeValidationFailure(error: unknown): error is {
  code: "workspace_validation_failed";
  message: string;
  resultJson: Record<string, unknown>;
} {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; resultJson?: unknown; message?: unknown };
  return maybe.code === "workspace_validation_failed" &&
    typeof maybe.message === "string" &&
    Boolean(maybe.resultJson) &&
    typeof maybe.resultJson === "object" &&
    !Array.isArray(maybe.resultJson);
}

function assertBranchReconcileWorkspaceIsSafe(input: {
  workspaceStatus: ExecutionWorkspace["status"];
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  runtimeServices: WorkspaceRuntimeService[];
  allowActiveWorkspace?: boolean;
}) {
  const allowedStatuses = input.allowActiveWorkspace ? ["idle", "active"] : ["idle"];
  if (!allowedStatuses.includes(input.workspaceStatus)) {
    throw unprocessable("Execution workspace branch reconciliation requires the workspace to be idle", {
      workspaceStatus: input.workspaceStatus,
      inspection: input.inspection,
    });
  }

  if (input.inspection.cleanliness !== "clean") {
    throw unprocessable("Execution workspace branch reconciliation requires a clean worktree", {
      inspection: input.inspection,
    });
  }

  assertBranchReconcileRuntimeServicesStopped({
    inspection: input.inspection,
    runtimeServices: input.runtimeServices,
  });
}

function assertBranchReconcileRuntimeServicesStopped(input: {
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  runtimeServices: WorkspaceRuntimeService[];
}) {
  const activeRuntimeServices = input.runtimeServices.filter((service) => service.status !== "stopped");
  if (activeRuntimeServices.length > 0) {
    throw unprocessable("Execution workspace branch reconciliation requires all runtime services to be stopped", {
      inspection: input.inspection,
      runtimeServices: activeRuntimeServices.map((service) => ({
        id: service.id,
        serviceName: service.serviceName,
        status: service.status,
      })),
    });
  }
}

function assertLockedBranchReconcileWorkspaceStillMatchesInspection(input: {
  lockedRow: ExecutionWorkspaceRow;
  inspectedRow: ExecutionWorkspaceRow;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  const lockedPath = readNullableString(input.lockedRow.providerRef) ?? readNullableString(input.lockedRow.cwd);
  const lockedBranch = readNullableString(input.lockedRow.branchName);
  const currentPath = lockedPath ? path.resolve(lockedPath) : null;

  if (
    input.lockedRow.sourceIssueId !== input.inspectedRow.sourceIssueId ||
    input.lockedRow.projectWorkspaceId !== input.inspectedRow.projectWorkspaceId ||
    lockedBranch !== input.inspection.fromBranch ||
    currentPath !== input.inspection.worktreePath
  ) {
    throw conflict("Execution workspace changed during branch reconciliation; retry with the latest workspace state", {
      workspaceId: input.lockedRow.id,
      expected: {
        status: input.inspectedRow.status,
        sourceIssueId: input.inspectedRow.sourceIssueId,
        projectWorkspaceId: input.inspectedRow.projectWorkspaceId,
        branchName: input.inspection.fromBranch,
        worktreePath: input.inspection.worktreePath,
      },
      current: {
        status: input.lockedRow.status,
        sourceIssueId: input.lockedRow.sourceIssueId,
        projectWorkspaceId: input.lockedRow.projectWorkspaceId,
        branchName: lockedBranch,
        worktreePath: currentPath,
      },
    });
  }
}

async function quarantineRestoreDirtyWorkspaceBranch(input: {
  db: Db;
  workspace: Pick<ExecutionWorkspace, "id" | "sourceIssueId">;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  actor: ExecutionWorkspaceBranchReconcileActor;
}): Promise<NonNullable<ExecutionWorkspaceBranchReconcileResult["rescueRef"]>> {
  const sourceIssue = await input.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      workMode: issues.workMode,
    })
    .from(issues)
    .where(eq(issues.id, input.workspace.sourceIssueId!))
    .then((rows) => rows[0] ?? null);
  if (!sourceIssue) throw notFound("Source issue not found");

  const { ensureGitWorktreeBranchCoherent } = await import("./workspace-runtime.js");
  try {
    const result = await ensureGitWorktreeBranchCoherent({
      db: input.db,
      repoRoot: input.inspection.repoRoot,
      worktreePath: input.inspection.worktreePath,
      expectedBranchName: input.inspection.fromBranch,
      actualBranchName: input.inspection.toBranch,
      sourceIssue,
      executionWorkspaceId: input.workspace.id,
      heartbeatRunId: input.actor.runId,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: true,
      persistForwardReconcile: false,
      reconcileOperationPhase: "worktree_prepare",
      recorder: null,
    });

    if (!result.dirtyQuarantineRepair) {
      throw unprocessable("Quarantine restore requires a dirty foreign-branch worktree to repair", {
        inspection: input.inspection,
      });
    }

    return {
      branchName: result.dirtyQuarantineRepair.rescueBranch,
      commitSha: result.dirtyQuarantineRepair.rescueCommitSha,
      fileCount: result.dirtyQuarantineRepair.fileCount,
      sourceAuditCommentId: result.dirtyQuarantineRepair.sourceAuditCommentId,
      claimantAuditCommentId: result.dirtyQuarantineRepair.claimantAuditCommentId,
    };
  } catch (error) {
    if (isWorkspaceRuntimeValidationFailure(error)) {
      throw unprocessable(error.message, {
        code: error.code,
        ...error.resultJson,
      });
    }
    throw error;
  }
}

async function inspectGitCloseReadiness(workspace: ExecutionWorkspace): Promise<{
  git: ExecutionWorkspaceCloseGitReadiness | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  const createdByRuntime = workspace.metadata?.createdByRuntime === true;
  const expectsGitInspection =
    workspace.providerType === "git_worktree" ||
    Boolean(workspace.repoUrl || workspace.baseRef || workspace.branchName || workspacePath);

  if (!expectsGitInspection) {
    return { git: null, warnings };
  }

  if (!workspacePath) {
    warnings.push("Workspace has no local path, so Paperclip cannot inspect git status before close.");
    return { git: null, warnings };
  }

  if (!(await pathExists(workspacePath))) {
    warnings.push(`Workspace path "${workspacePath}" does not exist, so Paperclip cannot inspect git status before close.`);
    return {
      git: {
        repoRoot: null,
        workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: null,
        behindCount: null,
        isMergedIntoBase: null,
        createdByRuntime,
      },
      warnings,
    };
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], workspacePath)).stdout.trim() || null;
  } catch (error) {
    warnings.push(
      `Could not inspect git status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let branchName = workspace.branchName;
  if (repoRoot && !branchName) {
    try {
      branchName = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).stdout.trim() || null;
    } catch {
      branchName = workspace.branchName;
    }
  }

  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  if (repoRoot) {
    try {
      const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], workspacePath)).stdout;
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) {
          untrackedEntryCount += 1;
          continue;
        }
        dirtyEntryCount += 1;
      }
    } catch (error) {
      warnings.push(
        `Could not read git working tree status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  let isMergedIntoBase: boolean | null = null;
  const baseRef = workspace.baseRef;

  if (repoRoot && baseRef) {
    try {
      const counts = (await runGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], workspacePath)).stdout.trim();
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch (error) {
      warnings.push(
        `Could not compare this workspace against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await runGit(["merge-base", "--is-ancestor", "HEAD", baseRef], workspacePath);
      isMergedIntoBase = true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === 1) isMergedIntoBase = false;
      else {
        warnings.push(
          `Could not determine whether this workspace is merged into ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    git: {
      repoRoot,
      workspacePath,
      branchName,
      baseRef,
      hasDirtyTrackedFiles: dirtyEntryCount > 0,
      hasUntrackedFiles: untrackedEntryCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
      isMergedIntoBase,
      createdByRuntime,
    },
    warnings,
  };
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata?.config) ? metadata.config : null;
  if (!raw) return null;

  const config: ExecutionWorkspaceConfig = {
    environmentId: readNullableString(raw.environmentId),
    provisionCommand: readNullableString(raw.provisionCommand),
    teardownCommand: readNullableString(raw.teardownCommand),
    cleanupCommand: readNullableString(raw.cleanupCommand),
    workspaceRuntime: cloneRecord(raw.workspaceRuntime),
    desiredState: readDesiredState(raw.desiredState),
    serviceStates: readServiceStates(raw.serviceStates),
  };

  const hasConfig = Object.values(config).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  return hasConfig ? config : null;
}

export function mergeExecutionWorkspaceConfig(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<ExecutionWorkspaceConfig> | null,
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const current = readExecutionWorkspaceConfig(metadata) ?? {
    environmentId: null,
    provisionCommand: null,
    teardownCommand: null,
    cleanupCommand: null,
    workspaceRuntime: null,
    desiredState: null,
    serviceStates: null,
  };

  if (patch === null) {
    delete nextMetadata.config;
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  const nextConfig: ExecutionWorkspaceConfig = {
    environmentId: patch.environmentId !== undefined ? readNullableString(patch.environmentId) : current.environmentId,
    provisionCommand: patch.provisionCommand !== undefined ? readNullableString(patch.provisionCommand) : current.provisionCommand,
    teardownCommand: patch.teardownCommand !== undefined ? readNullableString(patch.teardownCommand) : current.teardownCommand,
    cleanupCommand: patch.cleanupCommand !== undefined ? readNullableString(patch.cleanupCommand) : current.cleanupCommand,
    workspaceRuntime: patch.workspaceRuntime !== undefined ? cloneRecord(patch.workspaceRuntime) : current.workspaceRuntime,
    desiredState:
      patch.desiredState !== undefined
        ? readDesiredState(patch.desiredState)
        : current.desiredState,
    serviceStates:
      patch.serviceStates !== undefined ? readServiceStates(patch.serviceStates) : current.serviceStates,
  };

  const hasConfig = Object.values(nextConfig).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  if (hasConfig) {
    nextMetadata.config = {
      environmentId: nextConfig.environmentId,
      provisionCommand: nextConfig.provisionCommand,
      teardownCommand: nextConfig.teardownCommand,
      cleanupCommand: nextConfig.cleanupCommand,
      workspaceRuntime: nextConfig.workspaceRuntime,
      desiredState: nextConfig.desiredState,
      serviceStates: nextConfig.serviceStates ?? null,
    };
  } else {
    delete nextMetadata.config;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    config: readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspaceSummary(
  row: Pick<ExecutionWorkspaceRow, "id" | "name" | "mode" | "status" | "cwd" | "branchName" | "projectWorkspaceId" | "lastUsedAt">,
): ExecutionWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as ExecutionWorkspaceSummary["mode"],
    status: row.status as ExecutionWorkspaceSummary["status"],
    cwd: row.cwd ?? null,
    branchName: row.branchName ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
  };
}

function maxDate(...values: Array<Date | string | null | undefined>): Date {
  let latest = new Date(0);
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function toWorkspaceOverviewPrimaryService(
  service: WorkspaceRuntimeService | null,
): WorkspaceOverviewPrimaryService | null {
  if (!service) return null;
  return {
    id: service.id,
    serviceName: service.serviceName,
    status: service.status,
    url: service.url,
    port: service.port,
    healthStatus: service.healthStatus,
    updatedAt: service.updatedAt,
  };
}

function selectPrimaryOverviewService(services: WorkspaceRuntimeService[]) {
  return services.find((service) => service.status === "running" && service.url)
    ?? services.find((service) => service.url)
    ?? services.find((service) => service.status === "running")
    ?? services[0]
    ?? null;
}

function usesInheritedProjectRuntimeServices(row: ExecutionWorkspaceRow) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

function noActiveRuntimeServicesForWorkspaceCondition(row: ExecutionWorkspaceRow) {
  const inheritedProjectWorkspaceId = usesInheritedProjectRuntimeServices(row) ? row.projectWorkspaceId : null;
  const activeServiceConditions = inheritedProjectWorkspaceId
    ? and(
        eq(workspaceRuntimeServices.companyId, row.companyId),
        eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
        ne(workspaceRuntimeServices.status, "stopped"),
      )
    : and(
        eq(workspaceRuntimeServices.companyId, row.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, row.id),
        ne(workspaceRuntimeServices.status, "stopped"),
      );
  return sql`not exists (select 1 from ${workspaceRuntimeServices} where ${activeServiceConditions})`;
}

async function loadEffectiveRuntimeServicesByExecutionWorkspace(
  db: RuntimeServiceReadDb,
  companyId: string,
  rows: ExecutionWorkspaceRow[],
) {
  const executionRuntimeServices = await listCurrentRuntimeServicesForExecutionWorkspaces(
    db,
    companyId,
    rows.map((row) => row.id),
  );
  const projectWorkspaceIds = rows
    .filter((row) => usesInheritedProjectRuntimeServices(row))
    .map((row) => row.projectWorkspaceId)
    .filter((value): value is string => Boolean(value));
  const projectRuntimeServices = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    companyId,
    [...new Set(projectWorkspaceIds)],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      usesInheritedProjectRuntimeServices(row)
        ? (projectRuntimeServices.get(row.projectWorkspaceId!) ?? [])
        : (executionRuntimeServices.get(row.id) ?? []),
    ]),
  );
}

type WorkspaceOverviewPageRow = ExecutionWorkspaceRow & {
  projectName: string;
  projectWorkspaceMetadata: Record<string, unknown> | null;
};

type WorkspaceOverviewIssueRow = WorkspaceOverviewLinkedIssue & {
  executionWorkspaceId: string;
};

export function executionWorkspaceService(db: Db) {
  const recoveryActionsSvc = issueRecoveryActionService(db);

  function buildListConditions(
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) {
    const conditions = [eq(executionWorkspaces.companyId, companyId)];
    if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
    if (filters?.projectWorkspaceId) {
      conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
    }
    if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
    if (filters?.status) {
      const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
      if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
      else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
    }
    if (filters?.reuseEligible) {
      conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      conditions.push(isNull(executionWorkspaces.closedAt));
      conditions.push(inArray(executionWorkspaces.mode, ["isolated_workspace", "operator_branch", "adapter_managed", "cloud_sandbox"]));
    }
    return conditions;
  }

  function buildOverviewConditions(companyId: string, filters: WorkspaceOverviewQuery) {
    const conditions = [eq(executionWorkspaces.companyId, companyId)];
    if (filters.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
    if (filters.status && filters.status.length > 0) {
      if (filters.status.length === 1) conditions.push(eq(executionWorkspaces.status, filters.status[0]!));
      else conditions.push(inArray(executionWorkspaces.status, filters.status));
    } else {
      conditions.push(ne(executionWorkspaces.status, "archived"));
    }
    return conditions;
  }

  return {
    listOverview: async (
      companyId: string,
      filters: WorkspaceOverviewQuery,
    ): Promise<WorkspaceOverviewResponse> => {
      const conditions = buildOverviewConditions(companyId, filters);
      const whereClause = and(...conditions);

      const [totalRow, rows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(executionWorkspaces)
          .innerJoin(
            projects,
            and(
              eq(projects.id, executionWorkspaces.projectId),
              eq(projects.companyId, companyId),
            ),
          )
          .where(whereClause)
          .then((result) => result[0] ?? { count: 0 }),
        db
          .select({
            id: executionWorkspaces.id,
            companyId: executionWorkspaces.companyId,
            projectId: executionWorkspaces.projectId,
            projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
            sourceIssueId: executionWorkspaces.sourceIssueId,
            mode: executionWorkspaces.mode,
            strategyType: executionWorkspaces.strategyType,
            name: executionWorkspaces.name,
            status: executionWorkspaces.status,
            cwd: executionWorkspaces.cwd,
            repoUrl: executionWorkspaces.repoUrl,
            baseRef: executionWorkspaces.baseRef,
            branchName: executionWorkspaces.branchName,
            providerType: executionWorkspaces.providerType,
            providerRef: executionWorkspaces.providerRef,
            derivedFromExecutionWorkspaceId: executionWorkspaces.derivedFromExecutionWorkspaceId,
            lastUsedAt: executionWorkspaces.lastUsedAt,
            openedAt: executionWorkspaces.openedAt,
            closedAt: executionWorkspaces.closedAt,
            cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
            cleanupReason: executionWorkspaces.cleanupReason,
            metadata: executionWorkspaces.metadata,
            createdAt: executionWorkspaces.createdAt,
            updatedAt: executionWorkspaces.updatedAt,
            projectName: projects.name,
            projectWorkspaceMetadata: projectWorkspaces.metadata,
          })
          .from(executionWorkspaces)
          .innerJoin(
            projects,
            and(
              eq(projects.id, executionWorkspaces.projectId),
              eq(projects.companyId, companyId),
            ),
          )
          .leftJoin(
            projectWorkspaces,
            and(
              eq(projectWorkspaces.id, executionWorkspaces.projectWorkspaceId),
              eq(projectWorkspaces.companyId, companyId),
            ),
          )
          .where(whereClause)
          .orderBy(
            desc(executionWorkspaces.lastUsedAt),
            desc(executionWorkspaces.updatedAt),
            asc(executionWorkspaces.id),
          )
          .limit(filters.limit)
          .offset(filters.offset),
      ]);

      const pageRows = rows as WorkspaceOverviewPageRow[];
      if (pageRows.length === 0) {
        return {
          items: [],
          total: totalRow.count,
          limit: filters.limit,
          offset: filters.offset,
          hasMore: false,
          nextOffset: null,
        };
      }

      const workspaceIds = pageRows.map((row) => row.id);
      const [runtimeServicesByWorkspaceId, linkedIssueCountRows, linkedIssueRows] = await Promise.all([
        loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, pageRows),
        db
          .select({
            executionWorkspaceId: issues.executionWorkspaceId,
            count: sql<number>`count(*)::int`,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              inArray(issues.executionWorkspaceId, workspaceIds),
            ),
          )
          .groupBy(issues.executionWorkspaceId),
        db.execute(sql`
          select
            ranked.execution_workspace_id as "executionWorkspaceId",
            ranked.id,
            ranked.identifier,
            ranked.title,
            ranked.status,
            ranked.priority,
            ranked.updated_at as "updatedAt"
          from (
            select
              ${issues.executionWorkspaceId} as execution_workspace_id,
              ${issues.id} as id,
              ${issues.identifier} as identifier,
              ${issues.title} as title,
              ${issues.status} as status,
              ${issues.priority} as priority,
              ${issues.updatedAt} as updated_at,
              row_number() over (
                partition by ${issues.executionWorkspaceId}
                order by ${issues.updatedAt} desc, ${issues.id} asc
              ) as row_number
            from ${issues}
            where ${issues.companyId} = ${companyId}
              and ${issues.hiddenAt} is null
              and ${issues.executionWorkspaceId} in (${sql.join(workspaceIds.map((id) => sql`${id}`), sql`, `)})
          ) ranked
          where ranked.row_number <= ${WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT}
          order by ranked.execution_workspace_id asc, ranked.row_number asc
        `),
      ]);

      const linkedIssueCountByWorkspaceId = new Map(
        linkedIssueCountRows
          .filter((row) => row.executionWorkspaceId)
          .map((row) => [row.executionWorkspaceId!, row.count]),
      );
      const linkedIssuesByWorkspaceId = new Map<string, WorkspaceOverviewLinkedIssue[]>();
      for (const issue of linkedIssueRows as unknown as WorkspaceOverviewIssueRow[]) {
        const existing = linkedIssuesByWorkspaceId.get(issue.executionWorkspaceId) ?? [];
        existing.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          updatedAt: issue.updatedAt,
        });
        linkedIssuesByWorkspaceId.set(issue.executionWorkspaceId, existing);
      }

      const items: WorkspaceOverviewItem[] = pageRows.map((row) => {
        const runtimeServices = (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService);
        const runningServiceCount = runtimeServices.filter((service) => service.status === "running").length;
        const primaryService = selectPrimaryOverviewService(runtimeServices);
        const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
        const inheritedProjectRuntimeConfig = usesInheritedProjectRuntimeServices(row)
          ? readProjectWorkspaceRuntimeConfig(row.projectWorkspaceMetadata)
          : null;
        const linkedIssues = linkedIssuesByWorkspaceId.get(row.id) ?? [];
        const primaryServiceSummary = toWorkspaceOverviewPrimaryService(primaryService);

        return {
          key: `execution:${row.id}`,
          kind: "execution_workspace",
          workspaceId: row.id,
          workspaceName: row.name,
          projectId: row.projectId,
          projectUrlKey: deriveProjectUrlKey(row.projectName, row.projectId),
          projectName: row.projectName,
          mode: row.mode as WorkspaceOverviewItem["mode"],
          strategyType: row.strategyType as WorkspaceOverviewItem["strategyType"],
          cwd: row.cwd ?? null,
          branchName: row.branchName ?? row.baseRef ?? null,
          lastUpdatedAt: maxDate(
            row.lastUsedAt,
            row.updatedAt,
            linkedIssues[0]?.updatedAt,
            primaryServiceSummary?.updatedAt,
          ),
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.id,
          executionWorkspaceStatus: row.status as WorkspaceOverviewItem["executionWorkspaceStatus"],
          serviceCount: runtimeServices.length,
          runningServiceCount,
          primaryServiceUrl: primaryService?.url ?? null,
          primaryServiceUrlRunning: primaryService?.status === "running",
          primaryService: primaryServiceSummary,
          hasRuntimeConfig: Boolean(config?.workspaceRuntime ?? inheritedProjectRuntimeConfig?.workspaceRuntime),
          linkedIssueCount: linkedIssueCountByWorkspaceId.get(row.id) ?? 0,
          linkedIssues,
        };
      });

      const nextOffset = filters.offset + items.length;
      const total = totalRow.count;
      return {
        items,
        total,
        limit: filters.limit,
        offset: filters.offset,
        hasMore: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
      };
    },

    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, rows);
      return rows.map((row) =>
        toExecutionWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    listSummaries: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select({
          id: executionWorkspaces.id,
          name: executionWorkspaces.name,
          mode: executionWorkspaces.mode,
          status: executionWorkspaces.status,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
          projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
          lastUsedAt: executionWorkspaces.lastUsedAt,
        })
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      return rows.map((row) => toExecutionWorkspaceSummary(row));
    },

    findGitWorktreeContention: async (input: {
      companyId: string;
      worktreePath: string;
      liveBranchName: string | null;
      excludingExecutionWorkspaceId?: string | null;
    }): Promise<ExecutionWorkspaceGitWorktreeContention> => {
      const resolvedWorktreePath = path.resolve(input.worktreePath);
      const pathOrBranchConditions = [
        eq(executionWorkspaces.providerRef, input.worktreePath),
        eq(executionWorkspaces.cwd, input.worktreePath),
      ];
      if (input.liveBranchName) {
        pathOrBranchConditions.push(eq(executionWorkspaces.branchName, input.liveBranchName));
      }

      const candidates = await db
        .select({
          id: executionWorkspaces.id,
          cwd: executionWorkspaces.cwd,
          providerRef: executionWorkspaces.providerRef,
          branchName: executionWorkspaces.branchName,
          sourceIssueId: executionWorkspaces.sourceIssueId,
          sourceIssueIdentifier: issues.identifier,
        })
        .from(executionWorkspaces)
        .leftJoin(
          issues,
          and(
            eq(issues.companyId, executionWorkspaces.companyId),
            eq(issues.id, executionWorkspaces.sourceIssueId),
          ),
        )
        .where(and(
          eq(executionWorkspaces.companyId, input.companyId),
          isNull(executionWorkspaces.closedAt),
          ne(executionWorkspaces.status, "archived"),
          input.excludingExecutionWorkspaceId
            ? ne(executionWorkspaces.id, input.excludingExecutionWorkspaceId)
            : sql`true`,
          or(...pathOrBranchConditions),
        ))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.updatedAt))
        .limit(20);

      for (const candidate of candidates) {
        const candidatePath = readNullableString(candidate.providerRef) ?? readNullableString(candidate.cwd);
        const matchesPath = candidatePath ? path.resolve(candidatePath) === resolvedWorktreePath : false;
        const matchesBranch = Boolean(input.liveBranchName && candidate.branchName === input.liveBranchName);
        if (!matchesPath && !matchesBranch) continue;

        const linkedIssueConditions = [eq(issues.executionWorkspaceId, candidate.id)];
        if (candidate.sourceIssueId) linkedIssueConditions.push(eq(issues.id, candidate.sourceIssueId));
        const linkedIssueRows = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, input.companyId),
            isNull(issues.hiddenAt),
            linkedIssueConditions.length === 1 ? linkedIssueConditions[0]! : or(...linkedIssueConditions),
          ))
          .orderBy(desc(issues.updatedAt))
          .limit(20);

        const runToIssue = new Map<string, { id: string; identifier: string | null }>();
        for (const issue of linkedIssueRows) {
          if (issue.executionRunId) runToIssue.set(issue.executionRunId, { id: issue.id, identifier: issue.identifier ?? null });
          if (issue.checkoutRunId) runToIssue.set(issue.checkoutRunId, { id: issue.id, identifier: issue.identifier ?? null });
        }

        let activeRun: NonNullable<ExecutionWorkspaceGitWorktreeContention>["activeRun"] = null;
        const runIds = [...runToIssue.keys()];
        if (runIds.length > 0) {
          const [row] = await db
            .select({
              id: heartbeatRuns.id,
              status: heartbeatRuns.status,
            })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, input.companyId),
              inArray(heartbeatRuns.id, runIds),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ))
            .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.createdAt))
            .limit(1);
          if (row && (row.status === "queued" || row.status === "running")) {
            const issue = runToIssue.get(row.id) ?? null;
            activeRun = {
              id: row.id,
              status: row.status,
              issueId: issue?.id ?? null,
              issueIdentifier: issue?.identifier ?? null,
            };
          }
        }

        const claimedIssue =
          linkedIssueRows.find((issue) => issue.id === candidate.sourceIssueId)
          ?? linkedIssueRows[0]
          ?? null;

        return {
          claimedByWorkspaceId: candidate.id,
          claimedByIssueId: claimedIssue?.id ?? candidate.sourceIssueId ?? null,
          claimedByIssueIdentifier:
            claimedIssue?.identifier ?? candidate.sourceIssueIdentifier ?? null,
          activeRun,
        };
      }

      return null;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, row.companyId, [row]);
      return toExecutionWorkspace(
        row,
        (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
      );
    },

    getCloseReadiness: async (id: string): Promise<ExecutionWorkspaceCloseReadiness | null> => {
      const workspace = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!workspace) return null;

      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, workspace.companyId, [workspace]);
      const runtimeServices = (runtimeServicesByWorkspaceId.get(workspace.id) ?? []).map(toRuntimeService);

      const linkedIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, workspace.companyId), eq(issues.executionWorkspaceId, workspace.id)));

      const projectWorkspace = workspace.projectWorkspaceId
        ? await db
            .select({
              id: projectWorkspaces.id,
              cwd: projectWorkspaces.cwd,
              cleanupCommand: projectWorkspaces.cleanupCommand,
              isPrimary: projectWorkspaces.isPrimary,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.id, workspace.projectWorkspaceId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const primaryProjectWorkspace = workspace.projectId
        ? await db
            .select({
              id: projectWorkspaces.id,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.projectId, workspace.projectId),
                eq(projectWorkspaces.isPrimary, true),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const projectPolicy = workspace.projectId
        ? await db
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
        : null;

      const executionWorkspace = toExecutionWorkspace(workspace, runtimeServices);
      const config = readExecutionWorkspaceConfig((workspace.metadata as Record<string, unknown> | null) ?? null);
      const { git, warnings: gitWarnings } = await inspectGitCloseReadiness(executionWorkspace);
      const warnings = [...gitWarnings];
      const blockingReasons: string[] = [];
      const isSharedWorkspace = executionWorkspace.mode === "shared_workspace";
      const workspacePath = readNullableString(executionWorkspace.providerRef) ?? readNullableString(executionWorkspace.cwd);
      const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : null;
      const resolvedPrimaryWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
      const isProjectPrimaryWorkspace =
        workspace.projectWorkspaceId != null
        && workspace.projectWorkspaceId === primaryProjectWorkspace?.id
        && resolvedWorkspacePath != null
        && resolvedPrimaryWorkspacePath != null
        && resolvedWorkspacePath === resolvedPrimaryWorkspacePath;

      const linkedIssueSummaries = linkedIssues.map((issue) => ({
        ...issue,
        isTerminal: TERMINAL_ISSUE_STATUSES.has(issue.status),
      }));

      const blockingIssues = linkedIssueSummaries.filter((issue) => !issue.isTerminal);
      if (blockingIssues.length > 0) {
        const linkedIssueMessage =
          blockingIssues.length === 1
            ? "This workspace is still linked to an open issue."
            : `This workspace is still linked to ${blockingIssues.length} open issues.`;
        if (isSharedWorkspace) {
          warnings.push(`${linkedIssueMessage} Archiving it will detach this shared workspace session from those issues, but keep the underlying project workspace available.`);
        } else {
          blockingReasons.push(linkedIssueMessage);
        }
      }

      if (isSharedWorkspace) {
        warnings.push("This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.");
      }

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        warnings.push(
          runtimeServices.length === 1
            ? "Closing this workspace will stop 1 attached runtime service."
            : `Closing this workspace will stop ${runtimeServices.length} attached runtime services.`,
        );
      }

      if (git?.hasDirtyTrackedFiles) {
        warnings.push(
          git.dirtyEntryCount === 1
            ? "The workspace has 1 modified tracked file."
            : `The workspace has ${git.dirtyEntryCount} modified tracked files.`,
        );
      }
      if (git?.hasUntrackedFiles) {
        warnings.push(
          git.untrackedEntryCount === 1
            ? "The workspace has 1 untracked file."
            : `The workspace has ${git.untrackedEntryCount} untracked files.`,
        );
      }
      if (git?.aheadCount && git.aheadCount > 0 && git.isMergedIntoBase === false) {
        warnings.push(
          git.aheadCount === 1
            ? `This workspace is 1 commit ahead of ${git.baseRef ?? "the base ref"} and is not merged.`
            : `This workspace is ${git.aheadCount} commits ahead of ${git.baseRef ?? "the base ref"} and is not merged.`,
        );
      }
      if (git?.behindCount && git.behindCount > 0) {
        warnings.push(
          git.behindCount === 1
            ? `This workspace is 1 commit behind ${git.baseRef ?? "the base ref"}.`
            : `This workspace is ${git.behindCount} commits behind ${git.baseRef ?? "the base ref"}.`,
        );
      }

      const plannedActions: ExecutionWorkspaceCloseAction[] = [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Keep the execution workspace history and issue linkage, but remove it from active workspace lists.",
          command: null,
        },
      ];

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        plannedActions.push({
          kind: "stop_runtime_services",
          label: runtimeServices.length === 1 ? "Stop attached runtime service" : "Stop attached runtime services",
          description:
            runtimeServices.length === 1
              ? `${runtimeServices[0]?.serviceName ?? "A runtime service"} will be stopped before cleanup.`
              : `${runtimeServices.length} runtime services will be stopped before cleanup.`,
          command: null,
        });
      }

      const configuredCleanupCommands = [
        {
          kind: "cleanup_command" as const,
          label: "Run workspace cleanup command",
          description: "Workspace-specific cleanup runs before teardown.",
          command: config?.cleanupCommand ?? null,
        },
        {
          kind: "cleanup_command" as const,
          label: "Run project workspace cleanup command",
          description: "Project workspace cleanup runs before execution workspace teardown.",
          command: projectWorkspace?.cleanupCommand ?? null,
        },
      ];
      for (const action of configuredCleanupCommands) {
        if (!action.command) continue;
        plannedActions.push(action);
      }

      const teardownCommand = config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null;
      if (teardownCommand) {
        plannedActions.push({
          kind: "teardown_command",
          label: "Run teardown command",
          description: "Teardown runs after cleanup commands during workspace close.",
          command: teardownCommand,
        });
      }

      if (executionWorkspace.providerType === "git_worktree" && workspacePath) {
        plannedActions.push({
          kind: "git_worktree_remove",
          label: "Remove git worktree",
          description: `Paperclip will run git worktree cleanup for ${workspacePath}.`,
          command: `git worktree remove --force ${workspacePath}`,
        });
      }

      if (git?.createdByRuntime && executionWorkspace.branchName) {
        plannedActions.push({
          kind: "git_branch_delete",
          label: "Delete runtime-created branch",
          description: "Paperclip will try to delete the runtime-created branch after removing the worktree.",
          command: `git branch -d ${executionWorkspace.branchName}`,
        });
      }

      if (executionWorkspace.providerType === "local_fs" && git?.createdByRuntime && workspacePath) {
        const resolvedWorkspacePath = path.resolve(workspacePath);
        const resolvedProjectWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
        const containsProjectWorkspace = resolvedProjectWorkspacePath
          ? (
              resolvedWorkspacePath === resolvedProjectWorkspacePath ||
              resolvedProjectWorkspacePath.startsWith(`${resolvedWorkspacePath}${path.sep}`)
            )
          : false;
        if (containsProjectWorkspace) {
          warnings.push(`Paperclip will archive this workspace but keep "${workspacePath}" because it contains the project workspace.`);
        } else {
          plannedActions.push({
            kind: "remove_local_directory",
            label: "Remove runtime-created directory",
            description: `Paperclip will remove the runtime-created directory at ${workspacePath}.`,
            command: `rm -rf ${workspacePath}`,
          });
        }
      }

      const state =
        blockingReasons.length > 0
          ? "blocked"
          : warnings.length > 0
            ? "ready_with_warnings"
            : "ready";

      return {
        workspaceId: workspace.id,
        state,
        blockingReasons,
        warnings,
        linkedIssues: linkedIssueSummaries,
        plannedActions,
        isDestructiveCloseAllowed: blockingReasons.length === 0,
        isSharedWorkspace,
        isProjectPrimaryWorkspace,
        git,
        runtimeServices,
      };
    },

    create: async (data: typeof executionWorkspaces.$inferInsert) => {
      const row = await db
        .insert(executionWorkspaces)
        .values(data)
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    update: async (id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) => {
      const row = await db
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    reconcileExecutionWorkspaceBranch: async (
      id: string,
      input: {
        mode: ExecutionWorkspaceBranchReconcileMode;
        reason?: string | null;
        actor: ExecutionWorkspaceBranchReconcileActor;
        alternateRecoveryFingerprints?: string[] | null;
      },
    ): Promise<ExecutionWorkspaceBranchReconcileResult> => {
      const existingRow = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingRow) throw notFound("Execution workspace not found");

      const existing = toExecutionWorkspace(existingRow);
      if (!existing.sourceIssueId) {
        throw unprocessable("Execution workspace needs a source issue before Paperclip can audit branch reconciliation");
      }

      const inspection = await inspectExecutionWorkspaceBranchForReconcile(existing);
      if (input.mode === "forward" && inspection.ancestryVerdict !== "ancestor") {
        throw unprocessable(
          "Forward branch reconciliation requires the recorded branch to be an ancestor of the checked-out branch",
          { inspection },
        );
      }

      const reason = readNullableString(input.reason);
      const rescueRef = input.mode === "quarantine_restore"
        ? await (async () => {
            const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
              db,
              existing.companyId,
              [existingRow],
            );
            assertBranchReconcileRuntimeServicesStopped({
              inspection,
              runtimeServices: (runtimeServicesByWorkspaceId.get(existing.id) ?? []).map(toRuntimeService),
            });
            // The git rescue has to happen before the DB transaction because the
            // transaction may be retried/rolled back, while git side effects cannot.
            // The preflight runtime-service guard above keeps known local services
            // from holding files open during the non-transactional git sequence.
            return quarantineRestoreDirtyWorkspaceBranch({
              db,
              workspace: existing,
              inspection,
              actor: input.actor,
            });
          })()
        : null;
      const now = new Date();
      const allowActiveWorkspace =
        input.mode === "forward" &&
        input.actor.actorType === "system" &&
        input.actor.actorId === "workspace_runtime" &&
        Boolean(input.actor.runId);
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Runtime-service activation takes this same row lock before spawning
        // local services and persists a `starting` row before releasing it.
        const lockedRow = await tx
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, existing.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedRow) throw notFound("Execution workspace not found");

        assertLockedBranchReconcileWorkspaceStillMatchesInspection({
          lockedRow,
          inspectedRow: existingRow,
          inspection,
        });

        if (usesInheritedProjectRuntimeServices(lockedRow)) {
          await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, lockedRow.companyId),
                eq(projectWorkspaces.id, lockedRow.projectWorkspaceId!),
              ),
            )
            .for("update");
        }

        await tx
          .select({ id: workspaceRuntimeServices.id })
          .from(workspaceRuntimeServices)
          .where(
            usesInheritedProjectRuntimeServices(lockedRow)
              ? and(
                  eq(workspaceRuntimeServices.companyId, lockedRow.companyId),
                  eq(workspaceRuntimeServices.projectWorkspaceId, lockedRow.projectWorkspaceId!),
                  eq(workspaceRuntimeServices.scopeType, "project_workspace"),
                )
              : and(
                  eq(workspaceRuntimeServices.companyId, lockedRow.companyId),
                  eq(workspaceRuntimeServices.executionWorkspaceId, lockedRow.id),
                ),
          )
          .for("update");

        const lockedRuntimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
          txDb,
          lockedRow.companyId,
          [lockedRow],
        );
        const lockedRuntimeServices = (lockedRuntimeServicesByWorkspaceId.get(lockedRow.id) ?? []).map(toRuntimeService);
        const lockedWorkspace = toExecutionWorkspace(lockedRow, lockedRuntimeServices);
        if (!lockedWorkspace.sourceIssueId) {
          throw unprocessable("Execution workspace needs a source issue before Paperclip can audit branch reconciliation");
        }

        let updatedRow: ExecutionWorkspaceRow = lockedRow;
        if (input.mode !== "quarantine_restore") {
          assertBranchReconcileWorkspaceIsSafe({
            workspaceStatus: lockedWorkspace.status,
            inspection,
            runtimeServices: lockedRuntimeServices,
            allowActiveWorkspace,
          });
          if (lockedWorkspace.branchName !== inspection.fromBranch) {
            throw unprocessable("Execution workspace branch changed during reconciliation; retry with a fresh inspection", {
              workspaceBranch: lockedWorkspace.branchName,
              inspection,
            });
          }

          const updatePatch: Partial<typeof executionWorkspaces.$inferInsert> = {
            branchName: inspection.toBranch,
            updatedAt: now,
          };
          if (lockedWorkspace.name === inspection.fromBranch) {
            updatePatch.name = inspection.toBranch;
          }

          const [branchUpdatedRow] = await tx
            .update(executionWorkspaces)
            .set(updatePatch)
            .where(
              and(
                eq(executionWorkspaces.id, lockedWorkspace.id),
                allowActiveWorkspace
                  ? inArray(executionWorkspaces.status, ["idle", "active"])
                  : eq(executionWorkspaces.status, "idle"),
                eq(executionWorkspaces.branchName, inspection.fromBranch),
                noActiveRuntimeServicesForWorkspaceCondition(lockedRow),
              ),
            )
            .returning();
          if (!branchUpdatedRow) {
            const latestRuntimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(
              txDb,
              lockedRow.companyId,
              [lockedRow],
            );
            const latestRuntimeServices = (latestRuntimeServicesByWorkspaceId.get(lockedRow.id) ?? []).map(toRuntimeService);
            assertBranchReconcileWorkspaceIsSafe({
              workspaceStatus: lockedWorkspace.status,
              inspection,
              runtimeServices: latestRuntimeServices,
              allowActiveWorkspace,
            });
            throw unprocessable("Execution workspace branch reconciliation requires the workspace to stay idle with stopped runtime services during the update", {
              inspection,
            });
          }
          updatedRow = branchUpdatedRow;
        }

        let recoveryAction = await recoveryActionsSvc.resolveActiveForIssue(
          {
            companyId: lockedWorkspace.companyId,
            sourceIssueId: lockedWorkspace.sourceIssueId,
            kind: "workspace_validation",
            cause: WORKSPACE_VALIDATION_RECOVERY_CAUSE,
            fingerprint: inspection.fingerprint,
            status: "resolved",
            outcome: "restored",
            resolutionNote: input.mode === "quarantine_restore" && rescueRef
              ? `Execution workspace dirty worktree quarantined on "${rescueRef.branchName}" and restored recorded branch "${inspection.fromBranch}".`
              : `Execution workspace branch record reconciled from "${inspection.fromBranch}" to "${inspection.toBranch}".`,
          },
          tx,
        );
        if (!recoveryAction) {
          for (const alternateFingerprint of input.alternateRecoveryFingerprints ?? []) {
            if (!alternateFingerprint || alternateFingerprint === inspection.fingerprint) continue;
            recoveryAction = await recoveryActionsSvc.resolveActiveForIssue(
              {
                companyId: existing.companyId,
                sourceIssueId: existing.sourceIssueId!,
                kind: "workspace_validation",
                cause: WORKSPACE_VALIDATION_RECOVERY_CAUSE,
                fingerprint: alternateFingerprint,
                status: "resolved",
                outcome: "restored",
                resolutionNote: input.mode === "quarantine_restore" && rescueRef
                  ? `Execution workspace dirty worktree quarantined on "${rescueRef.branchName}" and restored recorded branch "${inspection.fromBranch}".`
                  : `Execution workspace branch record reconciled from "${inspection.fromBranch}" to "${inspection.toBranch}".`,
              },
              tx,
            );
            if (recoveryAction) break;
          }
        }

        let restoredSourceIssue: ExecutionWorkspaceBranchReconcileResult["restoredSourceIssue"] = null;
        let sourceIssueStatusChanged = false;
        if (input.mode === "quarantine_restore") {
          const [sourceBefore] = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
              executionPolicy: issues.executionPolicy,
              executionState: issues.executionState,
              monitorNextCheckAt: issues.monitorNextCheckAt,
              monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
              monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
              monitorAttemptCount: issues.monitorAttemptCount,
              monitorNotes: issues.monitorNotes,
              monitorScheduledBy: issues.monitorScheduledBy,
            })
            .from(issues)
            .where(eq(issues.id, lockedWorkspace.sourceIssueId))
            .for("update");
          if (!sourceBefore) throw notFound("Source issue not found");

          const requestedStatus = quarantineRestoreRequestedSourceStatus(sourceBefore);
          const policy = normalizeIssueExecutionPolicy(sourceBefore.executionPolicy ?? null);
          const transition = applyIssueExecutionPolicyTransition({
            issue: sourceBefore,
            policy,
            previousPolicy: policy,
            requestedStatus,
            requestedAssigneePatch: {},
            actor: {
              agentId: input.actor.agentId ?? null,
              userId: input.actor.actorType === "user" ? input.actor.actorId : null,
            },
            commentBody: null,
          });
          const { issueService } = await import("./issues.js");
          const updatedIssue = await issueService(db).update(
            lockedWorkspace.sourceIssueId,
            {
              ...(requestedStatus ? { status: requestedStatus } : {}),
              ...transition.patch,
              actorAgentId: input.actor.agentId ?? null,
              actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
            },
            tx,
          );
          if (!updatedIssue) throw notFound("Source issue not found");
          restoredSourceIssue = {
            id: updatedIssue.id,
            companyId: updatedIssue.companyId,
            status: updatedIssue.status,
            assigneeAgentId: updatedIssue.assigneeAgentId,
          };
          sourceIssueStatusChanged = sourceBefore.status !== updatedIssue.status;
        }

        const [auditComment] = await tx
          .insert(issueComments)
          .values({
            companyId: lockedWorkspace.companyId,
            issueId: lockedWorkspace.sourceIssueId,
            authorAgentId: input.actor.actorType === "agent" ? input.actor.agentId : null,
            authorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
            authorType: input.actor.actorType,
            createdByRunId: input.actor.runId,
            body: formatBranchReconcileAuditComment({
              mode: input.mode,
              reason,
              workspaceId: existing.id,
              inspection,
              recoveryActionId: recoveryAction?.id ?? null,
              rescueRef,
            }),
          })
          .returning({ id: issueComments.id });

        await tx
          .update(issues)
          .set({ updatedAt: now })
          .where(eq(issues.id, lockedWorkspace.sourceIssueId));

        return {
          workspace: toExecutionWorkspace(updatedRow, lockedRuntimeServices),
          inspection,
          recoveryAction,
          auditCommentId: auditComment?.id ?? null,
          rescueRef,
          restoredSourceIssue,
          sourceIssueStatusChanged,
        };
      });
    },

    clearEnvironmentSelection: async (companyId: string, environmentId: string) => {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: executionWorkspaces.id,
            metadata: executionWorkspaces.metadata,
          })
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.companyId, companyId));

        let cleared = 0;
        const updatedAt = new Date();
        for (const row of rows) {
          const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
          const config = readExecutionWorkspaceConfig(metadata);
          if (config?.environmentId !== environmentId) continue;

          await tx
            .update(executionWorkspaces)
            .set({
              metadata: mergeExecutionWorkspaceConfig(metadata, { environmentId: null }),
              updatedAt,
            })
            .where(eq(executionWorkspaces.id, row.id));
          cleared += 1;
        }

        return cleared;
      });
    },
  };
}

export { toExecutionWorkspace };
