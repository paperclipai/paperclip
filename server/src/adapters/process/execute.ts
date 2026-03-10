import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  runChildProcess,
} from "../utils.js";

export function resolveProcessExecutionCwd(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  return useConfiguredInsteadOfAgentHome ? configuredCwd || process.cwd() : workspaceCwd || configuredCwd || process.cwd();
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  // Match the typed local adapters: issue-scoped work should run from the resolved Paperclip workspace
  // unless the wake fell back to agent_home and the operator explicitly pinned a custom cwd.
  const cwd = resolveProcessExecutionCwd(config, context);
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;

  env.PAPERCLIP_RUN_ID = runId;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (typeof workspaceContext.cwd === "string" && workspaceContext.cwd.trim().length > 0) {
    env.PAPERCLIP_WORKSPACE_CWD = workspaceContext.cwd.trim();
  }
  if (typeof workspaceContext.source === "string" && workspaceContext.source.trim().length > 0) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceContext.source.trim();
  }
  if (typeof workspaceContext.workspaceId === "string" && workspaceContext.workspaceId.trim().length > 0) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceContext.workspaceId.trim();
  }
  if (typeof workspaceContext.repoUrl === "string" && workspaceContext.repoUrl.trim().length > 0) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceContext.repoUrl.trim();
  }
  if (typeof workspaceContext.repoRef === "string" && workspaceContext.repoRef.trim().length > 0) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceContext.repoRef.trim();
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
