import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Default role-to-mode mapping for Bob Shell agents.
 * Maps agent roles to their corresponding Paperclip modes.
 */
const ROLE_MODE_MAP: Record<string, string> = {
  ceo: "paperclip-ceo",
  cto: "paperclip-cto",
  cmo: "paperclip-cmo",
  cfo: "paperclip-cfo",
  coo: "paperclip-coo",
  vp: "paperclip-vp",
  manager: "paperclip-manager",
  engineer: "paperclip-engineer",
};

/** Default Bob Shell mode when no role-specific mode is found */
const DEFAULT_MODE = "paperclip-agent";

/** Default maximum retry attempts for transient failures */
export const DEFAULT_MAX_RETRIES = 2;

/** Default retry delay in milliseconds */
export const DEFAULT_RETRY_DELAY_MS = 1000;

/** Default timeout in seconds (0 = no timeout) */
export const DEFAULT_TIMEOUT_SEC = 0;

/** Default grace period for SIGTERM before SIGKILL */
export const DEFAULT_GRACE_SEC = 20;

/**
 * Input parameters for building Bob Shell runtime configuration.
 */
export interface BobExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

/**
 * Complete runtime configuration for Bob Shell execution.
 * Contains all resolved paths, environment variables, and execution parameters.
 */
export interface BobRuntimeConfig {
  /** Bob Shell command to execute (e.g., "bob") */
  command: string;
  /** Resolved absolute path to the Bob Shell executable */
  resolvedCommand: string;
  /** Working directory for execution */
  cwd: string;
  /** Bob Shell mode to use (e.g., "paperclip-agent") */
  mode: string;
  /** Agent role (e.g., "ceo", "engineer") */
  agentRole: string;
  /** Workspace ID if using execution workspace */
  workspaceId: string | null;
  /** Repository URL if using git workspace */
  workspaceRepoUrl: string | null;
  /** Repository ref (branch/tag) if using git workspace */
  workspaceRepoRef: string | null;
  /** Environment variables for Bob Shell process */
  env: Record<string, string>;
  /** Environment variables safe for logging (secrets redacted) */
  loggedEnv: Record<string, string>;
  /** Execution timeout in seconds (0 = no timeout) */
  timeoutSec: number;
  /** Grace period for SIGTERM before SIGKILL */
  graceSec: number;
  /** Additional command-line arguments */
  extraArgs: string[];
}

/**
 * Builds complete runtime configuration for Bob Shell execution.
 * 
 * Resolves all paths, environment variables, and execution parameters needed
 * to run Bob Shell. Handles workspace context, wake parameters, and session
 * information.
 * 
 * @param input - Execution input parameters
 * @returns Complete runtime configuration
 * 
 * @example
 * ```typescript
 * const config = await buildBobRuntimeConfig({
 *   runId: "run-123",
 *   agent: { id: "agent-456", role: "engineer", ... },
 *   config: { mode: "paperclip-agent", cwd: "/workspace" },
 *   context: { taskId: "task-789" },
 *   authToken: "token-abc"
 * });
 * ```
 */
export async function buildBobRuntimeConfig(input: BobExecutionInput): Promise<BobRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  // Resolve Bob Shell command and mode
  const command = asString(config.command, "bob");
  const agentRole = asString((agent as unknown as Record<string, unknown>).role, "general");
  const defaultMode = ROLE_MODE_MAP[agentRole] ?? DEFAULT_MODE;
  const mode = asString(config.mode, defaultMode);

  // Extract workspace context
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;

  // Extract workspace hints and runtime services
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");

  // Resolve working directory
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build environment variables
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Extract wake context
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  // Set wake context environment variables
  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }

  // Set workspace environment variables
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  // Merge user-provided environment variables
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Set API key if not explicitly provided
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Resolve command and prepare logging environment
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  // Extract execution parameters
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const extraArgs = asStringArray(config.extraArgs);

  return {
    command,
    resolvedCommand,
    cwd,
    mode,
    agentRole,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}
