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
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// JSON output parser
// ---------------------------------------------------------------------------

interface CodeBuddyResultJson {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface CodeBuddyAssistantMessage {
  type: string;
  role?: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
  providerData?: {
    model?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  sessionId?: string;
}

/**
 * Parse the JSON array output from `codebuddy --print --output-format json`.
 * The output is a JSON array of message objects. The last element with
 * `type: "result"` carries the final summary, session_id, and usage.
 */
function parseCodeBuddyJsonOutput(
  stdout: string,
): {
  resultJson: CodeBuddyResultJson | null;
  assistantMessages: CodeBuddyAssistantMessage[];
  assistantText: string;
  sessionId: string | null;
} {
  let parsed: unknown[];
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { resultJson: null, assistantMessages: [], assistantText: "", sessionId: null };
  }
  if (!Array.isArray(parsed)) {
    return { resultJson: null, assistantMessages: [], assistantText: "", sessionId: null };
  }

  let resultJson: CodeBuddyResultJson | null = null;
  const assistantMessages: CodeBuddyAssistantMessage[] = [];
  let sessionId: string | null = null;

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    if (obj.type === "result") {
      resultJson = obj as unknown as CodeBuddyResultJson;
      sessionId = resultJson.session_id ?? null;
    } else if (obj.type === "message" && obj.role === "assistant") {
      const msg = obj as unknown as CodeBuddyAssistantMessage;
      assistantMessages.push(msg);
      if (!sessionId && msg.sessionId) {
        sessionId = msg.sessionId;
      }
    }
  }

  // Extract text content from assistant messages
  const assistantText = assistantMessages
    .flatMap((msg) =>
      (msg.content ?? [])
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text ?? ""),
    )
    .join("\n");

  return { resultJson, assistantMessages, assistantText, sessionId };
}

/**
 * Parse stream-json output. Each line is a JSON object.
 * The last line with `type: "result"` is the terminal result.
 */
function parseCodeBuddyStreamJsonOutput(
  stdout: string,
): ReturnType<typeof parseCodeBuddyJsonOutput> {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  let resultJson: CodeBuddyResultJson | null = null;
  const assistantMessages: CodeBuddyAssistantMessage[] = [];
  let sessionId: string | null = null;
  let assistantText = "";

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "result") {
      resultJson = obj as unknown as CodeBuddyResultJson;
      sessionId = resultJson.session_id ?? null;
    } else if (obj.type === "assistant") {
      // stream-json format: {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
      const message = obj.message as Record<string, unknown> | undefined;
      if (message?.content && Array.isArray(message.content)) {
        for (const c of message.content as Array<Record<string, unknown>>) {
          if (c.type === "text" && typeof c.text === "string") {
            assistantText += c.text;
          }
        }
      }
      sessionId = (obj.session_id as string) ?? sessionId;
    }
  }

  return { resultJson, assistantMessages, assistantText, sessionId };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function resolveCodeBuddyBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "CODEBUDDY_API_KEY") ||
         hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ||
         hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY")
    ? "api"
    : "subscription";
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // ---- Resolve config ----
  const command = asString(config.command, "codebuddy");
  const rawModel = asString(config.model, "V-glm-5.1");
  // Strip Paperclip display prefix (V-/D-/M-) before passing to CodeBuddy CLI
  const baseModel = rawModel.replace(/^[VDM]-/, "");
  // Prefix with custom-local: to use models.json custom models instead of built-in ones
  const model = `custom-local:${baseModel}`;
  const effort = asString(config.effort, "");
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const outputFormat = asString(config.outputFormat, "json");
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

  const billingType = resolveCodeBuddyBillingType(env);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  // ---- Build prompt ----
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] CodeBuddy session "${runtimeSessionId}" does not match cwd "${cwd}". Starting fresh.\n`,
    );
  }

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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);

  // ---- Build CLI args ----
  const args: string[] = ["--print", "--output-format", outputFormat, "--model", model];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  if (dangerouslySkipPermissions) {
    args.push("-y");
  }

  if (effort) {
    args.push("--effort", effort);
  }

  if (maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (instructionsFilePath && !sessionId) {
    args.push("--system-prompt-file", instructionsFilePath);
  }

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  // ---- Log invocation meta ----
  if (onMeta) {
    await onMeta({
      adapterType: "codebuddy_local",
      command,
      cwd,
      commandArgs: args,
      commandNotes: sessionId ? [`Resuming session ${sessionId}`] : [],
      env,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        taskContextChars: taskContextNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  // ---- Execute ----
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
  const isStreamJson = outputFormat === "stream-json";
  const parsed = isStreamJson
    ? parseCodeBuddyStreamJsonOutput(proc.stdout)
    : parseCodeBuddyJsonOutput(proc.stdout);

  const { resultJson, assistantText, sessionId: resolvedSessionId } = parsed;

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
  if (!resultJson) {
    const stderrLine =
      proc.stderr.split(/\r?\n/).map((l: string) => l.trim()).find(Boolean) ?? "";
    const errorMessage =
      (proc.exitCode ?? 0) !== 0
        ? stderrLine
          ? `CodeBuddy exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
          : `CodeBuddy exited with code ${proc.exitCode ?? -1}`
        : "Failed to parse CodeBuddy JSON output";

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: (proc.exitCode ?? 0) !== 0 ? "codebuddy_execution_error" : "codebuddy_parse_error",
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
      clearSession: true,
    };
  }

  // Extract usage
  const usage = resultJson.usage
    ? {
        inputTokens: resultJson.usage.input_tokens ?? 0,
        outputTokens: resultJson.usage.output_tokens ?? 0,
        cachedInputTokens: resultJson.usage.cache_read_input_tokens ?? 0,
      }
    : undefined;

  // Session params for next heartbeat resume
  const resolvedSessionParams = resolvedSessionId
    ? ({
        sessionId: resolvedSessionId,
        cwd,
      } as Record<string, unknown>)
    : null;

  const isError = resultJson.is_error === true;
  const failed = (proc.exitCode ?? 0) !== 0 || isError;
  const errorMessage = failed
    ? resultJson.result ?? `CodeBuddy exited with code ${proc.exitCode ?? -1}`
    : null;

  const summary = assistantText || resultJson.result || "";

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: failed ? "codebuddy_execution_error" : null,
    usage,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: rawModel.startsWith("V-") ? "volcengine" : rawModel.startsWith("D-") ? "deepseek" : rawModel.startsWith("M-") ? "xiaomi" : "tencent",
    model,
    billingType,
    costUsd: resultJson.total_cost_usd ?? 0,
    resultJson: resultJson as unknown as Record<string, unknown>,
    summary,
    clearSession: isError,
  };
}
