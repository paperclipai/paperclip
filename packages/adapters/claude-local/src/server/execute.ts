import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import { weightedBudgetTokens } from "@paperclipai/adapter-utils";
import {
  runningProcesses,
  signalRunningProcess,
  type RunProcessResult,
} from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexTelemetryRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  selectPaperclipTaskMarkdown,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessSandboxExtraPaths,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  claudeModelUsageTotals,
  claudeAssistantMessageUsage,
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeMaxTurnsResult,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
} from "./parse.js";
import {
  materializeRemoteClaudeConfig,
  prepareClaudeConfigSeed,
  resolveManagedClaudeRuntimeStateDir,
  resolveSharedClaudeConfigDir,
  writePaperclipClaudeMcpConfig,
} from "./claude-config.js";
import { claudeCommandSupportsEffortFlag } from "./cli-capabilities.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  createClaudeAcpExecutor,
  formatClaudeAcpFallbackMessage,
  resolveClaudeExecutionEngineForRun,
} from "./acp.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeClaudeAcp = createClaudeAcpExecutor();

// The structured run-disposition contract for issue-scoped claude runs. Every
// other lane already carries this in its prompt (acpx engine, hermes,
// antigravity); claude_local carried it nowhere, which is why it sat at ~26%
// capture all week while the lanes that inject it sit at 99-100%.
const CLAUDE_DISPOSITION_CONTRACT = [
  "## Run disposition (required)",
  "",
  "Record the real issue state through Paperclip as you normally would. Then, whether or not that write succeeded, make the FINAL line of your response exactly this record so the platform can read your decision even when a status PATCH fails:",
  "",
  'PAPERCLIP_DISPOSITION: {"status":"done|cancelled|in_review|blocked","hasBlocker":true|false,"blocker":"<short reason, only when blocked>"}',
  "",
  "A prose status sentence is not a disposition. Do not omit the line because the PATCH succeeded — the line is how the run is recorded.",
].join("\n");

// One bounded follow-up turn in the SAME session when a clean run states no
// disposition, mirroring the acpx engine and hermes (both went to ~100% capture
// the day their re-ask shipped). Never more than one re-ask per run.
const CLAUDE_DISPOSITION_REASK_TIMEOUT_SEC = 90;
const CLAUDE_DISPOSITION_REASK_PROMPT =
  "Your previous reply did not end with the required PAPERCLIP_DISPOSITION line. " +
  "Reply with exactly ONE line and nothing else, reflecting the work you just did on this issue: " +
  'PAPERCLIP_DISPOSITION: {"status":"done|cancelled|in_review|blocked","hasBlocker":true|false,"blocker":"<named blocker, or empty>"}';

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeCommandSpec?: AdapterExecutionContext["runtimeCommandSpec"];
  executionTarget?: ReturnType<typeof readAdapterExecutionTarget>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: { eventType: string; level?: string; message?: string; payload?: Record<string, any> }) => Promise<void>;
}

interface ClaudeRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

export function claudeSessionCwdMatchesExecutionTarget(input: {
  runtimeSessionCwd: string;
  effectiveExecutionCwd: string;
  executionTargetIsRemote: boolean;
}): boolean {
  if (input.executionTargetIsRemote || input.runtimeSessionCwd.length === 0) return true;
  return path.resolve(input.runtimeSessionCwd) === path.resolve(input.effectiveExecutionCwd);
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, runtimeCommandSpec, executionTarget, authToken } = input;
  const onLog = input.onLog ?? (async () => {});

  const command = asString(config.command, "claude");
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
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
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
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (issueWorkMode) {
    env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
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
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
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
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
  }

  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: runtimeCommandSpec?.installCommand,
    detectCommand: runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
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

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: { eventType: string; level?: string; message?: string; payload?: Record<string, any> }) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runAdapterExecutionTargetProcess(input.runId, null, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveClaudeExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeClaudeAcp(ctx);
    } catch (err) {
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stderr",
        formatClaudeAcpFallbackMessage(`Claude ACP startup failed: ${reason}`),
      );
    }
  }
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatClaudeAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const executionTargetIsSandbox = executionTarget?.kind === "remote" && executionTarget.transport === "sandbox";

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const maxTokensPerRun = Math.max(0, asNumber(config.maxTokensPerRun, 0));
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const configEnv = parseObject(config.env);
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const hasExplicitClaudeConfigDir =
    typeof configEnv.CLAUDE_CONFIG_DIR === "string" && configEnv.CLAUDE_CONFIG_DIR.trim().length > 0;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    runtimeCommandSpec: ctx.runtimeCommandSpec,
    executionTarget,
    authToken,
    onLog,
  });
  const {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv: initialLoggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  let loggedEnv = initialLoggedEnv;
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const terminalResultCleanupGraceMs = Math.max(
    0,
    asNumber(config.terminalResultCleanupGraceMs, 5_000),
  );
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, claudeSkillEntries));
  // When instructionsFilePath is configured, build a stable content-addressed
  // file that includes both the file content and the path directive, so we only
  // need --append-system-prompt-file (Claude CLI forbids using both flags together).
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: claudeSkillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    instructionsContents: combinedInstructionsContents,
    onLog,
  });
  const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  const runtimeMcpIdentity = JSON.stringify(
    runtimeMcpServers.map(({ name, url, connectionId }) => ({ name, url, connectionId })),
  );
  const claudeRuntimeStateDir = resolveManagedClaudeRuntimeStateDir(
    process.env,
    agent.companyId,
    agent.id,
  );
  const localMcpConfigPath = await writePaperclipClaudeMcpConfig({
    stateDir: claudeRuntimeStateDir,
    runId,
    servers: runtimeMcpServers,
  });
  const localMcpConfigDir = path.dirname(localMcpConfigPath);
  const sharedClaudeConfigDir = resolveSharedClaudeConfigDir(process.env);
  const networkScope = parseLocalProcessNetworkScope(config.networkScope);
  const filesystemScope = parseLocalProcessFilesystemScope(config.filesystemScope);
  const localProcessSandbox: LocalProcessSandboxOptions | null =
    (filesystemScope || networkScope) && !executionTargetIsRemote
      ? {
          workspaceDir: effectiveExecutionCwd,
          filesystemScope,
          managedPaths: [
            { path: sharedClaudeConfigDir, access: "rw" },
            { path: path.join(path.dirname(sharedClaudeConfigDir), ".claude.json"), access: "rw" },
            { path: promptBundle.addDir, access: "ro" },
            { path: localMcpConfigDir, access: "ro" },
          ],
          extraPaths: parseLocalProcessSandboxExtraPaths(config.filesystemExtraPaths),
          homeDir: filesystemScope ? path.dirname(sharedClaudeConfigDir) : null,
          networkScope,
          networkAllowlist: parseLocalProcessNetworkAllowlist(config.networkAllowlist),
          networkTrustedUrls: [
            env.PAPERCLIP_API_URL,
            ...runtimeMcpServers.map((server) => server.url),
          ].filter((value): value is string => typeof value === "string" && value.length > 0),
          command: asString(config.filesystemSandboxCommand, "bwrap"),
        }
      : null;
  if (localProcessSandbox) {
    if (filesystemScope) env.CLAUDE_CONFIG_DIR = sharedClaudeConfigDir;
    const scopes = [filesystemScope ? "workspace filesystem" : null, networkScope ? `${networkScope} network` : null]
      .filter(Boolean)
      .join(" and ");
    await onLog(
      "stdout",
      `[paperclip] Confining Claude with ${scopes} scope.\n`,
    );
  }
  const useManagedRemoteClaudeConfig =
    executionTargetIsRemote &&
    adapterExecutionTargetUsesManagedHome(executionTarget) &&
    !hasExplicitClaudeConfigDir;
  const claudeConfigSeedDir = useManagedRemoteClaudeConfig
    ? await prepareClaudeConfigSeed(process.env, onLog, agent.companyId)
    : null;
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Claude runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "claude",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: promptBundle.addDir,
              followSymlinks: true,
            },
            {
              key: "mcp-config",
              localDir: localMcpConfigDir,
              followSymlinks: true,
            },
            ...(claudeConfigSeedDir
              ? [{
                key: "config-seed",
                localDir: claudeConfigSeedDir,
                followSymlinks: true,
              }]
              : []),
          ],
        });
      })()
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig: configEnv,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line))
    : null;
  const effectivePromptBundleAddDir = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.skills ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude", "skills")
    : promptBundle.addDir;
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath
    ? executionTargetIsRemote
      ? path.posix.join(effectivePromptBundleAddDir, path.basename(promptBundle.instructionsFilePath))
      : promptBundle.instructionsFilePath
    : undefined;
  const effectiveMcpConfigPath = executionTargetIsRemote
    ? path.posix.join(
        preparedExecutionTargetRuntime?.assetDirs["mcp-config"] ??
          path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude", "mcp-config"),
        path.basename(localMcpConfigPath),
      )
    : localMcpConfigPath;
  const remoteClaudeRuntimeRoot = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.runtimeRootDir ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude")
    : null;
  const remoteClaudeConfigSeedDir = claudeConfigSeedDir && remoteClaudeRuntimeRoot
    ? preparedExecutionTargetRuntime?.assetDirs["config-seed"] ??
      path.posix.join(remoteClaudeRuntimeRoot, "config-seed")
    : null;
  const remoteClaudeConfigDir = useManagedRemoteClaudeConfig && remoteClaudeRuntimeRoot
    ? path.posix.join(remoteClaudeRuntimeRoot, "config")
    : null;
  if (remoteClaudeConfigDir && remoteClaudeConfigSeedDir) {
    env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    await onLog(
      "stdout",
      `[paperclip] Materializing Claude auth/config into ${remoteClaudeConfigDir}.\n`,
    );
    await materializeRemoteClaudeConfig({
      runId,
      target: executionTarget,
      remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir,
      options: {
        cwd,
        env,
        timeoutSec: Math.max(timeoutSec, 15),
        graceSec,
        onLog,
      },
    });
  }
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
      duplexTelemetryRecorder: adapterExecutionTargetDuplexTelemetryRecorder(runtimeExecutionTarget),
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "claude",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
      netFetch: { companyId: agent.companyId },
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
      loggedEnv = buildInvocationEnvForLogs(env, {
        runtimeEnv,
        includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
        resolvedCommand,
      });
      if (remoteClaudeConfigDir) {
        loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      }
    }
  }
  let effectiveEffort = effort;
  if (executionTargetIsSandbox && effort) {
    const supportsEffort = await claudeCommandSupportsEffortFlag({
      runId,
      command,
      target: runtimeExecutionTarget,
      cwd,
      env,
      timeoutSec,
      graceSec,
    });
    if (supportsEffort === false) {
      effectiveEffort = "";
      await onLog(
        "stderr",
        `[paperclip] Claude CLI in the environment does not advertise --effort; omitting configured effort "${effort}". Upgrade the environment CLI/image to restore reasoning-effort control.\n`,
      );
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const runtimeMcpServerIdentity = asString(runtimeSessionParams.mcpServerIdentity, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const hasMatchingMcpServers =
    runtimeMcpServerIdentity.length === 0
      ? runtimeMcpServers.length === 0
      : runtimeMcpServerIdentity === runtimeMcpIdentity;
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtimeSessionId);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    isValidUuid &&
    hasMatchingPromptBundle &&
    hasMatchingMcpServers &&
    claudeSessionCwdMatchesExecutionTarget({
      runtimeSessionCwd,
      effectiveExecutionCwd,
      executionTargetIsRemote,
    }) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !isValidUuid) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" is not a valid UUID and will not be passed to --resume.\n`,
    );
  }
  if (
    executionTargetIsRemote &&
    runtimeSessionId &&
    isValidUuid &&
    !canResumeSession
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (
    runtimeSessionId &&
    isValidUuid &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(effectiveExecutionCwd)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && isValidUuid && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }
  if (runtimeSessionId && !hasMatchingMcpServers) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved with a different runtime MCP server set and will not be resumed.\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession: Boolean(sessionId) });
  const issueScopedRun =
    asString(parseObject(context.paperclipIssue).id, "").trim().length > 0 ||
    asString(context.issueId, "").trim().length > 0 ||
    asString(context.taskId, "").trim().length > 0;
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(sessionId),
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: taskContextNote.length > 0,
    // A fresh Claude session already receives the full task brief below. Do
    // not replay the prior-run summary into the same prompt.
    suppressContinuationSummary: !sessionId,
  });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  // 2026-08-23 (disposition gap): the structured disposition contract lived ONLY
  // in the GET /issues/:id/heartbeat-context response, so this lane received it
  // only when the agent happened to curl that endpoint. Measured over 89
  // succeeded issue-bound claude runs: 66 never fetched it and none of those
  // stated a marker, while 68% of the runs that DID see it complied — and zero
  // stated markers were lost to the parser. Carry the contract in the prompt
  // like every other lane, in last (highest-recency) position.
  const dispositionContractNote = issueScopedRun ? CLAUDE_DISPOSITION_CONTRACT : "";
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
    dispositionContractNote,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(...buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions,
      targetIsRemote: executionTargetIsRemote,
      localProcessUid: process.getuid?.() ?? null,
    }));
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effectiveEffort) args.push("--effort", effectiveEffort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    if (runtimeMcpServers.length > 0) {
      args.push("--mcp-config", effectiveMcpConfigPath, "--strict-mcp-config");
    }
    args.push("--add-dir", effectivePromptBundleAddDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  let tokenBudgetExceeded = false;
  let tokenBudgetObserved = 0;
  let predictedNextTurnTokens = 0;
  let tokenStreamRemainder = "";
  const observedMessageIds = new Set<string>();
  const observedMessageUsage: Required<UsageSummary> = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let forceKillTimer: NodeJS.Timeout | null = null;
  const boundedOnLog: AdapterExecutionContext["onLog"] = async (stream, chunk) => {
    await onLog(stream, chunk);
    if (stream !== "stdout" || tokenBudgetExceeded || maxTokensPerRun <= 0) return;
    const lines = `${tokenStreamRemainder}${chunk}`.split(/\r?\n/);
    tokenStreamRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseJson(line.trim());
      const observed = claudeAssistantMessageUsage(event);
      if (!observed) continue;
      if (!observedMessageIds.has(observed.messageId)) {
        predictedNextTurnTokens = 0;
        observedMessageIds.add(observed.messageId);
        observedMessageUsage.inputTokens += observed.usage.inputTokens;
        observedMessageUsage.cachedInputTokens += observed.usage.cachedInputTokens ?? 0;
        observedMessageUsage.outputTokens += observed.usage.outputTokens;
      }
      if (observed.hasToolUse) {
        predictedNextTurnTokens = Math.max(predictedNextTurnTokens, observed.weightedInputTokensForTurn);
      }
    }
    // Budget-weighted: cache reads count at CACHED_INPUT_BUDGET_WEIGHT so a
    // multi-turn run is not charged turns x resident-context (TSMC-20840).
    tokenBudgetObserved = weightedBudgetTokens(observedMessageUsage);
    const nextTurnWouldExhaustBudget =
      predictedNextTurnTokens > 0 &&
      tokenBudgetObserved + predictedNextTurnTokens >= maxTokensPerRun;
    if (tokenBudgetObserved < maxTokensPerRun && !nextTurnWouldExhaustBudget) return;

    tokenBudgetExceeded = true;
    await onLog(
      "stderr",
      nextTurnWouldExhaustBudget && tokenBudgetObserved < maxTokensPerRun
        ? `[paperclip] Claude maxTokensPerRun budget of ${maxTokensPerRun} tokens cannot fit the next model turn (observed ${tokenBudgetObserved}, projected next-turn input ${predictedNextTurnTokens}); stopping before tool execution.\n`
        : `[paperclip] Claude maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}); stopping before another model turn.\n`,
    );
    const running = runningProcesses.get(runId);
    if (running) signalRunningProcess(running, "SIGTERM");
    forceKillTimer = setTimeout(() => {
      const stillRunning = runningProcesses.get(runId);
      if (stillRunning) signalRunningProcess(stillRunning, "SIGKILL");
    }, Math.max(1, graceSec) * 1000);
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (dangerouslySkipPermissions && executionTargetIsRemote) {
      commandNotes.push(
        "Using a broad --allowedTools whitelist for remote execution so hosted targets do not inherit local Claude bypass permissions.",
      );
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      );
    }
    if (runtimeMcpServers.length > 0) {
      commandNotes.push(
        `Using ${runtimeMcpServers.length} Paperclip-managed MCP server(s) from strict config ${effectiveMcpConfigPath}.`,
      );
    }
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: boundedOnLog,
      runLogTail: paperclipBridge?.runLogTail,
      terminalResultCleanup: {
        graceMs: terminalResultCleanupGraceMs,
        hasTerminalResult: ({ stdout }) => parseClaudeStreamJson(stdout).resultJson !== null,
      },
      localProcessSandbox,
    });

    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    const parsedStream = parseClaudeStreamJson(proc.stdout);
    if (parsedStream.usage) {
      const finalObserved = weightedBudgetTokens(parsedStream.usage);
      tokenBudgetObserved = Math.max(tokenBudgetObserved, finalObserved);
      if (maxTokensPerRun > 0 && tokenBudgetObserved >= maxTokensPerRun) {
        tokenBudgetExceeded = true;
      }
    }
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  // Bounded in-run disposition re-ask. Runs only after a clean, successful
  // attempt that stated nothing: one resumed turn, hard-capped turns/time, and
  // skipped entirely when the token budget is already spent so it can never be
  // the thing that pushes a run over the governor's cap.
  const readAttemptDisposition = (attempt: {
    parsedStream: ReturnType<typeof parseClaudeStreamJson>;
  }) => {
    const resultJson = attempt.parsedStream.resultJson;
    if (!resultJson) return null;
    const disposition = (resultJson as Record<string, unknown>).disposition;
    return disposition && typeof disposition === "object" ? disposition : null;
  };

  const maybeReaskDisposition = async <
    T extends {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
  >(attempt: T): Promise<T> => {
    if (!issueScopedRun) return attempt;
    if (tokenBudgetExceeded) return attempt;
    if (attempt.proc.timedOut) return attempt;
    if ((attempt.proc.exitCode ?? 0) !== 0) return attempt;
    // Same success test toAdapterResult applies (`parsedSucceeded`) rather than
    // isClaudeCompletedSuccessResult, which additionally demands a
    // `terminal_reason` some CLI builds omit — a run that exited 0 with a
    // success result is exactly the run we want a disposition from.
    if (!attempt.parsed) return attempt;
    if (asString(attempt.parsed.subtype, "").trim().toLowerCase() !== "success") return attempt;
    if (attempt.parsed.is_error === true) return attempt;
    if (readAttemptDisposition(attempt)) return attempt;
    const reaskSessionId =
      attempt.parsedStream.sessionId || asString(attempt.parsed.session_id, "").trim();
    if (!reaskSessionId) return attempt;

    const reaskArgs = buildClaudeArgs(reaskSessionId, undefined).filter((arg, index, all) => {
      if (arg === "--max-turns") return false;
      return all[index - 1] !== "--max-turns";
    });
    reaskArgs.push("--max-turns", "2");
    await onLog("stdout", "[paperclip] disposition re-ask: one bounded turn in the same session\n");
    let reaskProc: RunProcessResult;
    try {
      reaskProc = await runAdapterExecutionTargetProcess(
        runId,
        runtimeExecutionTarget,
        command,
        reaskArgs,
        {
          cwd,
          env,
          stdin: CLAUDE_DISPOSITION_REASK_PROMPT,
          timeoutSec: CLAUDE_DISPOSITION_REASK_TIMEOUT_SEC,
          graceSec,
          onSpawn,
          // Deliberately the raw logger: the budget-accounting logger would let
          // the re-ask flip tokenBudgetExceeded and fail an otherwise clean run.
          onLog,
          localProcessSandbox,
        },
      );
    } catch {
      return attempt;
    }
    const reaskStream = parseClaudeStreamJson(reaskProc.stdout);
    const reaskDisposition = readAttemptDisposition({ parsedStream: reaskStream });
    if (!reaskDisposition) {
      await onLog("stdout", "[paperclip] disposition re-ask: still no disposition stated\n");
      return attempt;
    }
    await onLog(
      "stdout",
      `[paperclip] disposition re-ask: captured ${asString((reaskDisposition as Record<string, unknown>).status, "unknown")}\n`,
    );
    const mergedResultJson = { ...(attempt.parsedStream.resultJson ?? {}), disposition: reaskDisposition };
    return {
      ...attempt,
      parsedStream: { ...attempt.parsedStream, resultJson: mergedResultJson },
      parsed: mergedResultJson,
    };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      // Include whatever the stream parser saw before the timeout so partial
      // usage/cost/session data is not lost on timed-out runs.
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        ...(parsedStream.usage ? { usage: parsedStream.usage } : {}),
        ...(parsedStream.costUsd != null ? { costUsd: parsedStream.costUsd } : {}),
        ...(parsedStream.sessionId
          ? { sessionId: parsedStream.sessionId, sessionDisplayId: parsedStream.sessionId }
          : {}),
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      if (tokenBudgetExceeded) {
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: false,
          errorMessage:
            `Claude maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}).`,
          errorCode: "token_budget_exhausted",
          usage: observedMessageUsage,
          usageBasis: "per_run",
          provider: "anthropic",
          biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
          model,
          billingType,
          resultJson: {
            stopReason: "token_budget_exhausted",
            maxTokensPerRun,
            observedTokens: tokenBudgetObserved,
            ...(predictedNextTurnTokens > 0 ? { predictedNextTurnTokens } : {}),
          },
          clearSession: true,
        };
      }
      const fallbackErrorMessage = parseFallbackErrorMessage(proc);
      const providerQuota =
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeProviderQuotaError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientUpstream =
        !loginMeta.requiresLogin &&
        !providerQuota &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeTransientUpstreamError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientRetryNotBefore = providerQuota || transientUpstream
        ? extractClaudeRetryNotBefore({
            parsed: null,
            stdout: proc.stdout,
            stderr: proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
      const errorCode = loginMeta.requiresLogin
        ? "claude_auth_required"
        : isClaudeModelNotFoundError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        })
        ? "model_not_found"
        : providerQuota
        ? "provider_quota"
        : transientUpstream
        ? "claude_transient_upstream"
        : null;
      const errorFamily = providerQuota ? "provider_quota" : transientUpstream ? "transient_upstream" : null;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode,
        errorFamily,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(transientRetryNotBefore
            ? { retryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(transientRetryNotBefore
            ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(providerQuota && transientRetryNotBefore
            ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const fallbackModelUsageTotals = parsedStream.usage ? null : claudeModelUsageTotals(parsed.modelUsage);
    const usage =
      parsedStream.usage ??
      fallbackModelUsageTotals ??
      (tokenBudgetExceeded ? observedMessageUsage : null) ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();
    const usageBasis = parsedStream.usage
      ? parsedStream.usageBasis
      : fallbackModelUsageTotals
      ? ("per_run" as const)
      : null;

    const rawResolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const poisonedPreviousMessageId = isClaudePoisonedPreviousMessageIdError(parsed);
    // Fable 5 policy refusals exit cleanly (exitCode=0, is_error=false), so this
    // is intentionally independent of `failed` — otherwise a refusal looks like a
    // successful run to Paperclip and the heartbeat stalls silently. See RY-604.
    const claudeRefusal = isClaudeRefusalResult(parsed);
    const parsedIsError = asBoolean(parsed.is_error, false);
    const parsedSubtype = asString(parsed.subtype, "").trim().toLowerCase();
    const parsedSucceeded = parsedSubtype === "success" && !parsedIsError;
    const failed = tokenBudgetExceeded || (!parsedSucceeded && ((proc.exitCode ?? 0) !== 0 || parsedIsError));
    // Validate-before-persist guard: never persist a sessionId whose transcript
    // is known-poisoned. The Claude CLI keeps an on-disk JSONL keyed by the
    // session id; if the last entry contains a non-`msg_`-prefixed
    // `previous_message_id`, every subsequent `--resume` hits a 400 from
    // /v1/messages and the issue is permanently unrecoverable until the
    // sessionId is dropped server-side. Drop here so resolveNextSessionState
    // calls clearTaskSessions on the next heartbeat. See RED-978 / RED-976.
    const shouldDropSessionForPoison = poisonedPreviousMessageId;
    const resolvedSessionId = shouldDropSessionForPoison ? null : rawResolvedSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        promptBundleKey: promptBundle.bundleKey,
        mcpServerIdentity: runtimeMcpIdentity,
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const errorMessage = tokenBudgetExceeded
      ? `Claude maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}).`
      : failed
      ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`
      : null;
    const providerQuota =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      !poisonedPreviousMessageId &&
      isClaudeProviderQuotaError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientUpstream =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      !poisonedPreviousMessageId &&
      !providerQuota &&
      isClaudeTransientUpstreamError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientRetryNotBefore = providerQuota || transientUpstream
      ? extractClaudeRetryNotBefore({
          parsed,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage,
        })
      : null;
    const resolvedErrorCode = tokenBudgetExceeded
      ? "token_budget_exhausted"
      : loginMeta.requiresLogin
      ? "claude_auth_required"
      : failed && isClaudeModelNotFoundError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      })
      ? "model_not_found"
      : failed && clearSessionForMaxTurns
      ? "max_turns_exhausted"
      : failed && poisonedPreviousMessageId
      ? "claude_poisoned_previous_message_id"
      : providerQuota
      ? "provider_quota"
      : transientUpstream
      ? "claude_transient_upstream"
      : claudeRefusal
      ? "claude_refusal"
      : null;
    const errorFamily = providerQuota
      ? "provider_quota"
      : transientUpstream
      ? "transient_upstream"
      : claudeRefusal
      ? "model_refusal"
      : null;
    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(tokenBudgetExceeded
        ? {
          stopReason: "token_budget_exhausted",
          maxTokensPerRun,
          observedTokens: tokenBudgetObserved,
          ...(predictedNextTurnTokens > 0 ? { predictedNextTurnTokens } : {}),
        }
        : {}),
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
      ...(failed && poisonedPreviousMessageId ? { stopReason: "claude_poisoned_previous_message_id" } : {}),
      ...(claudeRefusal ? { stopReason: "refusal", errorFamily: "model_refusal" } : {}),
      ...(errorFamily ? { errorFamily } : {}),
      ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(providerQuota && transientRetryNotBefore ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
    };

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: resolvedErrorCode,
      errorFamily,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      errorMeta,
      usage,
      ...(usageBasis ? { usageBasis } : {}),
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd,
      resultJson: mergedResultJson,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession:
        tokenBudgetExceeded ||
        clearSessionForMaxTurns ||
        // Clear-on-error: a poisoned previous_message_id is a deterministic
        // state error. Force the server to drop persisted session state for
        // this issue so the next continuation starts from a clean slate.
        poisonedPreviousMessageId ||
        Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    let finalAttempt = initial;
    let fallbackSessionId = runtimeSessionId || runtime.sessionId;
    let clearSessionOnMissingSession = false;

    const sessionErrorKind =
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed
        ? isClaudeUnknownSessionError(initial.parsed)
          ? "unknown"
          : isClaudePoisonedPreviousMessageIdError(initial.parsed)
          ? "poisoned"
          : isClaudeImageProcessingError(initial.parsed)
          ? "image"
          : null
        : null;

    if (sessionErrorKind !== null) {
      const reason =
        sessionErrorKind === "poisoned"
          ? "returned a poisoned message-id"
          : sessionErrorKind === "image"
          ? "contains an unprocessable image"
          : "is unavailable";
      await onLog(
        "stdout",
        `[paperclip] Claude resume session "${sessionId}" ${reason}; retrying with a fresh session.\n`,
      );
      if (sessionErrorKind === "poisoned" && !executionTargetIsRemote) {
        const claudeConfigDir = resolveSharedClaudeConfigDir(effectiveEnv);
        // Mirrors Claude Code's project-dir encoding: non-alphanumeric chars become "-"; existing hyphens pass through.
        const encodedCwd = effectiveExecutionCwd.replace(/[^a-zA-Z0-9-]/g, "-");
        const poisonedJsonlPath = path.join(claudeConfigDir, "projects", encodedCwd, `${sessionId}.jsonl`);
        let unlinked = false;
        try {
          await fs.unlink(poisonedJsonlPath);
          unlinked = true;
        } catch {
          // best-effort; session is cleared server-side regardless
        }
        if (unlinked) {
          try {
            await onLog("stdout", `[paperclip] Removed poisoned session file: ${poisonedJsonlPath}\n`);
          } catch {
            // log stream may be closed; the unlink already succeeded
          }
        }
      }
      // Local: fall through to a single toAdapterResult below (which also runs
      // our transient_upstream retry-schedule logging) instead of an early return.
      finalAttempt = await runAttempt(null);
      fallbackSessionId = null;
      clearSessionOnMissingSession = true;
    }

    finalAttempt = await maybeReaskDisposition(finalAttempt);

    const result = toAdapterResult(finalAttempt, { fallbackSessionId, clearSessionOnMissingSession });

    if (result.errorFamily === "transient_upstream") {
      await onLog(
        "stderr",
        `[paperclip] Detected transient upstream error (e.g. rate limit). \n`,
      );
      if (result.retryNotBefore) {
        await onLog("stderr", `[paperclip] Retry scheduled after ${result.retryNotBefore}\n`);
      }
    }

    return result;
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (paperclipBridge) {
      await paperclipBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
