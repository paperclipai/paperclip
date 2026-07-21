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
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  SANDBOX_INSTALL_COMMAND,
  modelSupportsEffort,
  resolveKimiThinkingEffort,
} from "../index.js";
import {
  describeKimiFailure,
  detectKimiAuthRequired,
  extractKimiRuntimeEvents,
  isKimiSessionUnrecoverableError,
  isKimiTransientNetworkError,
  parseKimiJsonl,
} from "./parse.js";
import {
  createKimiAcpExecutor,
  formatKimiAcpFallbackMessage,
  resolveKimiExecutionEngineForRun,
} from "./acp.js";
import { firstNonEmptyLine } from "./utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const executeKimiAcp = createKimiAcpExecutor();

/**
 * Wrap `onLog` so each complete kimi stream-json stdout line is also mapped to
 * `onEvent` runtime events (assistant snippet, tool name). This keeps the raw
 * run log intact while lighting up the issue-thread activity indicator, which
 * reads `currentToolName` / `lastAssistantSnippet` / `lastEventAt` derived from
 * `onEvent` rather than from the raw log stream. Stdout arrives in arbitrary
 * chunks, so lines are buffered and split on newlines; the trailing partial
 * line (if any) is covered by the final `parseKimiJsonl` pass.
 */
function createKimiEventForwardingLog(
  onLog: AdapterExecutionContext["onLog"],
  onEvent: AdapterExecutionContext["onEvent"],
): AdapterExecutionContext["onLog"] {
  if (!onEvent) return onLog;
  let buffer = "";
  return async (stream, chunk) => {
    await onLog(stream, chunk);
    if (stream !== "stdout") return;
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      for (const event of extractKimiRuntimeEvents(line)) {
        await onEvent({ eventType: event.eventType, stream: "stdout", message: event.message, payload: event.payload });
      }
    }
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveKimiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "KIMI_MODEL_API_KEY") ? "api" : "subscription";
}

/**
 * Headless-safe environment for unattended `kimi -p` runs. CI=1 disables
 * theme detection, NO_COLOR=1 keeps stdout parseable, and
 * KIMI_CODE_NO_AUTO_UPDATE=1 skips the update preflight. User-configured
 * values always win.
 */
function buildKimiHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  if (!next.CI?.trim()) next.CI = "1";
  if (!next.NO_COLOR?.trim()) next.NO_COLOR = "1";
  if (!next.KIMI_CODE_NO_AUTO_UPDATE?.trim()) next.KIMI_CODE_NO_AUTO_UPDATE = "1";
  if (!next.TERM?.trim()) next.TERM = "dumb";
  return next;
}

function buildKimiRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildKimiHeadlessEnv(env) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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

async function buildKimiSkillsDir(
  config: Record<string, unknown>,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveKimiExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeKimiAcp(ctx);
    } catch (err) {
      // An explicitly requested ACP engine surfaces its failure; the default
      // (auto) selection falls back to the CLI lane with a diagnostic note.
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", formatKimiAcpFallbackMessage(`Kimi ACP startup failed: ${reason}`));
    }
  } else if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatKimiAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "kimi");
  const model = asString(config.model, "").trim();

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
  const kimiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredKimiSkillNames = resolvePaperclipDesiredSkillNames(config, kimiSkillEntries);
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
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Forward configured thinking effort as KIMI_MODEL_THINKING_EFFORT. Kimi has
  // no per-invocation effort flag; this env var is an operational override that
  // applies to Kimi providers (managed OAuth models included). Only send it for
  // models that advertise support_efforts, and never clobber an explicit value.
  const configuredEffort = asString(config.effort, "").trim();
  if (configuredEffort && modelSupportsEffort(model) && !hasNonEmptyEnvValue(env, "KIMI_MODEL_THINKING_EFFORT")) {
    const kimiEffort = resolveKimiThinkingEffort(configuredEffort);
    if (kimiEffort) env.KIMI_MODEL_THINKING_EFFORT = kimiEffort;
  }
  const runtimeEnv = buildKimiRuntimeEnv(env);
  const billingType = resolveKimiBillingType(runtimeEnv);
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
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let localSkillsDir: string | null = null;
  let remoteSkillsDir: string | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  if (executionTargetIsRemote) {
    try {
      localSkillsDir = await buildKimiSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Kimi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "kimi",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [{
          key: "skills",
          localDir: localSkillsDir,
          followSymlinks: true,
        }],
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
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      const managedRemoteHomeDir =
        managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : null;
      if (managedRemoteHomeDir) {
        env.HOME = managedRemoteHomeDir;
      }
      // Deliver the synced skills snapshot via --skills-dir (see buildArgs)
      // from its isolated per-run location instead of copying it over the
      // shared $KIMI_CODE_HOME/skills home. Overwriting the shared home would
      // delete Kimi skills installed by the operator or other agents that
      // Paperclip does not own.
      if (desiredKimiSkillNames.length > 0 && preparedExecutionTargetRuntime.assetDirs.skills) {
        remoteSkillsDir = preparedExecutionTargetRuntime.assetDirs.skills;
      }
    } catch (error) {
      await Promise.allSettled([
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
      throw error;
    }
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: remoteRuntimeRootDir,
      adapterKey: "kimi",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }

  // Local runs deliver desired skills via `--skills-dir` (see buildArgs) from a
  // dedicated per-run directory, rather than symlinking into the user's
  // ~/.kimi-code/skills home. This keeps skill loading reliable and isolated
  // without polluting the operator's Kimi install. Remote runs sync skills into
  // the remote skills home above, so this only applies to local execution.
  if (!executionTargetIsRemote && desiredKimiSkillNames.length > 0) {
    localSkillsDir = await buildKimiSkillsDir(config);
    await onLog(
      "stderr",
      `[paperclip] Prepared ${desiredKimiSkillNames.length} Kimi skill(s) for --skills-dir delivery.\n`,
    );
  }

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
      `[paperclip] Kimi session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Kimi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    const notes: string[] = ["Prompt is passed to Kimi via -p for non-interactive execution."];
    notes.push("Added --output-format stream-json for structured headless output.");
    notes.push("Set headless env (CI=1, NO_COLOR=1, KIMI_CODE_NO_AUTO_UPDATE=1) so unattended runs skip interactive prompts and update preflight.");
    if (hasNonEmptyEnvValue(env, "KIMI_MODEL_THINKING_EFFORT")) {
      notes.push(`Set KIMI_MODEL_THINKING_EFFORT=${env.KIMI_MODEL_THINKING_EFFORT} for model ${model}.`);
    }
    const effectiveSkillsDir = executionTargetIsRemote ? remoteSkillsDir : localSkillsDir;
    if (effectiveSkillsDir) {
      notes.push(`Loading ${desiredKimiSkillNames.length} desired skill(s) via --skills-dir ${effectiveSkillsDir}.`);
    }
    if (!executionTargetIsRemote && instructionsFilePath) {
      notes.push(`Added --add-dir ${path.dirname(instructionsFilePath)} so sibling instruction files are readable.`);
    }
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("-r", resumeSessionId);
    if (model) args.push("-m", model);
    // Make the agent instructions directory readable so Kimi can open sibling
    // instruction files (./HEARTBEAT.md, ./SOUL.md, ./TOOLS.md) referenced by
    // the prepended entry file. Local-only: the directory is a host path that
    // is not synced to remote execution targets.
    if (!executionTargetIsRemote && instructionsFilePath) {
      args.push("--add-dir", path.dirname(instructionsFilePath));
    }
    // Load desired Paperclip skills from the dedicated per-run directory
    // (local snapshot, or the synced remote snapshot) instead of the shared
    // skills home. Only passed when skills are desired so unconfigured agents
    // keep Kimi's default skill discovery.
    const effectiveSkillsDir = executionTargetIsRemote ? remoteSkillsDir : localSkillsDir;
    if (effectiveSkillsDir) {
      args.push("--skills-dir", effectiveSkillsDir);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("-p", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    const invocationEnv = buildKimiHeadlessEnv(env);
    const invocationRuntimeEnv = buildKimiRuntimeEnv(env);
    const loggedEnv = buildInvocationEnvForLogs(invocationEnv, {
      runtimeEnv: invocationRuntimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (onMeta) {
      await onMeta({
        adapterType: "kimi_local",
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
      env: invocationEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: createKimiEventForwardingLog(onLog, onEvent),
      runLogTail: paperclipBridge?.runLogTail,
    });
    return {
      proc,
      parsed: parseKimiJsonl(proc.stdout),
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
      parsed: ReturnType<typeof parseKimiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectKimiAuthRequired({
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });
    const networkUnavailable = isKimiTransientNetworkError(attempt.proc.stdout, attempt.proc.stderr);

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth
          ? "kimi_auth_required"
          : networkUnavailable
            ? "kimi_network_unavailable"
            : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const structuredFailure = describeKimiFailure({
      errorMessage: attempt.parsed.errorMessage,
      stderr: attempt.proc.stderr,
    });
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      (attempt.proc.signal
        ? `Kimi was terminated by signal ${attempt.proc.signal}`
        : `Kimi exited with code ${attempt.proc.exitCode ?? -1}`);
    // A null exit code means the process never exited normally (e.g. killed by
    // a signal). Timeouts are handled earlier; treat any other non-zero or
    // null exit as a failure so a signaled kill is never reported as success.
    const failed = attempt.proc.exitCode === null || attempt.proc.exitCode !== 0;

    // On retry, don't fall back to old session ID — the old session was stale
    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
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
    const resultJson: Record<string, unknown> = {
      toolCalls: attempt.parsed.toolCalls,
      toolResults: attempt.parsed.toolResults,
      ...(failed ? { stderr: attempt.proc.stderr } : {}),
    };

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: failed && authMeta.requiresAuth
        ? "kimi_auth_required"
        : failed && networkUnavailable
        ? "kimi_network_unavailable"
        : null,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "moonshot",
      biller: "moonshot",
      model: model || null,
      billingType,
      resultJson,
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isKimiSessionUnrecoverableError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Kimi resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    await Promise.all([
      paperclipBridge?.stop(),
      restoreRemoteWorkspace?.(),
      localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
    ]);
  }
}
