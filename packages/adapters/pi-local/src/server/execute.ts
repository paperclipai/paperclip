import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_BIZBOX_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const BIZBOX_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
const PI_AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function truncateSummary(value: string, maxChars: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function summarizeRecordFieldCount(record: Record<string, unknown>): string | null {
  const keyCount = Object.keys(record).length;
  if (keyCount === 0) return null;
  return `${keyCount} field${keyCount === 1 ? "" : "s"}`;
}

export function summarizeProgressToolInput(input: unknown): string | null {
  if (typeof input === "string") {
    return null;
  }
  const record = asRecord(input);
  if (!record) return null;

  return summarizeRecordFieldCount(record);
}

type PiProgressState = {
  sawThinking: boolean;
};

export function formatPiProgressMessage(line: string, state: PiProgressState): string | null {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return null;

  const type = readString(parsed.type);

  if (type === "agent_start") {
    state.sawThinking = false;
    return "[paperclip] Pi agent started.";
  }

  if (type === "turn_start") {
    state.sawThinking = false;
    return "[paperclip] Pi turn started.";
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (!assistantEvent) return null;
    const msgType = readString(assistantEvent.type);
    if (msgType === "thinking_delta" && !state.sawThinking) {
      state.sawThinking = true;
      return "[paperclip] Pi thinking...";
    }
    return null;
  }

  if (type === "tool_execution_start") {
    const toolName = readString(parsed.toolName, "tool");
    const inputSummary = summarizeProgressToolInput(parsed.args);
    return inputSummary
      ? `[paperclip] Pi tool running: ${toolName} (${inputSummary}).`
      : `[paperclip] Pi tool running: ${toolName}.`;
  }

  if (type === "tool_execution_end") {
    const toolName = readString(parsed.toolName, "tool");
    const isError = parsed.isError === true;
    const result = parsed.result;
    const resultType =
      typeof result === "string"
        ? "text"
        : Array.isArray(result)
          ? "array"
          : result && typeof result === "object"
            ? "object"
            : typeof result;
    return isError
      ? `[paperclip] Pi tool failed: ${toolName} (${resultType}).`
      : `[paperclip] Pi tool completed: ${toolName} (${resultType}).`;
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message);
    const toolResults = Array.isArray(parsed.toolResults) ? parsed.toolResults : [];
    const usage = message ? asRecord(message.usage) : null;
    const tokenSummary = usage
      ? `input ${asNumber(usage.inputTokens ?? usage.input, 0)}, output ${asNumber(usage.outputTokens ?? usage.output, 0)}`
      : null;
    const toolCount = toolResults.length > 0 ? `${toolResults.length} tool result${toolResults.length === 1 ? "" : "s"}` : null;
    const details = [toolCount, tokenSummary].filter((value): value is string => typeof value === "string" && value.length > 0);
    return details.length > 0
      ? `[paperclip] Pi turn completed (${details.join("; ")}).`
      : "[paperclip] Pi turn completed.";
  }

  if (type === "auto_retry_end") {
    const succeeded = parsed.success === true;
    if (succeeded) return "[paperclip] Pi automatic retry cycle completed.";
    const attempt = asNumber(parsed.attempt, 0);
    return attempt > 0
      ? `[paperclip] Pi automatic retries exhausted after ${attempt} attempts.`
      : "[paperclip] Pi automatic retries exhausted.";
  }

  if (type === "agent_end") {
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages.length > 0
      ? `[paperclip] Pi agent finished (${messages.length} message${messages.length === 1 ? "" : "s"}).`
      : "[paperclip] Pi agent finished.";
  }

  if (type === "error") {
    const message = readString(parsed.message, "").trim();
    return message
      ? `[paperclip] Pi error: ${truncateSummary(message, 72)}`
      : "[paperclip] Pi error.";
  }

  return null;
}

async function ensurePiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(BIZBOX_SESSIONS_DIR, { recursive: true });
  return BIZBOX_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(BIZBOX_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const progressPlaceholder =
    "[paperclip] Pi autonomous run is in progress. Watching for safe milestones.\n";

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_BIZBOX_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  
  // Ensure sessions directory exists
  await ensureSessionsDir();
  
  // Inject skills
  const piSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolvePaperclipDesiredSkillNames(config, piSkillEntries);
  await ensurePiSkillsInjected(onLog, piSkillEntries, desiredPiSkillNames);

  // Build environment
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.BIZBOX_API_KEY === "string" && envConfig.BIZBOX_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.BIZBOX_RUN_ID = runId;
  
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
    
  if (wakeTaskId) env.BIZBOX_TASK_ID = wakeTaskId;
  if (wakeReason) env.BIZBOX_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.BIZBOX_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.BIZBOX_APPROVAL_ID = approvalId;
  if (approvalStatus) env.BIZBOX_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.BIZBOX_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.BIZBOX_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (workspaceCwd) env.BIZBOX_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.BIZBOX_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.BIZBOX_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.BIZBOX_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.BIZBOX_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.BIZBOX_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.BIZBOX_API_KEY = authToken;
  }
  
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  // Validate model is available before execution
  await ensurePiModelConfiguredAndAvailable({
    model,
    command,
    cwd,
    env: runtimeEnv,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // Handle session
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionPath = canResumeSession ? runtimeSessionId : buildSessionPath(agent.id, new Date().toISOString());
  
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Ensure session file exists (Pi requires this on first run)
  if (!canResumeSession) {
    try {
      await fs.writeFile(sessionPath, "", { flag: "wx" });
    } catch (err) {
      // File may already exist, that's ok
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  // Handle instructions file and build system prompt extension
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  
  let systemPromptExtension = "";
  let instructionsReadFailed = false;
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      systemPromptExtension =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
        DEFAULT_BIZBOX_AGENT_PROMPT_TEMPLATE;
    } catch (err) {
      instructionsReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
      // Fall back to base prompt template
      systemPromptExtension = promptTemplate;
    }
  } else {
    systemPromptExtension = promptTemplate;
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canResumeSession });
  const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
  const renderedHeartbeatPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedHeartbeatPrompt,
  ]);
  const promptMetrics = {
    systemPromptChars: renderedSystemPromptExtension.length,
    promptChars: userPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedHeartbeatPrompt.length,
  };

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) return [] as string[];
    if (instructionsReadFailed) {
      return [
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ];
    }
    return [
      `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
      `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
    ];
  })();

  const buildArgs = (sessionFile: string): string[] => {
    const args: string[] = [];
    
    // Use JSON mode for structured output with print mode (non-interactive)
    args.push("--mode", "json");
    args.push("-p"); // Non-interactive mode: process prompt and exit
    
    // Use --append-system-prompt to extend Pi's default system prompt
    args.push("--append-system-prompt", renderedSystemPromptExtension);
    
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (thinking) args.push("--thinking", thinking);

    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    args.push("--session", sessionFile);

    // Add Paperclip skills directory so Pi can load the paperclip skill
    args.push("--skill", PI_AGENT_SKILLS_DIR);

    if (extraArgs.length > 0) args.push(...extraArgs);
    
    // Add the user prompt as the last argument
    args.push(userPrompt);

    return args;
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    const progressState: PiProgressState = { sawThinking: false };
    let stdoutBuffer = "";
    const sanitizedStdoutChunks: string[] = [];
    if (onMeta) {
      await onMeta({
        adapterType: "pi_local",
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: args,
        env: loggedEnv,
        prompt: userPrompt,
        promptMetrics,
        context,
      });
    }

    // Keep Pi runs readable in heartbeat logs without leaking the raw stdout stream.
    await onLog("stdout", progressPlaceholder);
    sanitizedStdoutChunks.push(progressPlaceholder);

    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        // Pass stderr through immediately (not JSONL)
        await onLog(stream, chunk);
        return;
      }

      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const progressMessage = formatPiProgressMessage(line, progressState);
        if (progressMessage) {
          const sanitizedChunk = `${progressMessage}\n`;
          sanitizedStdoutChunks.push(sanitizedChunk);
          await onLog("stdout", sanitizedChunk);
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: bufferedOnLog,
    });

    if (stdoutBuffer.trim().length > 0) {
      const progressMessage = formatPiProgressMessage(stdoutBuffer.trim(), progressState);
      if (progressMessage) {
        const sanitizedChunk = `${progressMessage}\n`;
        sanitizedStdoutChunks.push(sanitizedChunk);
        await onLog("stdout", sanitizedChunk);
      }
    }

    return {
      proc,
      rawStderr: proc.stderr,
      sanitizedStdout: sanitizedStdoutChunks.join(""),
      parsed: parsePiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      sanitizedStdout: string;
      parsed: ReturnType<typeof parsePiJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
    const resolvedSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd }
      : null;

    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
    const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
    const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

    return {
      exitCode: effectiveExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: provider,
      biller: resolvePiBiller(runtimeEnv, provider),
      model: model,
      billingType: "unknown",
      costUsd: attempt.parsed.usage.costUsd,
      resultJson: {
        stdout: attempt.sanitizedStdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
      clearSession: Boolean(clearSessionOnMissingSession),
    };
  };

  const initial = await runAttempt(sessionPath);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);
  
  if (
    canResumeSession &&
    initialFailed &&
    isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const newSessionPath = buildSessionPath(agent.id, new Date().toISOString());
    try {
      await fs.writeFile(newSessionPath, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const retry = await runAttempt(newSessionPath);
    return toResult(retry, true);
  }

  return toResult(initial);
}
