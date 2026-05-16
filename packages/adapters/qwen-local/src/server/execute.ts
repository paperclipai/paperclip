import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  applyPaperclipWorkspaceEnv,
  joinPromptSections,
  ensureAbsoluteDirectory,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// JSON / stream-json output parser
// ---------------------------------------------------------------------------

interface QwenResultEvent {
  type: "result";
  subtype?: string;
  result?: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

interface QwenAssistantEvent {
  type: "assistant";
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
  session_id?: string;
}

/**
 * Parse stream-json output from `qwen -o stream-json`.
 * Each line is a JSON object. The last line with `type: "result"` is the terminal result.
 */
function parseQwenStreamJsonOutput(
  stdout: string,
): {
  resultEvent: QwenResultEvent | null;
  assistantText: string;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
} {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  let resultEvent: QwenResultEvent | null = null;
  let sessionId: string | null = null;
  let assistantText = "";
  let lastUsage: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | null = null;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "result" && obj.subtype === "success") {
      resultEvent = obj as unknown as QwenResultEvent;
      sessionId = resultEvent.session_id ?? sessionId;
      if (resultEvent.usage) lastUsage = resultEvent.usage;
    } else if (obj.type === "assistant") {
      const msg = obj as unknown as QwenAssistantEvent;
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const c of msg.message.content) {
          if (c.type === "text" && typeof c.text === "string") {
            assistantText += c.text;
          }
        }
      }
      sessionId = msg.session_id ?? sessionId;
    } else if (obj.type === "system" && obj.subtype === "init") {
      // Capture session_id from init event as fallback
      sessionId = (obj.session_id as string) ?? sessionId;
    }
  }

  const usage = lastUsage
    ? {
        inputTokens: lastUsage.input_tokens ?? 0,
        outputTokens: lastUsage.output_tokens ?? 0,
        cachedInputTokens: lastUsage.cached_input_tokens ?? 0,
      }
    : null;

  return { resultEvent, assistantText, sessionId, usage };
}

/**
 * Parse json output from `qwen -o json`.
 * The output is a JSON array of event objects.
 */
function parseQwenJsonOutput(
  stdout: string,
): ReturnType<typeof parseQwenStreamJsonOutput> {
  let parsed: unknown[];
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { resultEvent: null, assistantText: "", sessionId: null, usage: null };
  }
  if (!Array.isArray(parsed)) {
    return { resultEvent: null, assistantText: "", sessionId: null, usage: null };
  }

  let resultEvent: QwenResultEvent | null = null;
  let sessionId: string | null = null;
  let assistantText = "";
  let lastUsage: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | null = null;

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    if (obj.type === "result" && obj.subtype === "success") {
      resultEvent = obj as unknown as QwenResultEvent;
      sessionId = resultEvent.session_id ?? sessionId;
      if (resultEvent.usage) lastUsage = resultEvent.usage;
    } else if (obj.type === "assistant") {
      const msg = obj as unknown as QwenAssistantEvent;
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const c of msg.message.content) {
          if (c.type === "text" && typeof c.text === "string") {
            assistantText += c.text;
          }
        }
      }
      sessionId = msg.session_id ?? sessionId;
    } else if (obj.type === "system" && obj.subtype === "init") {
      sessionId = (obj.session_id as string) ?? sessionId;
    }
  }

  const usage = lastUsage
    ? {
        inputTokens: lastUsage.input_tokens ?? 0,
        outputTokens: lastUsage.output_tokens ?? 0,
        cachedInputTokens: lastUsage.cached_input_tokens ?? 0,
      }
    : null;

  return { resultEvent, assistantText, sessionId, usage };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "Use PAPERCLIP_API_URL exactly as injected. Do not replace it with https://api.paperclip.ai or any guessed public endpoint.",
  ].join("\n");
}

function renderPaperclipApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) {
    return "";
  }

  return [
    "Paperclip API access note:",
    "Use the injected Paperclip API environment variables to update issue state before ending the heartbeat.",
    "Never hard-code Paperclip API hosts. In local/dev runs, https://api.paperclip.ai is the wrong server.",
    "For any mutating request, include Authorization: Bearer $PAPERCLIP_API_KEY and X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID.",
    "When work is complete, do not only leave a comment. PATCH the issue itself to a terminal or waiting status.",
    "PowerShell completion example:",
    `  Invoke-RestMethod -Method Patch -Uri "$env:PAPERCLIP_API_URL/api/issues/$env:PAPERCLIP_TASK_ID" -Headers @{ Authorization = "Bearer $env:PAPERCLIP_API_KEY"; "X-Paperclip-Run-Id" = $env:PAPERCLIP_RUN_ID } -ContentType "application/json" -Body (@{ status = "done"; comment = "Completed in this run." } | ConvertTo-Json)`,
    "Valid issue status values include backlog, todo, in_progress, in_review, done, blocked, and cancelled.",
  ].join("\n");
}

async function renderQwenSkillNote(config: Record<string, unknown>): Promise<string> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const selectedSkills = resolvePaperclipDesiredSkillNames(config, availableEntries)
    .map((key) => availableEntries.find((entry) => entry.key === key)?.runtimeName)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  if (selectedSkills.length === 0) return "";

  const skillsHome = path.join(os.homedir(), ".qwen", "skills");
  const lines = [
    "Paperclip runtime skills note:",
    `Skill root: ${skillsHome}`,
    `Selected skills: ${selectedSkills.join(", ")}`,
    "When the task involves Paperclip issues, heartbeats, status changes, delegation, comments, or API calls, read and follow the paperclip skill SKILL.md before acting.",
  ];
  if (selectedSkills.includes("paperclip")) {
    lines.push(`For this heartbeat, the Paperclip control-plane protocol is available at ${path.join(skillsHome, "paperclip", "SKILL.md")}.`);
  }
  return lines.join("\n");
}

function shouldStartFreshSessionForPaperclipApiRun(context: Record<string, unknown>): boolean {
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason : "";
  const issueId = typeof context.issueId === "string" ? context.issueId : "";
  const taskId = typeof context.taskId === "string" ? context.taskId : "";
  if (!issueId && !taskId) return false;
  return [
    "finish_successful_run_handoff",
    "run_liveness_continuation",
    "issue_assigned",
    "issue_commented",
    "issue_comment_mentioned",
  ].includes(wakeReason);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // ---- Resolve config ----
  const command = asString(config.command, "qwen");
  const model = asString(config.model, "qwen3.6-plus");
  const maxSessionTurns = asNumber(config.maxSessionTurns, 500);
  const approvalMode = asString(config.approvalMode, "yolo");
  const outputFormat = asString(config.outputFormat, "stream-json");
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const extraArgs = asStringArray(config.extraArgs);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);

  // ---- Resolve workspace ----
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ---- Build env ----
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Inject context env vars
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
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    agentHome,
  });

  // Apply user env config
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  // ---- Build prompt ----
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const forceFreshSession = shouldStartFreshSessionForPaperclipApiRun(context);
  const canResumeSession = runtimeSessionId.length > 0 && !forceFreshSession;
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  let instructionsPrefix = "";
  const commandNotes: string[] = sessionId ? [`Resuming session ${sessionId}`] : [];
  if (forceFreshSession && runtimeSessionId) {
    commandNotes.push(
      `Starting a fresh Qwen session instead of resuming ${runtimeSessionId} so Paperclip API routing follows the current runtime env.`,
    );
  }
  if (instructionsFilePath && !sessionId) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix = [
        instructionsContents.trim(),
        `The above agent instructions were loaded from ${instructionsFilePath}. Follow them for this Qwen run.`,
      ].filter(Boolean).join("\n\n");
      commandNotes.push(`Loaded agent instructions from ${instructionsFilePath}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
      commandNotes.push(`Configured instructionsFilePath ${instructionsFilePath}, but file could not be read.`);
    }
  }
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderPaperclipApiAccessNote(env);
  const skillNote = await renderQwenSkillNote(config);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    paperclipEnvNote,
    apiAccessNote,
    skillNote,
    renderedPrompt,
  ]);

  // ---- Build CLI args ----
  // Qwen headless mode: stdin prompt, --approval-mode yolo, --max-session-turns
  const args: string[] = [
    "-o", outputFormat,
    "--approval-mode", approvalMode,
    "--max-session-turns", String(maxSessionTurns),
    "-m", model,
  ];

  // Session resume via -c (--continue)
  if (sessionId) {
    args.push("-c");
  }

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  // Qwen supports reading from stdin when no positional argument is given.
  args.push("--");
  // The prompt is passed via stdin to avoid shell argument length limits
  // and to keep the command line clean. Qwen reads stdin when piped.

  // ---- Log invocation meta ----
  if (onMeta) {
    await onMeta({
      adapterType: "qwen_local",
      command,
      cwd,
      commandArgs: args,
      commandNotes,
      env,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        taskContextChars: taskContextNote.length,
        runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length + skillNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  // ---- Execute ----
  // Qwen reads prompt from stdin when invoked in headless mode
  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    stdin: prompt,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });

  // ---- Parse result ----
  const isJson = outputFormat === "json";
  const parsed = isJson
    ? parseQwenJsonOutput(proc.stdout)
    : parseQwenStreamJsonOutput(proc.stdout);

  const { resultEvent, assistantText, sessionId: resolvedSessionId, usage } = parsed;

  // Timeout
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      clearSession: true,
    };
  }

  // No parsed result
  if (!resultEvent) {
    const stderrLine =
      proc.stderr.split(/\r?\n/).map((l: string) => l.trim()).find(Boolean) ?? "";
    const errorMessage =
      (proc.exitCode ?? 0) !== 0
        ? stderrLine
          ? `Qwen exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
          : `Qwen exited with code ${proc.exitCode ?? -1}`
        : "Failed to parse Qwen output";

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: (proc.exitCode ?? 0) !== 0 ? "qwen_execution_error" : "qwen_parse_error",
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
      clearSession: true,
    };
  }

  // Session params for next heartbeat resume
  const resolvedSessionParams = resolvedSessionId
    ? {
        sessionId: resolvedSessionId,
        cwd,
      } as Record<string, unknown>
    : null;

  const isError = resultEvent.subtype !== "success";
  const failed = (proc.exitCode ?? 0) !== 0 || isError;
  const errorMessage = failed
    ? resultEvent.result ?? `Qwen exited with code ${proc.exitCode ?? -1}`
    : null;

  const summary = assistantText || resultEvent.result || "";

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: failed ? "qwen_execution_error" : null,
    usage: usage ?? undefined,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: "dashscope",
    model,
    billingType: "subscription",
    costUsd: 0,
    resultJson: resultEvent as unknown as Record<string, unknown>,
    summary,
    clearSession: isError,
  };
}
