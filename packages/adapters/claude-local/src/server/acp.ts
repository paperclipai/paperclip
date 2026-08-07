import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkScope,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import type {
  AcpxEngineExecutorOptions,
  AcpxRemoteManagedHomeContext,
  AcpxRemoteManagedHomeResult,
} from "@paperclipai/adapter-utils/acpx-engine/execute";
import {
  asNumber,
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  materializeRemoteClaudeConfig,
  prepareClaudeConfigSeed,
} from "./claude-config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "22.12.0";

export type ClaudeExecutionEngine = "cli" | "acp";

export interface ClaudeEngineSelection {
  engine: ClaudeExecutionEngine;
  explicit: boolean;
  fallbackReason?: string;
}

type ClaudeEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type ClaudeAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type ClaudeAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function normalizeEngine(value: unknown): ClaudeEngineSelection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  return { engine: "acp", explicit: false };
}

export function resolveClaudeExecutionEngine(config: Record<string, unknown>): ClaudeEngineSelection {
  return normalizeEngine(config.engine);
}

export async function resolveClaudeExecutionEngineForRun(
  input: ClaudeEngineResolutionInput,
): Promise<ClaudeEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  const filesystemScope = parseLocalProcessFilesystemScope(input.config.filesystemScope);
  const networkScope = parseLocalProcessNetworkScope(input.config.networkScope);
  if (filesystemScope || networkScope) {
    if (selection.explicit && selection.engine === "acp") {
      throw new Error("Local filesystem/network confinement requires the Claude CLI engine; ACP confinement is not supported.");
    }
    return {
      engine: "cli",
      explicit: selection.explicit,
      ...(!selection.explicit
        ? { fallbackReason: "Local filesystem/network scope requires spawn-level confinement in the CLI lane." }
        : {}),
    };
  }
  if (selection.explicit || selection.engine !== "acp") return selection;

  const fallbackReason = await defaultClaudeAcpFallbackReason(input);
  if (!fallbackReason) return selection;
  return { engine: "cli", explicit: false, fallbackReason };
}

export function formatClaudeAcpFallbackMessage(reason: string): string {
  return `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildClaudeAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const agentCommand = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  const stateDir = firstNonEmptyString(config.stateDir, config.acpStateDir);
  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const permissionMode =
    firstNonEmptyString(config.permissionMode, config.acpPermissionMode) ??
    DEFAULT_ACP_ENGINE_PERMISSION_MODE;
  const nonInteractivePermissions =
    firstNonEmptyString(config.nonInteractivePermissions, config.acpNonInteractivePermissions) ??
    DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS;
  const warmHandleIdleMs =
    config.warmHandleIdleMs ??
    config.acpWarmHandleIdleMs ??
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS;

  return {
    ...config,
    agent: "claude",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(agentCommand ? { agentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
}

/**
 * Classify billing the same way the Claude CLI lane does so ACP runs land in
 * the cost ledger with a real provider/billingType instead of acpx/unknown.
 * Host env only counts for local execution targets; remote targets see just
 * the adapter-config env.
 */
export function resolveClaudeAcpBillingIdentity(
  ctx: Pick<AdapterExecutionContext, "config"> &
    Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const envConfig = parseObject(parseObject(ctx.config).env);
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const considerHostEnv = target?.kind !== "remote";
  const readEnvValue = (key: string): string => {
    const fromConfig = envConfig[key];
    if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim();
    const fromHost = considerHostEnv ? process.env[key] : undefined;
    return typeof fromHost === "string" ? fromHost.trim() : "";
  };
  const bedrockFlag = readEnvValue("CLAUDE_CODE_USE_BEDROCK");
  const bedrock = bedrockFlag === "1" || bedrockFlag === "true" || Boolean(readEnvValue("ANTHROPIC_BEDROCK_BASE_URL"));
  const billingType: AdapterBillingType = bedrock
    ? "metered_api"
    : readEnvValue("ANTHROPIC_API_KEY")
    ? "api"
    : "subscription";
  return {
    provider: "anthropic",
    biller: bedrock ? "aws_bedrock" : "anthropic",
    billingType,
  };
}

/**
 * Claude remote managed-home seed for the runner-backed remote sandbox ACP lane.
 * Mirrors the Claude CLI lane (`claude-local/execute.ts`): ship a sanitized
 * config seed (settings.json + CLAUDE.md, no credentials) as the `config-seed`
 * asset, materialize it into an in-sandbox config dir (copying the sandbox's own
 * `$HOME/.claude` credentials in), then repoint `CLAUDE_CONFIG_DIR` onto that
 * in-sandbox config dir. Claude has no credential copy-back (its CLI lane has
 * none — mirroring the CLI is the contract), so no teardown hook.
 *
 * An explicit `CLAUDE_CONFIG_DIR` (user-managed) is honored only if it can reach
 * the remote sandbox; a host-only path cannot, so we do NOT forward it verbatim
 * (that would start remote Claude with no config/credentials). See the branch
 * below for the two portable dispositions. The engine's `useRemoteProcessSession`
 * gate already guarantees the remote sandbox (managed-home) target.
 */
async function prepareClaudeRemoteManagedHome(
  input: AcpxRemoteManagedHomeContext,
): Promise<AcpxRemoteManagedHomeResult> {
  const { env, runId, onLog, executionTarget } = input;
  const envConfig = parseObject(input.config.env);
  const explicitClaudeConfigDir =
    typeof envConfig.CLAUDE_CONFIG_DIR === "string" && envConfig.CLAUDE_CONFIG_DIR.trim().length > 0
      ? envConfig.CLAUDE_CONFIG_DIR.trim()
      : "";
  if (explicitClaudeConfigDir) {
    // User-managed escape hatch. Unlike the Claude CLI lane
    // (`claude-local/execute.ts`), which runs the process on the same host and can
    // forward the operator's path verbatim, the remote ACP lane spawns Claude
    // inside a sandbox that CANNOT see host paths. Forwarding an absolute host
    // path unchanged would leave remote Claude without the requested config or
    // credentials, so we choose one of two portable dispositions:
    //   1. The path lives INSIDE the staged workspace → remap its prefix onto the
    //      in-sandbox workspace dir so it resolves against the copied files.
    //   2. The path is host-only (outside the workspace) → it cannot cross into
    //      the sandbox, so ignore the un-portable override and seed the managed
    //      config instead (falling through below), which guarantees working
    //      config/credentials. Logged loudly so the substitution is diagnosable.
    const relativeToWorkspace = path.relative(input.workspaceLocalDir, explicitClaudeConfigDir);
    const isUnderWorkspace =
      relativeToWorkspace.length > 0 &&
      !relativeToWorkspace.startsWith("..") &&
      !path.isAbsolute(relativeToWorkspace);
    if (isUnderWorkspace) {
      const stagedRuntime = await input.stage([]);
      const remoteWorkspaceDir = stagedRuntime.workspaceRemoteDir ?? input.workspaceLocalDir;
      const remappedConfigDir = path.posix.join(
        remoteWorkspaceDir,
        relativeToWorkspace.split(path.sep).join(path.posix.sep),
      );
      env.CLAUDE_CONFIG_DIR = remappedConfigDir;
      await onLog(
        "stdout",
        `[paperclip] Remapped operator CLAUDE_CONFIG_DIR from host path ${explicitClaudeConfigDir} onto the in-sandbox workspace path ${remappedConfigDir} for the remote ACP run.\n`,
      );
      return { stagedRuntime };
    }
    await onLog(
      "stderr",
      `[paperclip] operator-provided CLAUDE_CONFIG_DIR=${explicitClaudeConfigDir} is outside the staged workspace and cannot reach the remote sandbox; ignoring the host-only path and seeding the managed Claude config instead.\n`,
    );
  }

  // Content-addressed sanitized seed (managed cache under the instance root, not
  // a temp dir — reused across runs, so no teardown cleanup).
  const claudeConfigSeedDir = await prepareClaudeConfigSeed(process.env, onLog, input.companyId);
  const stagedRuntime = await input.stage([
    { key: "config-seed", localDir: claudeConfigSeedDir, followSymlinks: true },
  ]);

  const remoteClaudeRuntimeRoot =
    stagedRuntime.runtimeRootDir ??
    path.posix.join(stagedRuntime.workspaceRemoteDir ?? input.workspaceLocalDir, ".paperclip-runtime", "claude");
  const remoteClaudeConfigSeedDir =
    stagedRuntime.assetDirs["config-seed"] ?? path.posix.join(remoteClaudeRuntimeRoot, "config-seed");
  const remoteClaudeConfigDir = path.posix.join(remoteClaudeRuntimeRoot, "config");

  await onLog("stdout", `[paperclip] Materializing Claude auth/config into ${remoteClaudeConfigDir}.\n`);
  await materializeRemoteClaudeConfig({
    runId,
    target: executionTarget,
    remoteClaudeConfigDir,
    remoteClaudeConfigSeedDir,
    options: {
      cwd: stagedRuntime.workspaceRemoteDir ?? input.workspaceLocalDir,
      env,
      timeoutSec: Math.max(input.timeoutSec, 15),
      graceSec: 20,
      onLog,
    },
  });
  // Repoint CLAUDE_CONFIG_DIR onto the in-sandbox config dir.
  env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
  return { stagedRuntime };
}

function withClaudeAcpDefaults(options: ClaudeAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    resolveBillingIdentity: resolveClaudeAcpBillingIdentity,
    prepareRemoteManagedHome: prepareClaudeRemoteManagedHome,
    ...options,
    adapterType: "claude_local",
    moduleDir,
    packageRootDir,
  };
}

export function createClaudeAcpExecutor(options: ClaudeAcpExecutorOptions = {}): ClaudeAcpExecutor {
  let executor: ClaudeAcpExecutor | null = null;
  return async (ctx) => {
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withClaudeAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildClaudeAcpConfig(ctx.config),
    });
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsClaudeAcpMinimum(version = process.version): boolean {
  const [major, minor, patch] = parseVersion(version);
  const [minMajor, minMinor, minPatch] = parseVersion(MIN_ACP_NODE_VERSION);
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function looksLikeShellCommand(command: string): boolean {
  return /\s/.test(command.trim());
}

async function findCommandOnPath(binName: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, binName);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function findAncestorBin(startDir: string, binName: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", binName);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function commandIsResolvable(
  command: string,
  input?: ClaudeEngineResolutionInput,
): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (looksLikeShellCommand(trimmed)) return true;
  const target = readAdapterExecutionTarget({
    executionTarget: input?.executionTarget,
    legacyRemoteExecution: input?.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote") {
    try {
      await ensureAdapterExecutionTargetCommandResolvable(
        trimmed,
        target,
        resolveAdapterExecutionTargetCwd(target, asString(input?.config.cwd, ""), process.cwd()),
        process.env,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (path.isAbsolute(trimmed) || hasPathSeparator(trimmed)) return pathExists(trimmed);
  return (await findCommandOnPath(trimmed)) !== null;
}

async function resolveClaudeAcpCommand(config: Record<string, unknown>): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  return (
    (await findAncestorBin(packageRootDir, "claude-agent-acp")) ??
    (await findCommandOnPath("claude-agent-acp")) ??
    path.join(packageRootDir, "node_modules", ".bin", "claude-agent-acp")
  );
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function resolveClaudeAcpCommandForTarget(
  config: Record<string, unknown>,
  target: ReturnType<typeof readAdapterExecutionTarget>,
): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  if (target?.kind === "remote") return "claude-agent-acp";
  return resolveClaudeAcpCommand(config);
}

async function defaultClaudeAcpFallbackReason(
  input: ClaudeEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Claude ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Claude ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsClaudeAcpMinimum()) {
    return `Node ${process.version} does not satisfy Claude ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = await resolveClaudeAcpCommandForTarget(input.config, target);
  if (!(await commandIsResolvable(command, input))) {
    return `Claude ACP server command is not available: ${command}.`;
  }
  return null;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function testClaudeAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "claude_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the existing Claude Code CLI lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "claude_acp_remote_target",
      level: "info",
      message: "Claude ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "claude_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsClaudeAcpMinimum() ? "claude_acp_node_supported" : "claude_acp_node_unsupported",
    level: nodeVersionMeetsClaudeAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsClaudeAcpMinimum()
      ? `Node ${process.version} satisfies Claude ACP runtime requirements.`
      : `Node ${process.version} does not satisfy Claude ACP runtime requirements.`,
    hint: nodeVersionMeetsClaudeAcpMinimum()
      ? undefined
      : `Run Claude ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = await resolveClaudeAcpCommandForTarget(config, target);
  const commandResolvable = await commandIsResolvable(command, {
    config,
    executionTarget: ctx.executionTarget,
  });
  checks.push({
    code: commandResolvable ? "claude_acp_command_resolvable" : "claude_acp_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Claude ACP server command is executable: ${command}`
      : `Claude ACP server command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install dependencies so @agentclientprotocol/claude-agent-acp is present, or set agentCommand to a valid Claude ACP server command.",
  });

  const envConfig = parseObject(config.env);
  const considerHostEnv = !targetIsRemote;
  const hasBedrock =
    envConfig.CLAUDE_CODE_USE_BEDROCK === "1" ||
    envConfig.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "1") ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "true") ||
    isNonEmpty(envConfig.ANTHROPIC_BEDROCK_BASE_URL) ||
    (considerHostEnv && isNonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL));
  const configApiKey = envConfig.ANTHROPIC_API_KEY;
  const hostApiKey = considerHostEnv ? process.env.ANTHROPIC_API_KEY : undefined;
  if (hasBedrock) {
    checks.push({
      code: "claude_acp_bedrock_auth",
      level: "info",
      message: "AWS Bedrock auth detected. Claude ACP will use Bedrock for inference.",
      hint: "Ensure AWS credentials and AWS_REGION are configured in this environment.",
    });
  } else if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_acp_anthropic_api_key_detected",
      level: "warn",
      message: "ANTHROPIC_API_KEY is set. Claude ACP will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "claude_acp_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "claude_acp_runtime_scaffold",
    level: "info",
    message: "Claude ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
