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
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
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
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { isPiUnknownSessionError, parsePiJsonl, createPiJsonlParser } from "./parse.js";
import { createPiStdoutCompactor, resolvePiStdoutLogMode } from "./stdout-compaction.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import { preparePiRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
const PI_AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

// Tool-surface policy for headless pi runs. The decisive defect behind the
// EYW-746/747/750 board-blocks was a *closed* --tools allowlist. In the
// fabric/codemode regime pi runs against (the host ~/.pi/agent dir; the control
// plane sets no PAPERCLIP_PI_PROVIDERS / PI_CODING_AGENT_DIR, so no managed dir
// is written), the model's registered DIRECT tool universe is the fabric
// gateway `fabric_exec` -- which carries the paperclip MCP + ctx_* families
// through codemode -- plus `powershell`, NOT the native builtins. A closed
// allowlist of native-builtin names (read,bash,edit,write,grep,find,ls)
// therefore intersects to NOTHING: the model is handed a zero-tool surface,
// improvises `ctx_batch_execute` / `paperclip_issue_list` calls as literal
// prose (the real camelCase paperclip tool names are only visible inside the
// fabric system prompt the model never got), and the run parks with no recorded
// disposition.
//
// Fix: only constrain the surface when the agent explicitly configures it.
// An unset `tools` config -> omit --tools entirely -> pi's permissive default
// surfaces the full registered set for that regime (fabric_exec here, native
// builtins elsewhere). An agent's own `tools` config is honored as-is (a
// closed allowlist is a deliberate restriction) but gets a fail-fast preflight
// warning when it would strip the fabric/ctx gateway the prompt references.

// Fail-fast preflight for the closed-allowlist defect. It fires only when the
// agent explicitly set a `tools` config (the sole case in which we pass
// --tools at all) AND that closed allowlist strips the fabric/ctx gateway that
// the rendered prompt actually references. In this regime the model can reach
// the paperclip MCP + ctx_* families ONLY through the fabric_exec gateway tool;
// with it stripped, those calls degrade to literal prose and the run parks
// with no recorded disposition. Surface it at launch so the failure is a
// logged, diagnosable notice instead of a silent multi-minute dead loop.
// Non-fatal by design: it warns. The default path (no `tools` config) omits
// --tools entirely and is immune, so this only fires for an agent that set a
// restrictive allowlist.
const PI_FABRIC_GATEWAY = "fabric_exec";

// Kernel argv limit guard. Linux caps each argv element at MAX_ARG_STR
// (128 KiB) and the total at ARG_MAX. The CMO/fabric regime renders a
// multi-hundred-KB paperclip context snapshot into the prompt and carries a
// large execution-continuation message payload; passing either as a single
// argv element trips `spawn E2BIG` and kills the run before the model starts.
// Below this threshold we keep the value inline (byte-for-byte the old
// behaviour); above it we materialize the system prompt to a temp file
// (pi's --append-system-prompt reads files from disk) and feed the user
// prompt through the child's stdin (pi -p reads piped stdin raw, identical
// to a positional message but argv-free). Both keep argv tiny and are no-ops
// when the payloads are small.
const ARGV_SAFE_BYTES = 96 * 1024;
function allowlistCoversGateway(allowlist: string): boolean {
  const tokens = allowlist.split(",").map((token) => token.trim()).filter(Boolean);
  return tokens.some(
    (token) =>
      token === "*" ||
      token === PI_FABRIC_GATEWAY ||
      token.startsWith("fabric_") ||
      token.startsWith("ctx_") ||
      token.startsWith("paperclip"),
  );
}
function promptReferencesGatewayTooling(renderedPrompt: string): boolean {
  return (
    renderedPrompt.includes("ctx_") ||
    renderedPrompt.includes(PI_FABRIC_GATEWAY) ||
    renderedPrompt.includes("paperclipListIssues") ||
    renderedPrompt.includes("paperclip_")
  );
}
function preflightToolRegistryWarning(renderedPrompt: string, allowlist: string): string | null {
  if (!promptReferencesGatewayTooling(renderedPrompt)) return null;
  if (allowlistCoversGateway(allowlist)) return null;
  return (
    `[paperclip] tool-registry preflight: the prompt references the paperclip/ctx gateway tools, ` +
    `but the agent's explicit --tools allowlist "${allowlist}" strips the fabric/ctx gateway ` +
    `(${PI_FABRIC_GATEWAY}). The model will emit those tool calls as text and the run may fail to ` +
    `record a disposition. Add "${PI_FABRIC_GATEWAY}" (or "*") to the allowlist, or omit the tools ` +
    `config so pi surfaces its full default tool set.`
  );
}

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

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

async function ensurePiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildPiSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-"));
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

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

function buildRemoteSessionPath(runtimeRootDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.posix.join(runtimeRootDir, "sessions", `${safeTimestamp}-${agentId}.jsonl`);
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
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
  const hasCustomPromptTemplate = asString(config.promptTemplate, "").trim().length > 0;
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const stdoutLogMode = resolvePiStdoutLogMode(config);

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

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

  if (!executionTargetIsRemote) {
    await ensureSessionsDir();
  }

  const piSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, piSkillEntries);
  if (!executionTargetIsRemote) {
    await ensurePiSkillsInjected(onLog, piSkillEntries, desiredPiSkillNames);
  }

  // Build environment
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
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Materialize custom Pi providers (PAPERCLIP_PI_PROVIDERS) into a managed
  // PI_CODING_AGENT_DIR before runtimeEnv is computed, so both local validation
  // and the spawned Pi process resolve models against the managed models.json.
  const preparedRuntimeConfig = await preparePiRuntimeConfig({ env });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  try {
    // Prepend installed skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Without this,
    // any pi_local agent whose AGENTS.md calls a skill command via bash hits
    // exit 127 "command not found". Only include skills that ensurePiSkillsInjected
    // actually linked — otherwise non-injected skills' binaries would be reachable
    // to the agent.
    const injectedSkillKeys = new Set(desiredPiSkillNames);
    const skillBinDirs = piSkillEntries
      .filter((entry) => injectedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const mergedEnv = ensurePathInEnv({ ...process.env, ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
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
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote) {
      await ensurePiModelConfiguredAndAvailable({
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
    let remoteRuntimeRootDir: string | null = null;
    let localSkillsDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let systemPromptTempDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTargetIsRemote) {
      try {
        localSkillsDir = await buildPiSkillsDir(config);
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Pi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "pi",
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
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
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
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
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
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "pi",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
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
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;
    const sessionPath = canResumeSession
      ? runtimeSessionId
      : executionTargetIsRemote && remoteRuntimeRootDir
        ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
        : buildSessionPath(agent.id, new Date().toISOString());

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` Pi stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] Pi session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    if (!canResumeSession) {
      if (executionTargetIsRemote) {
        await ensureAdapterExecutionTargetFile(runId, runtimeExecutionTarget, sessionPath, {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog,
        });
      } else {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      }
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
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
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const systemOwnsDefaultPolicy = !hasCustomPromptTemplate || Boolean(resolvedInstructionsFilePath && !instructionsReadFailed);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (stdoutLogMode !== "raw") {
        notes.push(`Pi stdout run-log compaction mode: ${stdoutLogMode}`);
      }
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    // --- argv limit guard (spawn E2BIG) ----------------------------------
    // The CMO/fabric regime renders a multi-hundred-KB paperclip context
    // snapshot into the system prompt and carries a large execution-continuation
    // payload in the user prompt. A single argv element over MAX_ARG_STR
    // (128 KiB on Linux) makes child_process.spawn fail with E2BIG before the
    // model ever starts. For local targets we move each oversized payload off
    // argv: the system prompt to a temp file that pi's --append-system-prompt
    // reads from disk, and the user prompt through the child's stdin (pi -p
    // reads piped stdin raw, byte-identical to a positional message). Both are
    // no-ops when the payloads stay under ARGV_SAFE_BYTES and are skipped for
    // remote targets (a host temp path is invisible to a remote pi process).
    let systemPromptArgCache: string | null = null;
    const resolveSystemPromptArg = async (): Promise<string> => {
      if (systemPromptArgCache !== null) return systemPromptArgCache;
      if (!executionTargetIsRemote && renderedSystemPromptExtension.length > ARGV_SAFE_BYTES) {
        const dir =
          systemPromptTempDir ??
          (systemPromptTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-prompt-")));
        const file = path.join(dir, "append-system-prompt.txt");
        await fs.writeFile(file, renderedSystemPromptExtension, "utf8");
        systemPromptArgCache = file;
        await onLog(
          "stdout",
          `[paperclip] System prompt is ${renderedSystemPromptExtension.length} chars (> ${ARGV_SAFE_BYTES} bytes); passing via file ${file} to avoid spawn E2BIG.\n`,
        );
      } else {
        systemPromptArgCache = renderedSystemPromptExtension;
      }
      return systemPromptArgCache;
    };

    const buildArgs = async (
      sessionFile: string,
      userPrompt: string,
    ): Promise<{ args: string[]; stdinPrompt: string | undefined }> => {
      const args: string[] = [];

      // Use JSON mode for structured output with print mode (non-interactive)
      args.push("--mode", "json");
      args.push("-p"); // Non-interactive mode: process prompt and exit

      // Use --append-system-prompt to extend Pi's default system prompt. When
      // the rendered prompt is oversized (local target) this is a temp-file
      // path that pi reads from disk instead of an inline argv element.
      args.push("--append-system-prompt", await resolveSystemPromptArg());

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      // Tool-surface policy: only constrain when the agent explicitly sets a
      // `tools` config. In the fabric/codemode regime a closed allowlist of
      // native-builtin names intersects to nothing and leaves the model a
      // zero-tool surface (the EYW-746/747/750 defect). An unset `tools` config
      // omits --tools entirely, so pi surfaces its full default tool set for
      // that regime (fabric_exec gateway + powershell here; native builtins
      // elsewhere). An explicit `tools` config is honored as a deliberate
      // restriction but is preflight-checked against the prompt.
      const explicitTools = asString(config.tools, "").trim();
      if (explicitTools.length > 0) {
        args.push("--tools", explicitTools);
        const preflightWarning = preflightToolRegistryWarning(
          renderedSystemPromptExtension + "\n" + userPrompt,
          explicitTools,
        );
        if (preflightWarning) {
          commandNotes.push(preflightWarning);
        }
      }

      args.push("--session", sessionFile);
      args.push("--skill", remoteSkillsDir ?? PI_AGENT_SKILLS_DIR);

      if (extraArgs.length > 0) args.push(...extraArgs);

      // Deliver the user prompt. Normally the last positional argv element. For
      // an oversized payload on a local target, omit it from argv and hand it to
      // the child through stdin (pi -p reads piped stdin raw) so a single argv
      // element never exceeds the kernel MAX_ARG_STR cap.
      const useStdinPrompt = !executionTargetIsRemote && userPrompt.length > ARGV_SAFE_BYTES;
      let stdinPrompt: string | undefined = undefined;
      if (useStdinPrompt) {
        stdinPrompt = userPrompt;
        await onLog(
          "stdout",
          `[paperclip] User prompt is ${userPrompt.length} chars (> ${ARGV_SAFE_BYTES} bytes); passing via stdin to avoid spawn E2BIG.\n`,
        );
      } else {
        args.push(userPrompt);
      }

      return { args, stdinPrompt };
    };

    const runAttempt = async (sessionFile: string) => {
      const attemptResumedSession = canResumeSession && sessionFile === sessionPath;
      await hydrateFreshSessionHandoff(ctx, { resumedSession: attemptResumedSession });
      const attemptSections = selectPaperclipPromptSections(context, {
        resumedSession: attemptResumedSession,
        includeCommunicationGuidance: false,
        includeExecutionContract: systemOwnsDefaultPolicy ? false : undefined,
      });
      const attemptBootstrapPrompt = !attemptResumedSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
      const attemptWakePrompt = attemptSections.wakePrompt;
      const attemptRenderedHeartbeatPrompt = attemptResumedSession && attemptWakePrompt.length > 0
        || isPaperclipRecoveryWakePayload(context.paperclipWake)
        || !hasCustomPromptTemplate
        ? ""
        : renderTemplate(promptTemplate, templateData);
      const attemptBaseUserPrompt = joinPromptSections([
        attemptBootstrapPrompt,
        attemptWakePrompt,
        attemptSections.taskContextNote,
        sessionHandoffNote,
        attemptRenderedHeartbeatPrompt,
      ]);
      const userPrompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: attemptResumedSession }),
        attemptBaseUserPrompt,
      ]);
      const promptMetrics = {
        systemPromptChars: renderedSystemPromptExtension.length,
        promptChars: userPrompt.length,
        bootstrapPromptChars: attemptBootstrapPrompt.length,
        wakePromptChars: attemptWakePrompt.length,
        taskContextChars: attemptSections.taskContextNote.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: attemptRenderedHeartbeatPrompt.length,
      };
      const { args: attemptArgs, stdinPrompt: attemptStdinPrompt } = await buildArgs(sessionFile, userPrompt);
      if (onMeta) {
        await onMeta({
          adapterType: "pi_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: attemptArgs,
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics: { ...promptMetrics, promptChars: userPrompt.length },
          context,
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      const compactStdoutLine = createPiStdoutCompactor(stdoutLogMode);
      // Compaction only affects the persisted run log; parsePiJsonl reads the unfiltered proc.stdout.
      const emitCompacted = async (line: string, suffix: string) => {
        const compacted = compactStdoutLine(line);
        if (compacted !== null) {
          await onLog("stdout", compacted + suffix);
        }
      };
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Pass stderr through immediately (not JSONL)
          await onLog(stream, chunk);
          return;
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line) {
            await emitCompacted(line, "\n");
          }
        }
      };

      const consumeAccounting = createPiJsonlParser();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(bufferedOnLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        return { usage: parsed.usage, costUsd: parsed.usage.costUsd, usageBasis: "per_run", provider, biller: resolvePiBiller(runtimeEnv, provider), billingType: "unknown", model, complete: parsed.sawAgentEnd };
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, attemptArgs, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: accountingLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
        // Oversized user prompt (local target) is handed to the child via stdin
        // instead of as a last argv element to stay under the kernel MAX_ARG_STR
        // cap. null keeps the legacy inline-argv path untouched.
        stdin: attemptStdinPrompt,
      });
      await accountingLog.flush();

      // Flush any remaining buffer content
      if (stdoutBuffer) {
        await emitCompacted(stdoutBuffer, "");
      }

      // Display output is capped by the process transport. Keep accounting
      // from the full stream, including when no checkpoint callback is installed.
      const parsed = parsePiJsonl(proc.stdout);
      if (hasAccounting) {
        const retained = consumeAccounting("");
        parsed.usage = retained.usage;
        parsed.sawAgentEnd = retained.sawAgentEnd;
      }
      return { proc, rawStderr: proc.stderr, parsed };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parsePiJsonl>;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: attempt.parsed.sawAgentEnd,
        usage: attempt.parsed.usage, usageBasis: "per_run", provider, biller: resolvePiBiller(runtimeEnv, provider), model, billingType: "unknown", costUsd: attempt.parsed.usage.costUsd,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
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
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: attempt.parsed.sawAgentEnd,
      usageBasis: "per_run",
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolvePiBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const newSessionPath = executionTargetIsRemote && remoteRuntimeRootDir
          ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
          : buildSessionPath(agent.id, new Date().toISOString());
        if (executionTargetIsRemote) {
          await ensureAdapterExecutionTargetFile(runId, executionTarget, newSessionPath, {
            cwd,
            env,
            timeoutSec: 15,
            graceSec: 5,
            onLog,
          });
        } else {
          try {
            await fs.writeFile(newSessionPath, "", { flag: "wx" });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
              throw err;
            }
          }
        }
        const retry = await runAttempt(newSessionPath);
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
