import fs from "node:fs/promises";
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
  readPaperclipRuntimeSkillEntries,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { syncBobWorkspace } from "./workspace.js";
import { parseBobShellOutput, generateBobShellSummary, parseBobShellStream } from "./parse-stdout.js";
import { resolveBobShellDesiredSkillNames } from "./skills.js";
import { prepareBobPromptBundle } from "./prompt-cache.js";
import { classifyBobError, describeBobFailure, shouldRetry, isSessionError } from "./error-detection.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface BobExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface BobRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  mode: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

async function buildBobRuntimeConfig(input: BobExecutionInput): Promise<BobRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "bob");
  const mode = asString(config.mode, "advanced");
  
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
  
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

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
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);

  return {
    command,
    resolvedCommand,
    cwd,
    mode,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

interface BobAttemptResult {
  proc: RunProcessResult;
  parsed: ReturnType<typeof parseBobShellStream>;
}

function buildBobResult(
  attempt: BobAttemptResult,
  opts: { 
    fallbackSessionId: string | null; 
    clearSession?: boolean; 
    timeoutSec?: number;
    cwd: string;
    promptBundleKey: string;
    workspaceId: string | null;
    workspaceRepoUrl: string | null;
    workspaceRepoRef: string | null;
  }
): AdapterExecutionResult {
  const { proc, parsed } = attempt;

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${opts.timeoutSec ?? 0}s`,
      errorCode: "timeout",
      clearSession: Boolean(opts.clearSession),
    };
  }

  const exitSuccess = (proc.exitCode ?? 0) === 0;
  const errorMessage = exitSuccess
    ? null
    : `Bob Shell exited with code ${proc.exitCode ?? -1}`;

  const resolvedSessionId = parsed.sessionId ?? opts.fallbackSessionId;
  const resolvedSessionParams = resolvedSessionId
    ? ({
        sessionId: resolvedSessionId,
        cwd: opts.cwd,
        promptBundleKey: opts.promptBundleKey,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        ...(opts.workspaceRepoUrl ? { repoUrl: opts.workspaceRepoUrl } : {}),
        ...(opts.workspaceRepoRef ? { repoRef: opts.workspaceRepoRef } : {}),
      } as Record<string, unknown>)
    : null;

  // Use extracted metadata (usage, cost, model) from parsed output
  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: exitSuccess ? null : "bob_shell_error",
    usage: parsed.usage ?? undefined,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: "bob_shell",
    biller: "bob_shell",
    model: parsed.model ?? undefined,
    billingType: parsed.model ? "metered_api" : "unknown",
    costUsd: parsed.costUsd ?? undefined,
    resultJson: {
      result: parsed.finalResult,
      stdout: proc.stdout,
      stderr: proc.stderr,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.costUsd ? { cost_usd: parsed.costUsd } : {}),
    },
    summary: parsed.summary || (exitSuccess ? "Bob Shell completed successfully" : errorMessage ?? "Unknown error"),
    clearSession: Boolean(opts.clearSession && !resolvedSessionId),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const runtimeConfig = await buildBobRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });

  const {
    command,
    resolvedCommand,
    cwd,
    mode,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;

  // Prepare prompt bundle (with caching) - must be done before session validation
  const bobSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveBobShellDesiredSkillNames(config, bobSkillEntries));
  const filteredSkills = bobSkillEntries.filter((entry) => desiredSkillNames.has(entry.key));
  const modeConfig = parseObject(config.modeConfig);
  
  // Read agent instructions from instructionsFilePath if configured
  let combinedInstructionsContents: string | null = null;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const instructionsFileDir = `${path.dirname(instructionsFilePath)}/`;
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  
  const promptBundle = await prepareBobPromptBundle({
    companyId: agent.companyId,
    agentId: agent.id,
    agentName: agent.name,
    agentCapabilities: null,
    mode,
    modeConfig,
    skills: filteredSkills,
    instructionsContents: combinedInstructionsContents,
    onLog,
  });

  // Extract session information from runtime and validate
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  
  // Validate session can be resumed
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    hasMatchingPromptBundle &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(promptBundle.rootDir));
  
  const sessionId = canResumeSession ? runtimeSessionId : null;
  
  if (runtimeSessionId && runtimeSessionCwd.length > 0 && path.resolve(runtimeSessionCwd) !== path.resolve(promptBundle.rootDir)) {
    await onLog(
      "stdout",
      `[paperclip] Bob Shell session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${promptBundle.rootDir}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Bob Shell session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }

  // Status update: session decision (logged to stderr for visibility)
  const sessionStatus = sessionId
    ? `Resuming Bob Shell session ${sessionId}`
    : "Starting new Bob Shell session";
  await onLog("stderr", `[paperclip] ${sessionStatus}\n`);

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  // Bootstrap prompt for new sessions only
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  const shouldUseResumeDeltaPrompt = Boolean(sessionId);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: shouldUseResumeDeltaPrompt });
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([renderedBootstrapPrompt, wakePrompt, sessionHandoffNote, renderedPrompt]);

  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildBobArgs = (resumeSessionId: string | null, promptText: string) => {
    const args = ["--chat-mode", mode, "--yolo"];
    if (resumeSessionId) {
      args.push("--resume-session", resumeSessionId);
    }
    args.push(...extraArgs);
    if (promptText.trim().length > 0) {
      args.push(promptText);
    }
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null): Promise<BobAttemptResult> => {
    const args = buildBobArgs(resumeSessionId, prompt);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Bob prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (resumeSessionId) {
      commandNotes.push(`Resuming Bob Shell session ${resumeSessionId}`);
    } else {
      commandNotes.push(`Using Bob Shell mode "${mode}"`);
    }
    if (promptBundle.instructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions from ${instructionsFilePath} (with path directive appended)`
      );
    }

    if (onMeta) {
      await onMeta({
        adapterType: "bob_shell",
        command: resolvedCommand,
        cwd: promptBundle.rootDir,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    // Wrap onLog to parse stdout incrementally for progressive status updates
    let accumulatedStdout = "";
    let lastPublishedSummary = "";
    const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stdout") {
        accumulatedStdout += chunk;
        const parsed = parseBobShellStream(accumulatedStdout);
        
        // Log summary updates to stderr for visibility (status updates not available in core adapter interface)
        if (parsed.summary && 
            parsed.summary.length > 0 && 
            parsed.summary !== lastPublishedSummary) {
          const statusParts: string[] = [parsed.summary];
          
          if (parsed.sessionId) {
            statusParts.push(`session: ${parsed.sessionId}`);
          }
          
          if (parsed.model) {
            statusParts.push(`model: ${parsed.model}`);
          }
          
          if (parsed.usage && (parsed.usage.inputTokens > 0 || parsed.usage.outputTokens > 0)) {
            statusParts.push(`tokens: ${parsed.usage.inputTokens}in/${parsed.usage.outputTokens}out`);
            if (parsed.usage.cachedInputTokens && parsed.usage.cachedInputTokens > 0) {
              statusParts.push(`cached: ${parsed.usage.cachedInputTokens}`);
            }
          }
          
          if (parsed.costUsd && parsed.costUsd > 0) {
            statusParts.push(`cost: $${parsed.costUsd.toFixed(4)}`);
          }
          
          await onLog("stderr", `[paperclip] ${statusParts.join(" | ")}\n`);
          lastPublishedSummary = parsed.summary;
        }
      }
      await onLog(stream, chunk);
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd: promptBundle.rootDir,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: wrappedOnLog,
    });

    const parsed = parseBobShellStream(accumulatedStdout || proc.stdout);
    return { proc, parsed };
  };

  // Enhanced retry logic with configurable attempts and exponential backoff
  const maxRetries = asNumber(config.maxRetries, 2);
  const retryDelayMs = asNumber(config.retryDelayMs, 1000);
  
  let currentAttempt = await runAttempt(sessionId ?? null);
  let attemptNumber = 1;
  
  while (attemptNumber <= maxRetries && !currentAttempt.proc.timedOut && (currentAttempt.proc.exitCode ?? 0) !== 0) {
    const errorClassification = classifyBobError({
      exitCode: currentAttempt.proc.exitCode,
      signal: currentAttempt.proc.signal,
      timedOut: currentAttempt.proc.timedOut,
      stdout: currentAttempt.proc.stdout,
      stderr: currentAttempt.proc.stderr,
    });

    // Check if we should retry
    if (!shouldRetry(errorClassification, attemptNumber, maxRetries)) {
      // Log detailed error information for non-retryable errors
      const failureDescription = describeBobFailure({
        exitCode: currentAttempt.proc.exitCode,
        signal: currentAttempt.proc.signal,
        timedOut: currentAttempt.proc.timedOut,
        stdout: currentAttempt.proc.stdout,
        stderr: currentAttempt.proc.stderr,
      });
      await onLog("stderr", `[paperclip] ${failureDescription}\n`);
      break;
    }

    // Calculate delay with exponential backoff
    const delay = retryDelayMs * Math.pow(2, attemptNumber - 1);
    
    await onLog(
      "stdout",
      `[paperclip] ${errorClassification.message}; retrying in ${delay}ms (attempt ${attemptNumber + 1}/${maxRetries + 1}).\n`,
    );
    
    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Retry with fresh session for session errors, otherwise retry with same session
    const retrySessionId = isSessionError(errorClassification) ? null : (sessionId ?? null);
    currentAttempt = await runAttempt(retrySessionId);
    attemptNumber++;
  }
  
  // Determine if we should clear the session
  const shouldClearSession = Boolean(sessionId && !currentAttempt.parsed.sessionId);
  
  return buildBobResult(currentAttempt, { 
    fallbackSessionId: runtimeSessionId || runtime.sessionId,
    clearSession: shouldClearSession,
    timeoutSec,
    cwd: promptBundle.rootDir,
    promptBundleKey: promptBundle.bundleKey,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
  });
}


