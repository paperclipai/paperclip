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
} from "@paperclipai/adapter-utils/server-utils";
import { parseQodoOutput, describeQodoFailure, isQodoUnknownSessionError } from "./parse.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(config.promptTemplate, "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.");
  const model = asString(config.model, "");
  const autoApprove = asBoolean(config.autoApprove, true);
  const actMode = asBoolean(config.actMode, true);
  const command = asString(config.command, "qodo");
  const configuredCwd = asString(config.cwd, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0 ? context.wakeReason.trim() : null;

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (authToken) {
    const hasExplicitApiKey = typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
    if (!hasExplicitApiKey) env.PAPERCLIP_API_KEY = authToken;
  }

  env.NO_COLOR = "1";

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog("stderr", `[paperclip] Qodo session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`);
  }

  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["chat"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (autoApprove) args.push("--yes");
    if (actMode) args.push("--act");
    if (model) args.push(`--model=${model}`);
    args.push("--ci");
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push(prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({ adapterType: "qodo_local", command, cwd, commandArgs: args, env: redactEnvForLogs(env), prompt, context });
    }
    const proc = await runChildProcess(runId, command, args, { cwd, env, timeoutSec, graceSec, onLog });
    const parsed = parseQodoOutput(proc.stdout);
    return { proc, parsed };
  };

  const toResult = (
    attempt: { proc: RunProcessResult; parsed: ReturnType<typeof parseQodoOutput> },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsed } = attempt;

    if (proc.timedOut) {
      return { exitCode: proc.exitCode, signal: proc.signal, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s`, errorCode: "timeout" };
    }

    const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    const resolvedSessionId = parsed.sessionId ?? opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } as Record<string, unknown> : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: (proc.exitCode ?? 0) === 0 ? null : (parsed.errorMessage ?? (stderrLine || `Qodo exited with code ${proc.exitCode ?? -1}`)),
      usage: parsed.usage ?? undefined,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "qodo",
      model: parsed.model || model,
      billingType: "subscription",
      costUsd: parsed.costUsd ?? 0,
      resultJson: parsed.resultJson,
      summary: parsed.summary,
      clearSession: Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isQodoUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog("stderr", `[paperclip] Qodo resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`);
    const retry = await runAttempt(null);
    return toResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }

  return toResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
