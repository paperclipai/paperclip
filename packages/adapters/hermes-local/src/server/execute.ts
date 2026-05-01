import fs from "node:fs/promises";
import path from "node:path";
import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetPaperclipApiUrl,
  adapterExecutionTargetRemoteCwd,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  applyPaperclipWorkspaceEnv,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  isHermesUnknownSessionError,
  parseHermesQuietStdout,
  parseHermesSessionExport,
} from "./parse.js";
import { prepareHermesRuntimeConfig } from "./runtime-config.js";

const SESSION_EXPORT_TIMEOUT_SEC = 15;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function firstMeaningfulStderrLine(text: string): string {
  // Hermes' stderr is structured as just "session_id: <id>" on success;
  // skip that line when surfacing an error message.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^session_id:\s*\S+/.test(line)) continue;
    return line;
  }
  return "";
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveHermesBiller(
  env: Record<string, string>,
  provider: string | null,
  billingProviderFromExport: string | null,
): string {
  return (
    inferOpenAiCompatibleBiller(env, null) ??
    billingProviderFromExport ??
    provider ??
    "unknown"
  );
}

async function fetchHermesSessionExport(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  runId: string;
  onLog: AdapterExecutionContext["onLog"];
}) {
  try {
    const proc = await runChildProcess(
      `${input.runId}-hermes-session-export`,
      input.command,
      ["sessions", "export", "--session-id", input.sessionId, "-"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: SESSION_EXPORT_TIMEOUT_SEC,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    if (proc.timedOut || (proc.exitCode ?? 1) !== 0) {
      const detail = firstNonEmptyLine(proc.stderr) || `exit ${proc.exitCode ?? -1}`;
      await input.onLog(
        "stderr",
        `[paperclip] Hermes sessions export for "${input.sessionId}" failed: ${detail}\n`,
      );
      return null;
    }
    return parseHermesSessionExport(proc.stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog(
      "stderr",
      `[paperclip] Hermes sessions export for "${input.sessionId}" threw: ${reason}\n`,
    );
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  if (executionTargetIsRemote) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "hermes_local does not yet support remote (SSH/sandbox) execution targets. Run on a local environment or use opencode_local.",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "hermes");
  const model = asString(config.model, "").trim();
  const provider = asString(config.provider, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" &&
    envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" &&
      context.taskId.trim().length > 0 &&
      context.taskId.trim()) ||
    (typeof context.issueId === "string" &&
      context.issueId.trim().length > 0 &&
      context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" &&
      context.commentId.trim().length > 0 &&
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
    ? context.issueIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
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
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    agentHome,
  });
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  const targetPaperclipApiUrl = adapterExecutionTargetPaperclipApiUrl(executionTarget);
  if (targetPaperclipApiUrl) env.PAPERCLIP_API_URL = targetPaperclipApiUrl;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const preparedRuntimeConfig = await prepareHermesRuntimeConfig({ env, config });

  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(
        ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env }),
      ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );

    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      executionTarget,
      cwd,
      runtimeEnv,
    );
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
      command,
      executionTarget,
      cwd,
      runtimeEnv,
    );
    const loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME", "HERMES_HOME"],
      resolvedCommand,
    });

    const timeoutSec = asNumber(config.timeoutSec, 0);
    const graceSec = asNumber(config.graceSec, 20);
    const ignoreRules = asBoolean(config.ignoreRules, false);
    const ignoreUserConfig = asBoolean(config.ignoreUserConfig, false);
    const acceptHooks = asBoolean(config.acceptHooks, true);
    const yolo = asBoolean(config.yolo, true);
    const maxTurns = asNumber(config.maxTurns, 0);
    const toolsets = asString(config.toolsets, "").trim();
    const skills = asString(config.skills, "").trim();
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);

    // Resume support: Hermes sessionId is a plain string id, e.g.
    // "20260501_113041_b9f19e". We resume only when the stored cwd matches.
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 ||
        path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd));
    const sessionId = canResumeSession ? runtimeSessionId : null;

    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsDir = resolvedInstructionsFilePath
      ? `${path.dirname(resolvedInstructionsFilePath)}/`
      : "";
    let instructionsPrefix = "";
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (resolvedInstructionsFilePath) {
        if (instructionsPrefix.length > 0) {
          notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
          notes.push(
            `Prepended instructions + path directive to argv prompt (relative references from ${instructionsDir}).`,
          );
        } else {
          notes.push(
            `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
          );
        }
      }
      notes.push("Hermes invocation: hermes chat -q <prompt> -Q --source paperclip");
      if (acceptHooks) notes.push("--accept-hooks (auto-approve unseen shell hooks)");
      if (yolo) notes.push("--yolo (bypass dangerous-command approvals)");
      if (ignoreRules) notes.push("--ignore-rules");
      if (ignoreUserConfig) notes.push("--ignore-user-config");
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
    const renderedPrompt = shouldUseResumeDeltaPrompt
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const buildArgs = (resumeSessionId: string | null) => {
      const args: string[] = ["chat", "-q", prompt, "-Q"];
      args.push("--source", "paperclip");
      if (resumeSessionId) args.push("-r", resumeSessionId);
      if (model) args.push("-m", model);
      if (provider) args.push("--provider", provider);
      if (toolsets) args.push("-t", toolsets);
      if (skills) args.push("-s", skills);
      if (acceptHooks) args.push("--accept-hooks");
      if (yolo) args.push("--yolo");
      if (ignoreRules) args.push("--ignore-rules");
      if (ignoreUserConfig) args.push("--ignore-user-config");
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      // Replace the long argv prompt with a placeholder for logs
      const argsForLogs = args.map((arg, idx) =>
        idx > 0 && args[idx - 1] === "-q" ? `<argv prompt ${prompt.length} chars>` : arg,
      );
      if (onMeta) {
        await onMeta({
          adapterType: "hermes_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: argsForLogs,
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(
        runId,
        executionTarget,
        command,
        args,
        {
          cwd,
          env: preparedRuntimeConfig.env,
          timeoutSec,
          graceSec,
          onSpawn,
          onLog,
        },
      );
      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parseHermesQuietStdout(proc.stdout, proc.stderr),
      };
    };

    const toResult = async (
      attempt: {
        proc: {
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          stdout: string;
          stderr: string;
        };
        rawStderr: string;
        parsed: ReturnType<typeof parseHermesQuietStdout>;
      },
      clearSessionOnMissingSession = false,
    ): Promise<AdapterExecutionResult> => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId || runtime.sessionId || null);

      // Best-effort post-run cost / usage fetch.
      let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let costUsd: number | null = null;
      let billingProvider: string | null = null;
      let exportedModel: string | null = null;
      if (resolvedSessionId && (attempt.proc.exitCode ?? 0) === 0) {
        const exportRecord = await fetchHermesSessionExport({
          command,
          cwd,
          env: runtimeEnv,
          sessionId: resolvedSessionId,
          runId,
          onLog,
        });
        if (exportRecord) {
          usage = {
            inputTokens: exportRecord.inputTokens,
            outputTokens: exportRecord.outputTokens,
            cachedInputTokens: exportRecord.cachedInputTokens,
          };
          costUsd = exportRecord.costUsd;
          billingProvider = exportRecord.billingProvider;
          exportedModel = exportRecord.model;
        }
      }

      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          } as Record<string, unknown>)
        : null;

      const stderrLine = firstMeaningfulStderrLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const fallbackErrorMessage =
        stderrLine || `Hermes exited with code ${rawExitCode ?? -1}`;
      const modelId = model || exportedModel || null;

      return {
        exitCode: rawExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (rawExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        usage,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveHermesBiller(
          runtimeEnv,
          parseModelProvider(modelId),
          billingProvider,
        ),
        model: modelId,
        billingType: "unknown",
        costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    const initialFailed =
      !initial.proc.timedOut && (initial.proc.exitCode ?? 0) !== 0;
    if (
      sessionId &&
      initialFailed &&
      isHermesUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Hermes session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return await toResult(retry, true);
    }

    return await toResult(initial);
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
