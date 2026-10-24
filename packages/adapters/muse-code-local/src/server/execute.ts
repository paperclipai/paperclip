import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  resolveLegacyPaperclipDesiredSkillNames,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { isMuseCodeUnknownSessionError, parseMuseCodeJsonl } from "./parse.js";
import { resolveMuseCodeSkillsHome } from "./skills.js";
import { MUSE_CODE_REASONING_EFFORTS } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function ensureMuseCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames: string[],
  skillsHome: string,
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames);
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog("stderr", `[paperclip] Removed maintainer-only Muse skill "${skillName}" from ${skillsHome}\n`);
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Muse skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Muse skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (executionTarget?.kind === "remote") {
    throw new Error(
      "muse_code_local supports local environments only; choose a local environment or an adapter with SSH/sandbox support.",
    );
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "muse");
  const model = asString(config.model, "").trim();
  const effortRaw = (
    asString(config.effort, "") ||
    asString(config.thinkingEffort, "") ||
    asString(config.reasoningEffort, "")
  ).trim();
  const effort = (MUSE_CODE_REASONING_EFFORTS as readonly string[]).includes(effortRaw) ? effortRaw : "";
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const dangerouslyBypassSandbox = asBoolean(
    config.dangerouslyBypassSandbox ?? config.disableSandbox,
    false,
  );

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

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  await ensureMuseCodeSkillsInjected(
    onLog,
    skillEntries,
    desiredSkillNames,
    resolveMuseCodeSkillsHome(config),
  );

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
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
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim() ? context.approvalStatus.trim() : null;
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
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"] });
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const initialSessionId = canResumeSession ? runtimeSessionId : randomUUID();
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Muse session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
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
  const commandNotes: string[] = [];
  if (resolvedInstructionsFilePath) {
    commandNotes.push(
      instructionsPrefix.length > 0
        ? `Loaded agent instructions from ${resolvedInstructionsFilePath}`
        : `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
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
  const buildPrompt = (resumedSession: boolean) => {
    const renderedBootstrapPrompt =
      !resumedSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
      resumedSession,
      includeCommunicationGuidance: false,
    });
    const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
    const renderedPrompt =
      shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const basePrompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    return {
      basePrompt,
      promptMetrics: {
        promptChars: basePrompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        taskContextChars: taskContextNote.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
    };
  };

  const buildArgs = (sessionId: string, promptFile: string) => {
    const args = [
      "exec",
      "--json",
      "--prompt-file",
      promptFile,
      "--workspace",
      cwd,
      "--session-id",
      sessionId,
      "--trust-workspace",
      "--disable-request-user-input",
      "--disable-reminders",
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--reasoning-effort", effort);
    if (dangerouslySkipPermissions) args.push("--disable-approval");
    if (dangerouslyBypassSandbox) args.push("--disable-sandbox");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (sessionId: string, resumedSession: boolean) => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession });
    const { basePrompt, promptMetrics } = buildPrompt(resumedSession);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession }),
      basePrompt,
    ]);
    const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-prompt-"));
    const promptFile = path.join(promptDir, "prompt.md");
    try {
      await fs.writeFile(promptFile, prompt, "utf8");
      const args = buildArgs(sessionId, promptFile);
      if (onMeta) {
        await onMeta({
          adapterType: "muse_code_local",
          command,
          cwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt,
          promptMetrics: { ...promptMetrics, promptChars: prompt.length },
          context,
        });
      }
      const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog,
      });
      return { proc, parsed: parseMuseCodeJsonl(proc.stdout) };
    } finally {
      await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const toResult = (
    attempt: Awaited<ReturnType<typeof runAttempt>>,
    attemptedSessionId: string,
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    const { proc, parsed } = attempt;
    const billingType = runtimeEnv.META_API_KEY ? "api" : "subscription_included";
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        usageComplete: false,
        usage: parsed.usageReported ? parsed.usage : undefined,
        usageBasis: "per_run",
        provider: parsed.provider ?? "meta",
        biller: "meta",
        model: parsed.model ?? (model || null),
        billingType,
        costUsd: null,
        costStatus: "unpriced",
        errorMessage: "Muse execution timed out",
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = parsed.sessionId ?? attemptedSessionId;
    const parsedError = parsed.errorMessage?.trim() ?? "";
    const rawExitCode = proc.exitCode;
    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError || firstNonEmptyLine(proc.stderr) || `Muse exited with code ${synthesizedExitCode ?? -1}`;
    return {
      exitCode: synthesizedExitCode,
      signal: proc.signal,
      timedOut: false,
      usageComplete: proc.exitCode === 0 && !proc.signal && parsed.usageReported,
      usageBasis: "per_run",
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: parsed.usageReported ? parsed.usage : undefined,
      sessionId: resolvedSessionId,
      sessionParams: {
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      },
      sessionDisplayId: resolvedSessionId,
      provider: parsed.provider ?? "meta",
      biller: "meta",
      model: parsed.model ?? (model || null),
      billingType,
      costUsd: null,
      costStatus: "unpriced",
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
      summary: parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !parsed.sessionId),
    };
  };

  const initial = await runAttempt(initialSessionId, canResumeSession);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
  if (
    canResumeSession &&
    initialFailed &&
    isMuseCodeUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Muse session "${initialSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const freshSessionId = randomUUID();
    const retry = await runAttempt(freshSessionId, false);
    return toResult(retry, freshSessionId, true);
  }

  return toResult(initial, initialSessionId);
}
