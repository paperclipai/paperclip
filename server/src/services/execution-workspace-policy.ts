import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
  PullRequestMergeStrategy,
  PullRequestPolicy,
} from "@paperclipai/shared";
import { asString, parseObject } from "../adapters/utils.js";

const KNOWN_PULL_REQUEST_POLICY_KEYS = new Set([
  "autoOpen",
  "autoMerge",
  "mergeStrategy",
  "targetBranch",
  "titleTemplate",
  "bodyTemplate",
  "draft",
  "requireResultBeforeArchive",
  "archiveTimeoutMs",
  "extensions",
]);

function parsePullRequestMergeStrategy(raw: unknown): PullRequestMergeStrategy | undefined {
  if (raw === "merge" || raw === "squash" || raw === "rebase") return raw;
  return undefined;
}

export function parsePullRequestPolicy(raw: unknown): PullRequestPolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;

  const policy: PullRequestPolicy = {};

  const autoMerge = typeof parsed.autoMerge === "boolean" ? parsed.autoMerge : undefined;
  const autoOpenRaw = typeof parsed.autoOpen === "boolean" ? parsed.autoOpen : undefined;
  // autoMerge=true implies autoOpen=true. Normalize once so downstream
  // consumers don't re-check the invariant every time.
  const autoOpen = autoMerge === true ? true : autoOpenRaw;
  if (autoOpen !== undefined) policy.autoOpen = autoOpen;
  if (autoMerge !== undefined) policy.autoMerge = autoMerge;

  const mergeStrategy = parsePullRequestMergeStrategy(parsed.mergeStrategy);
  if (mergeStrategy !== undefined) policy.mergeStrategy = mergeStrategy;

  if (typeof parsed.targetBranch === "string" && parsed.targetBranch.length > 0) {
    policy.targetBranch = parsed.targetBranch;
  }
  if (typeof parsed.titleTemplate === "string") policy.titleTemplate = parsed.titleTemplate;
  if (typeof parsed.bodyTemplate === "string") policy.bodyTemplate = parsed.bodyTemplate;
  if (typeof parsed.draft === "boolean") policy.draft = parsed.draft;
  if (typeof parsed.requireResultBeforeArchive === "boolean") {
    policy.requireResultBeforeArchive = parsed.requireResultBeforeArchive;
  }
  if (
    typeof parsed.archiveTimeoutMs === "number" &&
    Number.isInteger(parsed.archiveTimeoutMs) &&
    parsed.archiveTimeoutMs > 0
  ) {
    policy.archiveTimeoutMs = parsed.archiveTimeoutMs;
  }

  // Preserve unknown keys on policy.extensions so that a round-trip
  // through the parser does not silently drop forward-compat data the
  // consumer may have embedded in the project policy.
  const existingExtensions =
    typeof parsed.extensions === "object" &&
    parsed.extensions !== null &&
    !Array.isArray(parsed.extensions)
      ? (parsed.extensions as Record<string, unknown>)
      : null;
  const unknownKeys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (KNOWN_PULL_REQUEST_POLICY_KEYS.has(key)) continue;
    unknownKeys[key] = value;
  }
  const merged = { ...(existingExtensions ?? {}), ...unknownKeys };
  if (Object.keys(merged).length > 0) {
    policy.extensions = merged;
  }

  return Object.keys(policy).length > 0 ? policy : null;
}

export function pullRequestPolicyRequestsAutoOpen(policy: PullRequestPolicy | null | undefined) {
  return Boolean(policy?.autoOpen || policy?.requireResultBeforeArchive);
}

export function pullRequestPolicyBlocksArchive(policy: PullRequestPolicy | null | undefined) {
  return policy?.requireResultBeforeArchive === true;
}

type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

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
    ...(() => {
      const pullRequestPolicy = parsePullRequestPolicy(parsed.pullRequestPolicy);
      return pullRequestPolicy ? { pullRequestPolicy } : {};
    })(),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
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

export function parseIssueExecutionWorkspaceSettings(raw: unknown): IssueExecutionWorkspaceSettings | null {
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
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
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
