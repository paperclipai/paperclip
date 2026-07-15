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
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "20.0.0";

export type GeminiExecutionEngine = "cli" | "acp";

export interface GeminiEngineSelection {
  engine: GeminiExecutionEngine;
  explicit: boolean;
  fallbackReason?: string;
}

type GeminiEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type GeminiAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type GeminiAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function normalizeEngine(value: unknown): GeminiEngineSelection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  return { engine: "acp", explicit: false };
}

export function resolveGeminiExecutionEngine(config: Record<string, unknown>): GeminiEngineSelection {
  return normalizeEngine(config.engine);
}

export async function resolveGeminiExecutionEngineForRun(
  input: GeminiEngineResolutionInput,
): Promise<GeminiEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  if (selection.explicit || selection.engine !== "acp") return selection;

  const fallbackReason = await defaultGeminiAcpFallbackReason(input);
  if (!fallbackReason) return selection;
  return { engine: "cli", explicit: false, fallbackReason };
}

export function formatGeminiAcpFallbackMessage(reason: string): string {
  return `[paperclip] Gemini ACP default unavailable; falling back to Gemini CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildGeminiAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const configuredAgentCommand = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  const configuredGeminiCommand = firstNonEmptyString(config.command);
  const agentCommand = configuredAgentCommand ?? (configuredGeminiCommand ? `${configuredGeminiCommand} --acp` : undefined);
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
    agent: "gemini",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(agentCommand ? { agentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
  const model = asString(next.model, "").trim();
  if (!model || model === DEFAULT_GEMINI_LOCAL_MODEL) delete next.model;
  return next;
}

function withGeminiAcpDefaults(options: GeminiAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    ...options,
    adapterType: "gemini_local",
    moduleDir,
    packageRootDir,
  };
}

export function createGeminiAcpExecutor(options: GeminiAcpExecutorOptions = {}): GeminiAcpExecutor {
  let executor: GeminiAcpExecutor | null = null;
  return async (ctx) => {
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withGeminiAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildGeminiAcpConfig(ctx.config),
    });
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsGeminiAcpMinimum(version = process.version): boolean {
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
  input?: GeminiEngineResolutionInput,
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

function resolveGeminiAcpCommand(config: Record<string, unknown>): string {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  const geminiCommand = firstNonEmptyString(config.command) ?? "gemini";
  return `${geminiCommand} --acp`;
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function defaultGeminiAcpFallbackReason(
  input: GeminiEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Gemini ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Gemini ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsGeminiAcpMinimum()) {
    return `Node ${process.version} does not satisfy Gemini ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = resolveGeminiAcpCommand(input.config);
  if (!(await commandIsResolvable(command, resolveConfigPath(input.config), input))) {
    return `Gemini ACP command is not available: ${command}.`;
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

export async function testGeminiAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "gemini_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the existing Gemini CLI lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "gemini_acp_remote_target",
      level: "info",
      message: "Gemini ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "gemini_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsGeminiAcpMinimum() ? "gemini_acp_node_supported" : "gemini_acp_node_unsupported",
    level: nodeVersionMeetsGeminiAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsGeminiAcpMinimum()
      ? `Node ${process.version} satisfies ACP runtime requirements.`
      : `Node ${process.version} does not satisfy ACP runtime requirements.`,
    hint: nodeVersionMeetsGeminiAcpMinimum()
      ? undefined
      : `Run Gemini ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = resolveGeminiAcpCommand(config);
  const commandResolvable = await commandIsResolvable(command, resolveConfigPath(config), {
    config,
    executionTarget: ctx.executionTarget,
  });
  checks.push({
    code: commandResolvable ? "gemini_acp_command_resolvable" : "gemini_acp_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Gemini ACP command is executable: ${command}`
      : `Gemini ACP command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install the Gemini CLI with ACP support, or set agentCommand to a valid Gemini ACP server command.",
  });

  const envConfig = parseObject(config.env);
  const considerHostEnv = !targetIsRemote;
  const hasGca = envConfig.GOOGLE_GENAI_USE_GCA === "true" || (considerHostEnv && process.env.GOOGLE_GENAI_USE_GCA === "true");
  const configGeminiApiKey = envConfig.GEMINI_API_KEY;
  const hostGeminiApiKey = considerHostEnv ? process.env.GEMINI_API_KEY : undefined;
  const configGoogleApiKey = envConfig.GOOGLE_API_KEY;
  const hostGoogleApiKey = considerHostEnv ? process.env.GOOGLE_API_KEY : undefined;
  if (
    isNonEmpty(configGeminiApiKey) ||
    isNonEmpty(hostGeminiApiKey) ||
    isNonEmpty(configGoogleApiKey) ||
    isNonEmpty(hostGoogleApiKey) ||
    hasGca
  ) {
    const source = hasGca
      ? "Google account login (GCA)"
      : isNonEmpty(configGeminiApiKey) || isNonEmpty(configGoogleApiKey)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "gemini_acp_credentials_detected",
      level: "info",
      message: "Gemini credentials are set for ACP authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "gemini_acp_credentials_not_detected",
      level: "warn",
      message: "No Gemini ACP credentials were detected.",
      hint: "Set GEMINI_API_KEY / GOOGLE_API_KEY, enable Google account auth, or run `gemini auth login` before starting a Gemini ACP agent.",
    });
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "gemini_acp_runtime_scaffold",
    level: "info",
    message: "Gemini ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
