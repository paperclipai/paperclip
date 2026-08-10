import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
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
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  ensureGeminiWorkspaceGitExclude,
  parseResolvedMcpServers,
  prepareGeminiMcpSettingsAsset,
  stripGeminiWorkspaceMcpSettings,
  syncGeminiWorkspaceMcpSettings,
} from "./mcp-config.js";
import {
  describeGeminiFailure,
  detectGeminiAuthRequired,
  isGeminiTransientNetworkError,
  isGeminiTurnLimitResult,
  isGeminiSessionUnrecoverableError,
  parseGeminiJsonl,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import {
  createGeminiAcpExecutor,
  formatGeminiAcpFallbackMessage,
  resolveGeminiExecutionEngineForRun,
} from "./acp.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeGeminiAcp = createGeminiAcpExecutor();

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
}

function buildGeminiHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  const term = env.TERM?.trim().toLowerCase();
  if (!term || term === "dumb" || term === "vt100") {
    next.TERM = "xterm-256color";
  }
  if (!next.COLORTERM?.trim()) {
    next.COLORTERM = "truecolor";
  }
  next.NO_BROWSER = "1";
  delete next.NO_COLOR;
  return next;
}

function buildGeminiRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildGeminiHeadlessEnv(env) })).filter(
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
    "Use run_shell_command with curl to make Paperclip API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" \\"$PAPERCLIP_API_URL/api/agents/me\\"" })`,
    "POST/PATCH example:",
    `  run_shell_command({ command: "curl -s -X POST -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" -H 'Content-Type: application/json' -H \\"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\\" -d '{...}' \\"$PAPERCLIP_API_URL/api/issues/{id}/checkout\\"" })`,
    "",
    "",
  ].join("\n");
}

function geminiSkillsHome(): string {
  return path.join(os.homedir(), ".gemini", "skills");
}

/**
 * Inject Paperclip skills directly into `~/.gemini/skills/` via symlinks.
 * This avoids needing GEMINI_CLI_HOME overrides, so the CLI naturally finds
 * both its auth credentials and the injected skills in the real home directory.
 */
async function ensureGeminiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = geminiSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Gemini skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Gemini skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Gemini skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Gemini skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildGeminiSkillsDir(
  config: Record<string, unknown>,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-skills-"));
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
  const engineSelection = await resolveGeminiExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeGeminiAcp(ctx);
    } catch (err) {
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stderr",
        formatGeminiAcpFallbackMessage(`Gemini ACP startup failed: ${reason}`),
      );
    }
  }
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatGeminiAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, acquireLaunchPermit, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

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
  const geminiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredGeminiSkillNames = resolvePaperclipDesiredSkillNames(config, geminiSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureGeminiSkillsInjected(onLog, geminiSkillEntries, desiredGeminiSkillNames);
  }

  // External MCP servers: the heartbeat layer hands us `config.mcpServers`
  // already resolved (secret refs -> plaintext). Gemini reads MCP servers from
  // settings.json, so merge them into the per-agent workspace settings file
  // for local runs (remote runs ship a settings asset into the managed home).
  const resolvedMcpServers = parseResolvedMcpServers(config.mcpServers);
  const mcpServerNames = Object.keys(resolvedMcpServers);
  if (!executionTargetIsRemote) {
    // Keep the secret-bearing settings file out of the git tree before writing
    // it, so `git add -A` mid-run can't stage live tokens. Only when injecting.
    if (mcpServerNames.length > 0) {
      await ensureGeminiWorkspaceGitExclude({ cwd }).catch(() => undefined);
    }
    const mcpSync = await syncGeminiWorkspaceMcpSettings({ cwd, servers: resolvedMcpServers });
    if (mcpSync && mcpServerNames.length > 0) {
      await onLog(
        "stdout",
        `[paperclip] Injecting ${mcpServerNames.length} external MCP server${mcpServerNames.length === 1 ? "" : "s"} (${mcpServerNames.join(", ")}) via workspace .gemini/settings.json.\n`,
      );
    }
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent, runId, context) };
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
  // Folder-trust can block workspace settings + MCP connections in headless
  // runs, so also trust the workspace when MCP servers are injected locally.
  if (
    (executionTargetIsRemote || mcpServerNames.length > 0) &&
    typeof env.GEMINI_CLI_TRUST_WORKSPACE !== "string"
  ) {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const runtimeEnv = buildGeminiRuntimeEnv(env);
  const billingType = resolveGeminiBillingType(runtimeEnv);
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 3600),
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
  let remoteSkillsDir: string | null = null;
  let localSkillsDir: string | null = null;
  let preparedMcpSettings: Awaited<ReturnType<typeof prepareGeminiMcpSettingsAsset>> | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  // Managed sandbox images do not expose their baked-in Gemini auth selection
  // once HOME is replaced with the per-run runtime root. Keep this separate
  // from the credential itself: settings.json records only the selected mode.
  const hasGeminiApiKey = Boolean(
    env.GEMINI_API_KEY || env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  if (executionTargetIsRemote) {
    try {
      localSkillsDir = await buildGeminiSkillsDir(config);
      if (mcpServerNames.length > 0) {
        preparedMcpSettings = await prepareGeminiMcpSettingsAsset({ servers: resolvedMcpServers });
        if (hasGeminiApiKey) {
          const settings = JSON.parse(await fs.readFile(preparedMcpSettings.localFilePath, "utf8")) as Record<string, unknown>;
          settings.selectedAuthType = "gemini-api-key";
          settings.security = { auth: { selectedType: "gemini-api-key" } };
          await fs.writeFile(
            preparedMcpSettings.localFilePath,
            `${JSON.stringify(settings, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
      }
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Gemini runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "gemini",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
          ...(preparedMcpSettings
            ? [{
              key: "mcp-settings",
              localDir: preparedMcpSettings.localDir,
              followSymlinks: false,
            }]
            : []),
        ],
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
      const remoteHomeDir =
        managedRemoteHomeDir ??
        (await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
          cwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        }));
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        remoteSkillsDir = path.posix.join(remoteHomeDir, ".gemini", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env, timeoutSec, graceSec, onLog },
        );
      }
      if (preparedMcpSettings && !managedHome) {
        // Non-managed (SSH) remote: remoteHomeDir is the real user's $HOME, so
        // copying settings.json there would clobber their own
        // ~/.gemini/settings.json and leave plaintext secrets on the persistent
        // host with no cleanup. Skip the copy — external MCP servers need a
        // managed-home (sandbox) target.
        await onLog(
          "stderr",
          "[paperclip] Skipping external MCP server injection: remote execution requires a managed-home (sandbox) target so the user's real ~/.gemini/settings.json is not overwritten with secrets. Configure a sandbox target to use MCP servers remotely.\n",
        );
      } else if (remoteHomeDir && preparedMcpSettings && preparedExecutionTargetRuntime.assetDirs["mcp-settings"]) {
        const remoteMcpSettingsPath = path.posix.join(remoteHomeDir, ".gemini", "settings.json");
        const remoteMcpAssetPath = path.posix.join(
          preparedExecutionTargetRuntime.assetDirs["mcp-settings"],
          preparedMcpSettings.fileName,
        );
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteMcpSettingsPath))} && cp ${JSON.stringify(remoteMcpAssetPath)} ${JSON.stringify(remoteMcpSettingsPath)} && chmod 600 ${JSON.stringify(remoteMcpSettingsPath)}`,
          { cwd, env, timeoutSec, graceSec, onLog },
        );
        await onLog(
          "stdout",
          `[paperclip] Injecting ${mcpServerNames.length} external MCP server${mcpServerNames.length === 1 ? "" : "s"} (${mcpServerNames.join(", ")}) via remote ~/.gemini/settings.json.\n`,
        );
      }

      // When no secret-bearing MCP settings asset is present, create the
      // minimal managed-home settings file needed for Gemini's noninteractive
      // API-key authentication. MCP assets above receive the same selector
      // before they are synchronized, so neither feature overwrites the other.
      if (managedRemoteHomeDir && hasGeminiApiKey && !preparedMcpSettings) {
        const remoteSettingsPath = path.posix.join(managedRemoteHomeDir, ".gemini", "settings.json");
        const authSettingsJson = JSON.stringify({
          selectedAuthType: "gemini-api-key",
          security: { auth: { selectedType: "gemini-api-key" } },
        });
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSettingsPath))} && { [ -f ${JSON.stringify(remoteSettingsPath)} ] || printf '%s' ${JSON.stringify(authSettingsJson)} > ${JSON.stringify(remoteSettingsPath)}; }`,
          { cwd, env, timeoutSec, graceSec, onLog },
        );
      }
    } catch (error) {
      await Promise.allSettled([
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        preparedMcpSettings?.cleanup(),
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
      adapterKey: "gemini",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
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
      `[paperclip] Gemini session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Gemini session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
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
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    const notes: string[] = ["Prompt is passed to Gemini via --prompt for non-interactive execution."];
    notes.push("Added --approval-mode yolo for unattended execution.");
    notes.push("Set headless terminal/browser env so Gemini fails fast instead of opening interactive auth or color prompts.");
    if (executionTargetIsRemote) {
      notes.push("Set GEMINI_CLI_TRUST_WORKSPACE=true for remote headless execution.");
    }
    if (mcpServerNames.length > 0) {
      notes.push(
        `Injected ${mcpServerNames.length} external MCP server${mcpServerNames.length === 1 ? "" : "s"} (${mcpServerNames.join(", ")}) into ${executionTargetIsRemote ? "the remote home" : "the workspace"} .gemini/settings.json with trust=true.`,
      );
      if (!executionTargetIsRemote) {
        notes.push("Set GEMINI_CLI_TRUST_WORKSPACE=true so injected MCP servers load in headless runs.");
      }
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
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
    args.push("--approval-mode", "yolo");
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    const invocationEnv = buildGeminiHeadlessEnv(env);
    const invocationRuntimeEnv = buildGeminiRuntimeEnv(env);
    const loggedEnv = buildInvocationEnvForLogs(invocationEnv, {
      runtimeEnv: invocationRuntimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (onMeta) {
      await onMeta({
        adapterType: "gemini_local",
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
      acquireLaunchPermit,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog,
      runLogTail: paperclipBridge?.runLogTail,
    });
    return {
      proc,
      parsed: parseGeminiJsonl(proc.stdout),
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
      parsed: ReturnType<typeof parseGeminiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectGeminiAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });
    const networkUnavailable = isGeminiTransientNetworkError(attempt.proc.stdout, attempt.proc.stderr);

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth
          ? "gemini_auth_required"
          : networkUnavailable
            ? "gemini_network_unavailable"
            : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const structuredFailure = attempt.parsed.resultEvent
      ? describeGeminiFailure(attempt.parsed.resultEvent)
      : null;
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      `Gemini exited with code ${attempt.proc.exitCode ?? -1}`;
    const failed = (attempt.proc.exitCode ?? 0) !== 0;
    const clearSessionForTurnLimit = isGeminiTurnLimitResult(
      attempt.parsed.resultEvent,
      attempt.proc.exitCode,
    );

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
      ...(attempt.parsed.resultEvent ?? {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      }),
      ...(failed && clearSessionForTurnLimit ? { stopReason: "max_turns_exhausted" } : {}),
    };

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: failed && authMeta.requiresAuth
        ? "gemini_auth_required"
        : failed && clearSessionForTurnLimit
        ? "max_turns_exhausted"
        : failed && networkUnavailable
        ? "gemini_network_unavailable"
        : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      biller: "google",
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson,
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
      clearSession: clearSessionForTurnLimit || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isGeminiSessionUnrecoverableError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
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
      // The synced settings asset holds resolved secrets — remove it after the run.
      preparedMcpSettings?.cleanup(),
      // Local runs wrote resolved secrets into <cwd>/.gemini/settings.json — strip
      // the managed entries so plaintext exists on disk only during the run. The
      // start-of-run sentinel strip stays as a crash-recovery path. No-op for a
      // user-owned settings.json (no sentinel key).
      !executionTargetIsRemote
        ? stripGeminiWorkspaceMcpSettings({ cwd }).catch(() => undefined)
        : Promise.resolve(),
    ]);
  }
}
