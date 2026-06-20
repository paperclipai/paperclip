import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MISTRAL_LOCAL_MODEL } from "../index.js";
import { parseVibeStream, detectVibeAuthRequired } from "./parse.js";

const VIBE_CMD = "vibe";
const VIBE_SESSION_DIR = path.join(os.homedir(), ".vibe", "logs", "session");
const VIBE_ENV_FILE = path.join(os.homedir(), ".vibe", ".env");

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_GRACE_SEC = 10;

function resolveBillingType(envConfig: Record<string, unknown>): "api" | "subscription" {
  const key =
    (typeof envConfig.MISTRAL_API_KEY === "string" && envConfig.MISTRAL_API_KEY.trim()) ||
    (typeof process.env.MISTRAL_API_KEY === "string" && process.env.MISTRAL_API_KEY.trim());
  return key ? "api" : "subscription";
}

/**
 * Seed ~/.vibe/.env with MISTRAL_API_KEY when running in API-key mode.
 * Vibe CLI reads this file at startup; setting the env var alone is not always enough.
 */
async function seedVibeEnvIfNeeded(envConfig: Record<string, unknown>): Promise<void> {
  const apiKey = typeof envConfig.MISTRAL_API_KEY === "string" ? envConfig.MISTRAL_API_KEY.trim() : "";
  if (!apiKey) return;
  try {
    let existing = "";
    try { existing = await fs.readFile(VIBE_ENV_FILE, "utf-8"); } catch { /* file may not exist yet */ }
    const lines = existing.split("\n").filter((l) => !l.startsWith("MISTRAL_API_KEY="));
    lines.push(`MISTRAL_API_KEY=${apiKey}`);
    await fs.mkdir(path.dirname(VIBE_ENV_FILE), { recursive: true });
    await fs.writeFile(VIBE_ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  } catch { /* best-effort */ }
}

/**
 * Recover the Vibe session ID that was written after a run by scanning
 * ~/.vibe/logs/session/ for the newest directory created during this run.
 */
async function recoverLatestSessionId(beforeRunTime: number): Promise<string | null> {
  try {
    const entries = await fs.readdir(VIBE_SESSION_DIR, { withFileTypes: true });
    let newest: string | null = null;
    let newestMtime = 0;
    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      try {
        const stat = await fs.stat(path.join(VIBE_SESSION_DIR, dir.name));
        if (stat.mtimeMs > newestMtime && stat.mtimeMs >= beforeRunTime - 2000) {
          newestMtime = stat.mtimeMs;
          newest = dir.name;
        }
      } catch { /* skip unreadable entries */ }
    }
    if (!newest) return null;
    const raw = await fs.readFile(path.join(VIBE_SESSION_DIR, newest, "meta.json"), "utf-8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    return typeof meta.session_id === "string" ? meta.session_id : null;
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const model = asString(config.model, DEFAULT_MISTRAL_LOCAL_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const persistSession = asBoolean(config.persistSession, true);
  const envConfig = parseObject(config.env);

  const billingType = resolveBillingType(envConfig);
  await seedVibeEnvIfNeeded(envConfig);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
      )
    : [];

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build Paperclip environment
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim()
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim()
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });

  // VIBE_ACTIVE_MODEL selects the model alias from ~/.vibe/config.toml
  env.VIBE_ACTIVE_MODEL = model;

  // Build instructions prefix
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // Build prompt
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  // Session resume
  const prevSessionId = asString(
    (parseObject(runtime.sessionParams) as Record<string, unknown>).sessionId,
    "",
  );
  const canResumeSession = persistSession && prevSessionId.length > 0;

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canResumeSession });
  const renderedPrompt = canResumeSession && wakePrompt.length > 0
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  // Build runtime env (merge process.env + paperclip env + user env config)
  const runtimeEnv: Record<string, string> = { ...process.env as Record<string, string>, ...env };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") runtimeEnv[k] = v;
  }
  // Strip Claude Code nesting guards
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"]) {
    delete runtimeEnv[k];
  }

  // Build args: vibe -p <prompt> --output streaming --trust --workdir <cwd> [--resume <id>]
  const args: string[] = ["-p", prompt, "--output", "streaming", "--trust", "--workdir", cwd];
  if (canResumeSession) args.push("--resume", prevSessionId);

  if (onMeta) {
    await onMeta({
      adapterType: "mistral_local",
      command: VIBE_CMD,
      cwd,
      commandArgs: ["-p", "<prompt>", "--output", "streaming", "--trust", "--workdir", cwd,
        ...(canResumeSession ? ["--resume", prevSessionId] : [])],
      commandNotes: [
        "Prompt passed via -p for non-interactive execution.",
        `model=${model} (set via VIBE_ACTIVE_MODEL — alias in ~/.vibe/config.toml)`,
        `billing=${billingType}`,
        `timeout=${timeoutSec}s`,
        ...(canResumeSession ? [`Resuming session: ${prevSessionId}`] : []),
      ],
      env: buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand: VIBE_CMD }),
      prompt,
      context,
    });
  }

  await onLog("stdout", `[mistral] Vibe model=${model} billing=${billingType} — timeout ${timeoutSec}s\n`);
  if (canResumeSession) await onLog("stdout", `[mistral] Resuming session: ${prevSessionId}\n`);

  const beforeRunTime = Date.now();

  // Spawn vibe process
  const proc = await new Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(VIBE_CMD, args, { cwd, env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, graceSec * 1000);
    }, timeoutSec * 1000);

    let logChain = Promise.resolve();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      logChain = logChain.then(() => onLog("stdout", text));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      logChain = logChain.then(() => onLog("stderr", text));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      logChain.then(() => resolve({ exitCode: code, signal, timedOut, stdout, stderr }));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      logChain.then(() =>
        onLog("stderr", `[mistral] Process error: ${err.message}\n`).then(() =>
          resolve({ exitCode: null, signal: null, timedOut: false, stdout, stderr }),
        ),
      );
    });

    if (onSpawn && child.pid) {
      onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
    }
  });

  const parsed = parseVibeStream(proc.stdout ?? "");
  const authFailed = detectVibeAuthRequired(proc.stdout ?? "", proc.stderr ?? "");

  await onLog("stdout", `[mistral] Exit ${proc.exitCode ?? "null"} timed_out=${proc.timedOut}\n`);

  // Recover session ID written by Vibe after this run
  let sessionId: string | null = null;
  if (persistSession) {
    sessionId = await recoverLatestSessionId(beforeRunTime);
    if (sessionId) await onLog("stdout", `[mistral] Session: ${sessionId}\n`);
  }

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      provider: "mistral",
      biller: billingType === "subscription" ? "mistral_subscription" : "mistral",
      model,
      billingType,
      costUsd: null,
    };
  }

  const failed = (proc.exitCode ?? 0) !== 0;
  const stderrSnippet = (proc.stderr ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  const errorMessage = authFailed
    ? "Mistral authentication required. Run `vibe --setup` interactively."
    : parsed.errors.length > 0
    ? parsed.errors[0]
    : failed && !parsed.finalMessage
    ? stderrSnippet || `vibe exited with code ${proc.exitCode ?? -1}`
    : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: authFailed ? "mistral_auth_required" : null,
    provider: "mistral",
    biller: billingType === "subscription" ? "mistral_subscription" : "mistral",
    model,
    billingType,
    costUsd: null,
    summary: parsed.finalMessage?.slice(0, 2000) ?? null,
    resultJson:
      parsed.finalMessage || parsed.toolCallCount > 0
        ? { result: parsed.finalMessage ?? "", session_id: sessionId, tool_call_count: parsed.toolCallCount }
        : null,
    sessionId: persistSession && sessionId ? sessionId : null,
    sessionParams: persistSession && sessionId ? { sessionId } : null,
    sessionDisplayId: persistSession && sessionId ? sessionId.slice(0, 8) : null,
  };
}
