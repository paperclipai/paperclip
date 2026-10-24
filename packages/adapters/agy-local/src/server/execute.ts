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
  adapterExecutionTargetUsesPaperclipBridge,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetDuplexObservabilityRecorder,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
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
  describeAgyDeniedActions,
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgyTransientNetworkError,
  isAgyUnknownSessionError,
  parseAgyJsonl,
  resolveAgyRunOutcome,
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
import { ensureAgyApiKeySettings } from "./credentials.js";
import { prepareAgyLocalRunMcpHome } from "./mcp.js";
import {
  DEFAULT_AGY_LOCAL_MODEL,
  resolveAgyModelEffort,
  SANDBOX_INSTALL_COMMAND,
} from "../index.js";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { prepareAgyRemoteRun } from "./remote-setup.js";

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

export { resolveAgyModelEffort };

/**
 * Set agy's --print-timeout slightly below Paperclip's timeoutSec so agy exits cleanly
 * and emits a result event before being terminated mid-stream.
 */
export function resolveAgyPrintTimeoutSec(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return 0;
  const margin = Math.max(10, Math.floor(timeoutSec * 0.05));
  return Math.max(30, timeoutSec - margin);
}

export async function discoverAgySessionArtifacts(
  sessionId: string,
  cliHomeDirs?: string[],
): Promise<string[]> {
  if (!sessionId || typeof sessionId !== "string") return [];
  const homedir = os.homedir();
  const baseHomes = new Set<string>();
  if (Array.isArray(cliHomeDirs)) {
    for (const h of cliHomeDirs) {
      if (typeof h === "string" && h.trim()) baseHomes.add(h.trim());
    }
  }
  baseHomes.add(path.join(homedir, ".gemini", "antigravity-cli"));
  baseHomes.add(path.join(homedir, ".gemini", "antigravity"));

  const candidateDirs: string[] = [];
  for (const home of baseHomes) {
    candidateDirs.push(path.join(home, "brain", sessionId));
  }

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
          const real = await fs.realpath(fullPath).catch(() => fullPath);
          artifacts.push(real);
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
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
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
  const inputFormat = asString(config.inputFormat, "stream-json").trim().toLowerCase();
  const useStreamJsonInput = inputFormat !== "text";

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

  // ── Skills reconciliation and receipt logging ──────────────────────────────
  let skillRoot = resolveAgySkillRoot({
    config,
    agentId: agent.id,
    companyId: agent.companyId,
  });
  let skillsAddDir: string | null = null;
  let skillsHomeExists = false;
  if (skillRoot.addDir) {
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
    skillsHomeExists = await fs
      .stat(skillRoot.skillsHome)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (skillsHomeExists && !executionTargetIsRemote) {
      skillsAddDir = skillRoot.addDir;
    }
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
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

  if (runtimeEnv.GEMINI_API_KEY && !executionTargetIsRemote) {
    try {
      await ensureAgyApiKeySettings(runtimeEnv.HOME || os.homedir(), runtimeEnv);
    } catch (err) {
      await onLog(
        "stdout",
        `[paperclip] Warning: could not write agy settings.json: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 15);

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let remoteSkillsDir: string | null = null;
  let stagedAgyHomeDir: string | null = null;
  let stagedMcpConfigDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  const runtimeMcpIdentity = JSON.stringify(
    runtimeMcpServers.map(({ name, url, connectionId }) => ({ name, url, connectionId })),
  );

  // Post-staging setup failures (command resolution, bridge startup) run
  // the remote teardown through this handle; prepareAgyRemoteRun replaces
  // it with the real cleanup once remote setup has run.
  let cleanupRemoteSetupFailure: () => Promise<void> = async () => {};

  if (executionTargetIsRemote) {
    const preparedRemoteRun = await prepareAgyRemoteRun({
      runId,
      executionTarget,
      cwd,
      command,
      timeoutSec,
      graceSec,
      runtimeCommandSpec: ctx.runtimeCommandSpec,
      onLog,
      onRuntimeProgress: ctx.onRuntimeProgress,
      runtimeEnv,
      env,
      envConfig,
      runtimeMcpServers,
      skillsAssetDir: skillsHomeExists && skillRoot.addDir ? skillRoot.addDir : null,
      effectiveExecutionCwd,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
    });
    restoreRemoteWorkspace = preparedRemoteRun.restoreRemoteWorkspace;
    remoteRuntimeRootDir = preparedRemoteRun.remoteRuntimeRootDir;
    remoteSkillsDir = preparedRemoteRun.remoteSkillsDir;
    stagedAgyHomeDir = preparedRemoteRun.stagedAgyHomeDir;
    stagedMcpConfigDir = preparedRemoteRun.stagedMcpConfigDir;
    effectiveExecutionCwd = preparedRemoteRun.effectiveExecutionCwd;
    cleanupRemoteSetupFailure = preparedRemoteRun.cleanupSetupFailure;
  }

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(
    executionTarget,
    effectiveExecutionCwd,
  );

  // Command setup runs after remote assets are staged, so it sits under
  // the same cleanup guard as the staging block above.
  let resolvedCommand: string;
  try {
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

    resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
      command,
      executionTarget,
      cwd,
      runtimeEnv,
    );
  } catch (error) {
    await cleanupRemoteSetupFailure();
    throw error;
  }

  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "PATH", "ANTIGRAVITY_CLI_HOME", "GEMINI_CLI_HOME"],
    resolvedCommand,
  });

  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    try {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "agy",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
    } catch (error) {
      await cleanupRemoteSetupFailure();
      throw error;
    }
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      Object.assign(runtimeEnv, paperclipBridge.env);
      loggedEnv = buildInvocationEnvForLogs(env, {
        runtimeEnv,
        includeRuntimeKeys: ["HOME", "PATH", "ANTIGRAVITY_CLI_HOME", "GEMINI_CLI_HOME"],
        resolvedCommand,
      });
    }
  }

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId =
    asString(runtimeSessionParams.sessionId, "") ||
    asString(runtimeSessionParams.conversationId, "") ||
    asString(runtime.sessionId, "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const sessionCwdsMatch =
    runtimeSessionCwd.length === 0 ||
    (executionTargetIsRemote
      ? path.posix.normalize(runtimeSessionCwd) === path.posix.normalize(effectiveExecutionCwd)
      : path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd));
  const runtimeMcpServerIdentity = asString(runtimeSessionParams.mcpServerIdentity, "");
  const hasMatchingMcpServers =
    runtimeMcpServerIdentity.length === 0
      ? runtimeMcpServers.length === 0
      : runtimeMcpServerIdentity === runtimeMcpIdentity;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    sessionCwdsMatch &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  }
  if (runtimeSessionId && canResumeSession && !hasMatchingMcpServers) {
    // Each agy invocation loads mcp_config.json fresh, including resumed
    // conversations, so a changed tool set does not invalidate the saved
    // session (the same reasoning claude-local documents for --mcp-config).
    // The identity is still stored per session so the change is observable.
    await onLog(
      "stdout",
      `[paperclip] Antigravity runtime MCP server set changed; loading current tools when resuming session "${runtimeSessionId}".\n`,
    );
  }

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
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  // The prompt depends on whether this attempt resumes a conversation:
  // resumed attempts send only the wake delta, while a fresh session needs
  // the bootstrap prompt and the full request. Build it per attempt so the
  // fresh-session retry after an unknown-session failure does not reuse
  // the resume-only prompt built for the saved conversation.
  const buildPromptForAttempt = (resumeSessionId: string | null) => {
    const renderedBootstrapPrompt =
      !resumeSessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      resumedSession: Boolean(resumeSessionId),
    });
    const shouldUseResumeDeltaPrompt = Boolean(resumeSessionId) && wakePrompt.length > 0;
    const renderedPrompt =
      shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const attemptPrompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    return {
      prompt: attemptPrompt,
      promptMetrics: {
        promptChars: attemptPrompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
    };
  };

  const buildArgs = (resumeSessionId: string | null, attemptPrompt: string) => {
    const initialCwd = executionTargetIsRemote ? effectiveExecutionCwd : cwd;
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      useStreamJsonInput ? "stream-json" : "text",
      "--add-dir",
      initialCwd,
    ];

    // Multi-workspace monorepo injection: add all distinct workspace and configured directories
    const addedDirs = new Set<string>([
      executionTargetIsRemote
        ? path.posix.normalize(initialCwd)
        : path.resolve(initialCwd),
    ]);
    if (!executionTargetIsRemote) {
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
    }
    for (const addDir of additionalDirs) {
      const resolved = executionTargetIsRemote
        ? path.posix.normalize(addDir)
        : path.resolve(addDir);
      if (!addedDirs.has(resolved)) {
        addedDirs.add(resolved);
        args.push("--add-dir", addDir);
      }
    }
    const effectiveSkillsDir = executionTargetIsRemote ? remoteSkillsDir : skillsAddDir;
    if (effectiveSkillsDir) {
      const resolved = executionTargetIsRemote
        ? path.posix.normalize(effectiveSkillsDir)
        : path.resolve(effectiveSkillsDir);
      if (!addedDirs.has(resolved)) {
        addedDirs.add(resolved);
        args.push("--add-dir", effectiveSkillsDir);
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
    const resolvedModelEffort = resolveAgyModelEffort(model, effort);
    if (resolvedModelEffort.model) {
      args.push("--model", resolvedModelEffort.model);
    }
    if (resolvedModelEffort.effort) {
      args.push("--effort", resolvedModelEffort.effort);
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
    if (!useStreamJsonInput) {
      args.push("--print", attemptPrompt);
    }
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const { prompt: attemptPrompt, promptMetrics: attemptPromptMetrics } =
      buildPromptForAttempt(resumeSessionId);
    const args = buildArgs(resumeSessionId, attemptPrompt);
    if (onMeta) {
      await onMeta({
        adapterType: "agy_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args.map((arg) => (arg === attemptPrompt ? `<prompt ${attemptPrompt.length} chars>` : arg)),
        env: loggedEnv,
        prompt: attemptPrompt,
        promptMetrics: attemptPromptMetrics,
        context,
      });
    }

    const stdin = useStreamJsonInput
      ? JSON.stringify({ event: "user", message: { content: attemptPrompt } }) + "\n"
      : undefined;

    const proc = await runAdapterExecutionTargetProcess(
      runId,
      runtimeExecutionTarget,
      command,
      args,
      {
        onProcessStopped: providerStop.beginInvocation(),
        cwd: effectiveExecutionCwd,
        env: runtimeEnv,
        stdin,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
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
          // Stamped whenever managed servers exist: local runs write the
          // config directly, remote runs receive it via the staged sync.
          ...(runtimeMcpServers.length > 0 ? { mcpServerIdentity: runtimeMcpIdentity } : {}),
          ...(executionTargetIsRemote
            ? {
                remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
              }
            : {}),
        } as Record<string, unknown>)
      : null;

    const outcome = resolveAgyRunOutcome(attempt.parsed, attempt.proc.exitCode);
    const outcomeError = outcome.errorMessage?.trim() ?? "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode = outcome.failed && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      outcomeError || stderrLine || `Antigravity exited with code ${synthesizedExitCode ?? -1}`;
    const failed = outcome.failed;

    const provider = inferModelProvider(model);

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: failed
        ? outcome.permissionDenied
          ? "agy_permission_denied"
          : classifyErrorCode()
        : null,
      errorFamily: failed && !outcome.permissionDenied ? errorFamily : null,
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
      model: resolvedModelEffort.model || null,
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
      summary: attempt.parsed.summary || (failed ? fallbackErrorMessage : null),
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  const resolvedModelEffort = resolveAgyModelEffort(model, effort);
  if (resolvedModelEffort.warning) {
    await onLog("stdout", `[paperclip] Warning: ${resolvedModelEffort.warning}\n`);
  }

  let mcpCleanup: (() => Promise<void>) | null = null;
  if (runtimeMcpServers.length > 0 && !executionTargetIsRemote) {
    try {
      // Local runs get a private per-run HOME whose mcp_config.json holds
      // exactly this run's servers (plus the user's own). Writing run-scoped
      // bearer tokens into the shared host config would let a concurrent
      // run replace them before this process reads the file.
      const mcpResult = await prepareAgyLocalRunMcpHome({
        homedir: runtimeEnv.HOME || os.homedir(),
        env: runtimeEnv,
        servers: runtimeMcpServers,
        runId,
      });
      runtimeEnv.HOME = mcpResult.homeDir;
      mcpCleanup = mcpResult.cleanup;
      await onLog(
        "stdout",
        `[paperclip] Configured ${runtimeMcpServers.length} Paperclip-managed MCP server(s) in ${mcpResult.configPath}.\n`,
      );
    } catch (err) {
      await onLog(
        "stdout",
        `[paperclip] Warning: could not write Antigravity MCP config: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  try {
    const initial = await runAttempt(sessionId);
    const initialFailed =
      !initial.proc.timedOut && resolveAgyRunOutcome(initial.parsed, initial.proc.exitCode).failed;

    let finalAttempt: Attempt = initial;
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
      finalAttempt = retry;
      finalResult = toResult(retry, true);
    } else {
      finalResult = toResult(initial);
    }

    if (finalAttempt.parsed.deniedActions.length > 0) {
      await onLog("stdout", `[paperclip] ${describeAgyDeniedActions(finalAttempt.parsed.deniedActions)}\n`);
    }

    if (finalResult.sessionId && !executionTargetIsRemote) {
      const cliHomeDirs = [
        runtimeEnv.ANTIGRAVITY_CLI_HOME,
        runtimeEnv.GEMINI_CLI_HOME,
        runtimeEnv.HOME ? path.join(runtimeEnv.HOME, ".gemini", "antigravity-cli") : null,
      ].filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
      const artifacts = await discoverAgySessionArtifacts(finalResult.sessionId, cliHomeDirs);
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
  } finally {
    await mcpCleanup?.().catch(() => undefined);
    try {
      await providerStop.collectBeforeRestore();
    } catch {}
    try {
      await paperclipBridge?.stop();
    } catch {}
    try {
      await restoreRemoteWorkspace?.();
    } catch {}
    if (stagedAgyHomeDir) {
      await fs.rm(stagedAgyHomeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (stagedMcpConfigDir) {
      await fs.rm(stagedMcpConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
