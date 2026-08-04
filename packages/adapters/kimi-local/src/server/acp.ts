import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
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
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
import {
  asNumber,
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "20.0.0";

export type KimiExecutionEngine = "cli" | "acp";

export interface KimiEngineSelection {
  engine: KimiExecutionEngine;
  explicit: boolean;
  fallbackReason?: string;
}

type KimiEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type KimiAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type KimiAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function normalizeEngine(value: unknown): KimiEngineSelection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  return { engine: "acp", explicit: false };
}

export function resolveKimiExecutionEngine(config: Record<string, unknown>): KimiEngineSelection {
  return normalizeEngine(config.engine);
}

export async function resolveKimiExecutionEngineForRun(
  input: KimiEngineResolutionInput,
): Promise<KimiEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  if (selection.explicit || selection.engine !== "acp") return selection;

  const fallbackReason = await defaultKimiAcpFallbackReason(input);
  if (!fallbackReason) return selection;
  return { engine: "cli", explicit: false, fallbackReason };
}

export function formatKimiAcpFallbackMessage(reason: string): string {
  return `[paperclip] Kimi ACP default unavailable; falling back to Kimi CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildKimiAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const configuredAgentCommand = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  const configuredKimiCommand = firstNonEmptyString(config.command);
  const agentCommand = configuredAgentCommand ?? (configuredKimiCommand ? `${configuredKimiCommand} acp` : undefined);
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

  const next: Record<string, unknown> = {
    ...config,
    agent: "kimi",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(agentCommand ? { agentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
  const model = asString(next.model, "").trim();
  if (!model || model === DEFAULT_KIMI_LOCAL_MODEL) delete next.model;
  // Kimi's ACP backend advertises a `thinking` config option, not `effort`.
  // The shared acpx engine only knows the `effort` control key, which Kimi
  // rejects with ACP_BACKEND_UNSUPPORTED_CONTROL and fails the session. Drop
  // the CLI-lane effort fields so the ACP session is not configured with an
  // unsupported control; thinking-effort control remains available on the CLI
  // lane via KIMI_MODEL_THINKING_EFFORT.
  delete next.effort;
  delete next.thinkingEffort;
  return next;
}

function withKimiAcpDefaults(options: KimiAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    ...options,
    adapterType: "kimi_local",
    moduleDir,
    packageRootDir,
  };
}

export function createKimiAcpExecutor(options: KimiAcpExecutorOptions = {}): KimiAcpExecutor {
  let executor: KimiAcpExecutor | null = null;
  return async (ctx) => {
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withKimiAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildKimiAcpConfig(ctx.config),
    });
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsKimiAcpMinimum(version = process.version): boolean {
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

function firstShellToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("'") || trimmed.startsWith("\"")) return null;
  return trimmed.split(/\s+/, 1)[0] ?? null;
}

async function findCommandOnPath(binName: string, pathValue = process.env.PATH ?? ""): Promise<string | null> {
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, binName);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function resolveConfigPath(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  return typeof envConfig.PATH === "string" && envConfig.PATH.trim().length > 0
    ? envConfig.PATH
    : process.env.PATH ?? "";
}

async function commandIsResolvable(
  command: string,
  pathValue = process.env.PATH ?? "",
  input?: KimiEngineResolutionInput,
): Promise<boolean> {
  const token = firstShellToken(command);
  if (!token) return true;
  const target = readAdapterExecutionTarget({
    executionTarget: input?.executionTarget,
    legacyRemoteExecution: input?.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote") {
    try {
      await ensureAdapterExecutionTargetCommandResolvable(
        token,
        target,
        resolveAdapterExecutionTargetCwd(target, asString(input?.config.cwd, ""), process.cwd()),
        process.env,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (path.isAbsolute(token) || hasPathSeparator(token)) return pathExists(token);
  return (await findCommandOnPath(token, pathValue)) !== null;
}

function resolveKimiAcpCommand(config: Record<string, unknown>): string {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  const kimiCommand = firstNonEmptyString(config.command) ?? "kimi";
  return `${kimiCommand} acp`;
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function defaultKimiAcpFallbackReason(
  input: KimiEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Kimi ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Kimi ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsKimiAcpMinimum()) {
    return `Node ${process.version} does not satisfy Kimi ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = resolveKimiAcpCommand(input.config);
  if (!(await commandIsResolvable(command, resolveConfigPath(input.config), input))) {
    return `Kimi ACP command is not available: ${command}.`;
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

export async function testKimiAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "kimi_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the existing Kimi CLI lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "kimi_acp_remote_target",
      level: "info",
      message: "Kimi ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "kimi_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsKimiAcpMinimum() ? "kimi_acp_node_supported" : "kimi_acp_node_unsupported",
    level: nodeVersionMeetsKimiAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsKimiAcpMinimum()
      ? `Node ${process.version} satisfies ACP runtime requirements.`
      : `Node ${process.version} does not satisfy ACP runtime requirements.`,
    hint: nodeVersionMeetsKimiAcpMinimum()
      ? undefined
      : `Run Kimi ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = resolveKimiAcpCommand(config);
  const commandResolvable = await commandIsResolvable(command, resolveConfigPath(config), {
    config,
    executionTarget: ctx.executionTarget,
  });
  checks.push({
    code: commandResolvable ? "kimi_acp_command_resolvable" : "kimi_acp_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Kimi ACP command is executable: ${command}`
      : `Kimi ACP command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install the Kimi Code CLI with ACP support, or set agentCommand to a valid Kimi ACP server command.",
  });

  const envConfig = parseObject(config.env);
  const considerHostEnv = !targetIsRemote;
  const configModelName = envConfig.KIMI_MODEL_NAME;
  const hostModelName = considerHostEnv ? process.env.KIMI_MODEL_NAME : undefined;
  const configModelKey = envConfig.KIMI_MODEL_API_KEY;
  const hostModelKey = considerHostEnv ? process.env.KIMI_MODEL_API_KEY : undefined;
  if (
    (isNonEmpty(configModelName) && isNonEmpty(configModelKey)) ||
    (isNonEmpty(hostModelName) && isNonEmpty(hostModelKey))
  ) {
    const source =
      isNonEmpty(configModelName) && isNonEmpty(configModelKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "kimi_acp_credentials_detected",
      level: "info",
      message: "Kimi credentials are set for ACP authentication.",
      detail: `KIMI_MODEL_NAME + KIMI_MODEL_API_KEY detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "kimi_acp_credentials_not_detected",
      level: "warn",
      message: "No Kimi ACP credentials were detected.",
      hint: "Run `kimi login` (OAuth) or set the KIMI_MODEL_NAME + KIMI_MODEL_API_KEY environment pair before starting a Kimi ACP agent.",
    });
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "kimi_acp_runtime_scaffold",
    level: "info",
    message: "Kimi ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
