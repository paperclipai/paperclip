import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";
// The in-tree shim (../utils.js) re-exports buildPaperclipEnv but not the wake
// helpers, so import them directly from the shared package, exactly as the
// claude-local adapter does.
import {
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken && !env.PAPERCLIP_API_KEY?.trim()) env.PAPERCLIP_API_KEY = authToken;

  // Forward the wake context to the child. The derivations mirror the rich
  // claude-local adapter (packages/adapters/claude-local/src/server/execute.ts):
  // PAPERCLIP_RUN_ID and the API credential are already injected above; this
  // adds the task/issue the wake is about plus the wake-context, so a process
  // agent can tell which task woke it instead of having to rescan. Each var is
  // emitted only when present.
  //
  // Precedence: like PAPERCLIP_RUN_ID above, these are runtime-owned. They are
  // applied after config.env, and — crucially — each key is *removed* when the
  // current wake carries no value for it, so a static adapter config can neither
  // shadow nor leave stale wake context for the child. (claude-local applies its
  // config env last, i.e. config-wins; the process adapter keeps identity / wake
  // context runtime-owned, matching its existing PAPERCLIP_RUN_ID handling.)
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

  const wakeEnv: Record<string, string | null> = {
    PAPERCLIP_TASK_ID: wakeTaskId,
    PAPERCLIP_ISSUE_WORK_MODE: issueWorkMode,
    PAPERCLIP_WAKE_REASON: wakeReason,
    PAPERCLIP_WAKE_COMMENT_ID: wakeCommentId,
    PAPERCLIP_APPROVAL_ID: approvalId,
    PAPERCLIP_APPROVAL_STATUS: approvalStatus,
    PAPERCLIP_LINKED_ISSUE_IDS: linkedIssueIds.length > 0 ? linkedIssueIds.join(",") : null,
    PAPERCLIP_WAKE_PAYLOAD_JSON: wakePayloadJson,
  };
  for (const [key, value] of Object.entries(wakeEnv)) {
    if (value) {
      env[key] = value;
    } else {
      delete env[key];
    }
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn: ctx.onSpawn,
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
