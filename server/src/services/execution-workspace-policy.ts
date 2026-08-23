import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
  SharedWorkspaceConcurrency,
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
    ...(typeof parsed.existingBranch === "string" && parsed.existingBranch.trim().length > 0
      ? { existingBranch: parsed.existingBranch.trim() }
      : {}),
    ...(typeof parsed.worktreeParentDir === "string" ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.runtimeProvisionCommand === "string"
      ? { runtimeProvisionCommand: parsed.runtimeProvisionCommand }
      : {}),
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
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
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
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
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

/**
 * A low-trust review run is isolated regardless of what anything else asked for. Shared by the
 * dispatch path and by the suppressed-policy diagnosis below so the two never drift.
 */
export function applyLowTrustWorkspaceIsolation(
  mode: ParsedExecutionWorkspaceMode,
  lowTrustReview: boolean,
): ParsedExecutionWorkspaceMode {
  return lowTrustReview && mode === "shared_workspace" ? "isolated_workspace" : mode;
}

/**
 * Key-order-independent structural comparison, so an equal value written differently stays equal.
 * An empty record collapses to null: it carries no fields, so setting a config key to `{}` and
 * leaving that key unset configure the same thing.
 */
function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested: unknown) => {
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
      const entries = Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return entries.length > 0 ? Object.fromEntries(entries) : null;
    }) ?? "null"
  );
}

type ExecutionWorkspaceControlInput = {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
  agentConfig: Record<string, unknown>;
  lowTrustReview: boolean;
};

/**
 * Everything the isolated-workspaces gate can change about a run's workspace: the mode, the
 * shared-workspace concurrency, and the two adapter-config keys workspace control rewrites.
 */
function resolveExecutionWorkspaceControl(input: ExecutionWorkspaceControlInput) {
  const mode = applyLowTrustWorkspaceIsolation(
    resolveExecutionWorkspaceMode({
      projectPolicy: input.projectPolicy,
      issueSettings: input.issueSettings,
      legacyUseProjectWorkspace: input.legacyUseProjectWorkspace,
    }),
    input.lowTrustReview,
  );
  const adapterConfig = buildExecutionWorkspaceAdapterConfig({
    agentConfig: input.agentConfig,
    projectPolicy: input.projectPolicy,
    issueSettings: input.issueSettings,
    mode,
    legacyUseProjectWorkspace: input.legacyUseProjectWorkspace,
  });
  return {
    mode,
    sharedWorkspaceConcurrency: resolveSharedWorkspaceConcurrency({
      projectPolicy: input.projectPolicy,
      issueSettings: input.issueSettings,
    }),
    // Fingerprint the *effective* strategy, not the raw config key: an absent key and an explicit
    // `project_primary` resolve to the same strategy, so they must not read as a difference.
    adapterConfigFingerprint: stableJson([
      {
        ...(parseExecutionWorkspaceStrategy(adapterConfig.workspaceStrategy) ?? {}),
        type: resolveEffectiveWorkspaceStrategyType(mode, adapterConfig),
      },
      adapterConfig.workspaceRuntime ?? null,
    ]),
  };
}

/**
 * How the run's resolved mode reads to an operator diagnosing where their work landed.
 *
 * Only three of these are reachable here: with the policy and the issue settings both gated out,
 * the run resolves to `agent_default` (a legacy assignee override opting out of the project
 * workspace), to `shared_workspace`, or to `isolated_workspace` once a low-trust review run
 * escalates that. `operator_branch` needs a surviving policy or issue setting, so a suppressed run
 * never lands on it. Kept total over the mode union so a new mode cannot silently go undescribed.
 */
const WORKSPACE_PHRASE_BY_MODE: Record<ParsedExecutionWorkspaceMode, string> = {
  shared_workspace: "the shared project workspace",
  isolated_workspace: "an isolated workspace",
  operator_branch: "an operator branch workspace",
  agent_default: "the agent's own configured workspace",
};

/**
 * Describe a project execution workspace policy that is configured but not applied.
 *
 * {@link gateProjectExecutionWorkspacePolicy} drops the whole policy when the isolated-workspaces
 * instance feature is off, and downstream resolution then cannot tell "this project has no policy"
 * apart from "this project's policy was discarded": the run silently falls back while the project
 * API keeps echoing the policy back exactly as configured. Callers use this to name the discard on
 * the run instead of leaving the operator to infer it from a checkout that never got its worktrees.
 *
 * The warning fires only when the gate actually changes the run, established by resolving workspace
 * control both ways rather than by inspecting which fields the policy happens to carry: a policy
 * persisting accepted defaults (`defaultMode: "shared_workspace"`, `sharedWorkspaceConcurrency:
 * "auto"`, empty sub-objects) resolves identically with and without the gate and stays silent. It
 * names the workspace the run resolved to rather than assuming the shared project checkout, which
 * an `agent_default` override or a low-trust review run would not be.
 *
 * Returns null whenever there is nothing to warn about — the policy is applied, absent, disabled,
 * or changes nothing.
 */
export function describeSuppressedProjectExecutionWorkspacePolicy(input: {
  /** The parsed, *ungated* project policy — the one the gate is about to discard. */
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  /** The parsed, *ungated* issue settings; the same gate drops these alongside the policy. */
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
  agentConfig: Record<string, unknown>;
  lowTrustReview: boolean;
  isolatedWorkspacesEnabled: boolean;
}): string | null {
  if (input.isolatedWorkspacesEnabled) return null;
  if (!input.projectPolicy?.enabled) return null;

  const shared = {
    legacyUseProjectWorkspace: input.legacyUseProjectWorkspace,
    agentConfig: input.agentConfig,
    lowTrustReview: input.lowTrustReview,
  };
  // What the run would get with the flag on, against what it is actually getting with it off.
  const applied = resolveExecutionWorkspaceControl({
    ...shared,
    projectPolicy: input.projectPolicy,
    issueSettings: input.issueSettings,
  });
  const suppressed = resolveExecutionWorkspaceControl({ ...shared, projectPolicy: null, issueSettings: null });
  if (
    applied.mode === suppressed.mode &&
    applied.sharedWorkspaceConcurrency === suppressed.sharedWorkspaceConcurrency &&
    applied.adapterConfigFingerprint === suppressed.adapterConfigFingerprint
  ) {
    return null;
  }

  const details = [
    ...(input.projectPolicy.defaultMode ? [`default mode "${input.projectPolicy.defaultMode}"`] : []),
    ...(input.projectPolicy.workspaceStrategy?.type
      ? [`workspace strategy "${input.projectPolicy.workspaceStrategy.type}"`]
      : []),
  ];
  const detailSuffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return (
    `This project configures an execution workspace policy${detailSuffix}, but the "Isolated Workspaces" ` +
    `instance feature is disabled, so the policy is not applied and this run uses ` +
    `${WORKSPACE_PHRASE_BY_MODE[suppressed.mode]} instead. Enable "Isolated Workspaces" in instance ` +
    "settings for the project policy to take effect."
  );
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
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
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
  const networkEgress = parseObject(parsed.networkEgress);
  const allowFqdns = Array.isArray(networkEgress.allowFqdns)
    ? networkEgress.allowFqdns
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase())
    : [];
  const allowCidrs = Array.isArray(networkEgress.allowCidrs)
    ? networkEgress.allowCidrs
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
    ...(options.includeEnvironmentId && (typeof parsed.environmentId === "string" || parsed.environmentId === null)
      ? { environmentId: parsed.environmentId }
      : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(allowFqdns.length > 0 || allowCidrs.length > 0
      ? { networkEgress: { allowFqdns, allowCidrs } }
      : {}),
  };
}

export function selectEnvironmentExecutionWorkspaceSettings(
  parsedSettings: IssueExecutionWorkspaceSettings | null,
  isolatedWorkspacesEnabled: boolean,
): IssueExecutionWorkspaceSettings | null {
  if (!parsedSettings) return null;
  if (isolatedWorkspacesEnabled) return parsedSettings;
  return parsedSettings.networkEgress
    ? { networkEgress: parsedSettings.networkEgress }
    : null;
}

export type ExecutionWorkspaceEnvironmentSource =
  | "agent"
  | "instance"
  | "default"
  | "managed";

export type ExecutionWorkspaceEnvironmentResolution = {
  environmentId: string;
  source: ExecutionWorkspaceEnvironmentSource;
};

export class ManagedSandboxUnavailableError extends Error {
  constructor() {
    super(
      "This instance runs agents only in its platform-managed sandbox environment " +
        "(managed sandbox only), but no active managed sandbox environment exists — " +
        "its provider plugin may be unavailable. Refusing to fall back to local execution.",
    );
    this.name = "ManagedSandboxUnavailableError";
  }
}

export function resolveExecutionWorkspaceEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null;
  instanceDefaultEnvironmentId: string | null;
  localDefaultEnvironmentId: string;
  /**
   * Managed-sandbox-only policy (`enableManagedSandboxOnly`): any selection
   * that lands on the local environment is redirected to the managed
   * sandbox environment instead, and with no managed environment available
   * the resolution fails closed — never local. Non-local selections (ssh,
   * user-created sandboxes) are untouched: the policy hides local, it does
   * not forbid other environments.
   */
  managedSandboxOnly?: boolean;
  managedSandboxEnvironmentId?: string | null;
}): ExecutionWorkspaceEnvironmentResolution {
  const resolved = ((): ExecutionWorkspaceEnvironmentResolution => {
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
  })();
  if (input.managedSandboxOnly !== true || resolved.environmentId !== input.localDefaultEnvironmentId) {
    return resolved;
  }
  if (!input.managedSandboxEnvironmentId) {
    throw new ManagedSandboxUnavailableError();
  }
  return { environmentId: input.managedSandboxEnvironmentId, source: "managed" };
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

function parseSharedWorkspaceConcurrency(raw: unknown): SharedWorkspaceConcurrency | undefined {
  return raw === "auto" || raw === "serialize" || raw === "allow" ? raw : undefined;
}

export function resolveSharedWorkspaceConcurrency(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): SharedWorkspaceConcurrency {
  return input.issueSettings?.sharedWorkspaceConcurrency
    ?? (input.projectPolicy?.enabled ? input.projectPolicy.sharedWorkspaceConcurrency : undefined)
    ?? "auto";
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
