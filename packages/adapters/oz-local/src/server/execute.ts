import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OZ_MODEL } from "../index.js";
import {
  isOzUnknownConversationError,
  parseOzOutput,
} from "./parse.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // -------------------------------------------------------------------------
  // 1. Extract & validate config
  // -------------------------------------------------------------------------
  const command = asString(config.command, "oz");
  const model = asString(config.model, DEFAULT_OZ_MODEL).trim();
  const profile = asString(config.profile, "").trim();
  const mcpSpec = asString(config.mcp, "").trim();
  const skillSpec = asString(config.skill, "").trim();
  const agentName = asString(config.name, "").trim();
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

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

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  // -------------------------------------------------------------------------
  // 2. Build environment
  // -------------------------------------------------------------------------
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const hasExplicitWarpApiKey =
    typeof envConfig.WARP_API_KEY === "string" && envConfig.WARP_API_KEY.trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Context env vars
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
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  // User-provided env overrides
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Inject auth token — Oz uses WARP_API_KEY
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  if (!hasExplicitWarpApiKey && authToken) {
    env.WARP_API_KEY = authToken;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  // -------------------------------------------------------------------------
  // 3. Resolve session (conversation ID)
  // -------------------------------------------------------------------------
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeConversationId = asString(runtimeSessionParams.conversationId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeConversationId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const conversationId = canResumeSession ? runtimeConversationId : null;

  if (runtimeConversationId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Oz conversation "${runtimeConversationId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Load agent instructions file
  // -------------------------------------------------------------------------
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stdout",
        `[paperclip] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. Render prompt
  // -------------------------------------------------------------------------
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
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
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !conversationId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  // -------------------------------------------------------------------------
  // 6. Build args and run
  // -------------------------------------------------------------------------
  const buildArgs = (resumeConversationId: string | null): string[] => {
    const args = ["agent", "run"];
    // Prompt or conversation resume
    if (resumeConversationId) {
      args.push("--conversation", resumeConversationId);
      args.push("--prompt", prompt);
    } else {
      args.push("--prompt", prompt);
    }
    // Model
    if (model && model !== DEFAULT_OZ_MODEL) {
      args.push("--model", model);
    }
    // Working directory
    args.push("--cwd", cwd);
    // Profile (permissions)
    if (profile) args.push("--profile", profile);
    // MCP servers
    if (mcpSpec) args.push("--mcp", mcpSpec);
    // Skill
    if (skillSpec) args.push("--skill", skillSpec);
    // Name for traceability
    if (agentName) {
      args.push("--name", agentName);
    } else {
      args.push("--name", `paperclip-run-${runId.slice(0, 8)}`);
    }
    // Extra args
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const commandNotes = [
    "Prompt is passed via --prompt for non-interactive execution.",
    ...(conversationId ? [`Resuming conversation: ${conversationId}`] : ["Starting a new conversation."]),
    ...(mcpSpec ? [`MCP spec: ${mcpSpec}`] : []),
    ...(skillSpec ? [`Skill: ${skillSpec}`] : []),
    ...(instructionsFilePath && instructionsPrefix
      ? [`Loaded agent instructions from ${instructionsFilePath}`]
      : []),
  ];

  const runAttempt = async (resumeConversationId: string | null) => {
    const args = buildArgs(resumeConversationId);
    await onMeta?.({
      adapterType: "oz_local",
      command,
      cwd,
      commandNotes,
      commandArgs: args.map((value, index) =>
        index === args.length - 1 && value === prompt
          ? `<prompt ${prompt.length} chars>`
          : value,
      ),
      env: redactEnvForLogs(env),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
    return proc;
  };

  // -------------------------------------------------------------------------
  // 7. Execute (with session retry on stale conversation)
  // -------------------------------------------------------------------------
  const initial = await runAttempt(conversationId);
  const initialParsed = parseOzOutput(initial.stdout, initial.stderr);

  if (
    conversationId &&
    !initial.timedOut &&
    (initial.exitCode ?? 0) !== 0 &&
    isOzUnknownConversationError(initial.stdout, initial.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Oz conversation "${conversationId}" is unavailable; retrying with a fresh conversation.\n`,
    );
    const retry = await runAttempt(null);
    const retryParsed = parseOzOutput(retry.stdout, retry.stderr);
    return toResult(retry, retryParsed, cwd, model, workspaceId, workspaceRepoUrl, workspaceRepoRef, timeoutSec, true, true);
  }

  return toResult(initial, initialParsed, cwd, model, workspaceId, workspaceRepoUrl, workspaceRepoRef, timeoutSec, false, false);
}

function toResult(
  proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string },
  parsed: ReturnType<typeof parseOzOutput>,
  cwd: string,
  model: string,
  workspaceId: string,
  workspaceRepoUrl: string,
  workspaceRepoRef: string,
  timeoutSec: number,
  clearSessionOnMissingConversation: boolean,
  isRetry: boolean,
): AdapterExecutionResult {
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: parsed.requiresAuth ? "oz_auth_required" : null,
      clearSession: clearSessionOnMissingConversation,
    };
  }

  // On retry, don't fall back to old conversation ID — the old one was stale
  const resolvedConversationId = parsed.conversationId ?? (isRetry ? null : null);
  const resolvedSessionParams = resolvedConversationId
    ? ({
        conversationId: resolvedConversationId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
    : null;

  const exitOk = (proc.exitCode ?? 0) === 0;
  const errorMessage = exitOk
    ? null
    : (parsed.errorMessage ?? `Oz exited with code ${proc.exitCode ?? -1}`);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: !exitOk && parsed.requiresAuth ? "oz_auth_required" : null,
    sessionParams: resolvedSessionParams,
    sessionId: resolvedConversationId,
    sessionDisplayId: resolvedConversationId,
    provider: "warp",
    model,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    summary: parsed.summary,
    clearSession: clearSessionOnMissingConversation && !resolvedConversationId,
  };
}
