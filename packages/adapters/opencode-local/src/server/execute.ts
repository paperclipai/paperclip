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
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  runningProcesses,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl, isOpenCodeConnectionErrorOrHang } from "./parse.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
  discoverOpenCodeModelsCached,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  fallbackModel?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog?: (type: "stdout" | "stderr", message: string) => Promise<void>;
}): Promise<string> {
  const model = requireOpenCodeModelId(input.model);
  const fallbackModel = input.fallbackModel ? requireOpenCodeModelId(input.fallbackModel) : null;

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return model;
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

  if (probe.timedOut) {
    throw new Error(`\`opencode models\` timed out on the remote execution target after ${probeTimeoutSec}s.`);
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    throw new Error(
      detail
        ? `\`opencode models\` failed on the remote execution target: ${detail}`
        : "`opencode models` failed on the remote execution target.",
    );
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    throw new Error(
      "OpenCode returned no models on the remote execution target. Run `opencode models` there and verify provider auth.",
    );
  }

  if (models.some((entry) => entry.id === model)) {
    return model;
  }

  if (fallbackModel && models.some((entry) => entry.id === fallbackModel)) {
    if (input.onLog) {
      await input.onLog(
        "stdout",
        `[paperclip] Primary model "${model}" is unavailable on remote execution target. Falling back to "${fallbackModel}".\n`
      );
    }
    return fallbackModel;
  }

  const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
  throw new Error(
    `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
  );
}

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const skillsHome = claudeSkillsHome();
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
  const desiredNames = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const fallbackModel = asString(config.fallbackModel, "").trim();
  const variant = asString(config.variant, "").trim();
  let resolvedModel = model;

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
  const desiredOpenCodeSkillNames = resolvePaperclipDesiredSkillNames(config, openCodeSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureOpenCodeSkillsInjected(
      onLog,
      openCodeSkillEntries,
      desiredOpenCodeSkillNames,
    );
  }

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
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  let heartbeatInterval: NodeJS.Timeout | undefined;
  let silenceInterval: NodeJS.Timeout | undefined;
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

    let lastOutputTime = Date.now();
    let wasTerminatedDueToSilence = false;

    const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      lastOutputTime = Date.now();
      await onLog(stream, chunk);
    };

    let spawnMeta: { pid: number; processGroupId: number | null } | null = null;
    const wrappedOnSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
      spawnMeta = meta;
      if (onSpawn) {
        await onSpawn(meta);
      }
    };

    heartbeatInterval = setInterval(() => {
      onLog("stdout", `[paperclip] opencode_local heartbeat\n`).catch(() => {});
    }, 60_000);

    silenceInterval = setInterval(() => {
      const silenceDurationMs = Date.now() - lastOutputTime;
      if (silenceDurationMs > 5 * 60_000) {
        wasTerminatedDueToSilence = true;
        onLog("stderr", `[paperclip] OpenCode process has been silent for ${Math.round(silenceDurationMs / 1000)}s. Terminating process.\n`).catch(() => {});
        if (spawnMeta) {
          const { pid, processGroupId } = spawnMeta;
          const running = runningProcesses.get(runId);
          if (running) {
            const { child, processGroupId: pgid } = running;
            if (!child.killed) {
              if (process.platform !== "win32" && pgid) {
                try {
                  process.kill(-pgid, "SIGKILL");
                } catch {
                  try { child.kill("SIGKILL"); } catch {}
                }
              } else {
                try { child.kill("SIGKILL"); } catch {}
              }
            }
          } else if (pid) {
            if (process.platform !== "win32" && processGroupId) {
              try {
                process.kill(-processGroupId, "SIGKILL");
              } catch {
                try { process.kill(pid, "SIGKILL"); } catch {}
              }
            } else {
              try { process.kill(pid, "SIGKILL"); } catch {}
            }
          }
        }
      }
    }, 10_000);

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
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
      resolvedModel = await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        fallbackModel,
        command,
        cwd,
        env: runtimeEnv,
        onLog,
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
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime.restoreWorkspace();
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
      const remoteHomeDir = managedHome && preparedExecutionTargetRuntime.runtimeRootDir
        ? preparedExecutionTargetRuntime.runtimeRootDir
        : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog: wrappedOnLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".claude", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog: wrappedOnLog },
        );
      }
      resolvedModel = await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        fallbackModel,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog: wrappedOnLog,
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
    const renderedBootstrapPrompt =
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
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

    // Optional diagnostic: surface OpenCode's own logs on stderr (captured into the
    // run result) so failures that OpenCode otherwise wraps as an opaque
    // "Unexpected server error" can be diagnosed in remote/sandbox runs where the
    // log file is unreachable. Toggle via PAPERCLIP_OPENCODE_PRINT_LOGS (run env,
    // then process env).
    const printLogs = isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["run", "--format", "json"];
      if (printLogs) args.push("--print-logs");
      if (resumeSessionId) args.push("--session", resumeSessionId);
      if (resolvedModel) args.push("--model", resolvedModel);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
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
          promptMetrics,
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env: preparedRuntimeConfig.env,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn: wrappedOnSpawn,
        onLog: wrappedOnLog,
      });
      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parseOpenCodeJsonl(proc.stdout),
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
      },
      clearSessionOnMissingSession = false,
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

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
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

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const synthesizedExitCode = (parsedError || wasTerminatedDueToSilence) && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage = wasTerminatedDueToSilence
        ? "OpenCode process was terminated due to silence"
        : (parsedError ||
           stderrLine ||
           `OpenCode exited with code ${synthesizedExitCode ?? -1}`);
      const modelId = resolvedModel || null;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        errorCode: wasTerminatedDueToSilence ? "process_lost" : null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    try {
      let currentSessionId = sessionId;
      let initial = await runAttempt(currentSessionId);
      let initialFailed =
        initial.proc.timedOut ||
        (initial.proc.exitCode ?? 0) !== 0 ||
        Boolean(initial.parsed.errorMessage);

      if (
        currentSessionId &&
        initialFailed &&
        !initial.proc.timedOut &&
        isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${currentSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        currentSessionId = null;
        initial = await runAttempt(null);
        initialFailed =
          initial.proc.timedOut ||
          (initial.proc.exitCode ?? 0) !== 0 ||
          Boolean(initial.parsed.errorMessage);
      }

      if (
        initialFailed &&
        fallbackModel &&
        resolvedModel !== fallbackModel
      ) {
        const isTimeout = initial.proc.timedOut;
        const isConnectionOrHang =
          !isTimeout &&
          isOpenCodeConnectionErrorOrHang(
            initial.proc.stdout,
            initial.rawStderr,
            initial.parsed.errorMessage,
          );

        if (isTimeout || isConnectionOrHang) {
          const reason = isTimeout ? "timeout" : "connection error/hang";
          await onLog(
            "stdout",
            `[paperclip] Run failed due to ${reason} on model "${resolvedModel}". Retrying with fallback model "${fallbackModel}".\n`,
          );
          resolvedModel = fallbackModel;
          const fallbackAttempt = await runAttempt(currentSessionId);
          const fallbackFailed =
            fallbackAttempt.proc.timedOut ||
            (fallbackAttempt.proc.exitCode ?? 0) !== 0 ||
            Boolean(fallbackAttempt.parsed.errorMessage);
          if (
            currentSessionId &&
            fallbackFailed &&
            !fallbackAttempt.proc.timedOut &&
            isOpenCodeUnknownSessionError(fallbackAttempt.proc.stdout, fallbackAttempt.rawStderr)
          ) {
            await onLog(
              "stdout",
              `[paperclip] OpenCode session "${currentSessionId}" is unavailable; retrying with a fresh session on fallback model "${fallbackModel}".\n`,
            );
            const retryFallback = await runAttempt(null);
            return toResult(retryFallback, true);
          }
          return toResult(fallbackAttempt, currentSessionId === null);
        }
      }

      return toResult(initial, currentSessionId === null);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (silenceInterval) clearInterval(silenceInterval);
    await preparedRuntimeConfig.cleanup();
  }
}
