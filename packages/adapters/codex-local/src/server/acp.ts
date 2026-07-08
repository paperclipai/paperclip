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
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
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

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "22.13.0";

export type CodexExecutionEngine = "cli" | "acp";

export interface CodexEngineSelection {
  engine: CodexExecutionEngine;
  explicit: boolean;
  fallbackReason?: string;
}

type CodexEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type CodexAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type CodexAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function normalizeEngine(value: unknown): CodexEngineSelection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  return { engine: "acp", explicit: false };
}

export function resolveCodexExecutionEngine(config: Record<string, unknown>): CodexEngineSelection {
  return normalizeEngine(config.engine);
}

export async function resolveCodexExecutionEngineForRun(
  input: CodexEngineResolutionInput,
): Promise<CodexEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  if (selection.explicit || selection.engine !== "acp") return selection;

  const fallbackReason = await defaultCodexAcpFallbackReason(input);
  if (!fallbackReason) return selection;
  return { engine: "cli", explicit: false, fallbackReason };
}

export function formatCodexAcpFallbackMessage(reason: string): string {
  return `[paperclip] Codex ACP default unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildCodexAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
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
    agent: "codex",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(agentCommand ? { agentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
}

function withCodexAcpDefaults(options: CodexAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    ...options,
    adapterType: "codex_local",
    moduleDir,
    packageRootDir,
  };
}

export function createCodexAcpExecutor(options: CodexAcpExecutorOptions = {}): CodexAcpExecutor {
  let executor: CodexAcpExecutor | null = null;
  return async (ctx) => {
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withCodexAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildCodexAcpConfig(ctx.config),
    });
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsCodexAcpMinimum(version = process.version): boolean {
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

async function commandIsResolvable(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (looksLikeShellCommand(trimmed)) return true;
  if (path.isAbsolute(trimmed) || hasPathSeparator(trimmed)) return pathExists(trimmed);
  return (await findCommandOnPath(trimmed)) !== null;
}

async function resolveCodexAcpCommand(config: Record<string, unknown>): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  return (
    (await findAncestorBin(packageRootDir, "codex-acp")) ??
    (await findCommandOnPath("codex-acp")) ??
    path.join(packageRootDir, "node_modules", ".bin", "codex-acp")
  );
}

async function defaultCodexAcpFallbackReason(
  input: CodexEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote") {
    return "Codex ACP currently supports only the local Paperclip host, but this run targets a remote environment.";
  }
  if (!nodeVersionMeetsCodexAcpMinimum()) {
    return `Node ${process.version} does not satisfy Codex ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = await resolveCodexAcpCommand(input.config);
  if (!(await commandIsResolvable(command))) {
    return `Codex ACP server command is not available: ${command}.`;
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

async function hasCodexNativeCredentials(codexHome: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(codexHome, "auth.json"), "utf8").catch(() => null);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return isNonEmpty(record.OPENAI_API_KEY) || isNonEmpty(record.refresh_token);
  } catch {
    return false;
  }
}

export async function testCodexAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "codex_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the existing Codex CLI lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "codex_acp_remote_target_unsupported",
      level: "error",
      message: "Codex ACP currently runs on the local Paperclip host and cannot target a remote execution environment.",
      hint: "Use engine=cli for remote or sandbox Codex runs.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "codex_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsCodexAcpMinimum() ? "codex_acp_node_supported" : "codex_acp_node_unsupported",
    level: nodeVersionMeetsCodexAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsCodexAcpMinimum()
      ? `Node ${process.version} satisfies ACP runtime requirements.`
      : `Node ${process.version} does not satisfy ACP runtime requirements.`,
    hint: nodeVersionMeetsCodexAcpMinimum()
      ? undefined
      : `Run Codex ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = await resolveCodexAcpCommand(config);
  const commandResolvable = await commandIsResolvable(command);
  checks.push({
    code: commandResolvable ? "codex_acp_command_resolvable" : "codex_acp_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Codex ACP server command is executable: ${command}`
      : `Codex ACP server command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install dependencies so @agentclientprotocol/codex-acp is present, or set agentCommand to a valid Codex ACP server command.",
  });

  const envConfig = parseObject(config.env);
  const considerHostEnv = !targetIsRemote;
  const configApiKey = envConfig.OPENAI_API_KEY;
  const hostApiKey = considerHostEnv ? process.env.OPENAI_API_KEY : undefined;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_acp_openai_api_key_detected",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex ACP authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    const codexHome = isNonEmpty(envConfig.CODEX_HOME)
      ? envConfig.CODEX_HOME
      : path.join(process.env.HOME ?? "", ".codex");
    if (codexHome && await hasCodexNativeCredentials(codexHome)) {
      checks.push({
        code: "codex_acp_native_auth_detected",
        level: "info",
        message: "Codex ACP can use Codex native authentication.",
        detail: `Credentials found in ${path.join(codexHome, "auth.json")}.`,
      });
    } else {
      checks.push({
        code: "codex_acp_credentials_missing",
        level: "warn",
        message: "No Codex ACP credentials were detected.",
        hint: "Set OPENAI_API_KEY or run `codex login` before starting a Codex ACP agent.",
      });
    }
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "codex_acp_runtime_scaffold",
    level: "info",
    message: "Codex ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
