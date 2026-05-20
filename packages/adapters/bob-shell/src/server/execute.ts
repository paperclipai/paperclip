import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { syncBobWorkspace } from "./workspace.js";
import { parseBobShellStream } from "./parse-stdout.js";
import { resolveBobShellDesiredSkillNames } from "./skills.js";
import { prepareBobPromptBundle } from "./prompt-cache.js";
import {
  buildBobRuntimeConfig,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  type BobRuntimeConfig,
} from "./runtime-config.js";
import { validateSession, buildSessionParams } from "./session-management.js";
import { executeWithRetry, type BobAttemptResult } from "./retry-strategy.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the final adapter execution result from a Bob Shell attempt.
 * 
 * @param attempt - The completed Bob Shell attempt
 * @param opts - Result building options
 * @returns Adapter execution result
 */
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
  },
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
  const errorMessage = exitSuccess ? null : `Bob Shell exited with code ${proc.exitCode ?? -1}`;

  const resolvedSessionId = parsed.sessionId ?? opts.fallbackSessionId;
  const resolvedSessionParams = resolvedSessionId
    ? buildSessionParams(
        resolvedSessionId,
        opts.cwd,
        opts.promptBundleKey,
        opts.workspaceId,
        opts.workspaceRepoUrl,
        opts.workspaceRepoRef,
      )
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
    summary:
      parsed.summary || (exitSuccess ? "Bob Shell completed successfully" : errorMessage ?? "Unknown error"),
    clearSession: Boolean(opts.clearSession && !resolvedSessionId),
  };
}

/**
 * Executes a Bob Shell agent run with automatic retry on transient failures.
 * 
 * This is the main entry point for the Bob Shell adapter. It:
 * 1. Builds runtime configuration (command, env, workspace)
 * 2. Prepares prompt bundle with caching
 * 3. Validates and resumes sessions when possible
 * 4. Syncs workspace configuration (.bob/ directory)
 * 5. Executes Bob Shell with retry on transient errors
 * 6. Returns execution result with usage metrics and session info
 * 
 * @param ctx - Adapter execution context with agent config and runtime state
 * @returns Execution result with usage metrics, session info, and error details
 * 
 * @example
 * ```typescript
 * const result = await execute({
 *   runId: "run-123",
 *   agent: { id: "agent-456", name: "Engineer", ... },
 *   config: { mode: "paperclip-agent", cwd: "/workspace" },
 *   context: { taskId: "task-789" },
 *   ...
 * });
 * ```
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  // Build runtime configuration
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
    agentRole,
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
    agentRole: agentRole,
    agentCapabilities: null,
    mode,
    modeConfig,
    skills: filteredSkills,
    instructionsContents: combinedInstructionsContents,
    onLog,
  });

  // Validate session can be resumed
  const sessionValidation = validateSession({
    runtime,
    cwd,
    promptBundleKey: promptBundle.bundleKey,
  });

  const sessionId = sessionValidation.canResume ? sessionValidation.sessionId : null;

  // Log session validation results
  if (!sessionValidation.canResume && sessionValidation.reason) {
    await onLog("stdout", `[paperclip] ${sessionValidation.reason}\n`);
  }

  // Sync .bob/ workspace config into the actual project cwd so Bob Shell
  // can find its custom modes, MCP server config, and rule files there.
  await syncBobWorkspace({
    cwd,
    companyId: agent.companyId,
    agentId: agent.id,
    agentName: agent.name,
    agentRole: agentRole,
    agentCapabilities: null,
    agentInstructions: combinedInstructionsContents ?? undefined,
    mode,
    modeConfig,
    skills: filteredSkills,
    env,
    onLog,
  });

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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: shouldUseResumeDeltaPrompt,
  });
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

  /**
   * Builds Bob Shell command-line arguments.
   */
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

  /**
   * Executes a single Bob Shell attempt.
   */
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
      commandNotes.push(`Injected agent instructions from ${instructionsFilePath} (with path directive appended)`);
    }

    if (onMeta) {
      await onMeta({
        adapterType: "bob_shell",
        command: resolvedCommand,
        cwd,
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
        if (parsed.summary && parsed.summary.length > 0 && parsed.summary !== lastPublishedSummary) {
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
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: wrappedOnLog,
    });

    const parsed = parseBobShellStream(accumulatedStdout || proc.stdout);
    return { proc, parsed };
  };

  // Execute with retry strategy
  const maxRetries = asNumber(config.maxRetries, DEFAULT_MAX_RETRIES);
  const retryDelayMs = asNumber(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  const finalAttempt = await executeWithRetry(
    runAttempt,
    { maxRetries, retryDelayMs },
    onLog,
    sessionId,
  );

  // Determine if we should clear the session
  const shouldClearSession = Boolean(sessionId && !finalAttempt.parsed.sessionId);

  return buildBobResult(finalAttempt, {
    fallbackSessionId: runtime.sessionId ?? null,
    clearSession: shouldClearSession,
    timeoutSec,
    cwd,
    promptBundleKey: promptBundle.bundleKey,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
  });
}