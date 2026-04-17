import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  resolveCommandForLogs,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { COPILOT_API_BASE_URL, DEFAULT_COPILOT_MODEL } from "../index.js";
import { resolveCopilotToken } from "./token.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Determine if the given model ID is a Claude model.
 * Claude models route through ANTHROPIC_BASE_URL override on the claude CLI.
 * Non-Claude models (GPT-4o, Gemini, etc.) use OPENAI_BASE_URL / OPENAI_API_KEY instead.
 */
export function isClaudeModel(model: string): boolean {
  return /^claude[-_]/i.test(model);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const model = asString(config.model, DEFAULT_COPILOT_MODEL).trim();
  const claudeModel = isClaudeModel(model);
  const command = asString(config.command, claudeModel ? "claude" : "openai").trim();
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const sandbox = asBoolean(config.sandbox, false);
  const configuredCwd = asString(config.cwd, "");

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
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build base env
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Context vars
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim() ? context.approvalId.trim() : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim()
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  // Fetch Copilot token and inject API overrides
  let copilotToken: string;
  try {
    copilotToken = await resolveCopilotToken(effectiveEnv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Copilot token error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "copilot_auth_required",
    };
  }

  // Route Claude models through ANTHROPIC_BASE_URL override
  if (claudeModel) {
    env.ANTHROPIC_BASE_URL = COPILOT_API_BASE_URL;
    env.ANTHROPIC_API_KEY = copilotToken;
    effectiveEnv.ANTHROPIC_BASE_URL = COPILOT_API_BASE_URL;
    effectiveEnv.ANTHROPIC_API_KEY = copilotToken;
  } else {
    // For non-Claude models, set OpenAI-compatible env vars
    env.OPENAI_BASE_URL = COPILOT_API_BASE_URL;
    env.OPENAI_API_KEY = copilotToken;
    effectiveEnv.OPENAI_BASE_URL = COPILOT_API_BASE_URL;
    effectiveEnv.OPENAI_API_KEY = copilotToken;
  }

  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
    // Redact the Copilot token from logs
    // redactKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN"],
  });

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

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
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const { readFile } = await import("node:fs/promises");
      const contents = await readFile(instructionsFilePath, "utf8");
      const dir = path.dirname(instructionsFilePath);
      instructionsPrefix = `${contents}\n\nThe above instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${dir}/.\n\n`;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
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

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args = ["--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_COPILOT_MODEL) args.push("--model", model);
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--dangerously-skip-permissions");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--print", prompt);
    return args;
  };

  if (onMeta) {
    const args = buildArgs(sessionId);
    await onMeta({
      adapterType: "copilot_local",
      command: resolvedCommand,
      cwd,
      commandNotes: [
        "Prompt is passed via --print for non-interactive execution.",
        `Copilot API base: ${COPILOT_API_BASE_URL}`,
        `Model: ${model}`,
      ],
      commandArgs: args.map((v, i) => (i === args.length - 1 ? `<prompt ${prompt.length} chars>` : v)),
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  await onLog("stdout", `[paperclip] Routing through GitHub Copilot API (model: ${model})\n`);

  const proc = await runChildProcess(runId, command, buildArgs(sessionId), {
    cwd,
    env: runtimeEnv as Record<string, string>,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });

  if (proc.timedOut) {
    return { exitCode: proc.exitCode, signal: proc.signal, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s` };
  }

  const resolvedSessionId = runtimeSessionId || runtime.sessionId || null;
  const resolvedSessionParams = resolvedSessionId
    ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
    : null;

  const stderrTrimmed = proc.stderr.trim();

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage:
      (proc.exitCode ?? 0) === 0
        ? null
        : stderrTrimmed || `${command} exited with code ${proc.exitCode ?? -1}`,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: "github_copilot",
    biller: "github",
    model,
    billingType: "subscription",
    resultJson: { stdout: proc.stdout, stderr: proc.stderr },
  };
}
