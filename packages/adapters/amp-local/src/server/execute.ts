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
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseAmpStreamJson, describeAmpFailure } from "./parse.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const command = asString(config.command, "amp");
  const mode = asString(config.mode, "");
  const dangerouslyAllowAll = asBoolean(config.dangerouslyAllowAll, true);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const configuredCwd = asString(config.cwd, "");
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
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (agentHome) env.AGENT_HOME = agentHome;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Amp uses AMP_API_KEY for non-interactive auth
  const hasExplicitApiKey =
    typeof envConfig.AMP_API_KEY === "string" && (envConfig.AMP_API_KEY as string).trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.AMP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeThreadId = asString(runtimeSessionParams.threadId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeThread =
    runtimeThreadId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const threadId = canResumeThread ? runtimeThreadId : null;

  if (runtimeThreadId && !canResumeThread) {
    await onLog(
      "stderr",
      `[paperclip] Amp thread "${runtimeThreadId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: {
      id: runId,
      ...(asString(context.source, "").trim()
        ? { source: asString(context.source, "").trim() }
        : {}),
    },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([sessionHandoffNote, renderedPrompt]);

  // Build amp args
  const buildAmpArgs = (resumeThreadId: string | null) => {
    const args: string[] = [];
    args.push("--execute", "--stream-json");
    if (dangerouslyAllowAll) args.push("--dangerously-allow-all");
    if (mode) args.push("--mode", mode);
    if (extraArgs.length > 0) args.push(...extraArgs);
    if (resumeThreadId) {
      args.push("threads", "continue", resumeThreadId);
    }
    return args;
  };

  const args = buildAmpArgs(threadId);
  if (onMeta) {
    await onMeta({
      adapterType: "amp_local",
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
    stdin: prompt,
    timeoutSec,
    graceSec,
    onLog,
  });

  const parsedStream = parseAmpStreamJson(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  if (!parsedStream.resultJson) {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    // Check for auth errors
    const authRequired = /not\s+logged\s+in|please\s+log\s+in|login\s+required|unauthorized|authentication\s+required|AMP_API_KEY/i
      .test([proc.stdout, proc.stderr].join("\n"));

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: stderrLine
        ? `Amp exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `Amp exited with code ${proc.exitCode ?? -1}`,
      errorCode: authRequired ? "amp_auth_required" : null,
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
    };
  }

  const resolvedThreadId = parsedStream.threadId ?? (runtimeThreadId || runtime.sessionId);
  const resolvedSessionParams = resolvedThreadId
    ? ({ threadId: resolvedThreadId, cwd } as Record<string, unknown>)
    : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage:
      (proc.exitCode ?? 0) === 0
        ? null
        : describeAmpFailure(parsedStream.resultJson) ?? `Amp exited with code ${proc.exitCode ?? -1}`,
    usage: parsedStream.usage ?? undefined,
    sessionId: resolvedThreadId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedThreadId,
    provider: "amp",
    biller: "amp",
    model: parsedStream.model || "auto",
    billingType: "credits",
    costUsd: parsedStream.costUsd ?? undefined,
    resultJson: parsedStream.resultJson,
    summary: parsedStream.summary,
  };
}
