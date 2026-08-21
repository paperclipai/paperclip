import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  projects,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceDeliveryState,
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
import { logger } from "../middleware/logger.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { logActivity } from "./activity-log.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
  setBoundedPullRequestCacheEntry,
  type GitHubPullRequestReference,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";
import {
  listCurrentRuntimeServicesForExecutionWorkspaces,
  listCurrentRuntimeServicesForProjectWorkspaces,
  selectConfiguredRuntimeServiceRows,
} from "./workspace-runtime-read-model.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeServiceReadDb = Pick<Db, "select">;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const execFileAsync = promisify(execFile);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

// Return the timestamp when an issue became terminal. A `done` issue uses
// `completedAt`. A `cancelled` issue uses `cancelledAt`. The reaper cooldown
// measures the age of the terminal transition from this timestamp. Fall back to
// `updatedAt` when the terminal timestamp is null, so an old issue that lacks a
// recorded transition time still gates the cooldown. Return null for a
// non-terminal issue.
function issueTerminalTimestamp(issue: {
  status: string;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}): Date | null {
  if (issue.status === "done") return issue.completedAt ?? issue.updatedAt;
  if (issue.status === "cancelled") return issue.cancelledAt ?? issue.updatedAt;
  return null;
}

const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const WORKSPACE_VALIDATION_RECOVERY_CAUSE = "workspace_validation_failed";
export const ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON = "issue_terminal";

// The reopen-failure reason kept on the row when a rebuild does not finish. The
// value is sanitized: it never contains a repository URL, a host path, or git
// output.
export const EXECUTION_WORKSPACE_REOPEN_FAILED_REASON = "reopen_failed";

// How long the terminal reaper waits before it reclaims a stranded reopen-pending
// flag. A reopen sets the flag while the source issue is still terminal. The
// consuming request clears the flag within seconds when the request ends. If the
// server exits first, or every clear retry fails, the flag stays set and both the
// reaper and the archive route skip the workspace forever. After this grace the
// reaper reclaims the flag, but only when no run still owns it. The reaper checks
// for a live consuming run first, so a request that outruns this grace keeps its
// fence. A run has a heartbeat row the reaper can see. An HTTP consuming request
// has none, so the route re-stamps the flag on an interval below this grace, and
// the fresh timestamp keeps the fence. The grace is a backstop for a flag whose
// consumer is gone, not a hard deadline on the request.
export const STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS = 5 * 60 * 1000;

// The metadata key that holds the workspace lifecycle generation. The generation
// is a monotonic integer. Every archive and every reopen increases it by one. A
// destructive cleanup captures the generation it archived at, then re-reads the
// generation under the lifecycle lock immediately before it deletes the worktree.
// A reopen that ran in between raises the generation, so the stale cleanup finds
// a mismatch and does nothing. This fences a queued or in-flight cleanup against
// a workspace that a reopen already restored.
export const EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY = "lifecycleGeneration";

export function readExecutionWorkspaceLifecycleGeneration(
  metadata: Record<string, unknown> | null | undefined,
): number {
  const raw = metadata?.[EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

// Return a metadata object with the lifecycle generation increased by one. The
// caller keeps every other metadata key.
export function bumpExecutionWorkspaceLifecycleGeneration(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]:
      readExecutionWorkspaceLifecycleGeneration(metadata) + 1,
  };
}

function isClosedExecutionWorkspaceStatus(status: string | null | undefined): boolean {
  return status === "archived" || status === "cleanup_failed";
}

// The metadata key that marks a workspace as reopened for a source issue that is
// still terminal. A reopen sets this flag in the same write that publishes the
// row as active. The source issue is still terminal at that moment, because the
// route changes the issue out of the terminal state only after the reopen
// returns. Both destructive paths (the terminal reaper and the archive route)
// exclude a flagged workspace, so neither one archives and destroys a worktree
// that a reopen rebuilt while the caller has not yet consumed it. The reaper
// clears the flag on a later pass once the source issue leaves the terminal
// state, so a normal terminal cycle can reap the workspace again.
export const EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY = "reopenPendingConsumption";

// The metadata key that holds the time a reopen set the reopen-pending flag. The
// terminal reaper reads this timestamp to tell a fresh, in-flight reopen from a
// stranded flag whose consumer never cleared it. A reopen writes this key in the
// same write that sets the flag, and every clear removes both keys together.
export const EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY = "reopenPendingConsumptionSince";

export function metadataHasReopenPendingConsumption(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.[EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY] === true;
}

// Read the time a reopen set the reopen-pending flag. Return null when the flag
// carries no valid timestamp. The terminal reaper uses this to tell a fresh,
// in-flight reopen from a stranded flag whose consumer never cleared it.
export function readMetadataReopenPendingConsumptionSince(
  metadata: Record<string, unknown> | null | undefined,
): Date | null {
  const raw = metadata?.[EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY];
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Return a metadata object with the reopen-pending flag set. The caller keeps
// every other metadata key. The `at` timestamp records when the reopen set the
// flag, so the terminal reaper can reclaim a stranded flag after a grace period.
export function setMetadataReopenPendingConsumption(
  metadata: Record<string, unknown> | null | undefined,
  at: Date,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
    [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: at.toISOString(),
  };
}

// Return a metadata object with the reopen-pending flag removed. The caller
// keeps every other metadata key. The function removes the flag and its
// timestamp together, so no orphan timestamp survives a clear.
export function clearMetadataReopenPendingConsumption(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY];
  delete next[EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY];
  return next;
}

// Acquire the per-workspace, transaction-scoped Postgres advisory lock. Postgres
// releases the lock when the transaction that holds `tx` commits or rolls back.
// Both the reopen path and the destructive cleanup path acquire the same lock,
// so they never run against the same workspace at the same time, even on
// different server processes.
async function acquireExecutionWorkspaceLifecycleLock(
  tx: DbTransaction,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`,
  );
}

export type ReopenClosedIsolatedExecutionWorkspaceResult =
  // `generation` is the lifecycle generation the reopen published the active row
  // at. It owns the reopen-pending flag. A later clear must present this same
  // generation, so a stale actor never clears a newer reopen's fence.
  | { ok: true; workspace: ExecutionWorkspace; reopened: true; generation: number }
  | { ok: true; workspace: ExecutionWorkspace; reopened: false; generation: number }
  | { ok: false; code: "not_reopenable" | "rebuild_failed"; message: string };

export type ExecutionWorkspaceServiceOptions = {
  resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
  now?: () => Date;
  beforeTerminalWorkspaceCleanup?: (workspace: ExecutionWorkspaceRow) => Promise<void>;
  // The terminal-workspace reaper waits this many days after an issue tree
  // becomes terminal before it archives the workspace. A value of 0 disables
  // the cooldown. The default is 7 days.
  workspaceReaperCooldownDays?: number;
  inspectGitCloseReadiness?: (workspace: ExecutionWorkspace) => Promise<{
    git: ExecutionWorkspaceCloseGitReadiness | null;
    warnings: string[];
  }>;
};

function parseGitHubRepository(repoUrl: string | null) {
  if (!repoUrl) return null;
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() };
}

function pullRequestMatchesWorkspaceRepository(
  reference: GitHubPullRequestReference,
  workspace: Pick<ExecutionWorkspaceRow, "repoUrl">,
) {
  const repository = parseGitHubRepository(workspace.repoUrl);
  return Boolean(
    repository
    && repository.owner === reference.owner.toLowerCase()
    && repository.repo === reference.repo.toLowerCase(),
  );
}

export function deriveExecutionWorkspaceDeliveryState(input: {
  sourceIssueTerminal: boolean;
  mergedPullRequest: boolean;
  pullRequestStateUnknown: boolean;
  isMergedIntoBase: boolean | null;
}): ExecutionWorkspaceDeliveryState {
  if (input.sourceIssueTerminal && input.mergedPullRequest) return "merged_via_pr";
  if (input.isMergedIntoBase === true) return "merged_by_ancestry";
  if (input.isMergedIntoBase === false && !input.pullRequestStateUnknown) return "unmerged";
  return "unknown";
}

export type ExecutionWorkspaceBranchReconcileMode = "forward" | "override" | "quarantine_restore";

export type ExecutionWorkspaceBranchReconcileActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

export type ExecutionWorkspaceBranchRefResolution = "resolved" | "missing" | "error";

export type ExecutionWorkspaceBranchReconcileInspection = {
  fingerprint: string;
  worktreePath: string;
  repoRoot: string;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  fromBranchRefStatus: ExecutionWorkspaceBranchRefResolution;
  toBranchRefStatus: ExecutionWorkspaceBranchRefResolution;
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

async function runExpensiveGitStatus(input: {
  args: readonly string[];
  cwd: string;
  operation: string;
  fairnessKeys?: readonly string[];
}) {
  return workspaceGitOperationScheduler.run({
    workspacePath: input.cwd,
    args: input.args,
    operation: input.operation,
    fairnessKeys: input.fairnessKeys,
    cacheTtlMs: 0,
  });
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

async function resolveLocalBranchCommit(
  repoRoot: string,
  branch: string,
): Promise<{ status: ExecutionWorkspaceBranchRefResolution; sha: string | null }> {
  try {
    // --quiet makes an absent ref exit 1 with empty output instead of exiting
    // 128 with a fatal message, so a missing branch stays distinguishable from
    // git failing to inspect the repository at all.
    const sha = await readGitStdout(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repoRoot);
    return sha ? { status: "resolved", sha } : { status: "missing", sha: null };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    return { status: code === 1 ? "missing" : "error", sha: null };
  }
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

  const status = await runExpensiveGitStatus({
    args: ["status", "--porcelain", "--untracked-files=all"],
    cwd: worktreePath,
    operation: "execution_workspaces.branch_reconcile_status",
    fairnessKeys: [
      `workspace:${workspace.id}`,
      ...(workspace.sourceIssueId ? [`issue:${workspace.sourceIssueId}`] : []),
    ],
  })
    .then((output) => output.stdout)
    .catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanliness: ExecutionWorkspaceBranchReconcileInspection["cleanliness"] =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";

  const fromRef = await resolveLocalBranchCommit(repoRoot, fromBranch);
  const toRef = await resolveLocalBranchCommit(repoRoot, toBranch);
  const fromSha = fromRef.sha;
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
    fromBranchRefStatus: fromRef.status,
    toBranchRefStatus: toRef.status,
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
  statusInspectionSucceeded: boolean;
}> {
  const warnings: string[] = [];
  const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  const createdByRuntime = workspace.metadata?.createdByRuntime === true;
  const expectsGitInspection =
    workspace.providerType === "git_worktree" ||
    Boolean(workspace.repoUrl || workspace.baseRef || workspace.branchName || workspacePath);

  if (!expectsGitInspection) {
    return { git: null, warnings, statusInspectionSucceeded: true };
  }

  if (!workspacePath) {
    warnings.push("Workspace has no local path, so Paperclip cannot inspect git status before close.");
    return { git: null, warnings, statusInspectionSucceeded: false };
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
      statusInspectionSucceeded: true,
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
  let statusInspectionSucceeded = false;
  if (repoRoot) {
    try {
      const statusOutput = (await runExpensiveGitStatus({
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: workspacePath,
        operation: "execution_workspaces.close_readiness_status",
        fairnessKeys: [
          `company:${workspace.companyId}`,
          `workspace:${workspace.id}`,
          ...(workspace.sourceIssueId ? [`issue:${workspace.sourceIssueId}`] : []),
        ],
      })).stdout;
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) {
          untrackedEntryCount += 1;
          continue;
        }
        dirtyEntryCount += 1;
      }
      statusInspectionSucceeded = true;
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
    statusInspectionSucceeded,
  };
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata?.config) ? metadata.config : null;
  if (!raw) return null;

  const config: ExecutionWorkspaceConfig = {
    environmentId: readNullableString(raw.environmentId),
    provisionCommand: readNullableString(raw.provisionCommand),
    runtimeProvisionCommand: readNullableString(raw.runtimeProvisionCommand),
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
    runtimeProvisionCommand: null,
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
    runtimeProvisionCommand:
      patch.runtimeProvisionCommand !== undefined
        ? readNullableString(patch.runtimeProvisionCommand)
        : current.runtimeProvisionCommand,
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
      runtimeProvisionCommand: nextConfig.runtimeProvisionCommand,
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

function toRuntimeService(
  row: WorkspaceRuntimeServiceRow & { configIndex?: number | null },
): WorkspaceRuntimeService {
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
    exposure: (row.exposure as WorkspaceRuntimeService["exposure"]) ?? null,
    configIndex: row.configIndex ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
  deliveryState: ExecutionWorkspaceDeliveryState = "unknown",
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
    deliveryState,
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
    exposure: service.exposure ?? null,
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
        or(
          and(
            eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
            eq(workspaceRuntimeServices.scopeType, "project_workspace"),
          ),
          eq(workspaceRuntimeServices.executionWorkspaceId, row.id),
        ),
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
  const inheritedRows = rows.filter((row) => usesInheritedProjectRuntimeServices(row));
  const projectWorkspaceIds = inheritedRows
    .map((row) => row.projectWorkspaceId)
    .filter((value): value is string => Boolean(value));
  const uniqueProjectWorkspaceIds = [...new Set(projectWorkspaceIds)];
  const [executionRuntimeServices, projectRuntimeServices, projectWorkspaceRows] = await Promise.all([
    listCurrentRuntimeServicesForExecutionWorkspaces(
      db,
      companyId,
      rows.map((row) => row.id),
    ),
    listCurrentRuntimeServicesForProjectWorkspaces(
      db,
      companyId,
      uniqueProjectWorkspaceIds,
    ),
    uniqueProjectWorkspaceIds.length > 0
      ? db
          .select({
            id: projectWorkspaces.id,
            metadata: projectWorkspaces.metadata,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, companyId),
              inArray(projectWorkspaces.id, uniqueProjectWorkspaceIds),
            ),
          )
      : Promise.resolve([]),
  ]);
  const projectRuntimeConfigByWorkspaceId = new Map(
    projectWorkspaceRows.map((row) => [
      row.id,
      readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime
        ?? null,
    ]),
  );
  const effectiveProjectRuntimeServices = new Map(
    uniqueProjectWorkspaceIds.map((projectWorkspaceId) => [
      projectWorkspaceId,
      selectConfiguredRuntimeServiceRows(
        projectRuntimeServices.get(projectWorkspaceId) ?? [],
        projectRuntimeConfigByWorkspaceId.get(projectWorkspaceId) ?? null,
      ),
    ]),
  );

  return new Map(
    rows.map((row) => {
      if (!usesInheritedProjectRuntimeServices(row)) {
        const runtimeServiceRows = executionRuntimeServices.get(row.id) ?? [];
        const workspaceRuntime = readExecutionWorkspaceConfig(
          (row.metadata as Record<string, unknown> | null) ?? null,
        )?.workspaceRuntime ?? null;
        return [
          row.id,
          workspaceRuntime
            ? selectConfiguredRuntimeServiceRows(runtimeServiceRows, workspaceRuntime, {
                // Runtime rows created before shared services defaulted to project-workspace
                // scope remain valid for configs owned directly by an execution workspace.
                fallbackScopeTypes: ["execution_workspace"],
              })
            : runtimeServiceRows,
        ] as const;
      }

      const workspaceRuntime = projectRuntimeConfigByWorkspaceId.get(row.projectWorkspaceId!) ?? null;
      const executionScopedRows = selectConfiguredRuntimeServiceRows(
        (executionRuntimeServices.get(row.id) ?? []).filter(
          (runtimeService) => runtimeService.scopeType !== "project_workspace",
        ),
        workspaceRuntime,
      );
      const effectiveRows = [
        ...(effectiveProjectRuntimeServices.get(row.projectWorkspaceId!) ?? []),
        ...executionScopedRows,
      ].sort(
        (left, right) =>
          (left.configIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.configIndex ?? Number.MAX_SAFE_INTEGER),
      );
      return [row.id, effectiveRows] as const;
    }),
  );
}

type WorkspaceOverviewPageRow = ExecutionWorkspaceRow & {
  projectName: string;
  projectWorkspaceMetadata: Record<string, unknown> | null;
};

type WorkspaceOverviewIssueRow = WorkspaceOverviewLinkedIssue & {
  executionWorkspaceId: string;
};

export function executionWorkspaceService(db: Db, opts: ExecutionWorkspaceServiceOptions = {}) {
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const resolvePullRequestDetails = opts.resolvePullRequestDetails ?? createPullRequestMergeDetailsResolver(db);
  const now = opts.now ?? (() => new Date());
  // The reaper waits this long after an issue tree becomes terminal before it
  // archives the workspace. A value of 0 disables the cooldown, so the reaper
  // archives a terminal workspace on the same sweep. A negative value also
  // disables the cooldown.
  const workspaceReaperCooldownMs = Math.max(
    0,
    (opts.workspaceReaperCooldownDays ?? 7) * 24 * 60 * 60 * 1000,
  );
  const pullRequestStateCache = new Map<
    string,
    {
      details: Awaited<ReturnType<PullRequestMergeDetailsResolver>>;
      checkedAtMs: number;
    }
  >();
  const pullRequestStateCacheTtlMs = 5 * 60 * 1000;

  // The terminal-workspace reaper scans the candidate set in fixed-size pages.
  // It keeps this keyset cursor between sweeps so each sweep continues after the
  // previous page. A skipped candidate keeps its updatedAt, so a cursor is
  // required: without it the query re-selects the oldest ineligible rows every
  // sweep and starves eligible rows behind them. The cursor resets to the start
  // when a sweep reaches the end of the candidate set.
  let terminalSweepCursor: { updatedAt: Date; id: string } | null = null;
  // The reaper freezes an upper bound on updatedAt at the start of each
  // rotation. The scan only reads candidates at or below the bound, so a steady
  // stream of newer candidates cannot keep every page full and stop the cursor
  // from ever reaching the end. A frozen set is finite, so the cursor always
  // reaches a short page and resets, and older candidates that became eligible
  // are revisited on the next rotation. The next rotation captures a new bound,
  // so candidates updated after the previous bound enter the scan then.
  let terminalSweepBoundary: Date | null = null;
  // The scheduler starts a sweep on each tick and does not wait for the previous
  // sweep to finish. A sweep that outlasts the tick interval overlaps the next
  // sweep. Both sweeps share the cursor and the boundary above. Interleaved
  // reads and writes can leave a non-null cursor with a null boundary, which
  // removes the upper bound and makes the scan chase newer churn again. This
  // flag lets only one sweep run at a time, so one sweep owns the shared state.
  let terminalSweepInProgress = false;

  async function listWorkspaceIssueTree(workspace: Pick<ExecutionWorkspaceRow, "companyId" | "sourceIssueId">) {
    if (!workspace.sourceIssueId) return [];
    return db
      .select({
        id: issues.id,
        status: issues.status,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, workspace.companyId),
        sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE issue_tree(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${workspace.companyId}
                AND ${issues.id} = ${workspace.sourceIssueId}
              UNION ALL
              SELECT child.id
              FROM ${issues} child
              JOIN issue_tree parent ON child.parent_id = parent.id
              WHERE child.company_id = ${workspace.companyId}
            )
            SELECT id FROM issue_tree
          )
        `,
      ));
  }

  async function listDeliveryPullRequestProducts(
    workspace: Pick<ExecutionWorkspaceRow, "companyId" | "sourceIssueId">,
  ) {
    if (!workspace.sourceIssueId) return [];

    return db
      .select({
        id: issueWorkProducts.id,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        title: issueWorkProducts.title,
        summary: issueWorkProducts.summary,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, workspace.companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.issueId, workspace.sourceIssueId),
      ))
      .orderBy(desc(issueWorkProducts.updatedAt))
      .limit(100);
  }

  async function assessDelivery(
    workspace: ExecutionWorkspaceRow,
    git: ExecutionWorkspaceCloseGitReadiness | null,
  ) {
    const issueTree = await listWorkspaceIssueTree(workspace);
    const sourceIssue = issueTree.find((issue) => issue.id === workspace.sourceIssueId) ?? null;
    const sourceIssueTerminal = Boolean(sourceIssue && TERMINAL_ISSUE_STATUSES.has(sourceIssue.status));
    const subtreeTerminal = Boolean(sourceIssue && issueTree.every((issue) => TERMINAL_ISSUE_STATUSES.has(issue.status)));
    // The cooldown anchor is the most recent terminal timestamp across the whole
    // issue tree. The reaper compares it against the cooldown window. A null
    // anchor means no issue in the tree is terminal yet, so the cooldown never
    // applies (the terminal-tree gates above already block the archive).
    let cooldownAnchor: Date | null = null;
    for (const issue of issueTree) {
      const terminalAt = issueTerminalTimestamp(issue);
      if (terminalAt && (!cooldownAnchor || terminalAt.getTime() > cooldownAnchor.getTime())) {
        cooldownAnchor = terminalAt;
      }
    }
    let mergedPullRequest = false;
    let pullRequestStateUnknown = false;
    const workspaceHeadSha = git?.repoRoot && git.workspacePath
      ? await runGit(["rev-parse", "HEAD"], git.workspacePath)
        .then((result) => result.stdout.trim() || null)
        .catch(() => null)
      : null;

    if (sourceIssueTerminal) {
      const products = await listDeliveryPullRequestProducts(workspace);
      for (const product of products) {
        const references = extractGitHubPullRequestReferences([
          product.url,
          product.externalId,
          product.title,
          product.summary,
          product.metadata ? JSON.stringify(product.metadata) : null,
        ]);
        if (references.length === 0) continue;
        for (const reference of references) {
          if (!pullRequestMatchesWorkspaceRepository(reference, workspace)) continue;
          const key = `${workspace.companyId}:${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
          const cached = pullRequestStateCache.get(key);
          let details;
          if (cached && now().getTime() - cached.checkedAtMs < pullRequestStateCacheTtlMs) {
            details = cached.details;
          } else {
            details = await resolvePullRequestDetails(workspace.companyId, reference);
            setBoundedPullRequestCacheEntry(
              pullRequestStateCache,
              key,
              { details, checkedAtMs: now().getTime() },
            );
          }
          if (
            details.state === "merged"
            && details.headRef === workspace.branchName
            && details.headSha === workspaceHeadSha
            && workspaceHeadSha !== null
          ) {
            mergedPullRequest = true;
            break;
          }
          if (
            details.state === "unknown"
            || (details.state === "merged" && (!details.headRef || !details.headSha || !workspaceHeadSha))
          ) {
            pullRequestStateUnknown = true;
          }
        }
        if (mergedPullRequest) break;
      }
    }

    return {
      deliveryState: deriveExecutionWorkspaceDeliveryState({
        sourceIssueTerminal,
        mergedPullRequest,
        pullRequestStateUnknown,
        isMergedIntoBase: git?.isMergedIntoBase ?? null,
      }),
      sourceIssueTerminal,
      subtreeTerminal,
      cooldownAnchor,
      workspaceDirty: Boolean(git?.hasDirtyTrackedFiles || git?.hasUntrackedFiles),
      workspaceHeadSha,
    };
  }

  async function assertTerminalCleanupGitStateUnchanged(
    workspace: ExecutionWorkspaceRow,
    expectedHeadSha: string | null,
  ) {
    if (workspace.providerType !== "git_worktree") return;
    const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
    if (!workspacePath || !expectedHeadSha) {
      throw new Error("Refusing terminal workspace cleanup because the expected git HEAD is unknown");
    }

    const [current, currentHeadSha, currentBranchName] = await Promise.all([
      inspectGitCloseReadiness(toExecutionWorkspace(workspace)),
      readGitStdout(["rev-parse", "HEAD"], workspacePath).catch(() => null),
      readGitStdout(["symbolic-ref", "--quiet", "--short", "HEAD"], workspacePath).catch(() => null),
    ]);
    if (!current.statusInspectionSucceeded) {
      throw new Error("Refusing terminal workspace cleanup because the git status could not be verified");
    }
    if (
      !current.git?.repoRoot
      || current.git.hasDirtyTrackedFiles
      || current.git.hasUntrackedFiles
      || currentHeadSha !== expectedHeadSha
      || (workspace.branchName && currentBranchName !== workspace.branchName)
    ) {
      throw new Error("Refusing terminal workspace cleanup because the git worktree changed after delivery was verified");
    }
  }

  async function hydrateWorkspace(row: ExecutionWorkspaceRow, runtimeServices: WorkspaceRuntimeService[] = []) {
    const workspace = toExecutionWorkspace(row, runtimeServices);
    const { git } = await (opts.inspectGitCloseReadiness ?? inspectGitCloseReadiness)(workspace);
    const assessment = await assessDelivery(row, git);
    return toExecutionWorkspace(row, runtimeServices, assessment.deliveryState);
  }

  async function workspaceHasActiveRun(workspace: Pick<ExecutionWorkspaceRow, "id" | "companyId" | "sourceIssueId">) {
    const linkedIssues = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, workspace.companyId),
        or(
          eq(issues.executionWorkspaceId, workspace.id),
          ...(workspace.sourceIssueId ? [eq(issues.id, workspace.sourceIssueId)] : []),
        ),
      ));
    const runIds = [...new Set(linkedIssues.flatMap((issue) => [
      issue.checkoutRunId,
      issue.executionRunId,
    ]).filter((runId): runId is string => Boolean(runId)))];
    if (runIds.length === 0) return false;
    const active = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, workspace.companyId),
        inArray(heartbeatRuns.id, runIds),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .limit(1);
    return active.length > 0;
  }

  type FenceableWorkspaceRow = {
    status: string;
    metadata: Record<string, unknown> | null;
  };

  // The single generation-fenced gateway for a terminal-workspace write. It owns
  // the whole guarded step. It acquires the per-workspace lifecycle lock, it
  // re-reads the fresh row, and it compares the current lifecycle generation to
  // the generation the caller captured. It runs the caller's write body only
  // when the current generation still equals `expectedGeneration` and the fresh
  // row still passes the caller's `isWriteTarget` guard. Otherwise it emits the
  // optional skip log and returns the caller's skip value. Every fenced
  // terminal-workspace write routes through this function, so no other function
  // re-derives the lock, the fresh read, or the generation compare.
  async function fenceLifecycleGenerationWrite<T>(input: {
    workspaceId: string;
    expectedGeneration: number;
    isWriteTarget: (fresh: FenceableWorkspaceRow) => boolean;
    onSkip: () => T;
    skipLog?: { event: string; message: string };
    write: (context: { tx: DbTransaction; fresh: FenceableWorkspaceRow }) => Promise<T>;
  }): Promise<T> {
    return db.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, input.workspaceId);
      const row = await tx
        .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, input.workspaceId))
        .then((rows) => rows[0] ?? null);
      const fresh: FenceableWorkspaceRow | null = row
        ? { status: row.status, metadata: row.metadata as Record<string, unknown> | null }
        : null;
      const currentGeneration = fresh ? readExecutionWorkspaceLifecycleGeneration(fresh.metadata) : null;
      if (
        !fresh
        || currentGeneration !== input.expectedGeneration
        || !input.isWriteTarget(fresh)
      ) {
        if (input.skipLog) {
          logger.info(
            {
              event: input.skipLog.event,
              reason: "reopened",
              executionWorkspaceId: input.workspaceId,
              capturedGeneration: input.expectedGeneration,
              currentGeneration,
              currentStatus: fresh?.status ?? null,
            },
            input.skipLog.message,
          );
        }
        return input.onSkip();
      }
      return input.write({ tx, fresh });
    });
  }

  // Clear the reopen-pending flag through the lifecycle gateway. Every caller
  // presents the lifecycle generation that owns the fence it wants to clear. The
  // gateway removes the flag only when the current generation still equals
  // `expectedGeneration`. A newer reopen raises the generation and re-sets the
  // flag, so its fence has a different owner. This check stops a stale actor (a
  // delayed response cleanup, a retry, or an aged reaper snapshot) from clearing
  // a newer reopen's live fence.
  //
  // A caller that reclaims a stranded flag passes `requireStaleSinceBefore`. The
  // write-target guard then re-reads the flag timestamp from the fresh row and
  // clears the flag only when that timestamp is still older than the cutoff. This
  // re-confirms the strand decision against the live row instead of an aged
  // snapshot.
  async function clearReopenPendingConsumptionUnderLock(
    workspaceId: string,
    options: { expectedGeneration: number; requireStaleSinceBefore?: Date },
  ): Promise<boolean> {
    return fenceLifecycleGenerationWrite<boolean>({
      workspaceId,
      expectedGeneration: options.expectedGeneration,
      isWriteTarget: (fresh) => {
        if (!metadataHasReopenPendingConsumption(fresh.metadata)) return false;
        if (options.requireStaleSinceBefore) {
          const freshSince = readMetadataReopenPendingConsumptionSince(fresh.metadata);
          const stillStale =
            freshSince === null
            || freshSince.getTime() <= options.requireStaleSinceBefore.getTime();
          // The live row shows a fresh flag, so the consumer is still in flight.
          if (!stillStale) return false;
        }
        return true;
      },
      onSkip: () => false,
      write: async ({ tx, fresh }) => {
        await tx
          .update(executionWorkspaces)
          .set({
            metadata: clearMetadataReopenPendingConsumption(fresh.metadata),
            updatedAt: new Date(),
          })
          .where(eq(executionWorkspaces.id, workspaceId));
        return true;
      },
    });
  }

  // Re-stamp the reopen-pending timestamp for a workspace whose consuming request
  // is still in flight. The request that reopens and consumes the worktree is an
  // HTTP request, not a heartbeat run, so `workspaceHasActiveRun` cannot see it.
  // Without a refresh, a request that runs longer than the stale grace period lets
  // the terminal reaper clear the live fence, and a later sweep archives and
  // destroys the worktree under the request. The consuming route calls this on an
  // interval shorter than the grace period, so the flag never looks stale while the
  // request lives. The refresh runs under the lifecycle lock and re-stamps the
  // timestamp only while the flag is still set and the current generation still
  // equals `expectedGeneration`, so it never revives a cleared flag and never
  // refreshes a newer reopen's fence. It returns true when it re-stamped the flag.
  async function refreshReopenPendingConsumptionUnderLock(
    workspaceId: string,
    options: { expectedGeneration: number },
  ): Promise<boolean> {
    return fenceLifecycleGenerationWrite<boolean>({
      workspaceId,
      expectedGeneration: options.expectedGeneration,
      // A newer reopen or an archive raised the generation. The gateway then
      // skips, so this refresh never re-stamps another owner's fence.
      isWriteTarget: (fresh) => metadataHasReopenPendingConsumption(fresh.metadata),
      onSkip: () => false,
      write: async ({ tx, fresh }) => {
        await tx
          .update(executionWorkspaces)
          .set({
            metadata: setMetadataReopenPendingConsumption(fresh.metadata, now()),
            updatedAt: new Date(),
          })
          .where(eq(executionWorkspaces.id, workspaceId));
        return true;
      },
    });
  }

  async function cleanupTerminalWorkspace(
    workspace: ExecutionWorkspaceRow,
    expectedHeadSha: string | null,
    capturedGeneration: number,
  ): Promise<{ cleaned: boolean; warnings: string[]; skippedReopened?: boolean }> {
    // The gateway holds the per-workspace lifecycle lock across the destructive
    // actions. A reopen takes the same lock, so a reopen cannot rebuild the
    // worktree while this cleanup runs, and this cleanup cannot delete a worktree
    // that a reopen already restored. The advisory lock (not a row FOR UPDATE)
    // gives the exclusion, so the cleanup body can still update the same row on
    // the pooled connection without a self-block. A reopen restored this
    // workspace after it was archived when the guard fails, so the cleanup skips
    // and does not destroy the rebuilt worktree.
    return fenceLifecycleGenerationWrite<{ cleaned: boolean; warnings: string[]; skippedReopened?: boolean }>({
      workspaceId: workspace.id,
      expectedGeneration: capturedGeneration,
      isWriteTarget: (fresh) => isClosedExecutionWorkspaceStatus(fresh.status),
      skipLog: {
        event: "execution_workspace.cleanup_skipped",
        message: "execution workspace cleanup skipped because it was reopened",
      },
      onSkip: () => ({ cleaned: false, warnings: [], skippedReopened: true }),
      write: () => runTerminalWorkspaceCleanup(workspace, expectedHeadSha),
    });
  }

  async function runTerminalWorkspaceCleanup(workspace: ExecutionWorkspaceRow, expectedHeadSha: string | null) {
    const [
      {
        acquireGitWorktreeCleanupLock,
        cleanupExecutionWorkspaceArtifacts,
        stopRuntimeServicesForExecutionWorkspace,
      },
      { workspaceOperationService },
    ] = await Promise.all([
      import("./workspace-runtime.js"),
      import("./workspace-operations.js"),
    ]);
    const [projectWorkspace, projectPolicy] = await Promise.all([
      workspace.projectWorkspaceId
        ? db
            .select({ cwd: projectWorkspaces.cwd, cleanupCommand: projectWorkspaces.cleanupCommand })
            .from(projectWorkspaces)
            .where(and(
              eq(projectWorkspaces.companyId, workspace.companyId),
              eq(projectWorkspaces.id, workspace.projectWorkspaceId),
            ))
            .then((rows) => rows[0] ?? null)
        : null,
      db
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
        .from(projects)
        .where(and(eq(projects.companyId, workspace.companyId), eq(projects.id, workspace.projectId)))
        .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy)),
    ]);
    const config = readExecutionWorkspaceConfig((workspace.metadata as Record<string, unknown> | null) ?? null);

    const cleanupLock = workspace.providerType === "git_worktree" && (workspace.providerRef ?? workspace.cwd)
      ? await acquireGitWorktreeCleanupLock(workspace.providerRef ?? workspace.cwd!)
      : null;
    try {
      await assertTerminalCleanupGitStateUnchanged(workspace, expectedHeadSha);
      await opts.beforeTerminalWorkspaceCleanup?.(workspace);
      await assertTerminalCleanupGitStateUnchanged(workspace, expectedHeadSha);
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      });
      const cleanup = await cleanupExecutionWorkspaceArtifacts({
        workspace,
        projectWorkspace,
        cleanupCommand: config?.cleanupCommand ?? null,
        teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
        recorder: workspaceOperationService(db).createRecorder({
          companyId: workspace.companyId,
          executionWorkspaceId: workspace.id,
        }),
        assertSafeToCleanup: () => assertTerminalCleanupGitStateUnchanged(workspace, expectedHeadSha),
        beforeBranchDelete: () => cleanupLock?.releaseBranchRefLock() ?? Promise.resolve(),
        expectedBranchHeadSha: expectedHeadSha,
        // Git index, HEAD, and branch-ref locks prevent a clean HEAD change
        // from crossing final validation. The branch lock is released only
        // after non-forced worktree removal, then deletion is anchored to the
        // verified HEAD so a raced ref update fails closed.
        runCleanupCommands: false,
        forceWorktreeRemoval: false,
      });
      if (cleanup.cleaned && workspace.mode === "shared_workspace") {
        await db
          .update(issues)
          .set({ executionWorkspaceId: null, updatedAt: now() })
          .where(and(
            eq(issues.companyId, workspace.companyId),
            eq(issues.executionWorkspaceId, workspace.id),
          ));
      }
      const cleanupReason = [ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON, ...cleanup.warnings].join(" | ");
      if (!cleanup.cleaned || cleanup.warnings.length > 0) {
        await db
          .update(executionWorkspaces)
          .set({
            ...(cleanup.cleaned ? {} : { status: "cleanup_failed" }),
            cleanupReason,
            updatedAt: now(),
          })
          .where(eq(executionWorkspaces.id, workspace.id));
      }
      return cleanup;
    } finally {
      await cleanupLock?.release();
    }
  }

  // Write the cleanup-failed status under the per-workspace lifecycle lock, but
  // only while the row is still closed at the generation the reaper captured. The
  // reaper calls this from its catch handler after a cleanup threw. The cleanup
  // transaction already rolled back and released the lock, so a reopen can run in
  // the window before this write. A reopen raises the generation and restores the
  // row to active. A later archive lowers the row back to closed but keeps the
  // higher generation. The generation compare then skips this write, so stale
  // cleanup-failure state never lands on a newer archive lifecycle. The function
  // returns true when it wrote the status, or false when the fence skipped it.
  async function markTerminalCleanupFailedFenced(input: {
    workspaceId: string;
    capturedGeneration: number;
    cleanupReason: string;
  }): Promise<boolean> {
    // A reopen restored the row after the cleanup threw when the guard fails. The
    // gateway then skips, so the stale cleanup-failure status never overwrites the
    // newer lifecycle state.
    return fenceLifecycleGenerationWrite<boolean>({
      workspaceId: input.workspaceId,
      expectedGeneration: input.capturedGeneration,
      isWriteTarget: (fresh) => isClosedExecutionWorkspaceStatus(fresh.status),
      skipLog: {
        event: "execution_workspace.cleanup_failed_write_skipped",
        message: "execution workspace cleanup-failure write skipped because it was reopened",
      },
      onSkip: () => false,
      write: async ({ tx }) => {
        await tx
          .update(executionWorkspaces)
          .set({
            status: "cleanup_failed",
            cleanupReason: input.cleanupReason,
            updatedAt: now(),
          })
          .where(eq(executionWorkspaces.id, input.workspaceId));
        return true;
      },
    });
  }

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
      // Collection reads are deliberately DB-only. Delivery-state hydration
      // inspects git and may resolve pull requests, so doing it for every row
      // lets a large inventory launch an unbounded number of child processes.
      // Detail and close-readiness reads retain the live hydration path.
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
      const { refreshPersistedRuntimeServiceHealth } = await import("./workspace-runtime.js");
      await refreshPersistedRuntimeServiceHealth({
        db,
        companyId: row.companyId,
        executionWorkspaceId: row.id,
        projectWorkspaceId: row.projectWorkspaceId,
      });
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, row.companyId, [row]);
      return hydrateWorkspace(
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
      const {
        git,
        warnings: gitWarnings,
        statusInspectionSucceeded,
      } = await inspectGitCloseReadiness(executionWorkspace);
      const { deliveryState } = await assessDelivery(workspace, git);
      const warnings = [...gitWarnings];
      const blockingReasons: string[] = [];
      if (!statusInspectionSucceeded) {
        blockingReasons.push("Paperclip could not verify the workspace git status. Retry before destructive cleanup.");
      }
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
      if (
        git?.aheadCount
        && git.aheadCount > 0
        && git.isMergedIntoBase === false
        && deliveryState !== "merged_via_pr"
      ) {
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
        deliveryState,
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

    sweepTerminalWorkspaces: async (limit = 50) => {
      // Skip this sweep while another sweep runs. A concurrent sweep would share
      // the cursor and the boundary and could corrupt the rotation state. A
      // skipped tick is safe: the next tick runs the sweep with intact state.
      if (terminalSweepInProgress) {
        return {
          checked: 0,
          eligible: 0,
          archived: 0,
          cleanupFailed: 0,
          skippedActiveRun: 0,
          skippedNonTerminalTree: 0,
          skippedUndelivered: 0,
          skippedRace: 0,
          skippedReopened: 0,
          skippedCooldown: 0,
          clearedStaleReopenPending: 0,
        };
      }
      terminalSweepInProgress = true;
      try {
      const baseCandidateFilter = and(
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        isNull(executionWorkspaces.closedAt),
        sql<boolean>`${executionWorkspaces.sourceIssueId} IS NOT NULL`,
      );
      // Continue the scan after the previous sweep's last row. The keyset
      // predicate uses the same (updatedAt, id) order as the query, so each
      // sweep advances past the rows it already inspected instead of re-reading
      // the oldest ineligible candidates.
      const cursor = terminalSweepCursor;
      // Freeze an upper bound on updatedAt at the start of each rotation. Without
      // a bound, a steady stream of newer candidates keeps every page full, so
      // the cursor never reaches the end and never resets, and older candidates
      // that became eligible are never revisited. The frozen bound makes the
      // rotation cover a finite set, so the cursor always reaches a short page.
      if (!cursor) {
        terminalSweepBoundary = now();
      }
      const boundary = terminalSweepBoundary;
      const boundaryFilter = boundary
        ? lte(executionWorkspaces.updatedAt, boundary)
        : undefined;
      const cursorFilter = cursor
        ? or(
            gt(executionWorkspaces.updatedAt, cursor.updatedAt),
            and(
              eq(executionWorkspaces.updatedAt, cursor.updatedAt),
              gt(executionWorkspaces.id, cursor.id),
            ),
          )
        : undefined;
      const scanFilter = and(baseCandidateFilter, boundaryFilter, cursorFilter);
      const candidates = await db
        .select()
        .from(executionWorkspaces)
        .where(scanFilter)
        .orderBy(asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id))
        .limit(limit);
      // Advance the cursor to this page's last row. A short page means the scan
      // reached the end of the bounded candidate set, so reset the cursor and
      // the bound to start a new rotation on the next sweep.
      if (candidates.length < limit) {
        terminalSweepCursor = null;
        terminalSweepBoundary = null;
      } else {
        const lastCandidate = candidates[candidates.length - 1]!;
        terminalSweepCursor = { updatedAt: lastCandidate.updatedAt, id: lastCandidate.id };
      }
      const result = {
        checked: candidates.length,
        eligible: 0,
        archived: 0,
        cleanupFailed: 0,
        skippedActiveRun: 0,
        skippedNonTerminalTree: 0,
        skippedUndelivered: 0,
        skippedRace: 0,
        skippedReopened: 0,
        skippedCooldown: 0,
        clearedStaleReopenPending: 0,
      };

      for (const workspace of candidates) {
        const executionWorkspace = toExecutionWorkspace(workspace);
        const { git, statusInspectionSucceeded } = await inspectGitCloseReadiness(executionWorkspace);
        if (!statusInspectionSucceeded) {
          result.skippedUndelivered += 1;
          continue;
        }
        const assessment = await assessDelivery(workspace, git);
        const reopenPending = metadataHasReopenPendingConsumption(
          workspace.metadata as Record<string, unknown> | null,
        );
        if (!assessment.sourceIssueTerminal || !assessment.subtreeTerminal) {
          if (reopenPending) {
            // The source issue left the terminal state, so the reopen transition
            // committed. Clear the reopen-pending flag under the lifecycle lock so
            // a later terminal cycle can archive the workspace again. Pass the
            // generation from this snapshot, so the clear skips a newer reopen that
            // raised the generation and installed its own fence after this read.
            await clearReopenPendingConsumptionUnderLock(workspace.id, {
              expectedGeneration: readExecutionWorkspaceLifecycleGeneration(
                workspace.metadata as Record<string, unknown> | null,
              ),
            });
          }
          result.skippedNonTerminalTree += 1;
          continue;
        }
        if (assessment.workspaceDirty) {
          result.skippedUndelivered += 1;
          continue;
        }
        if (
          assessment.deliveryState !== "merged_via_pr"
          && assessment.deliveryState !== "merged_by_ancestry"
        ) {
          result.skippedUndelivered += 1;
          continue;
        }
        // Hold the archive during the cooldown window. The anchor is the most
        // recent terminal timestamp across the issue tree. A person can reopen
        // the work inside this window. A cooldown of 0 disables the check, so the
        // reaper archives the workspace on the same sweep. The archive statement
        // below re-checks the same cutoff under the lifecycle lock, so the loop
        // check and the guarded statement agree.
        const cooldownCutoff = workspaceReaperCooldownMs > 0
          ? new Date(now().getTime() - workspaceReaperCooldownMs)
          : null;
        if (
          cooldownCutoff
          && assessment.cooldownAnchor
          && assessment.cooldownAnchor.getTime() > cooldownCutoff.getTime()
        ) {
          result.skippedCooldown += 1;
          continue;
        }
        if (reopenPending) {
          const pendingSince = readMetadataReopenPendingConsumptionSince(
            workspace.metadata as Record<string, unknown> | null,
          );
          const staleBefore = new Date(now().getTime() - STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS);
          const stranded =
            pendingSince === null
            || pendingSince.getTime() <= staleBefore.getTime();
          if (!stranded) {
            // A reopen published this workspace as active while the source issue
            // is still terminal, and the consuming request is still in flight. Do
            // not archive it now. The authoritative check is the NOT reopenPending
            // predicate in the archive statement below; this early skip avoids the
            // work when the snapshot already shows the flag.
            result.skippedReopened += 1;
            continue;
          }
          // The flag is older than the grace period, but age alone does not prove
          // the consuming request ended. An authorized request can run longer than
          // the grace period. A live consuming run still owns the fence, so keep it
          // and skip. This stops the sweep from clearing the fence of a slow request
          // that a later sweep would then archive and destroy under the request.
          if (await workspaceHasActiveRun(workspace)) {
            result.skippedReopened += 1;
            continue;
          }
          // The reopen-pending flag outlived its consumption window and no run owns
          // it. The consuming request ended without moving the issue out of the
          // terminal state, or the server exited before it cleared the flag. Clear
          // the stranded flag under the lifecycle lock so a later sweep can reclaim
          // the workspace. Keep the row active, so a retried resume can still reuse
          // the rebuilt worktree. Pass this snapshot's generation and re-confirm
          // staleness against the fresh row under the lock, so a newer reopen that
          // raised the generation or refreshed the timestamp keeps its live fence.
          const cleared = await clearReopenPendingConsumptionUnderLock(workspace.id, {
            expectedGeneration: readExecutionWorkspaceLifecycleGeneration(
              workspace.metadata as Record<string, unknown> | null,
            ),
            requireStaleSinceBefore: staleBefore,
          });
          if (cleared) {
            result.clearedStaleReopenPending += 1;
            logger.info(
              {
                event: "execution_workspace.reopen",
                outcome: "stale_reopen_pending_cleared",
                executionWorkspaceId: workspace.id,
                sourceIssueId: workspace.sourceIssueId,
                pendingSince: pendingSince?.toISOString() ?? null,
              },
              "cleared a stranded reopen-pending flag on a terminal workspace",
            );
          }
          continue;
        }
        if (await workspaceHasActiveRun(workspace)) {
          result.skippedActiveRun += 1;
          continue;
        }
        result.eligible += 1;
        const closedAt = now();
        // Raise the lifecycle generation on archive. The cleanup below captures
        // this generation and re-checks it before it deletes the worktree, so a
        // reopen that runs in between fences the cleanup off.
        const archivedMetadata = bumpExecutionWorkspaceLifecycleGeneration(
          workspace.metadata as Record<string, unknown> | null,
        );
        // Take the per-workspace lifecycle lock before the archive decision, so a
        // concurrent reopen cannot publish an active row between the predicate
        // checks and the archive write. The archive statement re-checks the
        // status, the terminal predicates, and the reopen-pending flag under the
        // lock, so it never archives a workspace that a reopen just restored.
        const archived = await db.transaction(async (tx) => {
          await acquireExecutionWorkspaceLifecycleLock(tx, workspace.id);
          return tx
            .update(executionWorkspaces)
            .set({
              status: "archived",
              closedAt,
              cleanupEligibleAt: workspace.cleanupEligibleAt ?? closedAt,
              cleanupReason: ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON,
              metadata: archivedMetadata,
              updatedAt: closedAt,
            })
            .where(and(
              eq(executionWorkspaces.id, workspace.id),
              eq(executionWorkspaces.companyId, workspace.companyId),
              inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
              isNull(executionWorkspaces.closedAt),
              sql<boolean>`(${executionWorkspaces.metadata} ->> ${EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY}) IS DISTINCT FROM 'true'`,
              sql<boolean>`EXISTS (
                SELECT 1
                FROM ${issues} source_issue
                WHERE source_issue.company_id = ${workspace.companyId}
                  AND source_issue.id = ${workspace.sourceIssueId}
                  AND source_issue.status IN ('done', 'cancelled')
              )`,
              sql<boolean>`NOT EXISTS (
                SELECT 1
                FROM ${issues} linked_issue
                JOIN ${heartbeatRuns} live_run
                  ON live_run.id = linked_issue.checkout_run_id
                  OR live_run.id = linked_issue.execution_run_id
                WHERE linked_issue.company_id = ${workspace.companyId}
                  AND (
                    linked_issue.execution_workspace_id = ${workspace.id}
                    OR linked_issue.id = ${workspace.sourceIssueId}
                  )
                  AND live_run.company_id = ${workspace.companyId}
                  AND live_run.status IN ('queued', 'running')
              )`,
              sql<boolean>`NOT EXISTS (
                WITH RECURSIVE issue_tree(id, status) AS (
                  SELECT root.id, root.status
                  FROM ${issues} root
                  WHERE root.company_id = ${workspace.companyId}
                    AND root.id = ${workspace.sourceIssueId}
                  UNION ALL
                  SELECT child.id, child.status
                  FROM ${issues} child
                  JOIN issue_tree parent ON child.parent_id = parent.id
                  WHERE child.company_id = ${workspace.companyId}
                )
                SELECT 1 FROM issue_tree WHERE status NOT IN ('done', 'cancelled')
              )`,
              // Re-check the cooldown under the lifecycle lock. This predicate
              // matches the loop check above: block the archive when any issue in
              // the tree became terminal after the cutoff. The tree walk mirrors
              // the terminal-tree walk above. A null cutoff means the cooldown is
              // disabled, so this predicate drops out of the guard.
              cooldownCutoff
                ? sql<boolean>`NOT EXISTS (
                WITH RECURSIVE cooldown_tree(id, status, completed_at, cancelled_at, updated_at) AS (
                  SELECT root.id, root.status, root.completed_at, root.cancelled_at, root.updated_at
                  FROM ${issues} root
                  WHERE root.company_id = ${workspace.companyId}
                    AND root.id = ${workspace.sourceIssueId}
                  UNION ALL
                  SELECT child.id, child.status, child.completed_at, child.cancelled_at, child.updated_at
                  FROM ${issues} child
                  JOIN cooldown_tree parent ON child.parent_id = parent.id
                  WHERE child.company_id = ${workspace.companyId}
                )
                SELECT 1 FROM cooldown_tree
                WHERE COALESCE(
                  CASE
                    WHEN status = 'done' THEN completed_at
                    WHEN status = 'cancelled' THEN cancelled_at
                  END,
                  updated_at
                ) > ${cooldownCutoff.toISOString()}::timestamptz
              )`
                : undefined,
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
        });
        if (!archived) {
          result.skippedRace += 1;
          continue;
        }

        await logActivity(db, {
          companyId: archived.companyId,
          actorType: "system",
          actorId: "workspace_terminality_reaper",
          action: "execution_workspace.issue_terminal_archived",
          entityType: "execution_workspace",
          entityId: archived.id,
          details: {
            sourceIssueId: archived.sourceIssueId,
            deliveryState: assessment.deliveryState,
            cleanupEligibleAt: archived.cleanupEligibleAt?.toISOString() ?? null,
            cleanupReason: ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON,
          },
        });

        const capturedGeneration = readExecutionWorkspaceLifecycleGeneration(
          archived.metadata as Record<string, unknown> | null,
        );
        try {
          const cleanup = await cleanupTerminalWorkspace(archived, assessment.workspaceHeadSha, capturedGeneration);
          if (cleanup.skippedReopened) result.skippedReopened += 1;
          else if (!cleanup.cleaned) result.cleanupFailed += 1;
          else result.archived += 1;
        } catch (error) {
          result.cleanupFailed += 1;
          const failure = error instanceof Error ? error.message : String(error);
          // Mark cleanup_failed only while the row is still closed at the
          // generation this sweep captured. A reopen that raced after the failure
          // raises the generation and restores the row; a later archive keeps the
          // higher generation. The fenced write then skips, so stale
          // cleanup-failure state never lands on a newer archive lifecycle.
          await markTerminalCleanupFailedFenced({
            workspaceId: archived.id,
            capturedGeneration,
            cleanupReason: `${ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON} | ${failure}`,
          });
          await logActivity(db, {
            companyId: archived.companyId,
            actorType: "system",
            actorId: "workspace_terminality_reaper",
            action: "execution_workspace.issue_terminal_cleanup_failed",
            entityType: "execution_workspace",
            entityId: archived.id,
            details: { sourceIssueId: archived.sourceIssueId, failure },
          });
        }
      }
      return result;
      } finally {
        terminalSweepInProgress = false;
      }
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

    // Reopen one closed isolated execution workspace so an authorized issue can
    // use it again. The caller must first authorize the request on the issue.
    // The whole operation runs under the per-workspace lifecycle lock: it reads
    // the row in the issue scope, rebuilds the worktree, and only then publishes
    // the row as "active". A rebuild failure keeps the row closed and returns an
    // error, so the caller never dispatches a run against a broken workspace.
    reopenClosedIsolatedExecutionWorkspaceForIssue: async (input: {
      workspaceId: string;
      issue: { id: string; companyId: string; projectId: string | null };
      actor: { agentId: string | null; actorType: string };
    }): Promise<ReopenClosedIsolatedExecutionWorkspaceResult> => {
      const { issue, actor } = input;
      // Bind the workspace to the issue company and project. A null project on
      // the issue must match a null project on the row (IS NOT DISTINCT FROM).
      const projectIdCondition =
        issue.projectId == null
          ? sql`${executionWorkspaces.projectId} IS NULL`
          : eq(executionWorkspaces.projectId, issue.projectId);

      return db.transaction(async (tx): Promise<ReopenClosedIsolatedExecutionWorkspaceResult> => {
        await acquireExecutionWorkspaceLifecycleLock(tx, input.workspaceId);
        const row = await tx
          .select()
          .from(executionWorkspaces)
          .where(and(
            eq(executionWorkspaces.id, input.workspaceId),
            eq(executionWorkspaces.companyId, issue.companyId),
            projectIdCondition,
            eq(executionWorkspaces.mode, "isolated_workspace"),
          ))
          .then((rows) => rows[0] ?? null);
        if (!row) {
          // Wrong company, wrong project, wrong mode, or missing. Fail closed and
          // disclose no workspace detail.
          return { ok: false, code: "not_reopenable", message: "Execution workspace is not reopenable" };
        }
        if (!isClosedExecutionWorkspaceStatus(row.status)) {
          // A concurrent reopen already restored the row. Report success without a
          // second rebuild so the caller continues normally. The other request
          // owns the reopen-pending flag, so return its generation and let the
          // caller skip the consumption guard.
          return {
            ok: true,
            reopened: false,
            workspace: toExecutionWorkspace(row),
            generation: readExecutionWorkspaceLifecycleGeneration(row.metadata as Record<string, unknown> | null),
          };
        }

        const [
          { ensurePersistedExecutionWorkspaceAvailable },
          { workspaceOperationService },
          { ensureManagedProjectWorkspace },
        ] = await Promise.all([
          import("./workspace-runtime.js"),
          import("./workspace-operations.js"),
          // heartbeat.js imports this module, so a static import creates a
          // cycle. Load ensureManagedProjectWorkspace dynamically instead.
          import("./heartbeat.js"),
        ]);
        const [projectWorkspace, projectPolicy] = await Promise.all([
          row.projectWorkspaceId
            ? db
                .select({ cwd: projectWorkspaces.cwd })
                .from(projectWorkspaces)
                .where(and(
                  eq(projectWorkspaces.companyId, row.companyId),
                  eq(projectWorkspaces.id, row.projectWorkspaceId),
                ))
                .then((rows) => rows[0] ?? null)
            : null,
          db
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.companyId, row.companyId), eq(projects.id, row.projectId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy)),
        ]);
        // Resolve the base checkout that the rebuild spawns git in. A
        // local-folder project stores its base path in projectWorkspaces.cwd.
        // A managed_checkout project stores null there, so resolve its live
        // managed checkout instead. Never use row.cwd for a git_worktree
        // rebuild: row.cwd is the archived worktree path, which the reaper
        // already removed from disk. A spawn in that missing directory fails
        // with "spawn git ENOENT" and hides the real cause.
        let resolvedBaseCwd = projectWorkspace?.cwd ?? null;
        if (resolvedBaseCwd == null && row.strategyType === "git_worktree" && row.projectId) {
          const managedWorkspace = await ensureManagedProjectWorkspace({
            companyId: row.companyId,
            projectId: row.projectId,
            repoUrl: row.repoUrl,
            resolveGitAuth: createGitRemoteAuthProvider(db, row.companyId, {
              issueId: row.sourceIssueId ?? issue.id,
            }),
          });
          resolvedBaseCwd = managedWorkspace.cwd;
        }
        const config = readExecutionWorkspaceConfig(row.metadata as Record<string, unknown> | null);
        const nextGeneration = readExecutionWorkspaceLifecycleGeneration(
          row.metadata as Record<string, unknown> | null,
        ) + 1;
        const nextMetadata = bumpExecutionWorkspaceLifecycleGeneration(
          row.metadata as Record<string, unknown> | null,
        );
        const recorder = workspaceOperationService(db).createRecorder({
          companyId: row.companyId,
          executionWorkspaceId: row.id,
        });

        let rebuildError: string | null = null;
        try {
          const realized = await ensurePersistedExecutionWorkspaceAvailable({
            db: tx as unknown as Db,
            base: {
              baseCwd: resolvedBaseCwd ?? row.cwd ?? "",
              source: "task_session",
              projectId: row.projectId,
              workspaceId: row.projectWorkspaceId,
              repoUrl: row.repoUrl,
              repoRef: row.baseRef,
            },
            workspace: {
              id: row.id,
              mode: row.mode,
              strategyType: row.strategyType,
              cwd: row.cwd,
              providerRef: row.providerRef,
              projectId: row.projectId,
              projectWorkspaceId: row.projectWorkspaceId,
              repoUrl: row.repoUrl,
              baseRef: row.baseRef,
              branchName: row.branchName,
              metadata: row.metadata as Record<string, unknown> | null,
              config: {
                ...config,
                provisionCommand:
                  config?.provisionCommand
                  ?? projectPolicy?.workspaceStrategy?.provisionCommand
                  ?? null,
              },
            },
            issue: row.sourceIssueId
              ? { id: row.sourceIssueId, identifier: null, title: row.name }
              : null,
            agent: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: row.companyId,
            },
            recorder,
          });
          if (!realized) {
            rebuildError = "Execution workspace could not be rebuilt";
          }
        } catch (error) {
          rebuildError = error instanceof Error ? error.message : String(error);
        }

        if (rebuildError) {
          // The rebuild failed. Keep the row closed and retryable. Raise the
          // generation so a queued cleanup that captured the old generation does
          // nothing. Clear cleanupEligibleAt so the reaper does not destroy the
          // half-built worktree while a later reopen retries.
          await tx
            .update(executionWorkspaces)
            .set({
              cleanupReason: EXECUTION_WORKSPACE_REOPEN_FAILED_REASON,
              cleanupEligibleAt: null,
              metadata: nextMetadata,
              updatedAt: new Date(),
            })
            .where(eq(executionWorkspaces.id, row.id));
          // The server log carries the underlying cause for diagnosis. The audit
          // event and the returned message stay free of repo URLs, host paths,
          // and git output.
          logger.warn(
            {
              event: "execution_workspace.reopen",
              outcome: "rebuild_failed",
              executionWorkspaceId: row.id,
              issueId: issue.id,
              companyId: row.companyId,
              actorType: actor.actorType,
              actorAgentId: actor.agentId ?? null,
              generation: nextGeneration,
              error: rebuildError,
            },
            "execution workspace reopen rebuild failed",
          );
          await logActivity(tx as unknown as Db, {
            companyId: row.companyId,
            actorType: actor.actorType === "user" ? "user" : "agent",
            actorId: actor.agentId ?? "system",
            agentId: actor.actorType === "user" ? null : actor.agentId,
            action: "execution_workspace.reopen_failed",
            entityType: "execution_workspace",
            entityId: row.id,
            details: {
              issueId: issue.id,
              outcome: "rebuild_failed",
              generation: nextGeneration,
            },
          });
          return { ok: false, code: "rebuild_failed", message: "Failed to rebuild the execution workspace" };
        }

        // The rebuild succeeded. Publish the row as active in one write, and clear
        // the closed markers. Set the reopen-pending flag in the same write. The
        // source issue is still terminal at this point, because the route changes
        // the issue out of the terminal state only after this reopen returns. The
        // flag stops the terminal reaper and the archive route from archiving and
        // destroying the rebuilt worktree in that window.
        const activeMetadata = setMetadataReopenPendingConsumption(nextMetadata, now());
        const activeRow = await tx
          .update(executionWorkspaces)
          .set({
            status: "active",
            closedAt: null,
            cleanupReason: null,
            cleanupEligibleAt: null,
            metadata: activeMetadata,
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(executionWorkspaces.id, row.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!activeRow) {
          return { ok: false, code: "rebuild_failed", message: "Failed to rebuild the execution workspace" };
        }
        logger.info(
          {
            event: "execution_workspace.reopen",
            outcome: "reopened",
            executionWorkspaceId: row.id,
            issueId: issue.id,
            companyId: row.companyId,
            actorType: actor.actorType,
            actorAgentId: actor.agentId ?? null,
            generation: nextGeneration,
          },
          "execution workspace reopened",
        );
        await logActivity(tx as unknown as Db, {
          companyId: row.companyId,
          actorType: actor.actorType === "user" ? "user" : "agent",
          actorId: actor.agentId ?? "system",
          agentId: actor.actorType === "user" ? null : actor.agentId,
          action: "execution_workspace.reopened",
          entityType: "execution_workspace",
          entityId: row.id,
          details: {
            issueId: issue.id,
            outcome: "reopened",
            generation: nextGeneration,
          },
        });
        return { ok: true, reopened: true, workspace: toExecutionWorkspace(activeRow), generation: nextGeneration };
      });
    },

    // Clear the reopen-pending flag after a caller failed to consume a reopened
    // workspace. A reopen publishes the rebuilt worktree as active and sets the
    // flag while the source issue is still terminal. The route then moves the
    // issue out of the terminal state, and the terminal reaper clears the flag
    // once it observes the non-terminal issue. If that move never lands (the
    // route mutation returns null, throws, or leaves the issue terminal), the
    // issue stays terminal and the flag stays set. The terminal reaper and the
    // archive route both skip a reopen-pending row, so the rebuilt worktree leaks
    // and no path can reclaim it. This method clears the flag under the lifecycle
    // lock, so the reaper can archive and reclaim the worktree. It keeps the row
    // active, so a retried resume can still reuse the rebuilt worktree. The
    // method is idempotent: it does nothing when the flag is already clear.
    // Re-stamp the reopen-pending timestamp while a consuming request is still in
    // flight. The consuming route calls this on an interval shorter than the stale
    // grace period, so the terminal reaper never treats the live fence as stranded.
    // The refresh runs only while the flag is still set and the generation still
    // matches `expectedGeneration`, so it never revives a cleared flag and never
    // refreshes a newer reopen's fence. It returns { refreshed } so the caller can
    // stop the interval once the fence is no longer its own.
    refreshReopenPendingConsumption: async (input: {
      workspaceId: string;
      expectedGeneration: number;
    }): Promise<{ refreshed: boolean }> => {
      const refreshed = await refreshReopenPendingConsumptionUnderLock(input.workspaceId, {
        expectedGeneration: input.expectedGeneration,
      });
      return { refreshed };
    },

    clearReopenPendingConsumptionForUnconsumedReopen: async (input: {
      workspaceId: string;
      issue: { id: string; companyId: string };
      actor: { agentId: string | null; actorType: string };
      // The generation the reopen published the active row at. It owns the flag.
      // The clear runs only while the current generation still matches, so it never
      // clears a newer reopen's fence.
      expectedGeneration: number;
    }): Promise<{ cleared: boolean }> => {
      const cleared = await clearReopenPendingConsumptionUnderLock(input.workspaceId, {
        expectedGeneration: input.expectedGeneration,
      });
      if (cleared) {
        logger.info(
          {
            event: "execution_workspace.reopen",
            outcome: "unconsumed_reopen_cleared",
            executionWorkspaceId: input.workspaceId,
            issueId: input.issue.id,
            companyId: input.issue.companyId,
            actorType: input.actor.actorType,
            actorAgentId: input.actor.agentId ?? null,
          },
          "execution workspace reopen-pending flag cleared after an unconsumed reopen",
        );
        await logActivity(db, {
          companyId: input.issue.companyId,
          actorType: input.actor.actorType === "user" ? "user" : "agent",
          actorId: input.actor.agentId ?? "system",
          agentId: input.actor.actorType === "user" ? null : input.actor.agentId,
          action: "execution_workspace.reopen_unconsumed",
          entityType: "execution_workspace",
          entityId: input.workspaceId,
          details: {
            issueId: input.issue.id,
            outcome: "unconsumed_reopen_cleared",
          },
        });
      }
      return { cleared };
    },

    // Archive one workspace under the per-workspace lifecycle lock. The archive
    // route calls this so the transition to archived and the destruction fence
    // both run under the same lock as a reopen. The lock stops a concurrent
    // reopen from publishing an active row between the status re-check and the
    // archive write. The archive runs only while the row is still open (not
    // already archived by a race) and clears the reopen-pending flag.
    //
    // The method refuses to archive a row that carries the reopen-pending flag.
    // A reopen sets that flag when it publishes a rebuilt worktree as active
    // while the source issue is still terminal. The method returns a distinct
    // "reopen_pending" outcome for that row. It does not clear the flag and does
    // not archive. The route maps that outcome to HTTP 409 and returns before any
    // destructive cleanup, so the archive control never removes a rebuilt
    // worktree during the reopen consumption window.
    archiveWorkspaceUnderLifecycleLock: async (input: {
      id: string;
      patch: Partial<typeof executionWorkspaces.$inferInsert>;
      closedAt: Date;
    }): Promise<
      | { outcome: "archived"; workspace: ExecutionWorkspace; capturedGeneration: number }
      | { outcome: "reopen_pending" }
      | null
    > => {
      return db.transaction(async (tx) => {
        await acquireExecutionWorkspaceLifecycleLock(tx, input.id);
        const fresh = await tx
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, input.id))
          .then((rows) => rows[0] ?? null);
        if (!fresh || isClosedExecutionWorkspaceStatus(fresh.status)) {
          // The row is missing or already closed by a concurrent path. Do not
          // archive again.
          return null;
        }
        if (metadataHasReopenPendingConsumption(fresh.metadata as Record<string, unknown> | null)) {
          // A reopen published this row as active while its source issue is still
          // terminal. A caller will consume the rebuilt worktree. Refuse the
          // archive and keep the flag, so the destructive path never removes the
          // rebuilt worktree. The route maps this to HTTP 409.
          return { outcome: "reopen_pending" };
        }
        const baseMetadata =
          (input.patch.metadata as Record<string, unknown> | null | undefined)
          ?? (fresh.metadata as Record<string, unknown> | null);
        const archiveMetadata = clearMetadataReopenPendingConsumption(
          bumpExecutionWorkspaceLifecycleGeneration(baseMetadata),
        );
        const archived = await tx
          .update(executionWorkspaces)
          .set({
            ...input.patch,
            status: "archived",
            closedAt: input.closedAt,
            cleanupReason: null,
            metadata: archiveMetadata,
            updatedAt: new Date(),
          })
          .where(and(
            eq(executionWorkspaces.id, input.id),
            // Defense in depth: never archive a reopen-pending row even if the
            // flag appears between the read above and this write. The lifecycle
            // lock already serializes reopen and archive, so this predicate only
            // adds a second, authoritative guard at the write.
            sql<boolean>`(${executionWorkspaces.metadata} ->> ${EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY}) IS DISTINCT FROM 'true'`,
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!archived) return null;
        return {
          outcome: "archived",
          workspace: toExecutionWorkspace(archived),
          capturedGeneration: readExecutionWorkspaceLifecycleGeneration(archiveMetadata),
        };
      });
    },

    // Apply the terminal cleanup outcome to a workspace row through the lifecycle
    // gateway. The archive route calls this after the destruction fence ran, to
    // record cleanup warnings and, when the destroy failed, the cleanup_failed
    // status. A reopen that raced after the fence returned restores the row to an
    // open status and raises the generation. The gateway re-reads the fresh row
    // under the lock and writes only while the row is still closed at
    // `capturedGeneration`. So a stale cleanup patch never overwrites the closedAt,
    // the cleanup reason, or the status of a freshly rebuilt worktree. The method
    // returns the updated row, or null when the guard skipped the write.
    applyClosedWorkspaceCleanupOutcome: async (input: {
      id: string;
      closedAt: Date;
      capturedGeneration: number;
      cleanupReason: string | null;
      markCleanupFailed: boolean;
    }): Promise<ExecutionWorkspace | null> => {
      // A reopen restored the row after the destruction fence returned when the
      // guard fails. The gateway then skips, so the write never overwrites the
      // newly active lifecycle state.
      return fenceLifecycleGenerationWrite<ExecutionWorkspace | null>({
        workspaceId: input.id,
        expectedGeneration: input.capturedGeneration,
        isWriteTarget: (fresh) => isClosedExecutionWorkspaceStatus(fresh.status),
        onSkip: () => null,
        write: async ({ tx }) => {
          const row = await tx
            .update(executionWorkspaces)
            .set({
              closedAt: input.closedAt,
              cleanupReason: input.cleanupReason,
              ...(input.markCleanupFailed ? { status: "cleanup_failed" as const } : {}),
              updatedAt: new Date(),
            })
            .where(eq(executionWorkspaces.id, input.id))
            .returning()
            .then((rows) => rows[0] ?? null);
          return row ? toExecutionWorkspace(row) : null;
        },
      });
    },

    // Read the lifecycle generation of a workspace row. The archive route captures
    // this before it destroys, so it can hand the value to the destruction fence.
    readLifecycleGeneration: async (id: string): Promise<number | null> => {
      const row = await db
        .select({ metadata: executionWorkspaces.metadata })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? readExecutionWorkspaceLifecycleGeneration(row.metadata as Record<string, unknown> | null) : null;
    },

    // Run a destructive workspace cleanup through the lifecycle gateway. The
    // caller passes the generation it captured at archive time. If a reopen raised
    // the generation or restored the row to an open status, the gateway skips the
    // destroy callback, so a cleanup never deletes a worktree that a reopen
    // rebuilt.
    fenceClosedWorkspaceDestruction: async <T>(input: {
      workspaceId: string;
      capturedGeneration: number;
      destroy: () => Promise<T>;
    }): Promise<{ skippedReopened: true } | { skippedReopened: false; result: T }> => {
      return fenceLifecycleGenerationWrite<
        { skippedReopened: true } | { skippedReopened: false; result: T }
      >({
        workspaceId: input.workspaceId,
        expectedGeneration: input.capturedGeneration,
        isWriteTarget: (fresh) => isClosedExecutionWorkspaceStatus(fresh.status),
        skipLog: {
          event: "execution_workspace.cleanup_skipped",
          message: "execution workspace cleanup skipped because it was reopened",
        },
        onSkip: () => ({ skippedReopened: true as const }),
        write: async () => ({ skippedReopened: false as const, result: await input.destroy() }),
      });
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
      // A recorded branch whose ref is confirmed absent (not merely unreadable)
      // has nothing to lose, so adopting the clean checked-out branch is
      // trivially forward-only — provided the adopted branch's own local ref
      // resolves, so a nonexistent branch name is never persisted.
      const recordedBranchAdoptable =
        inspection.fromBranchRefStatus === "missing" &&
        inspection.toBranchRefStatus === "resolved";
      if (
        input.mode === "forward" &&
        inspection.ancestryVerdict !== "ancestor" &&
        !(recordedBranchAdoptable && inspection.cleanliness === "clean")
      ) {
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
                  or(
                    and(
                      eq(workspaceRuntimeServices.projectWorkspaceId, lockedRow.projectWorkspaceId!),
                      eq(workspaceRuntimeServices.scopeType, "project_workspace"),
                    ),
                    eq(workspaceRuntimeServices.executionWorkspaceId, lockedRow.id),
                  ),
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

        // Keep all actor-authored comments on the central attribution path so
        // an agent reconcile records its signed responsible user and policy
        // reason just like comments written through the issue routes.
        const { issueService } = await import("./issues.js");
        const auditComment = await issueService(txDb).addComment(
          lockedWorkspace.sourceIssueId,
          formatBranchReconcileAuditComment({
            mode: input.mode,
            reason,
            workspaceId: existing.id,
            inspection,
            recoveryActionId: recoveryAction?.id ?? null,
            rescueRef,
          }),
          {
            agentId: input.actor.actorType === "agent" ? input.actor.agentId ?? undefined : undefined,
            userId: input.actor.actorType === "user" ? input.actor.actorId : undefined,
            runId: input.actor.runId,
          },
          {
            authorType: input.actor.actorType,
            authorizationReason: "execution_workspace_branch_reconcile",
          },
          tx,
        );

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
