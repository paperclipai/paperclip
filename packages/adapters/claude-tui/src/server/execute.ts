import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  applyPaperclipWorkspaceEnv,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseJson,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  sanitizeChildEnv,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  parseClaudeStreamJson,
  resolveClaudeGatewayAttribution,
  resolveGatewayCostUsd,
  resolveGatewayModelOverride,
  resolveGatewayReportedModel,
} from "@paperclipai/adapter-claude-local/server";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

// Mirrors claude_local's sandbox allowlist. claude-p forwards these to the same
// underlying `claude` binary, so `--allowedTools` semantics are identical.
const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash(*) CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

function buildPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsSandbox: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (input.targetIsSandbox) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return ["--dangerously-skip-permissions"];
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onMeta, onSpawn, authToken } = ctx;
  const onLog = ctx.onLog ?? (async () => {});

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const executionTargetIsSandbox =
    executionTarget?.kind === "remote" && executionTarget.transport === "sandbox";

  // ---- config ---------------------------------------------------------------
  const command = asString(config.command, "claude-p");
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 200);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const configEnv = parseObject(config.env);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // ---- working directory ----------------------------------------------------
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
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);

  // ---- environment ----------------------------------------------------------
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    "";
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : "";
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    agentHome,
  });

  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  const hasExplicitApiKey =
    typeof configEnv.PAPERCLIP_API_KEY === "string" && configEnv.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...sanitizeChildEnv(process.env), ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const attribution = resolveClaudeGatewayAttribution(effectiveEnv);

  // ---- timeouts -------------------------------------------------------------
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 3600),
  );
  const graceSec = asNumber(config.graceSec, 20);
  // claude-p self-terminates at its internal 300s default unless given an
  // explicit --timeout. When the host imposes no cap (0), give claude-p a
  // generous wall-time so it does not kill long runs prematurely.
  const claudePTimeoutSec = timeoutSec > 0 ? timeoutSec : 3600;

  // ---- command availability -------------------------------------------------
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec: Math.max(timeoutSec, 60),
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec: Math.max(timeoutSec, 60),
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    cwd,
    runtimeEnv,
  );
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  // ---- session resume gating ------------------------------------------------
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 ||
      path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    !executionTargetIsRemote;
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" will not be resumed in "${effectiveExecutionCwd}". Starting a fresh session.\n`,
    );
  }

  // ---- prompt ---------------------------------------------------------------
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(sessionId),
  });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // ---- claude-p argument builder -------------------------------------------
  // NOTE: claude-p rejects `--print`/`-p` (it emulates print mode itself) and
  // reads the prompt from stdin when no positional arg is given. Unknown flags
  // (--effort, --chrome, --append-system-prompt-file) are forwarded to the
  // child `claude`. --output-format stream-json requires --verbose.
  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--timeout",
      String(claudePTimeoutSec),
    ];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(...buildPermissionArgs({ dangerouslySkipPermissions, targetIsSandbox: executionTargetIsSandbox }));
    const effectiveModel = resolveGatewayModelOverride(model, effectiveEnv) ?? model;
    if (effectiveModel) args.push("--model", effectiveModel);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session; skip
    // re-injecting them.
    if (instructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", instructionsFilePath);
    }
    if (chrome) args.push("--chrome");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_tui",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args,
        commandNotes: [
          "Driving the interactive Claude Code TUI via claude-p (drop-in `claude -p`).",
        ],
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }
    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
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

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      const stderrLine =
        proc.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
      const errorMessage =
        (proc.exitCode ?? 0) === 0
          ? "Failed to parse claude-p JSON output"
          : stderrLine
            ? `claude-p exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
            : `claude-p exited with code ${proc.exitCode ?? -1}`;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage,
        errorCode: null,
        resultJson: { stdout: proc.stdout, stderr: proc.stderr },
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
          cwd: effectiveExecutionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const parsedIsError = asBoolean(parsed.is_error, false);
    const failed = (proc.exitCode ?? 0) !== 0 || parsedIsError;
    const errorMessage = failed
      ? describeClaudeFailure(parsed) ?? `claude-p exited with code ${proc.exitCode ?? -1}`
      : null;
    const resolvedErrorCode = failed && clearSessionForMaxTurns ? "max_turns_exhausted" : null;
    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
    };

    const reportedModel = resolveGatewayReportedModel({
      env: effectiveEnv,
      configuredModel: model,
      parsedModel: parsedStream.model || asString(parsed.model, "") || null,
    });
    const costUsd = resolveGatewayCostUsd({
      env: effectiveEnv,
      model: reportedModel,
      usage,
      cliCostUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
    });

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: resolvedErrorCode,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: attribution.provider,
      biller: attribution.biller,
      model: reportedModel,
      billingType: attribution.billingType,
      costUsd,
      resultJson: mergedResultJson,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession:
        clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId ?? null);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    initial.parsed &&
    isClaudeUnknownSessionError(initial.parsed)
  ) {
    await onLog(
      "stdout",
      `[paperclip] claude-p resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }
  return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
