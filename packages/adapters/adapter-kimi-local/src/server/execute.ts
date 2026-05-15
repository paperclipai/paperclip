import { spawn } from "node:child_process";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  applyPaperclipWorkspaceEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";

interface KimiStatusPayload {
  context_usage?: number;
  context_tokens?: number;
  max_context_tokens?: number;
  token_usage?: {
    input_other?: number;
    output?: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
  message_id?: string;
  plan_mode?: boolean;
}

interface KimiParseResult {
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  summary: string;
  errorMessage: string | null;
}

function parseKimiStdout(stdout: string): KimiParseResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let summary = "";
  let errorMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.method === "event" && msg.params) {
        const params = msg.params as Record<string, unknown>;
        const eventType = asString(params.type, "");
        const payload = parseObject(params.payload) ?? {};

        if (eventType === "ContentPart" && payload.type === "text" && typeof payload.text === "string") {
          summary += payload.text;
        } else if (eventType === "StatusUpdate") {
          const tu = (payload.token_usage ?? {}) as Record<string, number>;
          inputTokens = (tu.input_other ?? 0) + (tu.input_cache_read ?? 0);
          outputTokens = tu.output ?? 0;
          cachedInputTokens = tu.input_cache_read ?? 0;
        } else if (eventType === "StopFailure" && typeof payload.reason === "string") {
          errorMessage = payload.reason;
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  return { usage: { inputTokens, outputTokens, cachedInputTokens }, summary, errorMessage };
}

function buildKimiStdin(userInput: string): string {
  const init = JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    id: "init-1",
    params: {
      protocol_version: "1.9",
      capabilities: { supports_question: true },
    },
  });
  const prompt = JSON.stringify({
    jsonrpc: "2.0",
    method: "prompt",
    id: "prompt-1",
    params: { user_input: userInput },
  });
  return `${init}\n${prompt}\n`;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  // ---- Config ----
  const command = asString(config.command, "kimi").trim() || "kimi";
  const model = asString(config.model, "").trim() || null;
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim() || null;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);

  // ---- Workspace / cwd ----
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "").trim();
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ---- Env ----
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

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
  }

  const envConfig = parseObject(config.env);
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  // ---- Prompt ----
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" as const },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  let prompt = joinPromptSections([wakePrompt, sessionHandoffNote, taskContextNote, renderedPrompt]);

  if (instructionsFilePath) {
    try {
      const { readFile } = await import("node:fs/promises");
      const instructions = await readFile(instructionsFilePath, "utf8");
      prompt = joinPromptSections([instructions, prompt]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
    }
  }

  // ---- Session ----
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams?.sessionId, runtime.sessionId ?? "").trim();
  const sessionId = runtimeSessionId || null;

  // ---- Args ----
  const args = ["--wire"];
  if (dangerouslySkipPermissions) args.push("--yolo");
  if (model) args.push("--model", model);
  if (sessionId) {
    args.push("--session", sessionId);
  }
  args.push(...extraArgs);

  // ---- Meta ----
  if (onMeta) {
    await onMeta({
      adapterType: "kimi_local",
      command,
      cwd,
      commandArgs: args,
      env: { ...env },
      prompt,
      context,
    });
  }

  // ---- Stdin JSON-RPC ----
  const stdinData = buildKimiStdin(prompt);

  // ---- Spawn (keep stdin open until turn finishes) ----
  const child = spawn(command, args, {
    cwd,
    env: runtimeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
  });

  const startedAt = new Date().toISOString();
  const processGroupId =
    typeof child.pid === "number" && child.pid > 0 && process.platform !== "win32" ? child.pid : null;

  if (onSpawn && typeof child.pid === "number") {
    await onSpawn({ pid: child.pid, processGroupId, startedAt });
  }

  runningProcesses.set(runId, { child, graceSec, processGroupId });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let stdinClosed = false;

  // Close stdin after N seconds of inactivity so kimi can exit cleanly
  const INACTIVITY_MS = 120000;
  let inactivityTimer: NodeJS.Timeout | null = null;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (!stdinClosed && child.stdin && !child.stdin.destroyed) {
        stdinClosed = true;
        child.stdin.end();
      }
    }, INACTIVITY_MS);
  };

  const maybeCloseStdin = () => {
    if (!stdinClosed && child.stdin && !child.stdin.destroyed) {
      stdinClosed = true;
      child.stdin.end();
    }
  };

  const timeout =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          if (inactivityTimer) clearTimeout(inactivityTimer);
          if (processGroupId && processGroupId > 0) {
            try { process.kill(-processGroupId, "SIGTERM"); } catch { /* ignore */ }
          } else {
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
          }
          setTimeout(() => {
            if (processGroupId && processGroupId > 0) {
              try { process.kill(-processGroupId, "SIGKILL"); } catch { /* ignore */ }
            } else {
              try { child.kill("SIGKILL"); } catch { /* ignore */ }
            }
          }, Math.max(1, graceSec) * 1000);
        }, timeoutSec * 1000)
      : null;

  return new Promise<AdapterExecutionResult>((resolve, reject) => {
    child.stdout?.on("data", async (chunk: unknown) => {
      const text = String(chunk);
      stdout += text;
      resetInactivityTimer();

      // Detect the JSON-RPC response to our prompt so we can close stdin
      // and let the process exit naturally.
      if (!stdinClosed && stdout.includes('"id":"prompt-1"') && stdout.includes('"status":"finished"')) {
        maybeCloseStdin();
      }

      try {
        await onLog("stdout", text);
      } catch {
        /* ignore */
      }
    });

    child.stderr?.on("data", async (chunk: unknown) => {
      const text = String(chunk);
      stderr += text;
      resetInactivityTimer();
      try {
        await onLog("stderr", text);
      } catch {
        /* ignore */
      }
    });

    child.on("error", (err: Error) => {
      if (timeout) clearTimeout(timeout);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      runningProcesses.delete(runId);
      const errno = (err as NodeJS.ErrnoException).code;
      const pathValue = runtimeEnv.PATH ?? runtimeEnv.Path ?? "";
      const msg =
        errno === "ENOENT"
          ? `Failed to start command "${command}" in "${cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
          : `Failed to start command "${command}" in "${cwd}": ${err.message}`;
      reject(new Error(msg));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) clearTimeout(timeout);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      runningProcesses.delete(runId);

      const parsed = parseKimiStdout(stdout);
      const failed = (code ?? 0) !== 0 || Boolean(parsed.errorMessage);
      const errorMessage = failed
        ? parsed.errorMessage ?? `Kimi exited with code ${code ?? -1}`
        : null;

      const sessionParams = sessionId
        ? ({
            sessionId,
            cwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          } as Record<string, unknown>)
        : null;

      resolve({
        exitCode: code,
        signal,
        timedOut,
        errorMessage,
        errorCode: timedOut ? "timeout" : failed ? "kimi_error" : null,
        usage: parsed.usage,
        sessionId,
        sessionParams,
        sessionDisplayId: sessionId,
        provider: "moonshot",
        biller: "moonshot",
        model,
        billingType: "subscription",
        resultJson: { stdout, stderr },
        summary: parsed.summary.slice(0, 500) || "Kimi run completed.",
      });
    });

    // Write stdin and start inactivity timer
    if (child.stdin) {
      child.stdin.write(stdinData);
      resetInactivityTimer();
    }
  });
}
