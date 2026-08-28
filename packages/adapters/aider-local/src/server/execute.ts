import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  resolveLegacyPaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
  refreshPaperclipWorkspaceEnvForExecution,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_AIDER_CHAT_HISTORY_FILE,
  DEFAULT_AIDER_LOCAL_MODEL,
} from "../shared/constants.js";
import { firstNonEmptyLine, isAiderQuotaError, parseAiderOutput } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

/**
 * Aider has no skills mechanism. The closest native surface is `--read`, which
 * loads a file as read-only context, so each desired skill contributes its
 * SKILL.md when one exists. Nothing is written into the workspace.
 */
async function resolveSkillReadPaths(input: {
  skillEntries: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames: string[];
  skipExistenceCheck: boolean;
}): Promise<string[]> {
  const desired = new Set(input.desiredSkillNames);
  const paths: string[] = [];
  for (const entry of input.skillEntries) {
    if (!desired.has(entry.key)) continue;
    const candidate = path.join(entry.source, "SKILL.md");
    if (input.skipExistenceCheck || (await pathExists(candidate))) {
      paths.push(candidate);
    }
  }
  return paths;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "aider");
  const model = asString(config.model, DEFAULT_AIDER_LOCAL_MODEL).trim();
  const alwaysApprove = asBoolean(config.alwaysApprove, true);
  // Paperclip's workspace sync is the persistence boundary between runs, so the
  // default leaves committing to the operator instead of letting Aider commit
  // every turn on its own.
  const autoCommits = asBoolean(config.autoCommits, false);
  const stream = asBoolean(config.stream, true);
  const pretty = asBoolean(config.pretty, false);
  const mapTokens = asNumber(config.mapTokens, 0);
  const editFiles = asStringArray(config.files);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const skillReadPaths = await resolveSkillReadPaths({
    skillEntries,
    desiredSkillNames,
    skipExistenceCheck: executionTargetIsRemote,
  });
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;

  try {
    const envConfig = parseObject(config.env);
    const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
    env.PAPERCLIP_RUN_ID = runId;
    const wakeTaskId = asString(context.taskId, "").trim() || asString(context.issueId, "").trim() || null;
    const wakeReason = asString(context.wakeReason, "").trim() || null;
    const wakeCommentId =
      asString(context.wakeCommentId, "").trim() || asString(context.commentId, "").trim() || null;
    const approvalId = asString(context.approvalId, "").trim() || null;
    const approvalStatus = asString(context.approvalStatus, "").trim() || null;
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
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
    if (authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }

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
      env,
      timeoutSec,
      graceSec,
      onLog,
    });

    if (executionTargetIsRemote) {
      await onLog(
        "stdout",
        `[paperclip] Syncing Aider workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "aider",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
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
    }

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    // Aider keys continuity off a chat transcript file in the run cwd rather
    // than a server-side session id, so the "session" is that file plus the cwd
    // it belongs to.
    const configuredHistoryFile = asString(config.chatHistoryFile, DEFAULT_AIDER_CHAT_HISTORY_FILE).trim()
      || DEFAULT_AIDER_CHAT_HISTORY_FILE;
    const chatHistoryPath = path.isAbsolute(configuredHistoryFile)
      ? configuredHistoryFile
      : path.join(effectiveExecutionCwd, configuredHistoryFile);

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const savedHistoryFile = asString(runtimeSessionParams.chatHistoryFile, "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const cwdMatches =
      runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd);
    const historyOnDisk = executionTargetIsRemote ? true : await pathExists(chatHistoryPath);
    const canResumeSession =
      savedHistoryFile.length > 0 &&
      cwdMatches &&
      historyOnDisk &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);

    if (savedHistoryFile.length > 0 && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Aider chat history "${savedHistoryFile}" is not resumable in "${effectiveExecutionCwd}". Starting a fresh chat.\n`,
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
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canResumeSession });
    const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const paperclipEnvNote = renderPaperclipEnvNote(env);
    const apiAccessNote = renderApiAccessNote(env);
    const prompt = joinPromptSections([
      wakePrompt,
      sessionHandoffNote,
      paperclipEnvNote,
      apiAccessNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const commandNotes = (() => {
      const notes: string[] = ["Prompt is passed to Aider via --message in one-shot mode."];
      if (alwaysApprove) notes.push("Added --yes-always for unattended execution.");
      if (!autoCommits) notes.push("Added --no-auto-commits so Paperclip's workspace sync owns commits.");
      if (canResumeSession) notes.push(`Resuming chat history from ${chatHistoryPath}.`);
      if (instructionsFilePath) notes.push(`Attached instructions via --read ${instructionsFilePath}.`);
      if (skillReadPaths.length > 0) {
        notes.push(`Attached ${skillReadPaths.length} Paperclip skill file(s) via --read.`);
      }
      return notes;
    })();

    const args = (() => {
      const list = ["--no-check-update"];
      if (!pretty) list.push("--no-pretty");
      if (!stream) list.push("--no-stream");
      if (!autoCommits) list.push("--no-auto-commits");
      if (alwaysApprove) list.push("--yes-always");
      if (model && model !== DEFAULT_AIDER_LOCAL_MODEL) list.push("--model", model);
      list.push("--chat-history-file", chatHistoryPath);
      if (canResumeSession) list.push("--restore-chat-history");
      if (mapTokens > 0) list.push("--map-tokens", String(mapTokens));
      if (instructionsFilePath) list.push("--read", instructionsFilePath);
      for (const skillPath of skillReadPaths) list.push("--read", skillPath);
      for (const file of editFiles) list.push("--file", file);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      if (extraArgs.length > 0) list.push(...extraArgs);
      list.push("--message", prompt);
      return list;
    })();

    if (onMeta) {
      await onMeta({
        adapterType: ADAPTER_TYPE,
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog,
    });

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
      };
    }

    const parsed = parseAiderOutput(proc.stdout, proc.stderr);
    const failed = (proc.exitCode ?? 0) !== 0;
    const errorMessage = failed
      ? parsed.errorMessage || firstNonEmptyLine(proc.stderr) || `Aider exited with code ${proc.exitCode ?? -1}`
      : null;
    const quotaExhausted = failed && isAiderQuotaError(proc.stdout, proc.stderr);

    const sessionParams: Record<string, unknown> = {
      chatHistoryFile: chatHistoryPath,
      cwd: effectiveExecutionCwd,
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      ...(executionTargetIsRemote
        ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) }
        : {}),
    };

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      ...(quotaExhausted ? { errorFamily: "provider_quota" as const } : {}),
      usage: {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
      },
      // Aider's footer reports the tokens for this `--message` turn only; the
      // dollar figure it labels "session" is the running total and is reported
      // separately in resultJson rather than as this run's cost.
      usageBasis: "per_run",
      sessionParams,
      sessionDisplayId: chatHistoryPath,
      provider: "aider",
      model: model === DEFAULT_AIDER_LOCAL_MODEL ? null : model,
      billingType: "api",
      costUsd: parsed.messageCostUsd,
      resultJson: {
        editedFiles: parsed.editedFiles,
        commits: parsed.commits,
        sessionCostUsd: parsed.sessionCostUsd,
        resumedChatHistory: canResumeSession,
        ...(failed ? { stderr: proc.stderr } : {}),
      },
      summary: parsed.summary,
    };
  } finally {
    await restoreRemoteWorkspace?.();
  }
}
