import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "20.0.0";

export type MuseExecutionEngine = "cli" | "acp";

export interface MuseEngineSelection {
  engine: MuseExecutionEngine;
  explicit: boolean;
  unavailableReason?: string;
}

type MuseEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type MuseAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type MuseAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function normalizeEngine(value: unknown): MuseEngineSelection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  return { engine: "acp", explicit: false };
}

export function resolveMuseExecutionEngine(config: Record<string, unknown>): MuseEngineSelection {
  return normalizeEngine(config.engine);
}

export async function resolveMuseExecutionEngineForRun(
  input: MuseEngineResolutionInput,
): Promise<MuseEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  if (selection.engine === "cli") return selection;
  const unavailable = (reason: string): MuseEngineSelection => ({
    ...selection,
    unavailableReason: `${reason} Repair the ACP setup, or explicitly set engine=cli to use the CLI engine.`,
  });

  const reason = await museAcpUnavailableReason(input);
  return reason ? unavailable(reason) : selection;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildMuseAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const configuredAgentCommand = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
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
    agent: "muse",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(configuredAgentCommand ? { agentCommand: configuredAgentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
  const model = asString(next.model, "").trim();
  if (!model || model === DEFAULT_MUSE_LOCAL_MODEL) delete next.model;
  next.summaryStrategy = "lastOutputSegment";
  next.coalescePlaceholderToolUpdates = true;
  return next;
}

function withMuseAcpDefaults(options: MuseAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    ...options,
    adapterType: "muse_local",
    moduleDir,
    packageRootDir,
  };
}

export function createMuseAcpExecutor(options: MuseAcpExecutorOptions = {}): MuseAcpExecutor {
  let executor: MuseAcpExecutor | null = null;
  return async (ctx) => {
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withMuseAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildMuseAcpConfig(ctx.config),
    });
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsMuseAcpMinimum(version = process.version): boolean {
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
  input?: MuseEngineResolutionInput,
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

function resolveMuseAcpCommand(config: Record<string, unknown>): string {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  return "muse-acp";
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function museAcpUnavailableReason(
  input: MuseEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Muse ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Muse ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsMuseAcpMinimum()) {
    return `Node ${process.version} (${process.execPath}) does not satisfy Muse ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = resolveMuseAcpCommand(input.config);
  // If muse-acp is not globally on path, check if muse executable itself exists
  const isAcpResolvable = await commandIsResolvable(command, resolveConfigPath(input.config), input);
  if (!isAcpResolvable) {
    const museCommand = firstNonEmptyString(input.config.command) ?? "muse";
    const isMuseResolvable =
      (await commandIsResolvable(museCommand, resolveConfigPath(input.config), input)) ||
      (await pathExists(path.join(os.homedir(), ".local/bin/muse")));
    if (!isMuseResolvable) {
      return `Muse executable is not available on PATH or in ~/.local/bin/muse.`;
    }
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

export async function testMuseAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "muse_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the CLI execution lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "muse_acp_remote_target",
      level: "info",
      message: "Muse ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "muse_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "muse_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsMuseAcpMinimum() ? "muse_acp_node_supported" : "muse_acp_node_unsupported",
    level: nodeVersionMeetsMuseAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsMuseAcpMinimum()
      ? `Node ${process.version} satisfies ACP runtime requirements.`
      : `Node ${process.version} (${process.execPath}) does not satisfy ACP runtime requirements.`,
    hint: nodeVersionMeetsMuseAcpMinimum()
      ? undefined
      : `Run Muse ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = resolveMuseAcpCommand(config);
  const commandResolvable = await commandIsResolvable(command, resolveConfigPath(config), {
    config,
    executionTarget: ctx.executionTarget,
  });
  const fallbackMuseResolvable =
    (await commandIsResolvable(asString(config.command, "muse"), resolveConfigPath(config), {
      config,
      executionTarget: ctx.executionTarget,
    })) || (await pathExists(path.join(os.homedir(), ".local/bin/muse")));

  if (commandResolvable || fallbackMuseResolvable) {
    checks.push({
      code: "muse_acp_command_resolvable",
      level: "info",
      message: `Muse ACP command is executable: ${commandResolvable ? command : "muse (via internal bridge)"}`,
    });
  } else {
    checks.push({
      code: "muse_acp_command_missing",
      level: "error",
      message: `Muse ACP command is not available: ${command}`,
      hint: "Ensure muse is installed on PATH or set agentCommand to a valid ACP server command.",
    });
  }

  const envConfig = parseObject(config.env);
  const considerHostEnv = !targetIsRemote;
  const hasApiKey =
    isNonEmpty(envConfig.MUSE_API_KEY) ||
    isNonEmpty(envConfig.META_API_KEY) ||
    (considerHostEnv && (isNonEmpty(process.env.MUSE_API_KEY) || isNonEmpty(process.env.META_API_KEY)));

  const authJsonCandidates = [
    typeof envConfig.MUSE_AUTH_PATH === "string" ? envConfig.MUSE_AUTH_PATH : null,
    typeof process.env.MUSE_AUTH_PATH === "string" ? process.env.MUSE_AUTH_PATH : null,
    path.join(os.homedir(), ".config/muse/auth.json"),
  ].filter(Boolean) as string[];

  let hasAuthJson = false;
  for (const candidate of authJsonCandidates) {
    if (await pathExists(candidate)) {
      hasAuthJson = true;
      break;
    }
  }

  if (hasApiKey || hasAuthJson) {
    checks.push({
      code: "muse_acp_credentials_detected",
      level: "info",
      message: "Muse credentials are set for ACP authentication.",
      detail: hasAuthJson ? "auth.json found" : "API key detected in environment",
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "muse_acp_credentials_not_detected",
      level: "warn",
      message: "No Muse ACP credentials were detected.",
      hint: "Run `muse login` or set MUSE_API_KEY before starting a Muse ACP agent.",
    });
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "muse_acp_runtime_scaffold",
    level: "info",
    message: "Muse ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
