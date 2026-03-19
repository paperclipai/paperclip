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
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
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

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensurePiSkillsInjected(onLog: AdapterExecutionContext["onLog"]) {
  const skillsEntries = await listPaperclipSkillEntries(__moduleDir);

  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  if (skillsEntries.length === 0) return;

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    skillsEntries.map((entry) => entry.name),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of skillsEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.name);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.name}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.name}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
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
  await ensurePiSkillsInjected(onLog);

  // Build environment
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
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
    
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

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
      "stderr",
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
        `You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.`;
      await onLog(
        "stderr",
        `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
    } catch (err) {
      instructionsReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
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
  const renderedHeartbeatPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedHeartbeatPrompt,
  ]);
  const promptMetrics = {
    systemPromptChars: renderedSystemPromptExtension.length,
    promptChars: userPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
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
    
    // Use RPC mode for proper lifecycle management (waits for agent completion)
    args.push("--mode", "rpc");
    
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
    
    return args;
  };

  const buildRpcStdin = (): string => {
    // Send the prompt as an RPC command
    const promptCommand = {
      type: "prompt",
      message: userPrompt,
    };
    return JSON.stringify(promptCommand) + "\n";
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    if (onMeta) {
      await onMeta({
        adapterType: "pi_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt: userPrompt,
        promptMetrics,
        context,
      });
    }

    // Buffer stdout by lines to handle partial JSON chunks
    let stdoutBuffer = "";
    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        // Pass stderr through immediately (not JSONL)
        await onLog(stream, chunk);
        return;
      }
      
      // Buffer stdout and emit only complete lines
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuffer = lines.pop() || "";
      
      // Emit complete lines
      for (const line of lines) {
        if (line) {
          await onLog(stream, line + "\n");
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog: bufferedOnLog,
      stdin: buildRpcStdin(),
    });
    
    // Flush any remaining buffer content
    if (stdoutBuffer) {
      await onLog("stdout", stdoutBuffer);
    }
    
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parsePiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
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
    const fallbackErrorMessage = stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

    return {
      exitCode: rawExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (rawExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
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
        stdout: attempt.proc.stdout,
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
      "stderr",
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
