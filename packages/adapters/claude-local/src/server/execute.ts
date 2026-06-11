import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { pickNextSeat, resetSeatRotation } from "./seat-rotation.js";
import { executeClaudeLocalWithFailover, type Tier0RawOutcome } from "./failover.js";
import { isRecoverable } from "./classifier.js";
import { buildTier1Gate, recordTier1Cost } from "./tier1-cost-cap.js";
import { fetchBlueprintWorkerKey } from "./secret-fetch.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
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
  const { runId, agent, config, context, authToken } = input;

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
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

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

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
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

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
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

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
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
  } = runtimeConfig;
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
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath ?? undefined;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    hasMatchingPromptBundle &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (
    runtimeSessionId &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(cwd)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
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
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
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
    args.push("--add-dir", promptBundle.addDir);
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

  const runAttempt = async (
    resumeSessionId: string | null,
    envOverride?: Record<string, string>,
  ) => {
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const attemptEnv = envOverride ? { ...env, ...envOverride } : env;
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
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
        cwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: attemptEnv,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
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
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
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

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        promptBundleKey: promptBundle.bundleKey,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
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
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // ── Helper: emit token usage to model-usage.jsonl (ROCAA-325) ───────────────
  const emitUsage = async (result: AdapterExecutionResult) => {
    const usage = result.usage;
    if (!usage) return;
    const logDir = path.join(homedir(), "architect-os", "logs");
    const logPath = path.join(logDir, "model-usage.jsonl");
    try {
      await fs.mkdir(logDir, { recursive: true });
      const rec = JSON.stringify({
        ts: new Date().toISOString(),
        runId,
        issueId: ctx.context.issueId ?? ctx.context.taskId ?? null,
        agentId: agent.id,
        model: result.model ?? model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        costUsd: result.costUsd ?? 0,
        actionType: "heartbeat",
        tier: "0",
      });
      await fs.appendFile(logPath, `${rec}\n`, "utf8");
    } catch {
      // Best-effort — never crash the dispatch path.
    }
  };

  const initial = await runAttempt(sessionId ?? null);

  // ── Unknown-session retry (existing logic) ────────────────────────────────
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    initial.parsed &&
    isClaudeUnknownSessionError(initial.parsed)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    const result = toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    if (!result.errorCode) resetSeatRotation();
    await emitUsage(result);
    return result;
  }

  // ── $0 Max-seat rotation on auth_required (ROCAA-325 Tier 0a) ────────────
  let lastRaw: Tier0RawOutcome = initial;
  let candidate = toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  while (candidate.errorCode === "claude_auth_required") {
    const { profileDir, allExhausted } = pickNextSeat();
    if (allExhausted || !profileDir) {
      await onLog(
        "stdout",
        `[paperclip] All $0 Max seats exhausted; proceeding to Tier 1 gate.\n`,
      );
      break;
    }
    await onLog(
      "stdout",
      `[paperclip] Seat auth_required — rotating to profile ${profileDir}.\n`,
    );
    const seatAttempt = await runAttempt(null, {
      HOME: profileDir,
      CLAUDE_CONFIG_DIR: profileDir,
    });
    lastRaw = seatAttempt;
    candidate = toAdapterResult(seatAttempt, { fallbackSessionId: null });
  }

  // ── Short-circuit on Tier 0 success ──────────────────────────────────────
  if ((candidate.exitCode ?? 0) === 0 && !candidate.errorCode) {
    resetSeatRotation();
    await emitUsage(candidate);
    return candidate;
  }

  // ── Tier 0b: agentic Anthropic-API re-spawn (cost-gated) ─────────────────
  // Subscription seats are exhausted but the failure is recoverable (e.g.
  // rate_limit). Run ONE fully-agentic attempt on the metered Anthropic API
  // before giving up: runAttempt() with ANTHROPIC_API_KEY set flips billing to
  // the metered key (resolveClaudeBillingType -> "api") while preserving the
  // entire agent lifecycle (tools/checkout/comment/session) — unlike the SDK
  // one-shot path. Gated by the shared Tier-1 cost-cap (daily + per-issue) and
  // the metered key; on success it short-circuits, else it surfaces the
  // failure honestly (no silent non-agentic "success").
  {
    const apiFailoverVerdict = isRecoverable({
      exitCode: lastRaw.proc.exitCode,
      stderr: lastRaw.proc.stderr,
      stdout: lastRaw.proc.stdout,
      parsed: lastRaw.parsed,
      timedOut: lastRaw.proc.timedOut,
    });
    // Defense-in-depth: if the base env is ALREADY metered (ANTHROPIC_API_KEY
    // present), this run is not on a subscription seat — never re-spawn (the
    // metered key is the terminal tier; a second metered attempt would be a
    // no-win retry). Guards against any future caller that pre-sets the key.
    const alreadyMetered = hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY");
    if (apiFailoverVerdict.recoverable && !alreadyMetered) {
      const apiFailoverIssueId = (ctx.context.issueId ?? ctx.context.taskId ?? null) as
        | string
        | null;
      const gateVerdict = await buildTier1Gate()({ issueId: apiFailoverIssueId });
      if (!gateVerdict.allowed) {
        await onLog(
          "stdout",
          `[paperclip] Tier 0b (agentic metered API) skipped — cost cap: ${gateVerdict.reason}. ${
            gateVerdict.detail ?? ""
          }\n`,
        );
      } else {
        let meteredKey: string | null = null;
        try {
          meteredKey = (await fetchBlueprintWorkerKey()).value;
        } catch (err) {
          await onLog(
            "stdout",
            `[paperclip] Tier 0b (agentic metered API) skipped — key unavailable: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
        if (meteredKey) {
          await onLog(
            "stdout",
            `[paperclip] Tier 0 (${apiFailoverVerdict.reason}) exhausted subscription seats — re-running AGENTIC on the metered Anthropic API (ANTHROPIC_API_KEY_BLUEPRINT_WORKER).\n`,
          );
          const apiRaw = await runAttempt(null, { ANTHROPIC_API_KEY: meteredKey });
          const apiCandidate = toAdapterResult(apiRaw, { fallbackSessionId: null });
          // Best-effort accounting — a cost-record write error must never crash
          // an otherwise-successful metered run.
          try {
            await recordTier1Cost(
              {},
              { issueId: apiFailoverIssueId, costUsd: apiCandidate.costUsd ?? 0 },
            );
          } catch (err) {
            await onLog(
              "stdout",
              `[paperclip] Tier 0b cost-record failed (non-fatal): ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
          if ((apiCandidate.exitCode ?? 0) === 0 && !apiCandidate.errorCode) {
            resetSeatRotation();
            await onLog(
              "stdout",
              `[paperclip] Tier 0b agentic metered-API run succeeded (cost $${(
                apiCandidate.costUsd ?? 0
              ).toFixed(4)}).\n`,
            );
            await emitUsage(apiCandidate);
            return apiCandidate;
          }
          await onLog(
            "stdout",
            `[paperclip] Tier 0b agentic metered-API run did not succeed (errorCode=${
              apiCandidate.errorCode ?? "unknown"
            }); surfacing the failure.\n`,
          );
          lastRaw = apiRaw;
          candidate = apiCandidate;
        }
      }
    }
  }

  // ── Tier 0 failed — route through the failover orchestrator ──────────────
  // The agentic Tier-0b metered-API attempt above already handled recoverable
  // failures (and short-circuits on success). The SDK one-shot Tier 1 is left
  // DISABLED (tier1: null) — it produced a non-agentic completion that recorded
  // as a "success" without doing the agent's work (no checkout/comment), which
  // is a silent prod regression. With tier1 null the orchestrator only attaches
  // tier metadata and surfaces the (already-built) Tier-0/0b result unchanged.
  const capturedLastRaw = lastRaw;
  const capturedCandidate = candidate;
  const failoverResult = await executeClaudeLocalWithFailover({
    tier0: {
      // The raw attempt has already been made; hand it to the orchestrator so
      // the classifier runs without spawning a second process.
      async runTier0(): Promise<Tier0RawOutcome> {
        return capturedLastRaw;
      },
    },
    tier1: null,
    prompt,
    model,
    onLog,
    onMeta: onMeta ?? undefined,
    resumeSessionId: sessionId ?? null,
    // Preserve the production toAdapterResult builder so the Tier 0 happy path
    // is byte-identical to before this wiring was added.
    buildTier0Result: () => capturedCandidate,
    issueId: (ctx.context.issueId ?? ctx.context.taskId ?? null) as string | null,
  });

  if (!failoverResult.errorCode) resetSeatRotation();
  await emitUsage(failoverResult);
  return failoverResult;
}
