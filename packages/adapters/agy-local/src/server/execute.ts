import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
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
import { DEFAULT_AGY_MODEL } from "../index.js";
import { parseAgyOutput, detectAgyAuthRequired } from "./parse.js";

const AGY_BINARY_CANDIDATES = [
  path.join(os.homedir(), ".local", "bin", "agy"),
  "/usr/local/bin/agy",
  "/usr/bin/agy",
];

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_GRACE_SEC = 15;

async function resolveAgyBinary(): Promise<string> {
  for (const candidate of AGY_BINARY_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "agy";
}

function buildAgyRuntimeEnv(
  base: Record<string, string>,
  extra: Record<string, unknown>,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...base,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") merged[k] = v;
  }
  // Strip Claude Code nesting guards so agy doesn't inherit them
  for (const k of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION",
    "CLAUDE_CODE_PARENT_SESSION",
  ]) {
    delete merged[k];
  }
  const binDir = path.join(os.homedir(), ".local", "bin");
  if (!merged.PATH?.includes(binDir)) {
    merged.PATH = `${binDir}:${merged.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  }
  return merged;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const model = asString(config.model, DEFAULT_AGY_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const envConfig = parseObject(config.env);

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
  const effectiveWorkspaceCwd =
    workspaceSource === "agent_home" && configuredCwd.length > 0 ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const agyCmdPath = await resolveAgyBinary();

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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const renderedPrompt =
    wakePrompt.length > 0 ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const runtimeEnv = buildAgyRuntimeEnv(env, envConfig);

  if (onMeta) {
    await onMeta({
      adapterType: "agy_local",
      command: agyCmdPath,
      cwd,
      commandArgs: ["--print", "<prompt>", "--dangerously-skip-permissions", "--model", model],
      commandNotes: [
        "Prompt is passed to agy via --print for non-interactive execution.",
        "--dangerously-skip-permissions enables unattended tool use.",
        `model=${model}`,
        `timeout=${timeoutSec}s`,
      ],
      env: buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand: agyCmdPath }),
      prompt,
      context,
    });
  }

  await onLog("stdout", `[agy] Antigravity CLI model=${model} — timeout ${timeoutSec}s\n`);

  const args = ["--print", prompt, "--dangerously-skip-permissions", "--model", model];

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

    const child = spawn(agyCmdPath, args, {
      cwd,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, graceSec * 1000);
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
        onLog("stderr", `[agy] Process error: ${err.message}\n`).then(() =>
          resolve({ exitCode: null, signal: null, timedOut: false, stdout, stderr }),
        ),
      );
    });

    if (onSpawn && child.pid) {
      onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
    }
  });

  const parsed = parseAgyOutput(proc.stdout ?? "");
  const authFailed = detectAgyAuthRequired(proc.stdout ?? "", proc.stderr ?? "");

  await onLog("stdout", `[agy] Exit ${proc.exitCode ?? "null"} timed_out=${proc.timedOut}\n`);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: authFailed ? "agy_auth_required" : null,
      provider: "google",
      biller: "google",
      model,
      billingType: "subscription",
      costUsd: null,
    };
  }

  const failed = (proc.exitCode ?? 0) !== 0;
  const stderrSnippet =
    (proc.stderr ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  const errorMessage = authFailed
    ? "Antigravity authentication required. Run `agy auth login` interactively on the server."
    : failed && !parsed.finalMessage
      ? stderrSnippet || `agy exited with code ${proc.exitCode ?? -1}`
      : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: authFailed ? "agy_auth_required" : null,
    provider: "google",
    biller: "google",
    model,
    billingType: "subscription",
    costUsd: null,
    summary: parsed.finalMessage?.slice(0, 2000) ?? null,
    resultJson: parsed.finalMessage ? { result: parsed.finalMessage } : null,
  };
}
