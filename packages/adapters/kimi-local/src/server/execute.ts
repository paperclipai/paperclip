import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseKimiStreamJson,
  detectKimiLoginRequired,
  describeKimiFailure,
  isKimiUnknownSessionError,
  isKimiMaxStepsError,
} from "./parse.js";

interface KimiExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface KimiRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

async function buildKimiRuntimeConfig(input: KimiExecutionInput): Promise<KimiRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "kimi");
  const configuredCwd = asString(config.cwd, "");
  
  // Resolve working directory
  const cwd = configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build environment variables
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Add wake context variables
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  // Add context variables
  if (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) {
    env.PAPERCLIP_WAKE_COMMENT_ID = context.wakeCommentId.trim();
  }
  if (typeof context.approvalId === "string" && context.approvalId.trim()) {
    env.PAPERCLIP_APPROVAL_ID = context.approvalId.trim();
  }
  if (typeof context.approvalStatus === "string" && context.approvalStatus.trim()) {
    env.PAPERCLIP_APPROVAL_STATUS = context.approvalStatus.trim();
  }
  if (Array.isArray(context.issueIds)) {
    const ids = context.issueIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
    if (ids.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = ids.join(",");
  }

  // Add user-provided env overrides
  const envConfig = parseObject(config.env);
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Add auth token if provided
  const hasExplicitApiKey = Boolean(
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim()
  );
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Ensure PATH is set
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  // Verify command is available
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = (await resolveCommandForLogs(command, cwd, runtimeEnv)) || command;

  // Build logged env (with secrets redacted)
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // Extract config
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const thinking = asBoolean(config.thinking, false);
  const yolo = asBoolean(config.yolo, true);
  const maxStepsPerTurn = asNumber(config.maxStepsPerTurn, 0);
  const maxRetriesPerStep = asNumber(config.maxRetriesPerStep, 0);

  // Build runtime config
  const runtimeConfig = await buildKimiRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const { command, resolvedCommand, cwd, env, loggedEnv, timeoutSec, graceSec, extraArgs } =
    runtimeConfig;

  // Prepare effective environment
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  // Handle session resumption
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams?.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams?.cwd, "");

  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || runtimeSessionCwd === cwd);

  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (
    runtimeSessionId &&
    runtimeSessionCwd.length > 0 &&
    runtimeSessionCwd !== cwd
  ) {
    await onLog(
      "stdout",
      `[paperclip] Kimi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Render prompt
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const prompt = renderTemplate(promptTemplate, templateData);

  // Build Kimi CLI arguments
  const buildKimiArgs = (resumeSessionId: string | null) => {
    const args: string[] = ["--print", "--output-format", "stream-json"];

    if (yolo) args.push("--yolo");
    if (thinking) args.push("--thinking");
    if (model) args.push("--model", model);
    if (maxStepsPerTurn > 0) args.push("--max-steps-per-turn", String(maxStepsPerTurn));
    if (maxRetriesPerStep > 0) args.push("--max-retries-per-step", String(maxRetriesPerStep));

    // Session resumption
    if (resumeSessionId) {
      args.push("--session", resumeSessionId);
    }

    if (extraArgs.length > 0) args.push(...extraArgs);

    return args;
  };

  // Run attempt
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildKimiArgs(resumeSessionId);

    if (onMeta) {
      await onMeta({
        adapterType: "kimi_local",
        command: resolvedCommand,
        cwd,
        commandArgs: args,
        commandNotes: resumeSessionId ? [`Resuming session ${resumeSessionId}`] : ["Starting new session"],
        env: loggedEnv,
        prompt,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseKimiStreamJson(proc.stdout);
    return { proc, parsedStream };
  };

  // Convert attempt to AdapterExecutionResult
  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseKimiStreamJson>;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream } = attempt;
    const loginMeta = detectKimiLoginRequired({
      parsed: parsedStream.resultJson,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });

    const errorMeta = loginMeta.requiresLogin ? { loginHint: "Run 'kimi login' to authenticate" } : undefined;

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

    // Check for parse failure
    if (!parsedStream.resultJson && proc.exitCode !== 0) {
      const stderrLine = proc.stderr.split(/\r?\n/).find((l: string) => l.trim()) ?? "";
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: stderrLine || `Kimi exited with code ${proc.exitCode ?? -1}`,
        errorCode: loginMeta.requiresLogin ? "kimi_auth_required" : null,
        errorMeta,
        resultJson: { stdout: proc.stdout, stderr: proc.stderr },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    // Determine session info
    const resolvedSessionId = parsedStream.sessionId || opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? ({ sessionId: resolvedSessionId, cwd } as Record<string, unknown>)
      : null;

    const clearSessionForMaxSteps = parsedStream.resultJson
      ? isKimiMaxStepsError(parsedStream.resultJson)
      : false;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeKimiFailure(parsedStream.resultJson || {}) ||
            `Kimi exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "kimi_auth_required" : null,
      errorMeta,
      usage: parsedStream.usage || { inputTokens: 0, outputTokens: 0 },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "moonshot",
      biller: "moonshot",
      model: parsedStream.model || model || "unknown",
      billingType: "api",
      costUsd: parsedStream.costUsd,
      resultJson: parsedStream.resultJson || { stdout: proc.stdout },
      summary: parsedStream.summary || "",
      clearSession: clearSessionForMaxSteps || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // Execute
  const initial = await runAttempt(sessionId ?? null);

  // Retry on unknown session
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    initial.parsedStream.resultJson &&
    isKimiUnknownSessionError(initial.parsedStream.resultJson)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Kimi resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }

  return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
