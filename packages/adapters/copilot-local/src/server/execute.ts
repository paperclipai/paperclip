import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  applyPaperclipWorkspaceEnv,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { buildCopilotArgs } from "./copilot-args.js";
import { applyCopilotPermissionEnvDefaults, enablesCopilotAllowAll } from "./copilot-env.js";
import { isCopilotAuthRequiredError, parseCopilotJsonl } from "./parse.js";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

async function readInstructionsPrefix(pathValue: string, onLog: AdapterExecutionContext["onLog"]): Promise<string> {
  const instructionsFilePath = pathValue.trim();
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return `${contents}\n\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}.\n\n`;
  } catch (err) {
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return "";
  }
}

function resolveBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "COPILOT_GITHUB_TOKEN") ||
    hasNonEmptyEnvValue(env, "GH_TOKEN") ||
    hasNonEmptyEnvValue(env, "GITHUB_TOKEN")
    ? "api"
    : "subscription";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "copilot");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId = typeof context.approvalId === "string" && context.approvalId.trim() ? context.approvalId.trim() : null;
  const approvalStatus = typeof context.approvalStatus === "string" && context.approvalStatus.trim() ? context.approvalStatus.trim() : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
  }
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  applyCopilotPermissionEnvDefaults(env, envConfig);
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 15),
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);

  const instructionsPrefix = await readInstructionsPrefix(asString(config.instructionsFilePath, ""), onLog);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false }),
    renderTemplate(promptTemplate, templateData),
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    wakePromptChars: renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false }).length,
  };
  const builtArgs = buildCopilotArgs(config, prompt);
  const hasBroadAllowAll = builtArgs.hasBroadAllowAll || enablesCopilotAllowAll(env);
  const commandArgsForLogs = builtArgs.args.map((value, idx) => (idx > 0 && builtArgs.args[idx - 1] === "-p" ? `<prompt ${prompt.length} chars>` : value));
  if (onMeta) {
    await onMeta({
      adapterType: "copilot_local",
      command: resolvedCommand,
      cwd: effectiveExecutionCwd,
      commandArgs: commandArgsForLogs,
      commandNotes: [
        "Invoked GitHub Copilot CLI with programmatic -p prompt mode, JSONL output, and --no-ask-user.",
        hasBroadAllowAll
          ? "Adapter config included a broad allow-all flag/env; Paperclip never adds this by default."
          : "Using explicit --allow-tool/--allow-url allowlists; no broad allow-all default.",
      ],
      env: buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand }),
      prompt,
      promptMetrics,
      context,
    });
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, builtArgs.args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });
  const parsed = parseCopilotJsonl(proc.stdout);
  const fallbackError =
    parsed.errorMessage ||
    firstNonEmptyLine(proc.stderr) ||
    `Copilot exited with code ${proc.exitCode ?? -1}`;
  const failed = proc.timedOut || (proc.exitCode ?? 0) !== 0;
  const authRequired = failed && isCopilotAuthRequiredError({
    stdout: proc.stdout,
    stderr: proc.stderr,
    errorMessage: fallbackError,
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: proc.timedOut ? `Timed out after ${timeoutSec}s` : failed ? fallbackError : null,
    errorCode: authRequired ? "copilot_auth_required" : null,
    usage: parsed.usage,
    sessionId: parsed.sessionId,
    sessionParams: parsed.sessionId ? { sessionId: parsed.sessionId, cwd: effectiveExecutionCwd } : null,
    sessionDisplayId: parsed.sessionId,
    provider: "github-copilot",
    biller: "github-copilot",
    model: builtArgs.model,
    billingType: resolveBillingType(runtimeEnv),
    costUsd: null,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    summary: parsed.summary,
  };
}
