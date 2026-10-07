import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
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
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl, createOpenCodeJsonlParser } from "./parse.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isFalseyEnvFlag,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
  resolveOpenCodePrintLogLevel,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { prepareOpenCodeRuntimeConfig, prepareManagedOpenCodeRemoteHomes } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveOpenCodeSkillsHome } from "./skills.js";
import {
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  OPENCODE_SURVIVING_GROUP_SIGKILL_SETTLE_MS,
  OPENCODE_SURVIVING_GROUP_TEARDOWN_POLL_MS,
  OPENCODE_SURVIVING_GROUP_TEARDOWN_SLACK_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOpenCodeOutputInactivityMonitorErrorMessage,
  resolveOpenCodeInactivityTimeout,
} from "./output-inactivity-monitor.js";
import {
  OPENCODE_PROCESS_ACTIVITY_POLL_INTERVAL_MS,
  createOpenCodeProcessActivityMonitor,
  hasLiveProcessGroupMember,
  type OpenCodeProcessActivityMonitorHandle,
} from "./process-activity-monitor.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function signalOpenCodeChild(
  target: { pid: number | null; processGroupId: number | null },
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, signal);
      return true;
    } catch {
      // Fall back to direct child signal if group signaling fails (e.g. group already gone).
    }
  }
  if (target.pid && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether the inactivity monitor may signal this spawn target from the
 * Paperclip host. Local runs spawn a real child process we own, and SSH runs
 * spawn a local ssh client we own — both report a real local process group on
 * POSIX. A sandbox runner instead reports a provider-internal pid and forces
 * `processGroupId` to null; signaling that pid with `process.kill` can hit an
 * unrelated host process while the sandbox-side opencode keeps running, and
 * sandbox teardown has no local seam (it belongs to the sandbox runner and the
 * runner's own timeout). So remote spawns without a local process group are
 * never signaled: the monitor still fails the run fast, and teardown stays
 * with the execution target's own runner.
 */
function canSignalSpawnTarget(
  target: { pid: number | null; processGroupId: number | null } | null,
  executionTargetIsRemote: boolean,
): target is { pid: number; processGroupId: number | null } {
  if (!target || target.pid == null || target.pid <= 0) return false;
  if (executionTargetIsRemote && (target.processGroupId == null || target.processGroupId <= 0)) {
    return false;
  }
  return true;
}

/** Whether the spawned child (or its process group) still exists. */
function isSpawnTargetAlive(target: { pid: number; processGroupId: number | null }): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(target.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the spawn target can still touch its workspace. Linux groups are
 * checked zombie-aware (`hasLiveProcessGroupMember`): an orphaned grandchild
 * can remain an unreaped group member on hosts whose pid 1 never reaps, and
 * a zombie holds no memory or descriptors, so it cannot write anywhere.
 * Elsewhere the signal-based existence check is the best available probe.
 */
async function isSpawnTargetLive(target: { pid: number; processGroupId: number | null }): Promise<boolean> {
  if (process.platform === "linux" && target.processGroupId && target.processGroupId > 0) {
    return hasLiveProcessGroupMember(target.processGroupId);
  }
  return isSpawnTargetAlive(target);
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown";
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}) {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return;
  }

  const defaultProbeTimeoutSec =
    input.executionTarget.kind === "remote" && input.executionTarget.transport === "sandbox"
      ? REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC
      : REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, defaultProbeTimeoutSec)
    : defaultProbeTimeoutSec;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    input.executionTarget,
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );

  // The remote availability probe is a best-effort pre-flight guard, not a gate.
  // If `opencode models` itself cannot run on the target — timeout, transient CLI
  // error, provider hiccup — do NOT abort the run. The real invocation is
  // authoritative, so a probe that can't execute must never be fatal. (Previously
  // these threw and crashed runs mid-flight, losing the agent's work + disposition.)
  if (probe.timedOut) {
    console.warn(
      `[opencode-local] Remote model availability probe for "${model}" timed out after ${probeTimeoutSec}s; proceeding with the configured model.`,
    );
    return;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    console.warn(
      `[opencode-local] Remote \`opencode models\` could not run for "${model}"${
        detail ? ` (${detail})` : ""
      }; proceeding with the configured model.`,
    );
    return;
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    console.warn(
      `[opencode-local] Remote \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return;
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveOpenCodeSkillsHome({}),
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildOpenCodeSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

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
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, openCodeSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureOpenCodeSkillsInjected(
      onLog,
      openCodeSkillEntries,
      desiredOpenCodeSkillNames,
      resolveOpenCodeSkillsHome(config),
    );
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
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
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
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
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let localSkillsDir: string | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      localSkillsDir = await buildOpenCodeSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OpenCode runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "opencode",
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
          ...(localRuntimeConfigHome
            ? [{
              key: "xdgConfig",
              localDir: localRuntimeConfigHome,
            }]
            : []),
        ],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
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
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
      prepareManagedOpenCodeRemoteHomes({
        env: preparedRuntimeConfig.env,
        config,
        runtimeRootDir: preparedExecutionTargetRuntime.runtimeRootDir,
        runId,
        configDir: preparedExecutionTargetRuntime.assetDirs.xdgConfig,
      });
      const remoteHomeDir = config.managedAiConnection
        ? preparedRuntimeConfig.env.HOME
        : managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".claude", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog },
        );
      }
      await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
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
        `[paperclip] OpenCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
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

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
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
      const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
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

    // Surface OpenCode's own logs on stderr (captured into the run result) so
    // upstream model stream errors and retries are visible in run output.
    // Without this, a rate-limited/unhealthy model can retry with backoff for
    // over an hour emitting nothing on stdout, which is indistinguishable from
    // a hung run (see silent-run incidents BEF-114/BEF-116). Enabled by default
    // at WARN level. Disable with PAPERCLIP_OPENCODE_PRINT_LOGS=0, or adjust
    // the level via PAPERCLIP_OPENCODE_PRINT_LOG_LEVEL (DEBUG|INFO|WARN|ERROR);
    // both read the run env first, then the process env.
    const printLogsDisabled = isFalseyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    const printLogLevel =
      resolveOpenCodePrintLogLevel(
        env.PAPERCLIP_OPENCODE_PRINT_LOG_LEVEL ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOG_LEVEL,
      ) ?? "WARN";

    // Bound a doomed run at the adapter level: a rate-limited/unhealthy model
    // can retry with backoff for over an hour emitting nothing on stdout
    // (BEF-114/BEF-116). The inactivity monitor treats only stdout JSONL model
    // events as progress — `--print-logs` stderr output must not keep a
    // retry-storming run alive — and, on Linux, process-group CPU/IO/child
    // churn keeps long-but-healthy tool executions alive. On fire the child
    // gets SIGTERM (5s grace) then SIGKILL, and the run fails fast with a
    // diagnosable error instead of churning until timeoutSec. Disable with
    // adapterConfig.outputInactivityTimeoutMs=null.
    const monitorResolution = resolveOpenCodeInactivityTimeout(config.outputInactivityTimeoutMs);
    if (monitorResolution.mode === "disabled") {
      await onLog(
        "stdout",
        `[paperclip] OpenCode output inactivity monitor is DISABLED via adapterConfig.outputInactivityTimeoutMs=null. Hung opencode runs will only be detected by the platform-level silent-run safety net.\n`,
      );
    } else if (monitorResolution.mode === "default" && "reason" in monitorResolution) {
      await onLog(
        "stdout",
        `[paperclip] Ignoring non-positive adapterConfig.outputInactivityTimeoutMs; falling back to default ${monitorResolution.timeoutMs}ms.\n`,
      );
    }
    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["run", "--format", "json"];
      if (!printLogsDisabled) {
        args.push("--print-logs", "--log-level", printLogLevel);
      }
      if (resumeSessionId) args.push("--session", resumeSessionId);
      if (model) args.push("--model", model);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
      const { basePrompt, promptMetrics } = buildPrompt(Boolean(resumeSessionId));
      const prompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
        basePrompt,
      ]);
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics: { ...promptMetrics, promptChars: prompt.length },
          context,
        });
      }

      const consumeAccounting = createOpenCodeJsonlParser();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(onLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        const provider = parseModelProvider(model || null);
        return { usage: parsed.usageReported ? parsed.usage : undefined, costUsd: parsed.costUsd,
          costStatus: parsed.usageComplete || parsed.costUsd != null ? undefined : "unpriced",
          usageBasis: "per_run", provider, biller: resolveOpenCodeBiller(runtimeEnv, provider), billingType: "unknown", model, complete: false };
      });

      let monitorFired = false;
      let monitorTerminationSignal: NodeJS.Signals | null = null;
      let monitorElapsedMs = 0;
      let monitorTimeoutMs = 0;
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let sigkillFired = false;
      let monitorLogPromise: Promise<unknown> | null = null;
      // Queue a stderr diagnostic instead of replacing any pending write: the
      // cleanup below awaits only the latest promise, so a bare reassignment
      // could drop an earlier diagnostic before the heartbeat logger
      // persists it. Chaining also keeps the lines in emission order.
      const queueMonitorLog = (line: string): void => {
        const previous = monitorLogPromise ?? Promise.resolve();
        monitorLogPromise = previous
          .catch(() => {})
          .then(() => Promise.resolve(onLog("stderr", line)).catch(() => {}));
      };
      const processActivityMonitor: { current: OpenCodeProcessActivityMonitorHandle | null } = { current: null };
      const resolvedMonitorTimeoutMs = monitorResolution.mode === "disabled" ? null : monitorResolution.timeoutMs;

      const monitor =
        monitorResolution.mode === "disabled"
          ? null
          : createOpenCodeOutputInactivityMonitor({
              timeoutMs: monitorResolution.timeoutMs,
              onFire: (state) => {
                monitorFired = true;
                monitorElapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
                monitorTimeoutMs = monitorResolution.timeoutMs;
                const message = formatOpenCodeOutputInactivityMonitorErrorMessage(monitorElapsedMs);
                const elapsedSec = Math.round(monitorElapsedMs / 1000);
                const timeoutSecLabel = Math.round(monitorResolution.timeoutMs / 1000);
                const sentSigterm = beginMonitorTermination();
                const terminationNote = sentSigterm
                  ? "terminating opencode child via SIGTERM (5s grace, then SIGKILL)"
                  : killTarget
                    ? "execution target has no safe local kill seam; failing the run fast and leaving teardown to the target's own runner"
                    : "no spawned child to signal yet; a child that spawns after this point is terminated on spawn";
                const logLine =
                  `[paperclip] adapter.invoke ${message}; ` +
                  `timeoutMs=${monitorResolution.timeoutMs} elapsedSinceLastEventMs=${monitorElapsedMs} ` +
                  `outputChunkCount=${state.outputChunkCount} outputBytes=${state.outputBytes} ` +
                  `parsedEvents=${state.parsedEventCount} stderrChunkCount=${state.stderrChunkCount} stderrBytes=${state.stderrBytes} ` +
                  `processActivityCount=${state.processActivityCount} ` +
                  `(timeout=${timeoutSecLabel}s elapsed=${elapsedSec}s); ${terminationNote}.\n`;
                // Issue the log without awaiting on the kill hot path, but keep
                // the promise queued so the surrounding try/finally can await
                // flush before the run resolves. Without this the diagnostic
                // that explains the kill could be dropped if the child exits
                // faster than onLog flushes.
                queueMonitorLog(logLine);
              },
            });

      // Signal the spawned child (SIGTERM, then SIGKILL after the grace
      // window). Returns false when the target is not safely signalable from
      // the host — a sandbox runner's pid must never be signaled here.
      const beginMonitorTermination = (): boolean => {
        const target = killTarget;
        if (!canSignalSpawnTarget(target, executionTargetIsRemote)) return false;
        const sentSig = signalOpenCodeChild(target, "SIGTERM");
        if (sentSig) monitorTerminationSignal = "SIGTERM";
        sigkillTimer = setTimeout(() => {
          sigkillTimer = null;
          sigkillFired = true;
          const stillSent = signalOpenCodeChild(target, "SIGKILL");
          if (stillSent) monitorTerminationSignal = "SIGKILL";
        }, OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
        if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
          (sigkillTimer as { unref: () => void }).unref();
        }
        return true;
      };

      const wrappedOnSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
        if (monitor && monitorFired) {
          // The inactivity window elapsed before the child spawned (slow
          // runtime preparation). The already-fired monitor never signals
          // again, so without this the fresh child would run to the
          // wall-clock timeout. Terminate it immediately on spawn.
          queueMonitorLog(
            "[paperclip] Output inactivity monitor fired before the opencode child spawned; terminating the fresh child now.\n",
          );
          beginMonitorTermination();
        } else if (monitor && resolvedMonitorTimeoutMs !== null && !executionTargetIsRemote) {
          processActivityMonitor.current = createOpenCodeProcessActivityMonitor({
            pid: meta.pid,
            processGroupId: meta.processGroupId,
            intervalMs: Math.min(
              OPENCODE_PROCESS_ACTIVITY_POLL_INTERVAL_MS,
              Math.max(1_000, Math.floor(resolvedMonitorTimeoutMs / 4)),
            ),
            onActivity: () => monitor.noteProcessActivity(),
          });
        }
        if (onSpawn) {
          await onSpawn(meta);
        }
      };

      let invocation:
        | {
            proc: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
            rawStderr: string;
            parsed: ReturnType<typeof parseOpenCodeJsonl>;
          }
        | null = null;
      try {
        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          onProcessStopped: providerStop.beginInvocation(),
          cwd,
          env: preparedRuntimeConfig.env,
          stdin: prompt,
          timeoutSec,
          graceSec,
          onSpawn: wrappedOnSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: async (stream, chunk) => {
            monitor?.noteOutputChunk(stream, chunk);
            await accountingLog(stream, chunk);
          },
          runLogTail: paperclipBridge?.runLogTail,
          settleRunDisposition: paperclipBridge?.settleRunDisposition,
        });
        // Parse any unterminated final record before deciding whether its usage
        // is complete. A clean exit alone cannot turn absent counters into zero.
        await accountingLog.flush();
        const retainedAccounting = consumeAccounting("");
        await accountingLog.flush({ complete: proc.exitCode === 0 && !proc.timedOut && !proc.signal
          && (retainedAccounting.usageComplete || retainedAccounting.costUsd != null) });
        // Display output is capped by the process transport. Keep accounting
        // from the full stream, including when no checkpoint callback is installed.
        const parsed = parseOpenCodeJsonl(proc.stdout);
        if (hasAccounting) {
          const retained = consumeAccounting("");
          parsed.usage = retained.usage;
          parsed.usageReported = retained.usageReported;
          parsed.usageComplete = retained.usageComplete;
          parsed.costUsd = retained.costUsd;
        }
        invocation = {
          proc,
          rawStderr: proc.stderr,
          parsed,
        };
      } finally {
        processActivityMonitor.current?.stop();
        monitor?.stop();
        if (sigkillTimer) {
          // The run resolved during the SIGTERM grace — e.g. opencode exited
          // promptly after SIGTERM while a detached tool subprocess in its
          // process group ignored SIGTERM and closed its inherited stdio.
          // When the group still exists, keep the scheduled SIGKILL so that
          // subprocess receives the full promised grace window before the
          // forced shutdown; cancel only when there is nothing left to
          // signal, so the escalation cannot be lost and leak the group.
          const signalableTarget = canSignalSpawnTarget(killTarget, executionTargetIsRemote) ? killTarget : null;
          if (!signalableTarget || !isSpawnTargetAlive(signalableTarget)) {
            clearTimeout(sigkillTimer);
            sigkillTimer = null;
          } else {
            // The surviving subprocess still owns the workspace, and once
            // this result resolves the heartbeat executor may immediately
            // start the next queued run for the same agent. Preserve the
            // full grace for the subprocess, but hold the resolve until its
            // teardown completes — self-exit or the scheduled SIGKILL at
            // grace end — so the next run cannot start while the old tool
            // is still writing. Liveness is zombie-aware: an orphaned
            // grandchild can stay an unreaped group member on hosts whose
            // pid 1 never reaps, and a zombie can no longer write anywhere.
            // A hard slack bounds the wait so a group that survives even
            // SIGKILL (e.g. uninterruptible disk sleep) can never hang the
            // run.
            queueMonitorLog(
              "[paperclip] Surviving process group is still alive after opencode exited; holding the run result until teardown completes so the next queued run cannot start early.\n",
            );
            const teardownDeadlineMs =
              Date.now() + OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS + OPENCODE_SURVIVING_GROUP_TEARDOWN_SLACK_MS;
            while (!sigkillFired && Date.now() < teardownDeadlineMs && (await isSpawnTargetLive(signalableTarget))) {
              await new Promise((resolve) => setTimeout(resolve, OPENCODE_SURVIVING_GROUP_TEARDOWN_POLL_MS));
            }
            if (sigkillFired) {
              // The SIGKILL was just delivered to the group; grant it a brief
              // settle so its members finish dying before the next queued
              // run may start.
              await new Promise((resolve) => setTimeout(resolve, OPENCODE_SURVIVING_GROUP_SIGKILL_SETTLE_MS));
            } else {
              // The group tore itself down (or the slack elapsed) — cancel
              // the no-longer-needed escalation.
              clearTimeout(sigkillTimer);
              sigkillTimer = null;
            }
          }
        }
        if (monitorLogPromise) {
          await monitorLogPromise;
          monitorLogPromise = null;
        }
      }
      // Snapshot the monitor outcome only after teardown completes: the
      // scheduled SIGKILL can fire during the surviving-group teardown wait
      // above, and the run result must report the actually-delivered signal
      // (SIGKILL), not the stale SIGTERM captured when termination began.
      return {
        proc: invocation.proc,
        rawStderr: invocation.rawStderr,
        parsed: invocation.parsed,
        monitor: monitorFired
          ? {
              fired: true as const,
              terminationSignal: monitorTerminationSignal,
              elapsedMsSinceLastEvent: monitorElapsedMs,
              timeoutMs: monitorTimeoutMs,
            }
          : { fired: false as const },
      };
    };

    const buildSessionIdentity = (resolvedSessionId: string | null) =>
      resolvedSessionId
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

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
        monitor?:
          | { fired: false }
          | { fired: true; terminationSignal: NodeJS.Signals | null; elapsedMsSinceLastEvent: number; timeoutMs: number };
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.monitor?.fired) {
        const errorMessage = formatOpenCodeOutputInactivityMonitorErrorMessage(attempt.monitor.elapsedMsSinceLastEvent);
        const modelId = model || null;
        // Retain the session identity on a monitor-fired failure: opencode
        // may have persisted the interrupted session, so the next run can
        // resume it. Nulling every session field here reads as an
        // instruction to clear the stored session, which would strand a
        // resumable session — the same retention rule the ordinary error
        // path applies.
        const resolvedSessionId = runtimeSessionId || null;
        return {
          exitCode: null,
          signal: attempt.monitor.terminationSignal ?? attempt.proc.signal,
          timedOut: false,
          errorMessage,
          errorCode: "opencode_output_inactivity_monitor",
          // The monitor killed the run mid-flight: report whatever usage was
          // already emitted, but never mark it complete (mirrors the timeout
          // branch's accounting semantics).
          usageComplete: false,
          usageBasis: "per_run",
          usage: attempt.parsed.usageReported ? attempt.parsed.usage : undefined,
          sessionId: resolvedSessionId,
          sessionParams: buildSessionIdentity(resolvedSessionId),
          sessionDisplayId: resolvedSessionId,
          provider: parseModelProvider(modelId),
          biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
          model: modelId,
          billingType: "unknown",
          costUsd: attempt.parsed.costUsd,
          costStatus: attempt.parsed.usageComplete || attempt.parsed.costUsd != null ? undefined : "unpriced",
          resultJson: {
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            outputInactivityMonitor: {
              kind: "output_inactivity",
              timeoutMs: attempt.monitor.timeoutMs,
              elapsedMsSinceLastEvent: attempt.monitor.elapsedMsSinceLastEvent,
              terminationSignal: attempt.monitor.terminationSignal,
            },
          },
          summary: attempt.parsed.summary,
          clearSession: false,
        };
      }
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: false,
          usage: attempt.parsed.usageReported ? attempt.parsed.usage : undefined,
          usageBasis: "per_run",
          provider: parseModelProvider(model || null),
          biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(model || null)),
          model,
          billingType: "unknown",
          costUsd: attempt.parsed.costUsd,
          costStatus: attempt.parsed.usageComplete || attempt.parsed.costUsd != null ? undefined : "unpriced",
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = buildSessionIdentity(resolvedSessionId);

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
      const modelId = model || null;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: attempt.proc.exitCode === 0 && !attempt.proc.signal
          && (attempt.parsed.usageComplete || attempt.parsed.costUsd != null),
        usageBasis: "per_run",
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: attempt.parsed.usageReported ? attempt.parsed.usage : undefined,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        costStatus: attempt.parsed.usageComplete || attempt.parsed.costUsd != null ? undefined : "unpriced",
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    try {
      const initial = await runAttempt(sessionId);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
      if (
        sessionId &&
        initialFailed &&
        isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      try {
        await providerStop.collectBeforeRestore();
      } finally {
        await Promise.all([
          paperclipBridge?.stop(),
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
      }
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
