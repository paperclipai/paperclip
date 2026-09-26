import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolveLegacyPaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgyTransientNetworkError,
  isAgyUnknownSessionError,
  parseAgyJsonl,
  type ParsedAgyOutput,
} from "./parse.js";
import {
  describeRunSkillSync,
  ensureAgySkillsInjected,
  resolveAgySkillRoot,
  resolveAgySkillsHome,
  syncSkillsForRun,
} from "./skills.js";
import { inferModelProvider } from "./models.js";
import { DEFAULT_AGY_LOCAL_MODEL } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Detect whether a model ID already includes a reasoning effort tier suffix.
 * agy rejects --model plus --effort together when the model already specifies effort.
 */
export function modelHasEffortSuffix(model: string): boolean {
  return /-(?:low|medium|high)$/i.test(model.trim());
}

/**
 * Set agy's --print-timeout slightly below Paperclip's timeoutSec so agy exits cleanly
 * and emits a result event before being terminated mid-stream.
 */
export function resolveAgyPrintTimeoutSec(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return 0;
  const margin = Math.max(10, Math.floor(timeoutSec * 0.05));
  return Math.max(30, timeoutSec - margin);
}

export async function discoverAgySessionArtifacts(sessionId: string): Promise<string[]> {
  if (!sessionId || typeof sessionId !== "string") return [];
  const homedir = os.homedir();
  const candidateDirs = [
    path.join(homedir, ".gemini", "antigravity-cli", "brain", sessionId),
    path.join(homedir, ".gemini", "antigravity", "brain", sessionId),
  ];

  const artifacts: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          artifacts.push(fullPath);
        }
      }
    } catch {
      // directory missing or inaccessible
    }
  }

  for (const dir of candidateDirs) {
    await walk(dir);
  }

  return [...new Set(artifacts)];
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config: rawConfig, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const config = parseObject({ ...parseObject(agent?.adapterConfig), ...parseObject(rawConfig) });

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
  const effort = asString(config.effort, "").trim();
  // When unset, omit --mode so Antigravity runs in default edit mode (matching test.ts probe)
  const mode = asString(config.mode, "").trim();
  const agentPersona = asString(config.agent ?? config.agentPersona, "").trim();
  const jsonSchema = asString(config.jsonSchema ?? config.json_schema, "").trim();
  const sandbox = Boolean(config.sandbox);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const additionalDirs = Array.isArray(config.addDirs)
    ? config.addDirs.map((d) => asString(d, "").trim()).filter(Boolean)
    : [];
  const project =
    asString(config.project, "").trim() ||
    asString((context.project as Record<string, unknown> | undefined)?.slug, "").trim() ||
    asString((context.project as Record<string, unknown> | undefined)?.name, "").trim();
  const printTimeoutConfig = asString(config.printTimeout, "").trim();
  const disableSlashCommands = Boolean(config.disableSlashCommands);

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
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ── Skills reconciliation and receipt logging ──────────────────────────────
  let skillRoot = resolveAgySkillRoot({ config, agentId: agent.id });
  let skillsAddDir: string | null = null;
  if (skillRoot.addDir && !executionTargetIsRemote) {
    try {
      const runSync = await syncSkillsForRun({
        config,
        agentId: agent.id,
        companyId: agent.companyId,
      });
      skillRoot = runSync.root;
      for (const line of describeRunSkillSync(runSync)) {
        await onLog("stdout", `${line}\n`);
      }
      for (const warning of runSync.warnings) {
        await onLog("stdout", `[paperclip] skill sync: ${warning}\n`);
      }
    } catch (err) {
      await onLog(
        "stdout",
        `[paperclip] Skill sync failed; the run continues without freshly synced skills: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
    const skillsHomeExists = await fs
      .stat(skillRoot.skillsHome)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (skillsHomeExists) skillsAddDir = skillRoot.addDir;
  } else if (skillRoot.addDir && executionTargetIsRemote) {
    await onLog(
      "stdout",
      `[paperclip] Skills synced to ${skillRoot.skillsHome} are not delivered to remote execution targets; ` +
        `set skillsScope to "global" and provision ~/.gemini/config/skills in the target instead.\n`,
    );
  }

  const envConfig = parseObject(config.env);
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

  const rawEnv = ensurePathInEnv({ ...process.env, ...env });
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(rawEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 15);

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
    timeoutSec,
  });

  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    cwd,
    runtimeEnv,
  );

  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "PATH"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(
    executionTarget,
    effectiveExecutionCwd,
  );

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId =
    asString(runtimeSessionParams.sessionId, "") ||
    asString(runtimeSessionParams.conversationId, "") ||
    asString(runtime.sessionId, "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
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
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
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
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--add-dir",
      cwd,
    ];

    // Multi-workspace monorepo injection: add all distinct workspace and configured directories
    const addedDirs = new Set<string>([path.resolve(cwd)]);
    for (const hint of workspaceHints) {
      const hintCwd = asString(hint.cwd, "").trim();
      if (hintCwd) {
        const resolved = path.resolve(hintCwd);
        if (!addedDirs.has(resolved)) {
          addedDirs.add(resolved);
          args.push("--add-dir", hintCwd);
        }
      }
    }
    for (const addDir of additionalDirs) {
      const resolved = path.resolve(addDir);
      if (!addedDirs.has(resolved)) {
        addedDirs.add(resolved);
        args.push("--add-dir", addDir);
      }
    }
    if (skillsAddDir) {
      const resolved = path.resolve(skillsAddDir);
      if (!addedDirs.has(resolved)) {
        addedDirs.add(resolved);
        args.push("--add-dir", skillsAddDir);
      }
    }

    if (dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (sandbox) {
      args.push("--sandbox");
    }
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    if (agentPersona) {
      args.push("--agent", agentPersona);
    }
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (mode) {
      args.push("--mode", mode);
    }
    if (jsonSchema) {
      args.push("--json-schema", jsonSchema);
    }
    if (project) {
      args.push("--project", project);
    }
    const effectivePrintTimeout = printTimeoutConfig || (timeoutSec > 0 ? `${timeoutSec}s` : "24h");
    if (effectivePrintTimeout) {
      args.push("--print-timeout", effectivePrintTimeout);
    }
    if (disableSlashCommands) {
      args.push("--disable-slash-commands");
    }
    if (extraArgs.length > 0) {
      args.push(...extraArgs);
    }
    args.push("--print", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "agy_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args.map((arg) => (arg === prompt ? `<prompt ${prompt.length} chars>` : arg)),
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
        env: runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
      },
    );

    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseAgyJsonl(proc.stdout),
    };
  };

  type Attempt = Awaited<ReturnType<typeof runAttempt>>;

  const toResult = (
    attempt: Attempt,
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    const requiresAuth = detectAgyAuthRequired({
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
      parsed: attempt.parsed,
    }).requiresAuth;
    const quotaExhausted = detectAgyQuotaExhausted({
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
      parsed: attempt.parsed,
    });
    const networkUnavailable = isAgyTransientNetworkError(
      attempt.proc.stdout,
      attempt.proc.stderr,
    );

    const classifyErrorCode = (): string | null => {
      if (attempt.proc.errorCode) return attempt.proc.errorCode;
      if (requiresAuth) return "agy_auth_required";
      if (quotaExhausted) return "agy_quota_exhausted";
      if (networkUnavailable) return "agy_network_unavailable";
      return null;
    };

    const errorFamily = quotaExhausted
      ? ("provider_quota" as const)
      : networkUnavailable
        ? ("transient_upstream" as const)
        : null;

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: classifyErrorCode(),
        errorFamily,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          conversationId: resolvedSessionId,
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

    const parsedError =
      typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode =
      (parsedError || attempt.parsed.isError) && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError || stderrLine || `Antigravity exited with code ${synthesizedExitCode ?? -1}`;
    const failed = (synthesizedExitCode ?? 0) !== 0;

    const provider = inferModelProvider(model);

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: failed ? classifyErrorCode() : null,
      errorFamily: failed ? errorFamily : null,
      usage: attempt.parsed.usage
        ? {
            inputTokens: attempt.parsed.usage.inputTokens,
            outputTokens: attempt.parsed.usage.outputTokens,
            cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
          }
        : undefined,
      usageBasis: "per_run",
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider,
      biller: "google",
      model: model || null,
      billingType: "subscription",
      costUsd: attempt.parsed.costUsd ?? 0,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(attempt.parsed.resultJson ? attempt.parsed.resultJson : {}),
        ...(attempt.parsed.thinkingTokens !== null
          ? { thinking_tokens: attempt.parsed.thinkingTokens }
          : {}),
        ...(attempt.parsed.tools.length > 0
          ? { tool_invocations: attempt.parsed.tools.map((t) => t.name) }
          : {}),
        ...(attempt.parsed.malformedLines > 0
          ? { malformed_stream_lines: attempt.parsed.malformedLines }
          : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  const initialFailed =
    !initial.proc.timedOut &&
    ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage) || initial.parsed.isError);

  let finalResult: AdapterExecutionResult;
  if (
    sessionId &&
    initialFailed &&
    (isAgyUnknownSessionError({
      stdout: initial.proc.stdout,
      stderr: initial.rawStderr,
      errorMessage: initial.parsed.errorMessage,
    }) ||
      isAgySessionUnrecoverableError(initial.proc.stdout, initial.rawStderr))
  ) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity conversation "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    finalResult = toResult(retry, true);
  } else {
    finalResult = toResult(initial);
  }

  if (finalResult.sessionId && !executionTargetIsRemote) {
    const artifacts = await discoverAgySessionArtifacts(finalResult.sessionId);
    if (artifacts.length > 0) {
      await onLog(
        "stdout",
        `[paperclip] Discovered ${artifacts.length} Antigravity artifact(s):\n${artifacts.map((a) => `  - ${a}`).join("\n")}\n`,
      );
      finalResult.resultJson = {
        ...(finalResult.resultJson as Record<string, unknown> | undefined),
        artifacts,
      };
    }
  }

  return finalResult;
}
