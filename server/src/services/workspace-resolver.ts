import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { FEATURE_FLAG_KEYS, isFeatureFlagEnabled } from "./feature-flags.js";
import { provisionExecutionWorkspaceWithLock } from "./workspace-provisioner.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceInput,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
} from "./workspace-runtime.js";
import { realizeExecutionWorkspace } from "./workspace-runtime.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";

/**
 * WorkspaceResolver (GST-951 plan §4.1).
 *
 * Policy layer that sits above `realizeExecutionWorkspace`. When
 * `WORKSPACE_RUNTIME_V2` is enabled for the company (optionally
 * overridden per-agent):
 *  - For code-mutating agent roles, force `git_worktree` strategy with a
 *    per-issue worktree.
 *  - For all other roles, fall through to the configured strategy.
 *
 * When the flag is OFF, the resolver passes through to legacy behaviour
 * unchanged. This lets the change ship dark and ramp per agent.
 */

/**
 * Agent roles whose work *mutates code* and therefore needs an isolated
 * per-issue worktree by default. The `AgentRole` enum doesn't currently
 * model "staff" or "release" as distinct roles (they're all `engineer`
 * underneath), so we match on the base role and let project policy or
 * per-agent overrides handle edge cases.
 */
export const CODE_MUTATING_AGENT_ROLES = new Set<string>([
  "engineer",
  "devops",
]);

export type WorkspaceResolutionSource = "reuse_existing_row" | "policy_v2" | "legacy_passthrough";

export interface WorkspaceResolution {
  realized: RealizedExecutionWorkspace;
  source: WorkspaceResolutionSource;
  /** Strategy actually used, after policy was applied. */
  strategy: "project_primary" | "git_worktree";
  /** True when the resolver routed through the new advisory-locked path. */
  usedV2: boolean;
  /** Pre-existing execution_workspaces row id that was reused, if any. */
  reusedExecutionWorkspaceId: string | null;
}

export interface ResolveWorkspaceInput {
  db: Db;
  base: ExecutionWorkspaceInput;
  /** Mutable runtime config — V2 may rewrite `workspaceStrategy` on it. */
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef & {
    role?: string | null;
  };
  recorder?: WorkspaceOperationRecorder | null;
  /**
   * If true, skip the active-row reuse lookup (e.g. when the caller has
   * already decided to provision fresh — say after detecting drift).
   */
  skipReuseLookup?: boolean;
}

interface ActiveRowSummary {
  id: string;
  strategyType: string;
  cwd: string | null;
  branchName: string | null;
  baseRef: string | null;
  providerRef: string | null;
  status: string;
}

async function findActiveRowForIssueAndAgent(
  db: Db,
  issueId: string,
  companyId: string,
): Promise<ActiveRowSummary | null> {
  const rows = await db
    .select({
      id: executionWorkspaces.id,
      strategyType: executionWorkspaces.strategyType,
      cwd: executionWorkspaces.cwd,
      branchName: executionWorkspaces.branchName,
      baseRef: executionWorkspaces.baseRef,
      providerRef: executionWorkspaces.providerRef,
      status: executionWorkspaces.status,
    })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, companyId),
        eq(executionWorkspaces.sourceIssueId, issueId),
        eq(executionWorkspaces.status, "active"),
      ),
    )
    .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

function setWorkspaceStrategy(config: Record<string, unknown>, strategyType: string): void {
  const current = config.workspaceStrategy;
  const next = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  next.type = strategyType;
  config.workspaceStrategy = next;
}

function readStrategyType(config: Record<string, unknown>): string {
  const raw = config.workspaceStrategy;
  if (!raw || typeof raw !== "object") return "project_primary";
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : "project_primary";
}

export interface DecidePolicyInput {
  agentRole: string | null | undefined;
  currentStrategyType: string;
}

export interface PolicyDecision {
  strategyType: string;
  /** True when the resolver overrode the caller's requested strategy. */
  changed: boolean;
}

/** Pure function: decide a strategy from agent role + current config. */
export function decideWorkspaceStrategy(input: DecidePolicyInput): PolicyDecision {
  const role = (input.agentRole ?? "").trim().toLowerCase();
  if (CODE_MUTATING_AGENT_ROLES.has(role)) {
    if (input.currentStrategyType === "git_worktree") {
      return { strategyType: "git_worktree", changed: false };
    }
    return { strategyType: "git_worktree", changed: true };
  }
  return {
    strategyType: input.currentStrategyType || "project_primary",
    changed: false,
  };
}

export async function resolveWorkspace(input: ResolveWorkspaceInput): Promise<WorkspaceResolution> {
  const flag = await isFeatureFlagEnabled(input.db, {
    companyId: input.agent.companyId,
    key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
    agentId: input.agent.id ?? null,
  });

  if (!flag.enabled) {
    const realized = await realizeExecutionWorkspace({
      base: input.base,
      config: input.config,
      issue: input.issue,
      agent: input.agent,
      recorder: input.recorder ?? null,
    });
    return {
      realized,
      source: "legacy_passthrough",
      strategy: realized.strategy,
      usedV2: false,
      reusedExecutionWorkspaceId: null,
    };
  }

  // Step 1: active-row reuse for (issue, agent). The plan keys reuse on
  // sourceIssueId; only one active row exists per issue (enforced by the
  // upstream `issues.executionWorkspaceId` patch path).
  let reuseHint: ActiveRowSummary | null = null;
  if (input.issue?.id && !input.skipReuseLookup) {
    reuseHint = await findActiveRowForIssueAndAgent(
      input.db,
      input.issue.id,
      input.agent.companyId,
    );
  }

  // Step 2: policy. Code-mutating roles → git_worktree; otherwise keep
  // whatever the caller (project policy/agent config) requested.
  const requestedStrategyType = readStrategyType(input.config);
  const policy = decideWorkspaceStrategy({
    agentRole: input.agent.role,
    currentStrategyType: requestedStrategyType,
  });
  if (policy.changed) {
    setWorkspaceStrategy(input.config, policy.strategyType);
  }

  // Step 3: materialise. The provisioner serialises `git_worktree`
  // creation per-project under an advisory lock and falls through to
  // `realizeExecutionWorkspace` for `project_primary`.
  const provisioned = await provisionExecutionWorkspaceWithLock({
    db: input.db,
    base: input.base,
    config: input.config,
    issue: input.issue,
    agent: input.agent,
    recorder: input.recorder ?? null,
  });

  return {
    realized: provisioned,
    source: reuseHint ? "reuse_existing_row" : "policy_v2",
    strategy: provisioned.strategy,
    usedV2: true,
    reusedExecutionWorkspaceId: reuseHint?.id ?? null,
  };
}
