import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let spawned = false;
  try {
    return await executeProcess({ ...ctx, onSpawn: async (meta) => {
      // Set this before metadata persistence: a failed callback cannot prove
      // that the already-created process did no billable work.
      spawned = true;
      await ctx.onSpawn?.(meta);
    } });
  } catch (error) {
    if (spawned) throw error;
    return { exitCode: 1, signal: null, timedOut: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }
}

async function executeProcess(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken, context } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  // Inject wake/task identity the same way local LLM adapters do so process
  // heartbeats see PAPERCLIP_TASK_ID when context carries an issue/task id.
  // Runtime keys win over adapterConfig.env above.
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
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from
  // sanitizeInheritedPaperclipEnv(process.env) + env, so a PAPERCLIP_API_KEY
  // on the server process never reaches the child.
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

  const instructions = parseObject(ctx.context.connectionInstructions);
  let instructionsDirectory: string | undefined;
  // Override configured/inherited paths even when the connection was removed.
  env.PAPERCLIP_CONNECTION_INSTRUCTIONS_FILE = "";
  let proc: Awaited<ReturnType<typeof runChildProcess>>;
  try {
    if (typeof instructions.text === "string" && instructions.text) {
      instructionsDirectory = await mkdtemp(join(tmpdir(), "paperclip-connection-instructions-"));
      const instructionsFile = join(instructionsDirectory, "instructions.json");
      await writeFile(instructionsFile, JSON.stringify(instructions), { mode: 0o600 });
      env.PAPERCLIP_CONNECTION_INSTRUCTIONS_FILE = instructionsFile;
    }
    proc = await runChildProcess(runId, command, args, {
      cwd, env, timeoutSec, graceSec, onLog, onSpawn: ctx.onSpawn,
    });
  } finally {
    if (instructionsDirectory) await rm(instructionsDirectory, { recursive: true, force: true });
  }

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
