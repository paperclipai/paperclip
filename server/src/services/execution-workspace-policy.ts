import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
} from "@paperclipai/shared";
import { asString, parseObject } from "../adapters/utils.js";

export type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE = "workspace_worktree_requires_project";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION =
  "Attach a project to the task, or bind a reusable execution workspace, then retry.";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE =
  `This task is set to run in an isolated git worktree, but it has no project and no reusable execution workspace to create the worktree from. ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`;

type WorkspaceStrategyType = ExecutionWorkspaceStrategy["type"];

export type UnrunnableWorktreeIssueRef = {
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
};

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return { ...value };
}

function parseExecutionWorkspaceStrategy(raw: unknown): ExecutionWorkspaceStrategy | null {
  const parsed = parseObject(raw);
  const type = asString(parsed.type, "");
  if (type !== "project_primary" && type !== "git_worktree" && type !== "adapter_managed" && type !== "cloud_sandbox") {
    return null;
  }
  return {
    type,
    ...(typeof parsed.baseRef === "string" ? { baseRef: parsed.baseRef } : {}),
    ...(typeof parsed.branchTemplate === "string" ? { branchTemplate: parsed.branchTemplate } : {}),
    ...(typeof parsed.worktreeParentDir === "string" ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.teardownCommand === "string" ? { teardownCommand: parsed.teardownCommand } : {}),
  };
}

export function resolveEffectiveWorkspaceStrategyType(
  mode: ParsedExecutionWorkspaceMode,
  config: Record<string, unknown> | null | undefined,
): WorkspaceStrategyType {
  const workspaceStrategy = parseObject(config?.workspaceStrategy);
  const type = asString(workspaceStrategy.type, "");
  if (type === "project_primary" || type === "git_worktree" || type === "adapter_managed" || type === "cloud_sandbox") {
    return type;
  }
  // Default mirrors workspace-runtime.ts realizeExecutionWorkspace: missing type -> "project_primary".
  // agent_default is a metadata-only mode that never creates a worktree, so it keeps "adapter_managed".
  return mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function resolvePinnedIssueWorkspaceStrategyType(input: {
  mode: ParsedExecutionWorkspaceMode;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): WorkspaceStrategyType {
  const strategyType = input.issueSettings?.workspaceStrategy?.type;
  if (
    strategyType === "project_primary" ||
    strategyType === "git_worktree" ||
    strategyType === "adapter_managed" ||
    strategyType === "cloud_sandbox"
  ) {
    return strategyType;
  }
  // When no explicit strategy type is set, mirror the runtime default (project_primary for most
  // modes; adapter_managed for agent_default). Mode alone never implies git_worktree.
  return input.mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function hasReusableExecutionWorkspaceBinding(issue: UnrunnableWorktreeIssueRef): boolean {
  return Boolean(issue.executionWorkspaceId && issue.executionWorkspacePreference === "reuse_existing");
}

export function isUnrunnableWorktreeCombo(input: {
  issue: UnrunnableWorktreeIssueRef;
  resolvedMode: ParsedExecutionWorkspaceMode;
  resolvedStrategy: string | null | undefined;
  reusableExecutionWorkspaceAvailable?: boolean | null;
  hasResolvablePriorSessionWorkspace?: boolean | null;
}): boolean {
  if (input.resolvedMode !== "isolated_workspace" && input.resolvedMode !== "operator_branch") return false;
  if (input.resolvedStrategy !== "git_worktree") return false;
  if (input.issue.projectId || input.issue.projectWorkspaceId) return false;
  const hasReusableWorkspace =
    input.reusableExecutionWorkspaceAvailable ?? hasReusableExecutionWorkspaceBinding(input.issue);
  if (hasReusableWorkspace) return false;
  return input.hasResolvablePriorSessionWorkspace !== true;
}

export function parseProjectExecutionWorkspacePolicy(raw: unknown): ProjectExecutionWorkspacePolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const defaultMode = asString(parsed.defaultMode, "");
  const defaultProjectWorkspaceId =
    typeof parsed.defaultProjectWorkspaceId === "string" ? parsed.defaultProjectWorkspaceId : undefined;
  const allowIssueOverride =
    typeof parsed.allowIssueOverride === "boolean" ? parsed.allowIssueOverride : undefined;
  const normalizedDefaultMode = (() => {
    if (
      defaultMode === "shared_workspace" ||
      defaultMode === "isolated_workspace" ||
      defaultMode === "operator_branch" ||
      defaultMode === "adapter_default"
    ) {
      return defaultMode as ProjectExecutionWorkspaceDefaultMode;
    }
    if (defaultMode === "project_primary") return "shared_workspace";
    if (defaultMode === "isolated") return "isolated_workspace";
    return undefined;
  })();
  return {
    enabled,
    ...(normalizedDefaultMode ? { defaultMode: normalizedDefaultMode } : {}),
    ...(allowIssueOverride !== undefined ? { allowIssueOverride } : {}),
    ...(defaultProjectWorkspaceId ? { defaultProjectWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(parsed.branchPolicy && typeof parsed.branchPolicy === "object" && !Array.isArray(parsed.branchPolicy)
      ? { branchPolicy: { ...(parsed.branchPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.pullRequestPolicy && typeof parsed.pullRequestPolicy === "object" && !Array.isArray(parsed.pullRequestPolicy)
      ? { pullRequestPolicy: { ...(parsed.pullRequestPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.authorizationPolicy && typeof parsed.authorizationPolicy === "object" && !Array.isArray(parsed.authorizationPolicy)
      ? { authorizationPolicy: { ...(parsed.authorizationPolicy as Record<string, unknown>) } }
      : {}),
  };
}

export function gateProjectExecutionWorkspacePolicy(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
  isolatedWorkspacesEnabled: boolean,
): ProjectExecutionWorkspacePolicy | null {
  if (!isolatedWorkspacesEnabled) return null;
  return projectPolicy;
}

type ParseIssueExecutionWorkspaceSettingsOptions = {
  includeEnvironmentId?: boolean;
};

export function parseIssueExecutionWorkspaceSettings(
  raw: unknown,
  options: ParseIssueExecutionWorkspaceSettingsOptions = {},
): IssueExecutionWorkspaceSettings | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const mode = asString(parsed.mode, "");
  const normalizedMode = (() => {
    if (
      mode === "inherit" ||
      mode === "shared_workspace" ||
      mode === "isolated_workspace" ||
      mode === "operator_branch" ||
      mode === "reuse_existing" ||
      mode === "agent_default"
    ) {
      return mode;
    }
    if (mode === "project_primary") return "shared_workspace";
    if (mode === "isolated") return "isolated_workspace";
    return "";
  })();
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(options.includeEnvironmentId && (typeof parsed.environmentId === "string" || parsed.environmentId === null)
      ? { environmentId: parsed.environmentId }
      : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
  };
}

export type ExecutionWorkspaceEnvironmentSource =
  | "agent"
  | "instance"
  | "default";

export type ExecutionWorkspaceEnvironmentResolution = {
  environmentId: string;
  source: ExecutionWorkspaceEnvironmentSource;
};

export function resolveExecutionWorkspaceEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null;
  instanceDefaultEnvironmentId: string | null;
  localDefaultEnvironmentId: string;
}): ExecutionWorkspaceEnvironmentResolution {
  if (input.agentDefaultEnvironmentId) {
    return {
      environmentId: input.agentDefaultEnvironmentId,
      source: "agent",
    };
  }
  if (input.instanceDefaultEnvironmentId) {
    return {
      environmentId: input.instanceDefaultEnvironmentId,
      source: "instance",
    };
  }
  return {
    environmentId: input.localDefaultEnvironmentId,
    source: "default",
  };
}

export function defaultIssueExecutionWorkspaceSettingsForProject(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
): IssueExecutionWorkspaceSettings | null {
  if (!projectPolicy?.enabled) return null;
  return {
    mode:
      projectPolicy.defaultMode === "isolated_workspace"
        ? "isolated_workspace"
        : projectPolicy.defaultMode === "operator_branch"
          ? "operator_branch"
          : projectPolicy.defaultMode === "adapter_default"
            ? "agent_default"
            : "shared_workspace",
  };
}

export function issueExecutionWorkspaceModeForPersistedWorkspace(
  mode: string | null | undefined,
): IssueExecutionWorkspaceSettings["mode"] {
  if (mode === null || mode === undefined) {
    return "agent_default";
  }
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function resolveExecutionWorkspaceMode(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
}): ParsedExecutionWorkspaceMode {
  const issueMode = input.issueSettings?.mode;
  if (issueMode && issueMode !== "inherit" && issueMode !== "reuse_existing") {
    return issueMode;
  }
  if (input.projectPolicy?.enabled) {
    if (input.projectPolicy.defaultMode === "isolated_workspace") return "isolated_workspace";
    if (input.projectPolicy.defaultMode === "operator_branch") return "operator_branch";
    if (input.projectPolicy.defaultMode === "adapter_default") return "agent_default";
    return "shared_workspace";
  }
  if (input.legacyUseProjectWorkspace === false) {
    return "agent_default";
  }
  return "shared_workspace";
}

export function buildExecutionWorkspaceAdapterConfig(input: {
  agentConfig: Record<string, unknown>;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  mode: ParsedExecutionWorkspaceMode;
  legacyUseProjectWorkspace: boolean | null;
}): Record<string, unknown> {
  const nextConfig = { ...input.agentConfig };
  const projectHasPolicy = Boolean(input.projectPolicy?.enabled);
  const issueHasWorkspaceOverrides = Boolean(
    input.issueSettings?.mode ||
    input.issueSettings?.workspaceStrategy ||
    input.issueSettings?.workspaceRuntime,
  );
  const hasWorkspaceControl = projectHasPolicy || issueHasWorkspaceOverrides || input.legacyUseProjectWorkspace === false;

  if (hasWorkspaceControl) {
    if (input.mode === "isolated_workspace") {
      const strategy =
        input.issueSettings?.workspaceStrategy ??
        input.projectPolicy?.workspaceStrategy ??
        parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy) ??
        ({ type: "git_worktree" } satisfies ExecutionWorkspaceStrategy);
      nextConfig.workspaceStrategy = strategy as unknown as Record<string, unknown>;
    } else {
      delete nextConfig.workspaceStrategy;
    }

    if (input.mode === "agent_default") {
      delete nextConfig.workspaceRuntime;
    } else if (input.issueSettings?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.issueSettings.workspaceRuntime) ?? undefined;
    } else if (input.projectPolicy?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.projectPolicy.workspaceRuntime) ?? undefined;
    }
  }

  return nextConfig;
}
