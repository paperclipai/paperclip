import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isQwenUnknownSessionError, parseQwenStreamJson } from "./parse.js";

function readStringEnvConfig(input: unknown): Record<string, string> {
  const record = parseObject(input);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      env[key] = value;
      continue;
    }
    const nested = parseObject(value);
    if (nested.type === "plain" && typeof nested.value === "string") {
      env[key] = nested.value;
    }
  }
  return env;
}

function resolveWakeTaskId(context: Record<string, unknown>): string | null {
  const taskId = asString(context.taskId, "").trim();
  if (taskId) return taskId;
  const issueId = asString(context.issueId, "").trim();
  return issueId || null;
}

async function loadInstructionsPrefix(cwd: string, instructionsFilePath: string, onLog: AdapterExecutionContext["onLog"]) {
  if (!instructionsFilePath) return "";
  const resolvedPath = path.resolve(cwd, instructionsFilePath);
  const instructionsDir = `${path.dirname(resolvedPath)}/`;
  try {
    const contents = await fs.readFile(resolvedPath, "utf8");
    await onLog("stderr", `[paperclip] Loaded agent instructions file: ${resolvedPath}\n`);
    return (
      `${contents}\n\n` +
      `The above agent instructions were loaded from ${resolvedPath}. ` +
      `Resolve any relative file references from ${instructionsDir}.\n\n`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${resolvedPath}": ${reason}\n`,
    );
    return "";
  }
}

function sessionParamsFor(cwd: string, sessionId: string | null, workspace: Record<string, string>) {
  if (!sessionId) return null;
  return {
    sessionId,
    cwd,
    ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    ...(workspace.repoUrl ? { repoUrl: workspace.repoUrl } : {}),
    ...(workspace.repoRef ? { repoRef: workspace.repoRef } : {}),
  };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "qwen");
  const model = asString(config.model, "").trim();
  const yolo = asBoolean(config.yolo, false);
  const approvalMode = asString(config.approvalMode, "").trim();
  const maxSessionTurns = asNumber(config.maxSessionTurns, 0);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = readStringEnvConfig(config.env);
  const runtimeEnvValues: Record<string, string> = { ...buildPaperclipEnv(agent) };
  runtimeEnvValues.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId = resolveWakeTaskId(context);
  if (wakeTaskId) runtimeEnvValues.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakeReason = asString(context.wakeReason, "").trim();
  if (wakeReason) runtimeEnvValues.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId = asString(context.wakeCommentId, "").trim() || asString(context.commentId, "").trim();
  if (wakeCommentId) runtimeEnvValues.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const approvalId = asString(context.approvalId, "").trim();
  if (approvalId) runtimeEnvValues.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = asString(context.approvalStatus, "").trim();
  if (approvalStatus) runtimeEnvValues.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (effectiveWorkspaceCwd) runtimeEnvValues.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  const workspaceId = asString(workspaceContext.workspaceId, "").trim();
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "").trim();
  const workspaceRepoRef = asString(workspaceContext.repoRef, "").trim();
  if (workspaceSource) runtimeEnvValues.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) runtimeEnvValues.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) runtimeEnvValues.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) runtimeEnvValues.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;

  for (const [key, value] of Object.entries(envConfig)) {
    runtimeEnvValues[key] = value;
  }
  if (!runtimeEnvValues.PAPERCLIP_API_KEY && authToken) {
    runtimeEnvValues.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...runtimeEnvValues })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const instructionsPrefix = await loadInstructionsPrefix(
    cwd,
    asString(config.instructionsFilePath, "").trim(),
    onLog,
  );
  const prompt = `${instructionsPrefix}${renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  })}`;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "").trim();
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "").trim();
  const runtimeSessionWorkspaceId = asString(runtimeSessionParams.workspaceId, "").trim();
  const runtimeSessionRepoUrl = asString(runtimeSessionParams.repoUrl, "").trim();
  const runtimeSessionRepoRef = asString(runtimeSessionParams.repoRef, "").trim();
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd)) &&
    runtimeSessionWorkspaceId === workspaceId &&
    runtimeSessionRepoUrl === workspaceRepoUrl &&
    runtimeSessionRepoRef === workspaceRepoRef;
  const resumeSessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[paperclip] Qwen session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const buildArgs = (sessionId: string | null) => {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (sessionId) args.push("--resume", sessionId);
    if (yolo) args.push("--yolo");
    else if (approvalMode) args.push("--approval-mode", approvalMode);
    if (model) args.push("--model", model);
    if (maxSessionTurns > 0) args.push("--max-session-turns", String(maxSessionTurns));
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (sessionId: string | null) => {
    const args = buildArgs(sessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "qwen_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes: sessionId ? [`Resuming Qwen session ${sessionId}`] : [],
        env: redactEnvForLogs(runtimeEnv),
        prompt,
        context,
      });
    }
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    return {
      proc,
      parsed: parseQwenStreamJson(proc.stdout),
      sessionId,
    };
  };

  let attempt = await runAttempt(resumeSessionId);
  if (
    resumeSessionId &&
    attempt.proc.exitCode !== 0 &&
    isQwenUnknownSessionError(attempt.proc.stdout, attempt.proc.stderr)
  ) {
    await onLog(
      "stderr",
      `[paperclip] Qwen reported unknown session "${resumeSessionId}". Retrying without --resume.\n`,
    );
    attempt = await runAttempt(null);
  }

  const finalSessionId = attempt.parsed.sessionId ?? attempt.sessionId ?? null;
  const errorMessage =
    attempt.parsed.errorMessage ??
    trimmedOrNull(attempt.proc.stderr) ??
    (attempt.proc.timedOut ? "process timed out" : null);
  return {
    exitCode: attempt.proc.exitCode,
    signal: attempt.proc.signal,
    timedOut: attempt.proc.timedOut,
    errorMessage,
    usage: attempt.parsed.usage,
    sessionId: finalSessionId,
    sessionParams: sessionParamsFor(cwd, finalSessionId, {
      workspaceId,
      repoUrl: workspaceRepoUrl,
      repoRef: workspaceRepoRef,
    }),
    sessionDisplayId: finalSessionId,
    provider: attempt.parsed.provider ?? "qwen",
    model: attempt.parsed.model ?? (model || null),
    costUsd: attempt.parsed.costUsd,
    resultJson: attempt.parsed.resultJson,
    summary: attempt.parsed.summary,
  };
}
