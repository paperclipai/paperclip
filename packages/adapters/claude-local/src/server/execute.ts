import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
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
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
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
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeMaxTurnsResult,
  isClaudeTransientUpstreamError,
  isClaudeSilentFailure,
  isClaudeUnknownSessionError,
  isClaudeQuotaExhausted,
  isClaudeImmutableThinkingBlockError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeImageProcessingError,
} from "./parse.js";
import { prepareClaudeConfigSeed, resolveSharedClaudeConfigDir } from "./claude-config.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { markAccountExhausted } from "./ccrotate-state.js";
import { readFileSync as readFileSyncNode } from "node:fs";
import os from "node:os";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeCommandSpec?: AdapterExecutionContext["runtimeCommandSpec"];
  executionTarget?: ReturnType<typeof readAdapterExecutionTarget>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
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

function isCcrotateAnthropicBaseUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const url = new URL(raw);
    return url.pathname.split("/").filter(Boolean).includes("ccrotate")
      || url.hostname.includes("ccrotate");
  } catch {
    return raw.includes("ccrotate");
  }
}

function applyCcrotateRunAuthEnv(input: {
  env: Record<string, string>;
  envConfig: Record<string, unknown>;
}): void {
  const paperclipApiKey = input.env.PAPERCLIP_API_KEY?.trim();
  if (!paperclipApiKey || !isCcrotateAnthropicBaseUrl(input.env.ANTHROPIC_BASE_URL)) return;

  if (!hasNonEmptyEnvValue(input.env, "ANTHROPIC_AUTH_TOKEN") || input.envConfig.ANTHROPIC_AUTH_TOKEN === undefined) {
    input.env.ANTHROPIC_AUTH_TOKEN = paperclipApiKey;
  }
  if (!hasNonEmptyEnvValue(input.env, "ANTHROPIC_API_KEY") || input.envConfig.ANTHROPIC_API_KEY === undefined) {
    input.env.ANTHROPIC_API_KEY = paperclipApiKey;
  }
}

interface CcrotateAdvanceInput {
  runId: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

interface CcrotateAdvanceResult {
  /** Whether we successfully invoked ccrotate (regardless of whether the active account changed). */
  invoked: boolean;
  /** The email ccrotate switched to. Same as before-switch when no rotation was possible. */
  toEmail: string | null;
  /** True when the active account differs from before — i.e., a real rotation happened. */
  switched: boolean;
  /** Best-effort skip reason when invoked=false (e.g. command not found, k8s target). */
  skipReason: string | null;
}

// Auto-allow extra-tier fallback. Without -y, ccrotate refuses to switch to
// extra-tier accounts in non-TTY contexts, which would defeat the retry path
// when the standard pool is exhausted.
const CCROTATE_NEXT_COMMAND = "ccrotate --target claude next --yes 2>&1";

function parseCcrotateNextOutput(output: string): { toEmail: string | null; switched: boolean } {
  const switched = output.match(/✓\s+Switched to account:\s*([^\s(]+)/);
  if (switched) {
    return { toEmail: switched[1] ?? null, switched: true };
  }
  const already = output.match(/✓\s+Already on\s+([^\s(]+)/);
  if (already) {
    return { toEmail: already[1] ?? null, switched: false };
  }
  return { toEmail: null, switched: false };
}

/**
 * Spawn `ccrotate next --yes` against the claude target on the same execution
 * target as the run. Used to recover from a mid-run 401 / quota-exhausted
 * failure by switching to a fresh account and retrying claude once.
 *
 * Best-effort: failure (ccrotate not installed, k8s execution target,
 * non-zero exit) returns `invoked=false` with a reason. Caller falls back to
 * the existing heartbeat-level recovery path in that case.
 */
/**
 * Write the just-burned account into ccrotate's shared tier-cache.json
 * with `serviceTier: 'exhausted'` and the parsed reset epoch. Same
 * advisory lock + atomic-rename recipe ccrotate uses; the contract
 * is the file format, not the code (see ccrotate-state.ts).
 *
 * Skipped for k8s execution targets — the file lives on the local pod's
 * filesystem (the same /paperclip PVC ccrotate-on-paperclip-0 reads),
 * so writing here only makes sense when the heartbeat run is executed
 * locally, which is the same condition `tryAdvanceCcrotateAccount`
 * already checks before calling `ccrotate next`.
 */
async function captureQuotaExhaustionToTierCache(input: {
  executionTarget: CcrotateAdvanceInput["executionTarget"];
  cwd: string;
  env: Record<string, string>;
  onLog: CcrotateAdvanceInput["onLog"];
  resetEpochSec: number;
  response: string | null;
}): Promise<void> {
  const { executionTarget, env, onLog, resetEpochSec, response } = input;
  if (executionTarget?.kind === "remote" && executionTarget.transport === "k8s") {
    return;
  }
  try {
    const home = env.HOME || env.PAPERCLIP_HOME || os.homedir();
    const profilesDir = path.join(home, ".ccrotate");
    const claudeJsonPath = path.join(home, ".claude.json");
    let activeEmail: string | null = null;
    try {
      const raw = readFileSyncNode(claudeJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
      activeEmail = parsed.oauthAccount?.emailAddress ?? null;
    } catch {
      // ~/.claude.json missing or malformed; can't attribute the burn
      return;
    }
    if (!activeEmail) return;
    markAccountExhausted(profilesDir, activeEmail, {
      reset5h: resetEpochSec,
      response,
    });
    await onLog(
      "stdout",
      `[paperclip] tier-cache: marked ${activeEmail} exhausted until ${new Date(resetEpochSec * 1000).toISOString()}\n`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void onLog("stderr", `[paperclip] tier-cache writeback failed: ${reason}\n`);
  }
}

async function tryAdvanceCcrotateAccount(
  input: CcrotateAdvanceInput,
): Promise<CcrotateAdvanceResult> {
  const { runId, executionTarget, cwd, env, onLog } = input;
  if (executionTarget?.kind === "remote" && executionTarget.transport === "k8s") {
    return { invoked: false, toEmail: null, switched: false, skipReason: "k8s_execution_target" };
  }
  try {
    const commandEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const proc = await runAdapterExecutionTargetShellCommand(
      runId,
      executionTarget,
      commandEnv.PATH
        ? `PATH=${shellQuote(commandEnv.PATH)} ${CCROTATE_NEXT_COMMAND}`
        : CCROTATE_NEXT_COMMAND,
      { cwd, env: commandEnv, timeoutSec: 15, graceSec: 5, onLog: async () => {} },
    );
    if (proc.timedOut) {
      return { invoked: false, toEmail: null, switched: false, skipReason: "ccrotate_timeout" };
    }
    if ((proc.exitCode ?? 0) !== 0) {
      return {
        invoked: false,
        toEmail: null,
        switched: false,
        skipReason: `ccrotate_exit_${proc.exitCode ?? "?"}`,
      };
    }
    const output = `${proc.stdout}\n${proc.stderr}`;
    const parsed = parseCcrotateNextOutput(output);
    return { invoked: true, toEmail: parsed.toEmail, switched: parsed.switched, skipReason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void onLog("stderr", `[paperclip] ccrotate advance failed: ${reason}\n`);
    return { invoked: false, toEmail: null, switched: false, skipReason: "ccrotate_threw" };
  }
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
  if (!executionTargetIsRemote) {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  }

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
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
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  applyCcrotateRunAuthEnv({ env, envConfig });

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
          assets: [
            {
              key: "skills",
              localDir: promptBundle.addDir,
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
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
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
    await runAdapterExecutionTargetShellCommand(
      runId,
      executionTarget,
      `mkdir -p ${shellQuote(remoteClaudeConfigDir)} && ` +
        `if [ -d ${shellQuote(remoteClaudeConfigSeedDir)} ]; then ` +
        `cp -R ${shellQuote(`${remoteClaudeConfigSeedDir}/.`)} ${shellQuote(remoteClaudeConfigDir)}/; ` +
        `fi`,
      {
        cwd,
        env,
        timeoutSec: Math.max(timeoutSec, 15),
        graceSec,
        onLog,
      },
    );
  }
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "claude",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
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

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  // BLO-6256: an empty stored promptBundleKey is NOT a license to resume blindly.
  // Sessions written before promptBundleKey was reliably persisted carry no key.
  // Resuming them silently inherits a stale system prompt (the AGENTS.md that
  // was in effect when the session was first created), so any subsequent change
  // to the agent's instructions is invisible to the running session. We treat
  // a missing key as "no proof the session matches the current prompt bundle"
  // and fall through to a fresh session, which re-injects agent-instructions.md
  // via --append-system-prompt-file on the next claude invocation.
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length > 0 && runtimePromptBundleKey === promptBundle.bundleKey;
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtimeSessionId);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    isValidUuid &&
    hasMatchingPromptBundle &&
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
  if (runtimeSessionId && !hasMatchingPromptBundle) {
    const storedKeyDescription = runtimePromptBundleKey.length > 0
      ? `"${runtimePromptBundleKey}"`
      : "(none stored)";
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle ${storedKeyDescription} and will not be resumed with "${promptBundle.bundleKey}".\n`,
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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
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
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(...buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions,
      targetIsSandbox: executionTargetIsSandbox,
    }));
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    args.push("--add-dir", effectivePromptBundleAddDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
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
    if (dangerouslySkipPermissions && executionTargetIsSandbox) {
      commandNotes.push(
        "Using a broad --allowedTools whitelist for sandbox execution because Claude rejects --dangerously-skip-permissions under root/sudo.",
      );
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
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
      onLog,
      terminalResultCleanup: {
        graceMs: terminalResultCleanupGraceMs,
        hasTerminalResult: ({ stdout }) => parseClaudeStreamJson(stdout).resultJson !== null,
      },
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
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
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      const fallbackErrorMessage = parseFallbackErrorMessage(proc);
      const transientUpstream =
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeTransientUpstreamError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientRetryNotBefore = transientUpstream
        ? extractClaudeRetryNotBefore({
            parsed: null,
            stdout: proc.stdout,
            stderr: proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
      const errorCode = loginMeta.requiresLogin
        ? "claude_auth_required"
        : transientUpstream
        ? "claude_transient_upstream"
        : null;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode,
        errorFamily: transientUpstream ? "transient_upstream" : null,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
          ...(transientRetryNotBefore
            ? { retryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(transientRetryNotBefore
            ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const rawResolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const poisonedPreviousMessageId = isClaudePoisonedPreviousMessageIdError(parsed);
    const parsedIsError = asBoolean(parsed.is_error, false);
    const resolvedSummary = parsedStream.summary || asString(parsed.result, "");
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
    // Trust the SDK's explicit success signal over the CLI's exit code. The
    // Claude CLI sometimes exits non-zero even after emitting
    // `{type:"result", subtype:"success", is_error:false}` (e.g. post-completion
    // cleanup hiccups, stderr writes from background tasks). Treating those as
    // failures re-queues already-completed agent work and burns budget — and
    // the resulting "Claude run failed: subtype=success: <summary>" message is
    // self-contradicting on its face.
    //
    // When `is_error` is true (the SDK's actual failure flag) we still mark
    // failed regardless of subtype — that's the quota / rate-limit path and
    // must continue to short-circuit. The downstream silent-failure detector
    // (isClaudeSilentFailure below) still runs on this path and catches the
    // "claimed success but did nothing real" subset.
    //
    // Auth-required exception: claude CLI emits
    // `{subtype:"success", is_error:false, result:"Not logged in · Please run /login"}`
    // when the OAuth refresh failed during init — the envelope reports
    // success but the result text screams auth failure. Trusting the
    // envelope here means the run gets classified as success with a
    // benign-sounding summary, the heartbeat upgrades errorCode to
    // adapter_failed (line 6207 of heartbeat.ts), and the ccrotate-aware
    // retry at line ~898 below NEVER fires because errorCode isn't
    // claude_auth_required. So a stale-active-account bug masquerades
    // as an inert "adapter failed" loop and the pool never advances.
    // Override claudeReportedSuccess when loginMeta says auth is needed.
    const claudeReportedSuccess =
      asString(parsed.subtype, "") === "success" && !parsedIsError && !loginMeta.requiresLogin;
    const failed =
      parsedIsError || loginMeta.requiresLogin || ((proc.exitCode ?? 0) !== 0 && !claudeReportedSuccess);
    const errorMessage = failed
      ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`
      : null;
    const quotaExhausted =
      failed && !loginMeta.requiresLogin && isClaudeQuotaExhausted(parsed);
    // Quota messages ("out of extra usage", "weekly limit reached", etc.) also
    // match the transient-upstream regex; classify quota first so the retry
    // schedule doesn't burn attempts against an already rate-limited account.
    const transientUpstream =
      failed &&
      !loginMeta.requiresLogin &&
      !quotaExhausted &&
      !clearSessionForMaxTurns &&
      !poisonedPreviousMessageId &&
      isClaudeTransientUpstreamError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientRetryNotBefore = transientUpstream
      ? extractClaudeRetryNotBefore({
          parsed,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage,
        })
      : null;
    const resolvedErrorCode = loginMeta.requiresLogin
      ? "claude_auth_required"
      : quotaExhausted
      ? "provider_quota_exhausted"
      : failed && clearSessionForMaxTurns
      ? "max_turns_exhausted"
      : failed && poisonedPreviousMessageId
      ? "claude_poisoned_previous_message_id"
      : transientUpstream
      ? "claude_transient_upstream"
      : null;
    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
      ...(failed && poisonedPreviousMessageId ? { stopReason: "claude_poisoned_previous_message_id" } : {}),
      ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
      ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
    };

    // Only check for silent failure when exit code indicates success.
    let silentFailure: { reason: string } | null = null;
    if (!failed) {
      const check = isClaudeSilentFailure(parsed, resolvedSummary);
      if (check.detected) {
        silentFailure = { reason: check.reason! };
      }
    }

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorCode: resolvedErrorCode,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      errorMessage,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: mergedResultJson,
      summary: resolvedSummary,
      silentFailure,
      clearSession:
        clearSessionForMaxTurns ||
        // Clear-on-error: a poisoned previous_message_id is a deterministic
        // state error. Force the server to drop persisted session state for
        // this issue so the next continuation starts from a clean slate.
        poisonedPreviousMessageId ||
        Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    let attempt = await runAttempt(sessionId ?? null);
    let resultOpts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean } = {
      fallbackSessionId: runtimeSessionId || runtime.sessionId,
    };

    if (sessionId && !attempt.proc.timedOut && (attempt.proc.exitCode ?? 0) !== 0) {
      const fallbackErrorMessage = attempt.parsed ? null : parseFallbackErrorMessage(attempt.proc);
      const sessionErrorKind = attempt.parsed
        ? isClaudeUnknownSessionError(attempt.parsed)
          ? "unknown"
          : isClaudePoisonedPreviousMessageIdError(attempt.parsed)
          ? "poisoned"
          : isClaudeImageProcessingError(attempt.parsed)
          ? "image"
          : isClaudeImmutableThinkingBlockError({
              parsed: attempt.parsed,
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              errorMessage: fallbackErrorMessage,
            })
          ? "immutable"
          : null
        : isClaudeImmutableThinkingBlockError({
            parsed: attempt.parsed,
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        ? "immutable"
        : null;

      if (sessionErrorKind !== null) {
        const resumeFailureReason =
          sessionErrorKind === "poisoned"
            ? "returned a poisoned message-id"
            : sessionErrorKind === "image"
            ? "contains an unprocessable image"
            : sessionErrorKind === "immutable"
            ? "contains immutable thinking blocks rejected by Claude"
            : "is unavailable";
        await onLog(
          "stdout",
          `[paperclip] Claude resume session "${sessionId}" ${resumeFailureReason}; retrying with a fresh session.\n`,
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
        attempt = await runAttempt(null);
        resultOpts = { fallbackSessionId: null, clearSessionOnMissingSession: true };
      }
    }

    let result = toAdapterResult(attempt, resultOpts);

    // ccrotate-aware retry: on auth/quota failure, advance ccrotate's active
    // account once and re-run claude with a fresh session. Catches the common
    // path where the active account's token expired or burned its quota mid
    // run, before propagating to the heartbeat-level recovery hook.
    if (
      result.errorCode === "claude_auth_required" ||
      result.errorCode === "provider_quota_exhausted"
    ) {
      // Capture runtime quota burns into the shared tier-cache state
      // BEFORE rotating, so the next `ccrotate next` invocation sees this
      // account as `serviceTier: 'exhausted'` and skips it. Without this
      // writeback, runtime burns are invisible to ccrotate's state machine
      // (Anthropic's per-org Usage API throttles its own probes), so the
      // pool can spiral into a retry storm rotating between exhausted
      // accounts that all look "no per-account data" in tier-cache.
      // Real incident 2026-05-08.
      const resultBag = result as unknown as Record<string, unknown>;
      const retryNotBeforeIso =
        typeof resultBag.retryNotBefore === "string"
          ? (resultBag.retryNotBefore as string)
          : null;
      if (result.errorCode === "provider_quota_exhausted" && retryNotBeforeIso) {
        const resetEpochSec = Math.floor(new Date(retryNotBeforeIso).getTime() / 1000);
        if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
          await captureQuotaExhaustionToTierCache({
            executionTarget,
            cwd,
            env,
            onLog,
            resetEpochSec,
            response: typeof result.summary === "string" ? result.summary : null,
          });
        }
      }
      const advance = await tryAdvanceCcrotateAccount({
        runId,
        executionTarget,
        cwd,
        env,
        onLog,
      });
      if (advance.invoked && advance.switched) {
        await onLog(
          "stdout",
          `[paperclip] ccrotate advanced to ${advance.toEmail ?? "<unknown>"} after ${result.errorCode}; retrying claude with a fresh session.\n`,
        );
        attempt = await runAttempt(null);
        result = toAdapterResult(attempt, {
          fallbackSessionId: null,
          clearSessionOnMissingSession: true,
        });
      } else if (advance.invoked && !advance.switched) {
        await onLog(
          "stdout",
          `[paperclip] ccrotate has no further account to rotate to (still on ${advance.toEmail ?? "<unknown>"}); leaving ${result.errorCode} for heartbeat-level recovery.\n`,
        );
      } else {
        await onLog(
          "stdout",
          `[paperclip] ccrotate advance skipped (${advance.skipReason ?? "unknown"}); leaving ${result.errorCode} for heartbeat-level recovery.\n`,
        );
      }
    }

    return result;
  } finally {
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
