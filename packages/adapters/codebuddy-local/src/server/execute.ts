import fsp from "node:fs/promises";
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
  joinPromptSectionsLabeled,
  buildStdinPromptCacheCorrelation,
  ensureAbsoluteDirectory,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  shouldMinimizeAdapterRuntimeSkillNotes,
  capPaperclipInjectedAgentInstructions,
  renderMinimizedPaperclipSkillNoteMarkdown,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createCodeBuddyStreamLogHandler } from "./stream-liveness.js";

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

function excerptStdioForDiagnostics(stdout: string, maxChars = 900): string {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.ceil((maxChars - 24) * 0.55);
  const tail = maxChars - 24 - head;
  return `${trimmed.slice(0, head)}\n…(truncated)…\n${trimmed.slice(-Math.max(tail, 0))}`;
}

/** Cap for `summary` when JSON parse is skipped but we still persist full stdout in `resultJson`. */
const PARSE_SKIPPED_SUMMARY_MAX_CHARS = 120_000;

export function buildParseSkippedSummary(stdout: string): string {
  const normalized = stdout.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "CodeBuddy exited 0 but produced no parseable JSON; raw stderr/stdout are stored on the run record.";
  }
  if (normalized.length <= PARSE_SKIPPED_SUMMARY_MAX_CHARS) return normalized;
  return (
    `${normalized.slice(0, PARSE_SKIPPED_SUMMARY_MAX_CHARS)}\n\n` +
    "…(summary truncated; full stdout is stored in result JSON)…"
  );
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

function resolveCodebuddySkillsHomeForPrompt(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  const configuredHome = asString(envConfig.HOME, "").trim();
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".codebuddy", "skills");
}

async function renderCodebuddyRuntimeSkillNote(
  config: Record<string, unknown>,
  minimize: boolean,
): Promise<string> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const selectedSkills = resolvePaperclipDesiredSkillNames(config, availableEntries)
    .map((key) => availableEntries.find((entry) => entry.key === key)?.runtimeName)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  if (selectedSkills.length === 0) return "";

  const skillsHome = resolveCodebuddySkillsHomeForPrompt(config);
  if (minimize) {
    return renderMinimizedPaperclipSkillNoteMarkdown(config, __moduleDir, skillsHome);
  }
  const lines = [
    "Paperclip 运行时技能说明：",
    `- 技能根目录：${skillsHome}`,
    `- 本次挂载的运行时技能名：${selectedSkills.join(", ")}`,
    "- 当事务涉及 Paperclip 的 issue、`heartbeat`、状态变更、委派、评论或 API 调用时，先阅读并按 `paperclip` 技能的 `SKILL.md` 再行动。",
  ];
  if (selectedSkills.includes("paperclip")) {
    lines.push(`- 本次心跳内，控制面协议（与 API 路由一致的操作说明）文件：${path.join(skillsHome, "paperclip", "SKILL.md")}`);
  }
  return lines.join("\n");
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
  const outputFormat = asString(config.outputFormat, "stream-json");
  const includePartialMessages = asBoolean(config.includePartialMessages, false);
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

  /** Reduce background cron + hot-reload churn in headless runs; override via config.env. */
  const applyDefaultCodebuddyHeadlessEnv = asBoolean(config.applyDefaultCodebuddyHeadlessEnv, true);
  if (applyDefaultCodebuddyHeadlessEnv) {
    const defaultHeadlessEnv: Record<string, string> = {
      CODEBUDDY_DISABLE_CRON: "1",
      CODEBUDDY_DISABLE_HOT_RELOAD: "1",
    };
    for (const [key, value] of Object.entries(defaultHeadlessEnv)) {
      const userVal = envConfig[key];
      if (typeof userVal === "string" && userVal.trim().length > 0) continue;
      if (typeof env[key] === "string" && env[key].trim().length > 0) continue;
      env[key] = value;
    }
  }

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
  const minimizeRuntimeSkillNotes = shouldMinimizeAdapterRuntimeSkillNotes(context, Boolean(sessionId));
  const skillNote = await renderCodebuddyRuntimeSkillNote(config, minimizeRuntimeSkillNotes);
  const { prompt, promptSections } = joinPromptSectionsLabeled([
    { id: "bootstrap", body: renderedBootstrapPrompt },
    { id: "wake", body: wakePrompt },
    { id: "session_handoff", body: sessionHandoffNote },
    { id: "task_context", body: taskContextNote },
    { id: "skill_note", body: skillNote },
    { id: "heartbeat_template", body: renderedPrompt },
  ]);

  let effectiveInstructionsPath = instructionsFilePath;
  if (instructionsFilePath && !sessionId) {
    try {
      const rawInstr = await fsp.readFile(instructionsFilePath, "utf8");
      const capped = capPaperclipInjectedAgentInstructions(rawInstr, context, Boolean(sessionId));
      if (capped !== rawInstr) {
        const tmp = path.join(os.tmpdir(), `paperclip-codebuddy-capped-instructions-${runId}.md`);
        await fsp.writeFile(tmp, capped, "utf8");
        effectiveInstructionsPath = tmp;
      }
    } catch {
      effectiveInstructionsPath = instructionsFilePath;
    }
  }

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

  if (effectiveInstructionsPath && !sessionId) {
    args.push("--system-prompt-file", effectiveInstructionsPath);
  }

  if (includePartialMessages && outputFormat === "stream-json") {
    args.push("--include-partial-messages");
  }

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  // ---- Log invocation meta ----
  if (onMeta) {
    const promptCacheCorrelation = buildStdinPromptCacheCorrelation({
      resumedSession: Boolean(sessionId),
      bootstrapTemplateConfigured: bootstrapPromptTemplate.trim().length > 0,
      bootstrapStdinEmittedChars: renderedBootstrapPrompt.length,
      heartbeatTemplateConfigured: promptTemplate.trim().length > 0,
      heartbeatStdinEmittedChars: renderedPrompt.length,
    });
    await onMeta({
      adapterType: "codebuddy_local",
      command,
      cwd,
      commandArgs: args,
      commandNotes: sessionId ? [`Resuming session ${sessionId}`] : [],
      env,
      prompt,
      promptSections,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        taskContextChars: taskContextNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      promptCacheCorrelation,
      context,
    });
  }

  // ---- Execute ----
  const fs = await import("node:fs");

  // Plan A: On Windows, bypass cmd.exe wrapping to avoid STATUS_DLL_INIT_FAILED
  // caused by @lydell/node-pty/conpty.node failing in a non-console process tree.
  // Instead of: spawn(cmd.exe, ["/d","/s","/c", "codebuddy.cmd ..."])
  // We do:      spawn(node.exe, [entryScript, ...args])
  // Falls back to cmd.exe wrapping if resolution fails at any step.
  let spawnCommand = command;
  let spawnArgs = args;
  if (process.platform === "win32") {
    const { execSync } = await import("node:child_process");
    try {
      const whichOut = execSync(`where ${command}`, { encoding: "utf8", timeout: 5000 })
        .split("\n").map((s: string) => s.trim()).filter(Boolean);
      const cmdPath = whichOut.find((p: string) => /\.cmd$/i.test(p));
      if (cmdPath) {
        const cmdDir = path.dirname(cmdPath);
        const entryScript = path.join(cmdDir, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
        const nodeOut = execSync("where node", { encoding: "utf8", timeout: 5000 })
          .split("\n").map((s: string) => s.trim()).filter(Boolean);
        const nodeBin = nodeOut[0];
        if (nodeBin && fs.existsSync(entryScript)) {
          spawnCommand = nodeBin;
          spawnArgs = [entryScript, ...args];
          await onLog("stdout", `[paperclip] Plan A: bypassing cmd.exe wrapper, spawning node directly\n`);
        }
      }
    } catch {
      // Fall back to default cmd.exe wrapping
    }
  }

  const isStreamJson = outputFormat === "stream-json";
  const streamLog = createCodeBuddyStreamLogHandler({ runId, onLog, graceSec });

  const proc = await runChildProcess(runId, spawnCommand, spawnArgs, {
    cwd,
    env,
    stdin: prompt,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog: streamLog.onLog,
    terminalResultCleanup: isStreamJson
      ? {
          graceMs: asNumber(config.terminalResultCleanupGraceMs, 5_000),
          hasTerminalResult: ({ stdout, stderr }) =>
            stdout.includes('"type":"result"') || stderr.includes('"type":"result"'),
        }
      : undefined,
  });
  await streamLog.flush();

  const fatalStop = streamLog.getFatalStop();
  if (fatalStop) {
    return {
      exitCode: proc.exitCode ?? 1,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage: fatalStop.errorMessage,
      errorCode: fatalStop.errorCode,
      clearSession: true,
      resultJson: { stdout: proc.stdout, stderr: proc.stderr, codebuddyFatalStop: true },
    };
  }

  // ---- Parse result ----
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

  // No parsed `type:result` payload (truncated stdout, schema drift, etc.)
  if (!resultJson) {
    // Pause strict JSON semantics for the happy path: if the CLI succeeded, treat the run as OK
    // and persist raw streams for DB / log storage (source of truth). No codebuddy_parse_error.
    if ((proc.exitCode ?? 0) === 0) {
      await onLog(
        "stdout",
        "[paperclip] CodeBuddy JSON not parsed (exit 0). Persisting raw stdout/stderr on the run; skipping parse-based usage/session extraction.\n",
      );
      const summary = buildParseSkippedSummary(proc.stdout);
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: null,
        errorCode: null,
        usage: undefined,
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        provider: rawModel.startsWith("V-")
          ? "volcengine"
          : rawModel.startsWith("D-")
            ? "deepseek"
            : rawModel.startsWith("M-")
              ? "xiaomi"
              : "tencent",
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          codebuddyParseSkipped: true,
          codebuddyParseNote:
            "CodeBuddy --print JSON was not parsed (often oversized, truncated, or non-array shape). Raw streams are stored; inspect stdout in the run record or logs.",
        },
        summary,
        clearSession: false,
      };
    }

    const stderrLine =
      proc.stderr.split(/\r?\n/).map((l: string) => l.trim()).find(Boolean) ?? "";
    const baseMessage =
      stderrLine
        ? `CodeBuddy exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `CodeBuddy exited with code ${proc.exitCode ?? -1}`;

    const extra: string[] = [];
    const outExcerpt = excerptStdioForDiagnostics(proc.stdout);
    if (outExcerpt) extra.push(`stdout excerpt:\n${outExcerpt}`);
    const errExcerpt = excerptStdioForDiagnostics(proc.stderr, 420);
    if (errExcerpt) extra.push(`stderr excerpt:\n${errExcerpt}`);

    const errorMessage = extra.length > 0 ? `${baseMessage}\n\n${extra.join("\n\n")}` : baseMessage;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: "codebuddy_execution_error",
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
