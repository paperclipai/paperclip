import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { withWorkspaceRestore } from "@paperclipai/adapter-utils/workspace-restore-result";
import { DEFAULT_AGY_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { buildAgyRemoteSkillsCommand } from "./remote-skills.js";
import { prepareAgyRuntimeMcpConfig } from "./runtime-config.js";
import {
  describeAgyFailure,
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgyTurnLimitResult,
  isAgyUnknownSessionError,
  parseAgyOutput,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function prefixAgyGoal(prompt: string): string {
  return /^\/goal(?:\s|$)/.test(prompt) ? prompt : `/goal ${prompt}`;
}

function resolveAgyProvider(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gemini-")) return "google";
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gpt-")) return "openai";
  return null;
}

function parseCumulativeUsage(value: unknown): UsageSummary | null {
  const raw = parseObject(value);
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    inputTokens: asNumber(raw.inputTokens ?? raw.input_tokens, 0),
    outputTokens: asNumber(raw.outputTokens ?? raw.output_tokens, 0),
    cachedInputTokens: asNumber(
      raw.cachedInputTokens ?? raw.cached_input_tokens ?? raw.cache_read_tokens,
      0,
    ),
  };
}

async function buildAgySkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agy-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, true);

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
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const agySkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredAgySkillNames = resolveLegacyPaperclipDesiredSkillNames(config, agySkillEntries);

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
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
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
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
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
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
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);

  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    cwd,
    runtimeEnv,
  );
  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const configuredExtraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  // Some older agent configs packed multiple CLI options into one array item.
  // Split those entries when they contain the stale goal flag, then route
  // permission bypass exclusively through its typed boolean setting below.
  const normalizedExtraArgs = configuredExtraArgs.flatMap((arg) =>
    /(?:^|\s)--?goal(?:\s|$)/i.test(arg) ? arg.trim().split(/\s+/).filter(Boolean) : [arg],
  );
  const ignoredLegacyGoalArgs = normalizedExtraArgs.filter((arg) => /^--?goal$/i.test(arg));
  const extraArgs = normalizedExtraArgs.filter(
    (arg) => !/^--?goal$/i.test(arg) && !/^--dangerously-skip-permissions$/i.test(arg),
  );

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteSkillsDir: string | null = null;
  let localSkillsDir: string | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  if (executionTargetIsRemote) {
    try {
      localSkillsDir = await buildAgySkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Antigravity CLI runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "agy",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
        ],
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
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
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      // AGY authenticates from the remote user's ~/.gemini state. Keep the
      // actual remote HOME even when the workspace/runtime is managed; the
      // managed runtime root is for Paperclip assets, not user credentials.
      const remoteHomeDir = await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onLog,
      });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        remoteSkillsDir = path.posix.join(effectiveExecutionCwd, ".agents", "skills");
        const skillSync = await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          buildAgyRemoteSkillsCommand(
            remoteSkillsDir,
            preparedExecutionTargetRuntime.assetDirs.skills,
            agySkillEntries.filter((entry) => desiredAgySkillNames.includes(entry.key)).map((entry) => entry.runtimeName),
          ),
          { cwd, env, timeoutSec, graceSec, onLog },
        );
        if (skillSync.timedOut || skillSync.exitCode !== 0) {
          throw new Error("Failed to synchronize managed AGY skills on the execution target");
        }
      }
    } catch (error) {
      await Promise.allSettled([
        restoreRemoteWorkspace?.(),
        localSkillsDir
          ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined)
          : Promise.resolve(),
      ]);
      throw error;
    }
  }

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(
    executionTarget,
    effectiveExecutionCwd,
  );
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: remoteRuntimeRootDir,
      adapterKey: "agy",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      loggedEnv = buildInvocationEnvForLogs(env, {
        runtimeEnv: ensurePathInEnv({ ...process.env, ...env }),
        includeRuntimeKeys: ["HOME"],
        resolvedCommand,
      });
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 ||
      path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] AGY CLI session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] AGY CLI session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const content = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${content.trim()}\n\n` +
        `The instructions above were loaded from ${instructionsFilePath}.\n` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes = (() => {
    const notes: string[] = [
      "Prompt is passed to AGY CLI through stdin as a stream-json user event.",
      "Prefixed the task prompt with /goal so AGY works continuously toward the objective.",
    ];
    if (ignoredLegacyGoalArgs.length > 0) {
      notes.push("Removed legacy -goal/--goal CLI arguments; /goal is sent as a prompt command.");
    }
    if (normalizedExtraArgs.some((arg) => /^--dangerously-skip-permissions$/i.test(arg))) {
      notes.push("Ignored the raw permission-bypass CLI argument; the typed permission setting controls this option.");
    }
    if (asBoolean(config.dangerouslySkipPermissions, false)) {
      notes.push("Added --dangerously-skip-permissions because the agent configuration enables it.");
    }
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        "Prepended instructions + path directive to prompt.",
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
  })();

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
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(sessionId),
  });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const hasLocalRuntimeMcpServers =
    !executionTargetIsRemote && (ctx.runtimeMcp?.getServers().length ?? 0) > 0;
  const prompt = prefixAgyGoal(joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
    hasLocalRuntimeMcpServers
      ? [
          "Paperclip runtime clarification: for GitHub or other connected-app operations, inspect the tool definitions exposed for the Paperclip assigned-tools gateway, then call the exact exposed tool on that gateway. Paperclip gateway tool names are namespaced. If the task refers to a `github` server or raw upstream names such as `get_me`, treat those as the intended provider/action and resolve them to the exact tool names exposed for the assigned gateway. Do not call guessed names. Run-scoped gateway credentials permit only the MCP methods `tools/list` and `tools/call`; do not call `resources/list`, `resources/read`, `prompts/list`, or `prompts/get` on that gateway. The Paperclip connections server only handles connection discovery and requests; provider actions are on the assigned-tools gateway.",
        ].join("\n")
      : null,
  ]));
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args: string[] = [];
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    if (model && model !== DEFAULT_AGY_LOCAL_MODEL) {
      args.push("--model", model);
    }
    if (asBoolean(config.dangerouslySkipPermissions, false)) {
      args.push("--dangerously-skip-permissions");
    }
    if (sandbox) {
      args.push("--sandbox");
    }
    if (extraArgs.length > 0) {
      args.push(...extraArgs);
    }

    // Paperclip consumes structured events for session, tool, and usage data.
    // AGY's stream-json input mode also requires stream-json output. Place both
    // flags after extraArgs so custom args cannot silently disable the protocol.
    args.push("--output-format", "stream-json");
    args.push("--input-format", "stream-json");
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "agy_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes,
        commandArgs: args,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(
      runId,
      runtimeExecutionTarget,
      command,
      args,
      {
        cwd,
        env,
        stdin: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog,
      },
    );
    return {
      proc,
      parsed: parseAgyOutput(proc.stdout, proc.stderr),
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseAgyOutput>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectAgyAuthRequired({
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "agy_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const failed = (attempt.proc.exitCode ?? 0) !== 0 || attempt.parsed.isError;
    const clearSessionForTurnLimit = isAgyTurnLimitResult(
      attempt.proc.stdout,
      attempt.proc.stderr,
      attempt.proc.exitCode,
    );
    const quotaMeta =
      failed && !authMeta.requiresAuth && !clearSessionForTurnLimit
        ? detectAgyQuotaExhausted({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
          })
        : { exhausted: false as const, resetHint: null, retryNotBefore: null };

    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (canFallbackToRuntimeSession ? sessionId : null);

    const isSameSession = Boolean(
      sessionId &&
      canResumeSession &&
      canFallbackToRuntimeSession &&
      resolvedSessionId &&
      resolvedSessionId === sessionId,
    );

    const previousCumulativeUsage = isSameSession
      ? parseCumulativeUsage(runtimeSessionParams.cumulativeUsage)
      : null;

    let resolvedUsage = attempt.parsed.usage;
    let resolvedUsageBasis: "per_run" | "session_cumulative" | null = attempt.parsed.usageBasis;
    let nextCumulativeUsage: UsageSummary | null = previousCumulativeUsage;

    if (attempt.parsed.hasStepUsage) {
      resolvedUsageBasis = "per_run";
      if (attempt.parsed.resultUsage) {
        nextCumulativeUsage = attempt.parsed.resultUsage;
      } else if (previousCumulativeUsage) {
        nextCumulativeUsage = {
          inputTokens: previousCumulativeUsage.inputTokens + resolvedUsage.inputTokens,
          outputTokens: previousCumulativeUsage.outputTokens + resolvedUsage.outputTokens,
          cachedInputTokens: (previousCumulativeUsage.cachedInputTokens ?? 0) + (resolvedUsage.cachedInputTokens ?? 0),
        };
      } else {
        nextCumulativeUsage = resolvedUsage;
      }
    } else if (attempt.parsed.resultUsage) {
      if (isSameSession && previousCumulativeUsage) {
        resolvedUsage = {
          inputTokens: Math.max(0, attempt.parsed.resultUsage.inputTokens - previousCumulativeUsage.inputTokens),
          outputTokens: Math.max(0, attempt.parsed.resultUsage.outputTokens - previousCumulativeUsage.outputTokens),
          cachedInputTokens: Math.max(
            0,
            (attempt.parsed.resultUsage.cachedInputTokens ?? 0) - (previousCumulativeUsage.cachedInputTokens ?? 0),
          ),
        };
        resolvedUsageBasis = "per_run";
        nextCumulativeUsage = attempt.parsed.resultUsage;
      } else if (!isSameSession) {
        resolvedUsage = attempt.parsed.resultUsage;
        resolvedUsageBasis = "per_run";
        nextCumulativeUsage = attempt.parsed.resultUsage;
      } else {
        resolvedUsage = attempt.parsed.resultUsage;
        resolvedUsageBasis = "session_cumulative";
        nextCumulativeUsage = attempt.parsed.resultUsage;
      }
    }

    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(nextCumulativeUsage ? { cumulativeUsage: nextCumulativeUsage } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? {
                remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
              }
            : {}),
        } as Record<string, unknown>)
      : null;

    const fallbackErrorMessage =
      attempt.parsed.errorMessage || describeAgyFailure(attempt.proc.stdout, attempt.proc.stderr);

    const errorCode = !failed
      ? null
      : authMeta.requiresAuth
      ? "agy_auth_required"
      : clearSessionForTurnLimit
      ? "max_turns_exhausted"
      : quotaMeta.exhausted
      ? "agy_quota_exhausted"
      : null;

    return {
      exitCode: failed && attempt.proc.exitCode === 0 ? 1 : attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode,
      errorFamily: quotaMeta.exhausted ? "transient_upstream" : null,
      retryNotBefore: quotaMeta.retryNotBefore ?? null,
      usage: resolvedUsage,
      usageBasis: resolvedUsageBasis,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: resolveAgyProvider(model),
      biller: "google",
      model,
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(quotaMeta.exhausted
          ? { errorFamily: "transient_upstream", quotaResetHint: quotaMeta.resetHint }
          : {}),
      },
      summary: attempt.parsed.summary,
      clearSession:
        clearSessionForTurnLimit || Boolean(
          !resolvedSessionId && (clearSessionOnMissingSession || (runtimeSessionId && !canResumeSession)),
        ),
    };
  };

  const executeTurn = async (): Promise<AdapterExecutionResult> => {
    const initial = await runAttempt(sessionId);
    ctx.signal?.throwIfAborted();
    if (
      sessionId &&
      !initial.proc.timedOut &&
      ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.isError) &&
      isAgyUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] AGY CLI resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  };

  try {
    const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
    if (executionTargetIsRemote && runtimeMcpServers.length > 0) {
      await onLog(
        "stderr",
        "[paperclip] Paperclip-managed MCP servers are not yet injected for remote AGY execution targets.\n",
      );
    }
    const runtimeMcpConfig = executionTargetIsRemote
      ? { serverNames: [] as string[], cleanup: async () => {} }
      : await prepareAgyRuntimeMcpConfig(
          effectiveExecutionCwd,
          runtimeMcpServers,
          ctx.signal,
          agySkillEntries
            .filter((entry) => desiredAgySkillNames.includes(entry.key))
            .map((entry) => ({ name: entry.runtimeName, source: entry.source })),
        );
    try {
      if (runtimeMcpConfig.serverNames.length > 0) {
        await onLog(
          "stdout",
          `[paperclip] Antigravity will use ${runtimeMcpConfig.serverNames.length} Paperclip-managed MCP server(s): ${runtimeMcpConfig.serverNames.join(", ")}.\n`,
        );
      }
      return await withWorkspaceRestore(executeTurn, async () => {
        await restoreRemoteWorkspace?.();
      });
    } finally {
      await runtimeMcpConfig.cleanup();
    }
  } finally {
    await Promise.allSettled([
      paperclipBridge?.stop(),
      localSkillsDir
        ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined)
        : Promise.resolve(),
    ]);
  }
}
