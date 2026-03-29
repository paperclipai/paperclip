import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCopilotJsonl,
  describeCopilotFailure,
  detectCopilotAuthRequired,
  isCopilotUnknownSessionError,
} from "./parse.js";

interface CopilotRuntimeConfig {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

async function buildCopilotRuntimeConfig(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<CopilotRuntimeConfig> {
  const { runId, agent, config, context } = input;

  const command = asString(config.command, "copilot");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return { command, cwd, env, timeoutSec, graceSec, extraArgs };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);

  const runtimeConfig = await buildCopilotRuntimeConfig({
    runId,
    agent,
    config,
    context,
  });
  const { command, cwd, env, timeoutSec, graceSec, extraArgs } = runtimeConfig;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([sessionHandoffNote, renderedPrompt]);

  const buildCopilotArgs = (resumeSessionId: string | null) => {
    const args = ["-p", prompt, "--output-format", "json", "-s", "--no-color"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (dangerouslySkipPermissions) args.push("--allow-all");
    else args.push("--allow-all-tools");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildCopilotArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "copilot_local",
        command,
        cwd,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseCopilotJsonl(proc.stdout);
    return { proc, parsedStream };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseCopilotJsonl>;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream } = attempt;
    const authMeta = detectCopilotAuthRequired({
      stdout: proc.stdout,
      stderr: proc.stderr,
    });

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

    const resolvedSessionId = parsedStream.sessionId ?? opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? ({ sessionId: resolvedSessionId, cwd } as Record<string, unknown>)
      : null;

    // Build error message from stderr (where Copilot puts its errors) and parsed result.
    const errorMessage =
      (proc.exitCode ?? 0) === 0
        ? null
        : describeCopilotFailure(parsedStream.resultJson, proc.stderr);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: authMeta.requiresLogin ? "copilot_auth_required" : null,
      usage: parsedStream.usage ?? undefined,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "github",
      biller: "github",
      model: parsedStream.model || model,
      billingType: "subscription",
      costUsd: null, // subscription-based, no per-run cost
      resultJson: parsedStream.resultJson,
      summary: parsedStream.summary,
      // Include stderr excerpt in resultJson when there's no JSONL output (error cases)
      ...(proc.stderr && !parsedStream.resultJson
        ? {
            resultJson: {
              stderr: proc.stderr,
              stdout: proc.stdout,
            },
          }
        : {}),
      clearSession: Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // Run the initial attempt, with session resume if available.
  const initial = await runAttempt(sessionId ?? null);

  // Copilot outputs session errors to stderr with zero JSONL on stdout.
  // Check stderr (not parsed result) for unknown session detection.
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCopilotUnknownSessionError(initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }

  return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
