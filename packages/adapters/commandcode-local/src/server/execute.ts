import fs from "node:fs/promises";
import path from "node:path";
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
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_COMMANDCODE_LOCAL_MODEL } from "../index.js";
import { isCommandCodeUnknownSessionError, parseCommandCodeOutput } from "./parse.js";

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

async function readInstructionsSection(instructionsFilePath: string): Promise<string> {
  if (!instructionsFilePath) return "";
  const content = await fs.readFile(instructionsFilePath, "utf8");
  return [
    "Agent instructions:",
    content.trim(),
  ].filter(Boolean).join("\n\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "commandcode");
  const model = asString(config.model, "").trim();
  const maxTurns = asNumber(config.maxTurns, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);

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

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsSection = await readInstructionsSection(instructionsFilePath);

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  try {
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
    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === "string") env[key] = value;
    }
    if (authToken && !hasExplicitApiKey) env.PAPERCLIP_API_KEY = authToken;

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
        `[paperclip] Syncing CommandCode workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "commandcode",
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

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] CommandCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] CommandCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
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
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const paperclipEnvNote = renderPaperclipEnvNote(env);
    const apiAccessNote = renderApiAccessNote(env);
    const prompt = joinPromptSections([
      instructionsSection,
      wakePrompt,
      sessionHandoffNote,
      paperclipEnvNote,
      apiAccessNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars: instructionsSection.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["-p", "--verbose", "--skip-onboarding", "--trust"];
      if (dangerouslySkipPermissions) args.push("--yolo");
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (model) args.push("--model", model);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const commandNotes = [
      "Prompt is passed to CommandCode through stdin in print mode.",
      "CommandCode print mode emits plain text, not structured JSONL tool events.",
      ...(dangerouslySkipPermissions ? ["Added --yolo for unattended execution."] : []),
    ];

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "commandcode_local",
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

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
      });
      return {
        proc,
        parsed: parseCommandCodeOutput(proc.stdout, proc.stderr),
      };
    };

    const toResult = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
      clearSessionOnMissingSession = false,
      isRetry = false,
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

      const failed = (attempt.proc.exitCode ?? 0) !== 0;
      const fallbackErrorMessage =
        attempt.parsed.errorMessage ||
        firstNonEmptyLine(attempt.proc.stderr) ||
        firstNonEmptyLine(attempt.proc.stdout) ||
        `CommandCode exited with code ${attempt.proc.exitCode ?? -1}`;

      const canFallbackToRuntimeSession = !isRetry;
      const resolvedSessionId = attempt.parsed.sessionId
        ?? (canFallbackToRuntimeSession ? (runtimeSessionId || runtime.sessionId || null) : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
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

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: failed ? fallbackErrorMessage : null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "command-code",
        biller: "command-code",
        model: model || null,
        billingType: "credits",
        costUsd: null,
        resultJson: {
          outputFormat: "plain_text",
          ...(failed ? { stderr: attempt.proc.stderr } : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCommandCodeUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] CommandCode resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    await restoreRemoteWorkspace?.();
  }
}
