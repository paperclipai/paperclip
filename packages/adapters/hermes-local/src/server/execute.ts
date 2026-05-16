import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  inferOpenAiCompatibleBiller,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  renderTemplate,
  renderPaperclipWakePrompt,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { parseHermesOutput, isHermesUnknownSessionError } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

function resolveHermesBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  // Config fields with defaults
  const command = asString(config.command, path.join(os.homedir(), ".local/bin/hermes"));
  const model = asString(config.model, "minimax/MiniMax-M2.7");
  const provider = parseModelProvider(model) ?? asString(config.provider, "minimax");
  const modelId = parseModelId(model) ?? "MiniMax-M2.7";
  const configuredToolsets = asString(config.toolsets, "terminal,file,web,search,vision");
  const configuredCwd = asString(config.cwd, "");
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);

  // Workspace context
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

  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

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
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 &&
      context.commentId.trim()) ||
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

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
  }
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Build runtime env
  const runtimeEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  // Ensure hermes is installed and resolvable
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
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);

  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  // Build the prompt
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
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
    bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
  ]).trim();

  // Build hermes chat args
  const args: string[] = ["chat"];
  args.push("-q", userPrompt);
  if (provider) args.push("--provider", provider);
  if (modelId) args.push("--model", modelId);
  if (configuredToolsets) args.push("-t", configuredToolsets);
  args.push("--quiet"); // suppress banner for programmatic use
  args.push("--pass-session-id");
  if (extraArgs.length > 0) args.push(...extraArgs);

  // Log startup
  await onLog(
    "stdout",
    `[hermes-local] Starting Hermes: ${resolvedCommand} ${args.join(" ")}\n`,
  );

  // Run the subprocess
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      stderrBuffer += chunk;
      await onLog(stream, chunk);
      return;
    }
    stdoutBuffer += chunk;
    await onLog(stream, chunk);
  };

  const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, resolvedCommand, args, {
    cwd: effectiveExecutionCwd,
    env: executionTargetIsRemote ? env : runtimeEnv,
    timeoutSec,
    graceSec,
    onLog: bufferedOnLog,
  });

  // Flush remaining stdout
  if (stdoutBuffer && !stdoutBuffer.endsWith("\n")) {
    await onLog("stdout", "\n");
  }

  // Parse output
  const parsed = parseHermesOutput(stdoutBuffer, stderrBuffer);

  if (onMeta) {
    await onMeta({
      adapterType: "hermes_local",
      command: resolvedCommand,
      cwd: effectiveExecutionCwd,
      commandNotes: [`Hermes model: ${model}`, `Provider: ${provider}`, `Toolsets: ${configuredToolsets}`],
      commandArgs: args,
      env: loggedEnv,
      prompt: userPrompt,
      promptMetrics: {
        systemPromptChars: 0,
        promptChars: userPrompt.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: 0,
      },
      context,
    });
  }

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Hermes timed out after ${timeoutSec}s`,
      clearSession: false,
    };
  }

  const stderrLine = firstNonEmptyLine(stderrBuffer);
  const rawExitCode = proc.exitCode;
  const parsedError = parsed.errors.find((error) => error.trim().length > 0) ?? "";
  const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
  const fallbackErrorMessage =
    parsedError || stderrLine || `Hermes exited with code ${rawExitCode ?? -1}`;

  return {
    exitCode: effectiveExitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
    usage: {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cachedInputTokens: parsed.usage.cachedInputTokens,
    },
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    provider,
    biller: resolveHermesBiller(runtimeEnv, provider),
    model,
    billingType: "unknown",
    costUsd: parsed.usage.costUsd,
    resultJson: {
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      sessionId: null,
    },
    summary: parsed.finalMessage || parsed.messages.join("\n\n").trim() || "(no output)",
    clearSession: false,
  };
}
