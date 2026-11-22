/**
 * TECH-8174: Hermes execution inside a sandbox environment (for example the Kubernetes sandbox
 * provider). Separate from the host path in execute.ts so local and hosted runs stay unchanged.
 *
 * The run is built on the host and shipped to the sandbox:
 *  - HERMES_HOME (config.yaml, .env, skills) is prepared on the host in a throwaway directory,
 *    fully isolated from the host's ~/.hermes, and shipped as the `hermesHome` runtime asset.
 *  - The instructions bundle directory is shipped as the `instructions` asset.
 *  - The prompt is written to a file inside the sandbox over exec stdin; it never travels in argv
 *    (argv becomes the Kubernetes exec URI, which the kube-apiserver audit log records).
 *  - Env (provider keys, system prompt) travels with the exec request; the Kubernetes provider
 *    delivers it over stdin (fork #415). The run JWT never enters the sandbox: Paperclip API access
 *    goes through the callback bridge, whose env replaces PAPERCLIP_API_URL / PAPERCLIP_API_KEY.
 *
 * Scope (see docs/hermes-sandbox-execution.md): explicit providers including Ramp Router (stage 2,
 * verified by an in-sandbox registry probe), runtime MCP servers through bridge relay routes
 * (host-held credentials), sandbox targets only (never SSH). Native mem0 memory
 * (`adapterConfig.memoryProvider`) works through a server relay on the callback bridge (TECH-8908):
 * the pod holds no memory token and no route to the memory service.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  SandboxCallbackBridgeRoutePolicy,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { createRunHome, type RunHome } from "@paperclipai/adapter-utils/run-home";
import {
  AGENT_IDENTITY_ENV_KEYS,
  buildPaperclipAgentPromptTemplate,
  buildPaperclipEnv,
  joinPromptSections,
  resolveEffectiveMemoryHardeningFlags,
  type MemoryHardeningFlags,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

import { DEFAULT_GRACE_SEC, DEFAULT_TIMEOUT_SEC } from "../shared/constants.js";
import {
  CANONICAL_HERMES_BIN,
  TRUSTED_HERMES_LAUNCHERS,
  getHermesCommandScanMode,
} from "./command-scan-policy.js";
import { resolveEffectiveRunConfig } from "./detect-model.js";
import {
  HERMES_FORBIDDEN_ENV_VARS,
  HERMES_MAX_SYSTEM_PROMPT_BYTES,
  augmentStaleImageError,
  buildPrompt,
  cfgBoolean,
  cfgNumber,
  cfgString,
  cfgStringArray,
  isBenignStderrLog,
  parseHermesOutput,
  renderHermesSystemPrompt,
  resolveHermesCommand,
  resolveMemoryGuidance,
} from "./execute.js";
import {
  HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE,
  hasExplicitHermesProviderCredential,
  isHermesProviderCredentialName,
} from "./isolation.js";
import { cleanupHermesMcpHome, hermesMcpRelayPath, prepareHermesMcpHome } from "./mcp-config.js";

import {
  MAX_CONFIG_STRING_LENGTH,
  canSafelyRedactSecret,
  createChunkAwareStreamingRedactor,
  redactSensitiveString,
  resolveHermesMemoryProvider,
} from "./memory-config.js";
import { normalizeConfiguredModel } from "./model-arg.js";
import {
  RAMP_ROUTER_API_KEY_ENV,
  ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE,
  ROUTER_KEY_MISSING_MESSAGE,
  ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES,
  readRouterApiKey,
  routerEnvNamesToStrip,
} from "./router-readiness.js";
import { probeHermesRouterSupportInTarget } from "./router-readiness-remote.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";

export const HERMES_SANDBOX_ADAPTER_KEY = "hermes";

/**
 * Sandbox providers whose exec channel keeps env values out of the exec command (the Kubernetes
 * provider delivers env over stdin, fork #415). Hermes carries its system prompt and provider key in
 * env, so other providers are refused until they make the same guarantee. Keep in sync with
 * SANDBOX_ONLY_ADAPTER_PROVIDERS in packages/shared/src/environment-support.ts (the capability the UI
 * offers); this adapter does not depend on that package, and this run-time check is authoritative.
 */
export const HERMES_SANDBOX_PROVIDERS: readonly string[] = ["kubernetes"];


// A relay gives up only after the server's own tool timeout, so the tool's clean timeout error wins the race.
const HERMES_MCP_RELAY_DEFAULT_TOOL_TIMEOUT_MS = 25_000;
const HERMES_MCP_RELAY_DEADLINE_MARGIN_MS = 5_000;
export const HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE =
  "Refusing to start: Hermes runs in sandbox environments only, not over SSH. Select a sandbox or the local environment for this agent.";
export const HERMES_SANDBOX_RUNTIME_MEMORY_UNSUPPORTED_MESSAGE =
  "Refusing to start: Paperclip runtime memory (per-company database) is not supported for Hermes in sandbox environments. Move the agent to the external memory service or select the local environment.";
export const HERMES_SANDBOX_MEMORY_BRIDGE_REQUIRED_MESSAGE =
  "Refusing to start: adapterConfig.memoryProvider in a sandbox environment needs the Paperclip callback bridge, which did not start for this run. Remove memoryProvider or select the local environment.";
/**
 * Bridge policy for the memory relay routes: their own concurrency lane and a 35 s in-pod deadline (Hermes's mem0
 * client waits 30 s; the host abort lands at 33 s and the server relay gives up at 32 s). File bridge only: the
 * duplex transport ignores route policies.
 */
export const HERMES_SANDBOX_MEMORY_ROUTE_POLICIES: readonly SandboxCallbackBridgeRoutePolicy[] = [
  {
    path: /^\/api\/agent-memory-relay\/(?:search|memories(?:\/[0-9a-f-]{36})?)$/i,
    deadlineMs: 35_000,
    maxConcurrent: 4,
  },
];

/** Path of the server's mem0 relay under the bridge origin (server/src/routes/agent-memory-relay.ts). */
export const HERMES_SANDBOX_MEMORY_RELAY_PATH = "/api/agent-memory-relay";
export const HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE =
  "Refusing to start: PAPERCLIP_HERMES_COMMAND_SCAN=required is not yet supported for Hermes in sandbox environments.";
export const HERMES_SANDBOX_ROUTER_KEY_UNREDACTABLE_MESSAGE =
  "Cannot safely redact the Ramp Router API key; refusing to start";
export const HERMES_SANDBOX_MANAGED_CONNECTION_UNSUPPORTED_MESSAGE =
  "Refusing to start: managed AI connections are not yet supported for Hermes in sandbox environments. Select the local environment for this agent.";
export const HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE =
  `Refusing to start: Hermes runs only in sandbox providers that keep env values out of the exec command (${HERMES_SANDBOX_PROVIDERS.join(", ")}).`;
export const HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE =
  `Refusing to start: in a sandbox environment Hermes runs only from the image (${CANONICAL_HERMES_BIN}); a custom hermesCommand/command is not supported.`;

/** Directories under the remote run home, mirroring adapter-utils createRunHome. */
const REMOTE_RUN_HOME_SUBDIRS = ["config", "data", "cache", "state", "tmp", "runtime"] as const;

/** Placeholder at least as long as any in-sandbox bridge origin, for the pre-staging size check. */
const BRIDGE_URL_SIZE_PLACEHOLDER = "http://127.0.0.1:65535";


/**
 * The instructions asset. A Paperclip-managed bundle directory holds only the bundle and is shipped
 * whole; any other instructions file is shipped ALONE (its directory may be a repository or a home
 * directory). Symlinks are never followed.
 */
async function prepareInstructionsAsset(
  config: Record<string, unknown>,
  instructionsFilePath: string,
  instructionsContent: string,
  scratchDir: string,
): Promise<{ localDir: string; relativeFile: string }> {
  const filePath = path.resolve(instructionsFilePath);
  const managedRoot = config.instructionsBundleMode === "managed" ? cfgString(config.instructionsRootPath) : undefined;
  if (managedRoot) {
    const root = path.resolve(managedRoot);
    const relative = path.relative(root, filePath);
    const insideRoot = relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (insideRoot) return { localDir: root, relativeFile: relative.split(path.sep).join("/") };
  }
  // Ship exactly the content already loaded into the prompt, as a fresh regular file: nothing next
  // to it, and no symlink is followed or recreated.
  const dir = path.join(scratchDir, "instructions");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = path.basename(filePath) || "instructions.md";
  await fs.writeFile(path.join(dir, name), instructionsContent, { mode: 0o600, flag: "wx" });
  return { localDir: dir, relativeFile: name };
}

export const HERMES_SANDBOX_PROMPT_STAGING_FAILED_MESSAGE = "Could not stage the Hermes prompt in the sandbox.";
/** Exit status of the launch exec when the staging step (not Hermes) failed; confirmed by the nonce line. */
export const HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE = 121;

/**
 * TECH-8174: one exec that stages the prompt file and the run home, then execs the Hermes launch.
 * Before, the staging was its own exec. The script and argv carry only fixed text and paths: the
 * prompt arrives on stdin (after the provider's env line), the staging step reads it to EOF in a
 * subshell (so its `umask 077` does not reach Hermes), and Hermes then starts with stdin at EOF,
 * as before. A staging failure writes one line with a per-run nonce and exits with
 * HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE without starting Hermes; `stagingFailed` needs both, so a
 * Hermes exit with the same code is never mistaken for a staging failure.
 */
export function buildHermesSandboxPromptStagingLaunch(input: {
  queryPath: string;
  homeRoot: string;
  command: string;
  args: string[];
}): {
  command: string;
  args: string[];
  stagingFailed: (result: { exitCode: number | null; timedOut: boolean; stderr?: string | null }) => boolean;
} {
  const marker = `[hermes] ${HERMES_SANDBOX_PROMPT_STAGING_FAILED_MESSAGE} (stage ${randomBytes(8).toString("hex")})`;
  const script = [
    '( umask 077 && mkdir -p "$2"' + REMOTE_RUN_HOME_SUBDIRS.map((dir) => ` "$2/${dir}"`).join("") + ' && cat > "$1" ) ||',
    `  { printf '%s\\n' ${shellQuote(marker)} >&2; exit ${HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE}; }`,
    "shift 2",
    'exec "$@"',
  ].join("\n");
  return {
    command: "sh",
    args: ["-c", script, "paperclip-hermes-launch", input.queryPath, input.homeRoot, input.command, ...input.args],
    stagingFailed: (result) =>
      !result.timedOut &&
      result.exitCode === HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE &&
      (result.stderr ?? "").includes(marker),
  };
}

/** The sandbox-side env for a run home rooted at `homeRoot` (POSIX), like createRunHome's env. */
export function buildRemoteRunHomeEnv(homeRoot: string): Record<string, string> {
  const sub = (name: string) => path.posix.join(homeRoot, name);
  return {
    HOME: homeRoot,
    XDG_CONFIG_HOME: sub("config"),
    XDG_DATA_HOME: sub("data"),
    XDG_CACHE_HOME: sub("cache"),
    XDG_STATE_HOME: sub("state"),
    XDG_RUNTIME_DIR: sub("runtime"),
    XDG_CONFIG_DIRS: sub("config"),
    XDG_DATA_DIRS: sub("data"),
    TMPDIR: sub("tmp"),
  };
}

/**
 * The scratch-dir env a Local run gets from the heartbeat (a host temp dir), pointed at the run home's
 * sandbox-side `tmp` instead. Routines such as kb-ingest write intermediate files to
 * `$PAPERCLIP_SCRATCH_DIR`; the heartbeat only sets it for Local targets, and any host value a config
 * carried would be meaningless in the pod. The run home is removed after the run, like the Local scratch.
 */
export function buildRemoteRunScratchEnv(homeRoot: string): Record<string, string> {
  const dir = path.posix.join(homeRoot, "tmp");
  return {
    PAPERCLIP_RUN_SCRATCH_DIR: dir,
    PAPERCLIP_TASK_SCRATCH_DIR: dir,
    PAPERCLIP_SCRATCH_DIR: dir,
    PAPERCLIP_TMPDIR: dir,
  };
}

/**
 * Entry point from execute(): any remote target lands here. Only sandbox targets run; an SSH
 * target is refused before anything is created or launched.
 */
export async function executeHermesOnRemoteTarget(
  ctx: AdapterExecutionContext,
  target: AdapterExecutionTarget,
): Promise<AdapterExecutionResult> {
  if (target.kind !== "remote" || target.transport !== "sandbox") {
    return refuse(ctx, HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE);
  }
  if (!HERMES_SANDBOX_PROVIDERS.includes(target.providerKey ?? "")) {
    return refuse(ctx, HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE);
  }
  return executeHermesInSandbox(ctx, target);
}

async function refuse(ctx: AdapterExecutionContext, message: string): Promise<never> {
  await ctx.onLog("stderr", `[hermes] ${message}\n`);
  throw new Error(message);
}

async function executeHermesInSandbox(
  ctx: AdapterExecutionContext,
  target: AdapterExecutionTarget & { kind: "remote"; transport: "sandbox" },
): Promise<AdapterExecutionResult> {
  // Validate the command scan mode first, exactly as the host path does.
  if (getHermesCommandScanMode() === "required") {
    await refuse(ctx, HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE);
  }

  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const userEnvRaw = config.env;
  const userEnv: Record<string, string> = {};
  if (userEnvRaw && typeof userEnvRaw === "object" && !Array.isArray(userEnvRaw)) {
    for (const [key, value] of Object.entries(userEnvRaw as Record<string, unknown>)) {
      if (typeof value === "string") userEnv[key] = value;
    }
  }

  let hardeningFlags: MemoryHardeningFlags;
  try {
    hardeningFlags = resolveEffectiveMemoryHardeningFlags(process.env, userEnv);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[hermes] Invalid PAPERCLIP_MEMORY_HARDENING configuration: ${reason}\n`);
    throw err;
  }

  // ── Gates ───────────────────────────────────────────────────────────────
  if (ctx.runtimeMemory) await refuse(ctx, HERMES_SANDBOX_RUNTIME_MEMORY_UNSUPPORTED_MESSAGE);
  let memoryProvider: ReturnType<typeof resolveHermesMemoryProvider>;
  try {
    memoryProvider = resolveHermesMemoryProvider(config);
  } catch (err) {
    await ctx.onLog("stderr", `[hermes] ${err instanceof Error ? err.message : "Invalid adapterConfig.memoryProvider"}\n`);
    throw err;
  }

  if (config.managedAiRouting || config.managedAiConnection) {
    await refuse(ctx, HERMES_SANDBOX_MANAGED_CONNECTION_UNSUPPORTED_MESSAGE);
  }

  const configuredCommand = resolveHermesCommand(config).trim();
  if (!TRUSTED_HERMES_LAUNCHERS.has(configuredCommand)) {
    await refuse(ctx, HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE);
  }
  const command = CANONICAL_HERMES_BIN;

  // ── Provider and model: explicit config only (the host Hermes config is never read) ─
  const configuredModel = normalizeConfiguredModel(cfgString(config.model));
  const effective = resolveEffectiveRunConfig({
    explicitProvider: cfgString(config.provider),
    configuredModel,
    detected: null,
  });
  if (!effective.ok) return await refuse(ctx, effective.message);
  const isRouterRun = effective.isRouter;
  const resolvedProvider = effective.provider;
  const model = effective.effectiveModel;

  // Sandbox runs are always isolated from the host: they need their own explicit credential.
  if (!hasExplicitHermesProviderCredential(userEnv)) {
    await refuse(ctx, HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE);
  }

  let anthropicRequestTimeoutSec: number | undefined;
  if (resolvedProvider === "anthropic" || resolvedProvider === "auto") {
    const value = config.requestTimeoutSec ?? 300;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error("Hermes requestTimeoutSec must be a positive finite number");
    }
    anthropicRequestTimeoutSec = value;
  }

  // Runtime MCP servers are Paperclip URLs. Hermes reaches them through bridge relay routes; the host adds
  // each server's credential, so no MCP token (and not the run JWT) enters the pod.
  const allRuntimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  const mcpRelayAvailable = adapterExecutionTargetUsesPaperclipBridge(target);
  const runtimeMcpServers = mcpRelayAvailable ? allRuntimeMcpServers : [];
  if (!mcpRelayAvailable && allRuntimeMcpServers.length > 0) {
    await ctx.onLog(
      "stdout",
      `[hermes] Warning: ${allRuntimeMcpServers.length} runtime MCP server(s) need the Paperclip bridge, which this target does not use; this run continues without them.\n`,
    );
  }

  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  // TECH-7895 Router gates, as on the host: no extraArgs, and only the agent's own canonical
  // RAMP_ROUTER_API_KEY binding (never a host .env, never the plugin's shared envKeys Secret).
  // The key reaches the sandbox only in the exec env, which the Kubernetes provider delivers over
  // stdin (never argv, never a file).
  if (isRouterRun) {
    if (extraArgs && extraArgs.length > 0) await refuse(ctx, ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE);
    if (!readRouterApiKey(userEnv)) await refuse(ctx, ROUTER_KEY_MISSING_MESSAGE);
    const routerKey = userEnv[RAMP_ROUTER_API_KEY_ENV]!;
    const redactable = (value: string) => value.length <= MAX_CONFIG_STRING_LENGTH && canSafelyRedactSecret(value);
    if (!redactable(routerKey) || !redactable(routerKey.trim())) {
      await refuse(ctx, HERMES_SANDBOX_ROUTER_KEY_UNREDACTABLE_MESSAGE);
    }
  }
  const wantsPaperclipRuntimeSkills = Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills");

  // ── Instructions bundle (content read on the host; the directory is shipped) ─
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let instructionsContent: string | null = null;
  if (instructionsFilePath) {
    try {
      instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Working directory: never the server's own cwd ──────────────────────
  const workspace = ctx.context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object"
    ? cfgString((workspace as Record<string, unknown>).cwd)
    : undefined;
  const configuredCwd = cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir);

  const memoryGuidance = await resolveMemoryGuidance(ctx, { usingIsolatedHome: true });
  const agentPromptTemplate = memoryGuidance ? buildPaperclipAgentPromptTemplate(memoryGuidance) : undefined;

  /** The query and system prompt, exactly as the host path assembles them (split and fallback). */
  const composePrompts = (
    apiUrl: string | undefined,
    remoteInstructionsFile: string | null,
  ): { query: string; systemPrompt: string; relocated: boolean } => {
    const promptConfig: Record<string, unknown> = { ...config };
    if (apiUrl) {
      promptConfig.paperclipApiUrl = apiUrl;
    } else if (!cfgString(promptConfig.paperclipApiUrl) && cfgString(userEnv.PAPERCLIP_API_URL)) {
      promptConfig.paperclipApiUrl = userEnv.PAPERCLIP_API_URL;
    }
    let agentInstructions = "";
    if (instructionsContent !== null) {
      const file = remoteInstructionsFile ?? instructionsFilePath ?? "";
      agentInstructions =
        `${instructionsContent}\nThe above agent instructions were loaded from ${file}. Resolve any relative file references from ${path.posix.dirname(file)}/.`;
    }
    const built = buildPrompt(ctx, promptConfig, { resumedSession: false, returnSections: true, hardeningFlags });
    const unsplitSystemPrompt = () => joinPromptSections([
      userEnv.HERMES_EPHEMERAL_SYSTEM_PROMPT,
      agentInstructions,
      renderHermesSystemPrompt(ctx.agent, { includeDefaultIdentity: true, agentPromptTemplate }),
    ]);
    if (!built.hermesPromptSplit) return { query: built.query, systemPrompt: unsplitSystemPrompt(), relocated: false };
    const candidateOverlay = joinPromptSections([
      userEnv.HERMES_EPHEMERAL_SYSTEM_PROMPT,
      agentInstructions,
      ...built.systemSections,
      renderHermesSystemPrompt(ctx.agent, { includeDefaultIdentity: false, agentPromptTemplate }),
    ]);
    if (Buffer.byteLength(candidateOverlay, "utf8") <= HERMES_MAX_SYSTEM_PROMPT_BYTES) {
      return { query: built.query, systemPrompt: candidateOverlay, relocated: false };
    }
    // Same fallback as the host path: keep the relocated sections in the query instead.
    const fallback = buildPrompt(ctx, promptConfig, {
      resumedSession: false,
      returnSections: true,
      hardeningFlags: { ...hardeningFlags, hermesPromptSplit: false },
    });
    return { query: fallback.query, systemPrompt: unsplitSystemPrompt(), relocated: true };
  };

  const assertSystemPromptFits = async (systemPrompt: string) => {
    const bytes = Buffer.byteLength(systemPrompt, "utf8");
    if (bytes > HERMES_MAX_SYSTEM_PROMPT_BYTES) {
      await refuse(
        ctx,
        `HERMES_EPHEMERAL_SYSTEM_PROMPT exceeds maximum argument size (${bytes} bytes > ${HERMES_MAX_SYSTEM_PROMPT_BYTES} bytes limit)`,
      );
    }
  };

  const onCleanupWarning = (msg: string) => {
    void ctx.onLog("stdout", `[hermes] Warning: ${msg}\n`).catch(() => {});
  };

  let assetHome: RunHome | null = null;
  let localHermesHome: string | null = null;
  let emptyWorkspaceDir: string | null = null;
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let remoteCleanupPaths: string[] = [];
  let remoteCleanupCwd = target.remoteCwd;
  let redactor: ReturnType<typeof createChunkAwareStreamingRedactor> | null = null;
  let completed = false;
  const sensitiveValues: string[] = [];

  const emitClassifiedChunk = async (stream: "stdout" | "stderr", rawChunk: string, redactedChunk: string) => {
    if (stream === "stderr") {
      if (rawChunk.includes("\n") || rawChunk.includes("\r")) {
        const rawLines = rawChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [rawChunk];
        const redactedLines = redactedChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [redactedChunk];
        for (let i = 0; i < rawLines.length; i++) {
          const rawLine = rawLines[i];
          const redactedLine = redactedLines[i] ?? redactSensitiveString(rawLine, sensitiveValues);
          await ctx.onLog(isBenignStderrLog(rawLine) ? "stdout" : "stderr", redactedLine);
        }
        return;
      }
      return ctx.onLog(isBenignStderrLog(rawChunk) ? "stdout" : "stderr", redactedChunk);
    }
    return ctx.onLog(stream, redactedChunk);
  };

  try {
    let cwd = configuredCwd;
    if (!cwd) {
      // Nothing to sync: stage an empty workspace rather than the server's working directory.
      emptyWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-sandbox-ws-"));
      cwd = emptyWorkspaceDir;
    }

    // ── Local assets: an isolated HERMES_HOME built in a throwaway host directory ─
    assetHome = await createRunHome({ prefix: "paperclip-hermes-sandbox-" });
    const preparedHome = await prepareHermesMcpHome({
      servers: runtimeMcpServers,
      bridgeRelay: true,
      ...(memoryProvider ? { memoryProvider } : {}),
      config,
      flags: hardeningFlags,
      onWarning: onCleanupWarning,
      canonicalRouterEndpoint: isRouterRun,
      isolatedFromHost: true,
      ...(anthropicRequestTimeoutSec !== undefined ? { anthropicRequestTimeoutSec } : {}),
      tempDirPrefix: path.join(assetHome.path, "hermes-"),
    });
    localHermesHome = preparedHome.homeDir;
    if (wantsPaperclipRuntimeSkills) {
      try {
        const selectedSkills = await reconcileHermesPaperclipSkills(config, undefined, {
          skillsHome: path.join(localHermesHome, "skills"),
        });
        if (selectedSkills.length > 0) {
          await ctx.onLog(
            "stdout",
            `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the sandbox Hermes home.\n`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
        throw err;
      }
    }

    const instructionsAsset = instructionsContent !== null && instructionsFilePath
      ? await prepareInstructionsAsset(config, instructionsFilePath, instructionsContent, assetHome.path)
      : null;

    // Refuse an oversized system prompt before anything is staged. The in-sandbox API origin is not
    // known yet, so a placeholder at least as long as any bridge origin stands in for it.
    const usesBridge = adapterExecutionTargetUsesPaperclipBridge(target);
    // The instructions land where the sandbox runtime stages assets by default
    // (<remoteCwd>/.paperclip-runtime/hermes/<asset key>); the check after staging, with the actual
    // path, stays authoritative.
    const expectedRemoteInstructionsFile = instructionsAsset
      ? path.posix.join(target.remoteCwd, ".paperclip-runtime", HERMES_SANDBOX_ADAPTER_KEY, "instructions", instructionsAsset.relativeFile)
      : null;
    const preflightPrompt = composePrompts(usesBridge ? BRIDGE_URL_SIZE_PLACEHOLDER : undefined, expectedRemoteInstructionsFile);
    await assertSystemPromptFits(preflightPrompt.systemPrompt);

    // ── Ship workspace and assets ──────────────────────────────────────────
    await ctx.onLog(
      "stdout",
      `[hermes] Syncing workspace and Hermes runtime assets to ${describeAdapterExecutionTarget(target)}.\n`,
    );
    const prepared = await prepareAdapterExecutionTargetRuntime({
      runId: ctx.runId,
      target,
      adapterKey: HERMES_SANDBOX_ADAPTER_KEY,
      timeoutSec,
      workspaceLocalDir: cwd,
      onProgress: (line) => ctx.onLog("stdout", line),
      onRuntimeProgress: ctx.onRuntimeProgress,
      assets: [
        { key: "hermesHome", localDir: localHermesHome, followSymlinks: true },
        ...(instructionsAsset ? [{ key: "instructions", localDir: instructionsAsset.localDir, followSymlinks: false }] : []),
      ],
    });
    restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => ctx.onLog("stdout", line));
    const remoteCwd = prepared.workspaceRemoteDir ?? adapterExecutionTargetRemoteCwd(target, cwd);
    remoteCleanupCwd = remoteCwd;
    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, remoteCwd) ?? target;
    const runtimeRootDir =
      prepared.runtimeRootDir ?? path.posix.join(remoteCwd, ".paperclip-runtime", HERMES_SANDBOX_ADAPTER_KEY);
    const remoteHermesHome = prepared.assetDirs.hermesHome;
    if (!remoteHermesHome) throw new Error("The Hermes home was not staged to the sandbox.");
    const remoteHomeRoot = path.posix.join(runtimeRootDir, "home");
    const remoteQueryPath = path.posix.join(runtimeRootDir, "query.txt");
    // Per run, so concurrent runs in one workspace never share or delete each other's probe home.
    // The run id becomes one path segment of a directory that is later removed with rm -rf, so only
    // a plain [A-Za-z0-9_-] id is used verbatim; anything else is replaced by its hash.
    const probeRunSegment = /^[A-Za-z0-9_-]{1,128}$/.test(ctx.runId)
      ? ctx.runId
      : createHash("sha256").update(String(ctx.runId)).digest("hex").slice(0, 32);
    const remoteRouterProbeDir = path.posix.join(runtimeRootDir, `router-probe-${probeRunSegment}`);
    remoteCleanupPaths = [remoteHermesHome, remoteHomeRoot, remoteQueryPath, remoteRouterProbeDir];
    const remoteInstructionsDir = prepared.assetDirs.instructions;

    await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, remoteCwd, {}, { timeoutSec });

    if (isRouterRun) {
      // The registry probe runs inside the sandbox against the image's Hermes, not on this host.
      const capability = await probeHermesRouterSupportInTarget({
        runId: ctx.runId,
        target: runtimeTarget,
        cwd: remoteCwd,
        probeDir: remoteRouterProbeDir,
      });
      if (!capability.supported) await refuse(ctx, capability.message);
      await ctx.onLog("stdout", `[hermes] Ramp Router provider verified in ${describeAdapterExecutionTarget(target)} for ${command}\n`);
    }

    // ── Callback bridge: the only route to the Paperclip API from the sandbox ─
    if (adapterExecutionTargetUsesPaperclipBridge(runtimeTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: ctx.runId,
        target: runtimeTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeTarget),
        runtimeRootDir,
        adapterKey: HERMES_SANDBOX_ADAPTER_KEY,
        timeoutSec,
        hostApiToken: ctx.authToken,
        onLog: ctx.onLog,
        relayRoutes: runtimeMcpServers.map((server, index) => ({
          path: hermesMcpRelayPath(preparedHome.serverKeys[index]!),
          upstreamUrl: server.url,
          token: server.token,
          deadlineMs: (server.requestTimeoutMs ?? HERMES_MCP_RELAY_DEFAULT_TOOL_TIMEOUT_MS) + HERMES_MCP_RELAY_DEADLINE_MARGIN_MS,
          label: server.name,
        })),
        // The MCP relay routes above register their own policies; memory gets its own lane (TECH-8908).
        ...(memoryProvider === "mem0" ? { bridgeRoutePolicies: HERMES_SANDBOX_MEMORY_ROUTE_POLICIES } : {}),
      });
    }
    const bridgeEnv = paperclipBridge?.env ?? {};

    // ── Prompt (built with the in-sandbox API origin) ──────────────────────
    const remoteInstructionsFile = instructionsAsset && remoteInstructionsDir
      ? path.posix.join(remoteInstructionsDir, instructionsAsset.relativeFile)
      : null;
    if (instructionsContent !== null && instructionsFilePath) {
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${instructionsContent.length} chars)\n`,
      );
    }
    const composed = composePrompts(bridgeEnv.PAPERCLIP_API_URL, remoteInstructionsFile);
    const prompt = composed.query;
    const finalSystemPrompt = composed.systemPrompt;
    if (composed.relocated) {
      await ctx.onLog("stderr", "[hermes] Ephemeral system prompt exceeds size limit; keeping relocated sections in query.\n");
    }
    await assertSystemPromptFits(finalSystemPrompt);

    // ── Sandbox env: explicit layers only, never the host process env ──────
    const env: Record<string, string> = {
      ...userEnv,
      ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
    };
    // PAPERCLIP_API_KEY never comes from config, and the run JWT never enters the sandbox; the
    // bridge env below supplies a run-scoped bridge token instead (fork #416).
    delete env.PAPERCLIP_API_KEY;
    delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
    // The persistent per-agent identity key stays on the host (TECH-8988); nothing in the pod signs with it.
    for (const key of AGENT_IDENTITY_ENV_KEYS) delete env[key];
    // The host PATH means nothing in the sandbox (the image provides it).
    delete env.PATH;
    for (const key of Object.keys(env)) {
      if (key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")) delete env[key];
    }
    for (const key of HERMES_FORBIDDEN_ENV_VARS) delete env[key];
    // The pod never holds the memory token or a memory proxy: those names are stripped even without
    // memoryProvider, and a memory run gets bridge-relayed values below (TECH-8908).
    for (const name of ["MEM0_API_KEY", "MEM0_HOST", "MEM0_PROXY"]) delete env[name];
    // Endpoint overrides and aliases never reach Hermes; a Router run also drops the generic SDK
    // endpoints and the Python import-path overrides (the probe verified the image's own registry).
    for (const name of routerEnvNamesToStrip(env, isRouterRun)) delete env[name];
    if (isRouterRun) {
      for (const name of ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES) delete env[name];
    } else {
      // Not this run's credential; keep it out of the sandbox.
      delete env[RAMP_ROUTER_API_KEY_ENV];
    }
    Object.assign(env, preparedHome.env);
    if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
    const wakeContext = (ctx.context ?? {}) as Record<string, unknown>;
    const envTaskId = cfgString(wakeContext.taskId) || cfgString(wakeContext.issueId) || cfgString(ctx.config?.taskId);
    if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
    const envWakeReason = cfgString(wakeContext.wakeReason) || cfgString(ctx.config?.wakeReason);
    if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
    const envCommentId = cfgString(wakeContext.commentId) || cfgString(wakeContext.wakeCommentId) || cfgString(ctx.config?.commentId);
    if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;
    Object.assign(env, bridgeEnv);
    if (memoryProvider === "mem0") {
      if (!bridgeEnv.PAPERCLIP_API_URL || !bridgeEnv.PAPERCLIP_API_KEY) {
        await refuse(ctx, HERMES_SANDBOX_MEMORY_BRIDGE_REQUIRED_MESSAGE);
      }
      // Hermes's mem0 client joins its paths onto this host. The API key is the per-run bridge token (the
      // in-pod gateway requires it and strips it); the server picks the agent's own memory token.
      env.MEM0_HOST = `${bridgeEnv.PAPERCLIP_API_URL!.replace(/\/+$/, "")}${HERMES_SANDBOX_MEMORY_RELAY_PATH}`;
      env.MEM0_API_KEY = bridgeEnv.PAPERCLIP_API_KEY!;
      if (hardeningFlags.mem0AutoSyncOff) env.MEM0_AUTO_SYNC = "false";
    }
    // Applied last so no config env can redirect the home, Hermes home or protected invariants.
    Object.assign(env, buildRemoteRunHomeEnv(remoteHomeRoot), buildRemoteRunScratchEnv(remoteHomeRoot));
    env.HERMES_HOME = remoteHermesHome;
    env.HERMES_EPHEMERAL_SYSTEM_PROMPT = finalSystemPrompt;
    env.HERMES_DISABLE_LAZY_INSTALLS = "1";
    env.MEM0_TELEMETRY = "False";
    env.PYTHONDONTWRITEBYTECODE = "1";

    // Redaction: every credential the agent binds (provider keys, including a Router key) and the
    // bridge token are scrubbed from streamed and returned output. Values that cannot be redacted
    // safely (too long, or no boundary-safe characters) are skipped rather than mangling output.
    const redactionSet = new Set<string>();
    const noteSecret = (value: string | undefined) => {
      for (const variant of [value, value?.trim()]) {
        if (variant && variant.length <= MAX_CONFIG_STRING_LENGTH && canSafelyRedactSecret(variant)) redactionSet.add(variant);
      }
    };
    for (const [name, value] of Object.entries(userEnv)) {
      if (isHermesProviderCredentialName(name)) noteSecret(value);
    }
    noteSecret(bridgeEnv.PAPERCLIP_API_KEY);
    sensitiveValues.push(...[...redactionSet].sort((a, b) => b.length - a.length));
    redactor = createChunkAwareStreamingRedactor(sensitiveValues);
    const activeRedactor = redactor;

    // ── Args: flags and paths only; the prompt is read from a file ─────────
    const args: string[] = ["chat", "--query-file", remoteQueryPath];
    if (cfgBoolean(config.quiet) !== false) args.push("-Q");
    if (effective.modelArg) args.push("-m", effective.modelArg);
    if (resolvedProvider !== "auto") args.push("--provider", resolvedProvider);
    if (toolsets) args.push("-t", toolsets);
    if (maxTurns && maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (cfgBoolean(config.worktreeMode) === true) args.push("-w");
    if (cfgBoolean(config.checkpoints) === true) args.push("--checkpoints");
    if (cfgBoolean(config.verbose) === true) args.push("-v");
    args.push("--source", "tool");
    args.push("--yolo");
    if (extraArgs?.length) args.push(...extraArgs);

    await ctx.onLog(
      "stdout",
      `[hermes] Starting Hermes Agent in ${describeAdapterExecutionTarget(target)} (model=${model ?? "hermes-default"}, provider=${resolvedProvider} [${effective.resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
    );

    const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      for (const item of activeRedactor.processDetailed(stream, chunk)) {
        await emitClassifiedChunk(stream, item.raw, item.redacted);
      }
    };

    // The exec env is merged over the pod's own environment, which Paperclip does not control.
    // A Router run therefore launches Hermes through `env -u` for every fixed endpoint-override and
    // import-path name, so the pod cannot reintroduce one and the run loads the same registry the
    // in-sandbox probe verified (the probe itself runs under `env -i`). Names only; no values.
    const launch = isRouterRun
      ? {
          command: "env",
          args: [
            ...[...new Set([...routerEnvNamesToStrip({}, true), ...ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES])]
              .sort()
              .flatMap((name) => ["-u", name]),
            command,
            ...args,
          ],
        }
      : { command, args };
    // TECH-8174: the launch exec stages the prompt file and run home first (one exec instead of
    // two). The prompt still travels only on stdin, never in argv; argv carries the two paths.
    const staging = buildHermesSandboxPromptStagingLaunch({
      queryPath: remoteQueryPath,
      homeRoot: remoteHomeRoot,
      command: launch.command,
      args: launch.args,
    });
    const result = await runAdapterExecutionTargetProcess(ctx.runId, runtimeTarget, staging.command, staging.args, {
      cwd: remoteCwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      runLogTail: paperclipBridge?.runLogTail,
      settleRunDisposition: paperclipBridge?.settleRunDisposition,
    });

    for (const fl of activeRedactor.flushDetailed()) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk);
    }
    if (staging.stagingFailed(result)) {
      throw new Error(HERMES_SANDBOX_PROMPT_STAGING_FAILED_MESSAGE);
    }

    const scrub = (text: string) => redactSensitiveString(text, sensitiveValues);
    const scrubbedStdout = scrub(result.stdout || "");
    const scrubbedStderr = scrub(result.stderr || "");
    const parsed = parseHermesOutput(scrubbedStdout, scrubbedStderr);
    await ctx.onLog("stdout", `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`);

    const executionResult: AdapterExecutionResult = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      provider: resolvedProvider,
      model,
      // Every sandbox run uses a fresh Hermes home, so there is never a session to resume.
      clearSession: true,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    };
    const hermesFailed = !result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0;
    const failedOutputExcerpt = hermesFailed && parsed.response
      ? scrub(parsed.response.split("\n").find((line) => line.trim().length > 0) ?? "").slice(0, 300)
      : "";
    if (parsed.errorMessage) {
      executionResult.errorMessage = augmentStaleImageError(scrub(parsed.errorMessage), null, scrubbedStderr);
    } else if (hermesFailed) {
      executionResult.errorMessage = failedOutputExcerpt
        ? `Hermes exited with code ${result.exitCode}: ${failedOutputExcerpt}`
        : `Hermes exited with code ${result.exitCode}`;
    }
    if (parsed.usage) executionResult.usage = parsed.usage;
    if (parsed.costUsd !== undefined) executionResult.costUsd = parsed.costUsd;
    if (parsed.response && !hermesFailed) executionResult.summary = scrub(parsed.response.slice(0, 2000));
    executionResult.resultJson = {
      result: hermesFailed ? "" : scrub(parsed.response || ""),
      session_id: parsed.sessionId || null,
      usage: parsed.usage || null,
      cost_usd: parsed.costUsd ?? null,
    };
    completed = true;
    return executionResult;
  } finally {
    for (const fl of redactor?.flushDetailed() ?? []) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk).catch(() => {});
    }
    await paperclipBridge?.stop().catch(() => onCleanupWarning("Sandbox bridge shutdown encountered an error"));
    if (remoteCleanupPaths.length > 0) {
      // The shipped Hermes home and the prompt file must not outlive the run on a reused lease.
      await runAdapterExecutionTargetShellCommand(
        ctx.runId,
        target,
        `rm -rf ${remoteCleanupPaths.map(shellQuote).join(" ")}`,
        { cwd: remoteCleanupCwd, env: {}, timeoutSec: 30, graceSec: 5 },
      ).catch(() => onCleanupWarning("Sandbox Hermes home cleanup encountered an error"));
    }
    // A failed copy-back would silently lose the agent's workspace changes, so it fails an otherwise
    // completed run (after the local cleanup below), as the Pi adapter does. When the run already
    // failed, that original error is kept and the restore failure is only logged.
    let restoreError: unknown = null;
    try {
      await restoreRemoteWorkspace?.();
    } catch (err) {
      restoreError = err;
    }
    if (localHermesHome) await cleanupHermesMcpHome(localHermesHome, onCleanupWarning);
    await assetHome?.cleanup().catch(() => onCleanupWarning("Temporary asset home cleanup encountered an error"));
    if (emptyWorkspaceDir) {
      await fs.rm(emptyWorkspaceDir, { recursive: true, force: true })
        .catch(() => onCleanupWarning("Temporary empty workspace cleanup encountered an error"));
    }
    if (restoreError) {
      if (completed) throw restoreError;
      const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
      onCleanupWarning(`Sandbox workspace restore failed after the run failed: ${reason}`);
    }
  }
}
