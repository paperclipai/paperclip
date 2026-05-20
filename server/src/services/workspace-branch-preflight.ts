import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@paperclipai/db";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { asString, parseObject, renderTemplate } from "../adapters/utils.js";
import type { ExecutionWorkspaceIssueRef } from "./workspace-runtime.js";
import type { ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";

const execFile = promisify(execFileCallback);

export class WorkspaceBranchPreflightError extends Error {
  readonly code = "workspace_branch_preflight";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkspaceBranchPreflightError";
    this.details = details;
  }
}

export type ExpectedBranchSpec = {
  /** Exact branch name required (git worktree / explicit override). */
  exact: string | null;
  /** When set, current branch must start with this prefix (e.g. `ff-442-`). */
  prefix: string | null;
  /** Human-readable summary for error messages. */
  label: string;
};

export type WorkspaceBranchPreflightInput = {
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  issueDescription: string | null;
  workspaceCwd: string;
  workspaceSource: "project_primary" | "task_session" | "agent_home";
  persistedBranchName: string | null;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueWorkspaceSettings: Record<string, unknown> | null;
  skipPreflight?: boolean;
};

export type WorkspaceBranchPreflightResult = {
  expectedBranch: string | null;
  expectedSpec: ExpectedBranchSpec | null;
  currentBranch: string | null;
  autoCheckedOut: boolean;
  warnings: string[];
};

const GITHUB_TREE_BRANCH_RE =
  /github\.com\/[^/\s]+\/[^/\s]+\/tree\/([^/?#\s]+)/gi;

function readIssueNumber(identifier: string | null, issueNumber: number | null): number | null {
  if (typeof issueNumber === "number" && Number.isFinite(issueNumber)) return issueNumber;
  if (!identifier) return null;
  const match = identifier.match(/-(\d+)$/i);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function sanitizeBranchName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .slice(0, 120) || "paperclip-work"
  );
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderBranchTemplate(
  template: string,
  input: {
    issue: ExecutionWorkspaceIssueRef | null;
    projectId: string | null;
    repoRef: string | null;
  },
): string {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
      issueNumber: readIssueNumber(input.issue?.identifier ?? null, null)?.toString() ?? "",
    },
    project: { id: input.projectId ?? "" },
    workspace: { repoRef: input.repoRef ?? "" },
    slug,
  });
}

function parseBranchPolicy(raw: unknown): Record<string, unknown> {
  return parseObject(raw);
}

function branchPolicyEnforcement(policy: ProjectExecutionWorkspacePolicy | null): "strict" | "off" {
  const branchPolicy = parseBranchPolicy(policy?.branchPolicy);
  const enforcement = asString(branchPolicy.enforcement, "strict");
  return enforcement === "off" ? "off" : "strict";
}

function branchPolicyAutoCheckout(policy: ProjectExecutionWorkspacePolicy | null): boolean {
  const branchPolicy = parseBranchPolicy(policy?.branchPolicy);
  if (typeof branchPolicy.autoCheckout === "boolean") return branchPolicy.autoCheckout;
  return true;
}

export function extractBranchNamesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(GITHUB_TREE_BRANCH_RE)) {
    const branch = match[1]?.trim();
    if (branch) found.add(sanitizeBranchName(decodeURIComponent(branch)));
  }
  return [...found];
}

export function deriveExpectedBranchSpec(input: {
  issue: ExecutionWorkspaceIssueRef | null;
  issueNumber: number | null;
  issueDescription: string | null;
  persistedBranchName: string | null;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueWorkspaceSettings: Record<string, unknown> | null;
  projectId: string | null;
  repoRef: string | null;
}): ExpectedBranchSpec | null {
  const issueRef = input.issue;
  const settings = parseObject(input.issueWorkspaceSettings);
  const branchOverride = asString(settings.branchOverride, "").trim();
  if (branchOverride) {
    const exact = sanitizeBranchName(branchOverride);
    return { exact, prefix: null, label: exact };
  }

  if (input.persistedBranchName?.trim()) {
    const exact = sanitizeBranchName(input.persistedBranchName);
    return { exact, prefix: null, label: exact };
  }

  const branchPolicy = parseBranchPolicy(input.projectPolicy?.branchPolicy);
  const issueStrategy = parseObject(settings.workspaceStrategy);
  const projectStrategy = parseObject(input.projectPolicy?.workspaceStrategy);
  const strategy = Object.keys(issueStrategy).length > 0 ? issueStrategy : projectStrategy;
  const strategyType = asString(strategy.type, "");
  const branchTemplate =
    asString(branchPolicy.branchTemplate, "").trim() ||
    asString(strategy.branchTemplate, "").trim() ||
    (strategyType === "git_worktree" ? "{{issue.identifier}}-{{slug}}" : "");

  if (branchTemplate) {
    const exact = sanitizeBranchName(
      renderBranchTemplate(branchTemplate, {
        issue: issueRef,
        projectId: input.projectId,
        repoRef: input.repoRef,
      }),
    );
    return { exact, prefix: null, label: exact };
  }

  const descriptionBranches = extractBranchNamesFromText(input.issueDescription);
  if (descriptionBranches.length === 1) {
    const exact = descriptionBranches[0]!;
    return { exact, prefix: null, label: exact };
  }

  const prefixTemplate = asString(branchPolicy.identifierPrefixTemplate, "").trim();
  const issueNum = readIssueNumber(issueRef?.identifier ?? null, input.issueNumber);
  if (prefixTemplate && issueNum != null) {
    const prefix = sanitizeBranchName(
      renderBranchTemplate(prefixTemplate, {
        issue: issueRef,
        projectId: input.projectId,
        repoRef: input.repoRef,
      }),
    );
    return { exact: null, prefix: prefix.endsWith("-") ? prefix : `${prefix}-`, label: `${prefix}*` };
  }

  if (issueNum != null) {
    const identifier = issueRef?.identifier ?? "";
    const lowered = identifier.toLowerCase();
    if (/^[a-z]+-\d+$/i.test(identifier)) {
      const prefix = `${lowered.split("-")[0]}-${issueNum}-`;
      return { exact: null, prefix, label: `${prefix}*` };
    }
  }

  return null;
}

export function branchMatchesSpec(currentBranch: string, spec: ExpectedBranchSpec): boolean {
  if (spec.exact) return currentBranch === spec.exact;
  if (spec.prefix) return currentBranch.startsWith(spec.prefix);
  return true;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    await execFile("git", ["rev-parse", "--git-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function readGitCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await execFile(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd },
    );
    return branch.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await execFile("git", ["show-ref", "--verify", `refs/heads/${branchName}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function checkoutGitBranch(cwd: string, branchName: string): Promise<void> {
  await execFile("git", ["checkout", branchName], { cwd });
}

export async function listSharedCwdInProgressConflicts(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null;
    workspaceCwd: string;
    excludeIssueId: string;
  },
): Promise<Array<{ id: string; identifier: string | null }>> {
  if (!input.projectId) return [];

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionWorkspaceId: issues.executionWorkspaceId,
      projectWorkspaceId: issues.projectWorkspaceId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.projectId, input.projectId),
        eq(issues.status, "in_progress"),
        ne(issues.id, input.excludeIssueId),
      ),
    );

  const executionWorkspaceIds = [
    ...new Set(
      rows
        .map((row) => row.executionWorkspaceId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];

  const cwdByExecutionWorkspaceId = new Map<string, string>();
  if (executionWorkspaceIds.length > 0) {
    const workspaceRows = await db
      .select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, input.companyId),
          inArray(executionWorkspaces.id, executionWorkspaceIds),
          isNotNull(executionWorkspaces.cwd),
        ),
      );
    for (const row of workspaceRows) {
      if (row.cwd) cwdByExecutionWorkspaceId.set(row.id, row.cwd);
    }
  }

  const projectWorkspaceIds = [
    ...new Set(
      rows
        .map((row) => row.projectWorkspaceId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  const primaryCwdByProjectWorkspaceId = new Map<string, string>();
  if (projectWorkspaceIds.length > 0) {
    const projectWorkspaceRows = await db
      .select({ id: projectWorkspaces.id, cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, input.companyId),
          inArray(projectWorkspaces.id, projectWorkspaceIds),
        ),
      );
    for (const row of projectWorkspaceRows) {
      if (row.cwd) primaryCwdByProjectWorkspaceId.set(row.id, row.cwd);
    }
  }

  const normalizedTarget = input.workspaceCwd;
  const conflicts: Array<{ id: string; identifier: string | null }> = [];
  for (const row of rows) {
    const executionCwd = row.executionWorkspaceId
      ? cwdByExecutionWorkspaceId.get(row.executionWorkspaceId) ?? null
      : null;
    const primaryCwd = row.projectWorkspaceId
      ? primaryCwdByProjectWorkspaceId.get(row.projectWorkspaceId) ?? null
      : null;
    const comparableCwd = executionCwd ?? primaryCwd;
    if (comparableCwd && comparableCwd === normalizedTarget) {
      conflicts.push({ id: row.id, identifier: row.identifier });
    }
  }
  return conflicts;
}

export async function enforceWorkspaceBranchPreflight(
  db: Db,
  input: WorkspaceBranchPreflightInput & {
    projectId: string | null;
    repoRef: string | null;
    issue: ExecutionWorkspaceIssueRef | null;
  },
): Promise<WorkspaceBranchPreflightResult> {
  const warnings: string[] = [];
  if (input.skipPreflight || process.env.PAPERCLIP_SKIP_BRANCH_PREFLIGHT === "true") {
    return {
      expectedBranch: input.persistedBranchName,
      expectedSpec: null,
      currentBranch: null,
      autoCheckedOut: false,
      warnings,
    };
  }

  if (branchPolicyEnforcement(input.projectPolicy) === "off") {
    return {
      expectedBranch: input.persistedBranchName,
      expectedSpec: null,
      currentBranch: null,
      autoCheckedOut: false,
      warnings,
    };
  }

  if (!(await isGitRepository(input.workspaceCwd))) {
    return {
      expectedBranch: input.persistedBranchName,
      expectedSpec: null,
      currentBranch: null,
      autoCheckedOut: false,
      warnings,
    };
  }

  const conflicts = await listSharedCwdInProgressConflicts(db, {
    companyId: input.companyId,
    projectId: input.projectId,
    workspaceCwd: input.workspaceCwd,
    excludeIssueId: input.issueId,
  });
  if (conflicts.length > 0 && input.workspaceSource === "project_primary") {
    const conflictLabels = conflicts
      .map((row) => row.identifier ?? row.id)
      .join(", ");
    throw new WorkspaceBranchPreflightError(
      `Workspace preflight refused: project primary path "${input.workspaceCwd}" is already checked out for in-progress issue(s) ${conflictLabels}. Use an isolated git worktree or finish/conflict-resolve the other issue first.`,
      {
        workspaceCwd: input.workspaceCwd,
        conflictingIssues: conflicts,
      },
    );
  }

  const expectedSpec = deriveExpectedBranchSpec({
    issue: input.issue,
    issueNumber: input.issueNumber,
    issueDescription: input.issueDescription,
    persistedBranchName: input.persistedBranchName,
    projectPolicy: input.projectPolicy,
    issueWorkspaceSettings: input.issueWorkspaceSettings,
    projectId: input.projectId,
    repoRef: input.repoRef,
  });

  if (!expectedSpec) {
    const currentBranch = await readGitCurrentBranch(input.workspaceCwd);
    return {
      expectedBranch: null,
      expectedSpec: null,
      currentBranch,
      autoCheckedOut: false,
      warnings,
    };
  }

  let currentBranch = await readGitCurrentBranch(input.workspaceCwd);
  let autoCheckedOut = false;

  if (currentBranch && !branchMatchesSpec(currentBranch, expectedSpec)) {
    if (expectedSpec.exact && branchPolicyAutoCheckout(input.projectPolicy)) {
      if (await localBranchExists(input.workspaceCwd, expectedSpec.exact)) {
        await checkoutGitBranch(input.workspaceCwd, expectedSpec.exact);
        currentBranch = await readGitCurrentBranch(input.workspaceCwd);
        autoCheckedOut = currentBranch === expectedSpec.exact;
        if (autoCheckedOut) {
          warnings.push(`Checked out branch "${expectedSpec.exact}" for ${input.issueIdentifier ?? input.issueId}.`);
        }
      }
    }
  }

  if (!currentBranch) {
    throw new WorkspaceBranchPreflightError(
      `Workspace preflight failed: "${input.workspaceCwd}" is not on a named git branch (detached HEAD). Expected ${expectedSpec.label} for ${input.issueIdentifier ?? input.issueId}.`,
      { expected: expectedSpec, workspaceCwd: input.workspaceCwd },
    );
  }

  if (!branchMatchesSpec(currentBranch, expectedSpec)) {
    throw new WorkspaceBranchPreflightError(
      `Workspace preflight failed: git branch "${currentBranch}" does not match expected ${expectedSpec.label} for ${input.issueIdentifier ?? input.issueId} in "${input.workspaceCwd}". Checkout the issue branch before running the agent.`,
      {
        expected: expectedSpec,
        actual: currentBranch,
        workspaceCwd: input.workspaceCwd,
        issueIdentifier: input.issueIdentifier,
      },
    );
  }

  const expectedBranch = expectedSpec.exact ?? expectedSpec.prefix ?? null;
  return {
    expectedBranch,
    expectedSpec,
    currentBranch,
    autoCheckedOut,
    warnings,
  };
}

export function expectedBranchForPersistence(spec: ExpectedBranchSpec | null): string | null {
  if (!spec) return null;
  return spec.exact ?? null;
}
