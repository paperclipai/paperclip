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
  asNumber,
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  createAcpxLocalExecutor,
} from "@paperclipai/adapter-acpx-local/server";
import {
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
} from "@paperclipai/adapter-acpx-local";
import {
  DEFAULT_CODEX_LOCAL_ACP_WARM_HANDLE_IDLE_MS,
} from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const acpxLocalPackageRootDir = path.resolve(packageRootDir, "../acpx-local");
const MIN_ACP_NODE_VERSION = "22.12.0";

export type CodexExecutionEngine = "cli" | "acp";

export interface CodexEngineSelection {
  engine: CodexExecutionEngine;
  explicit: boolean;
  fallbackReason?: string;
}

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
  input: Pick<AdapterExecutionContext, "config"> &
    Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>,
): Promise<CodexEngineSelection> {
  const selection = normalizeEngine(input.config.engine);
  if (selection.explicit || selection.engine !== "acp") return selection;

  const fallbackReason = await defaultCodexAcpFallbackReason(input);
  if (!fallbackReason) return selection;
  return { engine: "cli", explicit: false, fallbackReason };
}

export function formatCodexAcpFallbackMessage(reason: string): string {
  return `[paperclip] Codex ACPX unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACPX or engine=cli to silence this fallback.\n`;
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
  const agentCommand = firstNonEmptyString(config.acpAgentCommand, config.agentCommand);
  const stateDir = firstNonEmptyString(config.acpStateDir, config.stateDir);
  const mode = firstNonEmptyString(config.acpMode, config.mode) ?? DEFAULT_ACPX_LOCAL_MODE;
  const permissionMode =
    firstNonEmptyString(config.acpPermissionMode, config.permissionMode) ??
    DEFAULT_ACPX_LOCAL_PERMISSION_MODE;
  const nonInteractivePermissions =
    firstNonEmptyString(config.acpNonInteractivePermissions, config.nonInteractivePermissions) ??
    DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS;
  const warmHandleIdleMs =
    config.acpWarmHandleIdleMs ??
    config.warmHandleIdleMs ??
    DEFAULT_CODEX_LOCAL_ACP_WARM_HANDLE_IDLE_MS;

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

async function commandIsResolvable(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (looksLikeShellCommand(trimmed)) return true;
  if (path.isAbsolute(trimmed) || hasPathSeparator(trimmed)) return pathExists(trimmed);
  return (await findCommandOnPath(trimmed)) !== null;
}

async function resolveCodexAcpCommand(config: Record<string, unknown>): Promise<string> {
  const configured = firstNonEmptyString(config.acpAgentCommand, config.agentCommand);
  if (configured) return configured;
  const bundled = path.join(acpxLocalPackageRootDir, "node_modules", ".bin", "codex-acp");
  if (await pathExists(bundled)) return bundled;
  return (await findCommandOnPath("codex-acp")) ?? bundled;
}

async function defaultCodexAcpFallbackReason(
  input: Pick<AdapterExecutionContext, "config"> &
    Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote") {
    return "Codex ACPX currently supports only the local Paperclip host, but this run targets a remote environment.";
  }
  if (!nodeVersionMeetsCodexAcpMinimum()) {
    return `Node ${process.version} does not satisfy Codex ACPX's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = await resolveCodexAcpCommand(input.config);
  if (!(await commandIsResolvable(command))) {
    return `Codex ACP server command is not available: ${command}.`;
  }
  return null;
}

function hasOpenAiApiKey(config: Record<string, unknown>): boolean {
  const envConfig = parseObject(config.env);
  const configured = asString(envConfig.OPENAI_API_KEY, "").trim();
  const inherited = process.env.OPENAI_API_KEY?.trim() ?? "";
  return configured.length > 0 || inherited.length > 0;
}

export function createCodexAcpExecutor(): CodexAcpExecutor {
  const executeAcpx = createAcpxLocalExecutor();
  return async (ctx) => {
    const acpConfig = buildCodexAcpConfig(ctx.config);
    const apiKeyAuth = hasOpenAiApiKey(acpConfig);
    const result = await executeAcpx({
      ...ctx,
      config: acpConfig,
      onMeta: ctx.onMeta
        ? async (meta) => {
            await ctx.onMeta?.({
              ...meta,
              adapterType: "codex_local",
              commandNotes: [
                "Execution engine: ACPX.",
                ...(meta.commandNotes ?? []),
              ],
            });
          }
        : undefined,
    });

    return {
      ...result,
      provider: result.provider === "acpx" || !result.provider ? "openai" : result.provider,
      biller: result.biller ?? (apiKeyAuth ? "openai" : "chatgpt"),
      billingType:
        result.billingType && result.billingType !== "unknown"
          ? result.billingType
          : apiKeyAuth
            ? "api"
            : "subscription",
      resultJson: {
        ...(result.resultJson ?? {}),
        executionEngine: "acp",
        acpxAgent: "codex",
      },
    };
  };
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
    message: "Execution engine selected: ACPX.",
    hint: "Set engine=cli to use the existing Codex CLI lane.",
  });

  if (targetIsRemote) {
    checks.push({
      code: "codex_acpx_remote_target_unsupported",
      level: "error",
      message: "Codex ACPX currently runs on the local Paperclip host and cannot target a remote execution environment.",
      hint: "Use engine=cli for remote or sandbox Codex runs.",
    });
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await fs.mkdir(cwd, { recursive: true });
    checks.push({
      code: "codex_acpx_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_acpx_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsCodexAcpMinimum() ? "codex_acpx_node_supported" : "codex_acpx_node_unsupported",
    level: nodeVersionMeetsCodexAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsCodexAcpMinimum()
      ? `Node ${process.version} satisfies ACPX runtime requirements.`
      : `Node ${process.version} does not satisfy ACPX runtime requirements.`,
    hint: nodeVersionMeetsCodexAcpMinimum()
      ? undefined
      : `Run Codex ACPX with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = await resolveCodexAcpCommand(config);
  const commandResolvable = await commandIsResolvable(command);
  checks.push({
    code: commandResolvable ? "codex_acpx_command_resolvable" : "codex_acpx_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Codex ACP server command is executable: ${command}`
      : `Codex ACP server command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install the bundled ACPX dependencies, or set acpAgentCommand to a valid Codex ACP server command.",
  });

  const envConfig = parseObject(config.env);
  const configApiKey = envConfig.OPENAI_API_KEY;
  const hostApiKey = targetIsRemote ? undefined : process.env.OPENAI_API_KEY;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_acpx_openai_api_key_detected",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex ACPX authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    const codexHome = isNonEmpty(envConfig.CODEX_HOME)
      ? envConfig.CODEX_HOME
      : path.join(process.env.HOME ?? "", ".codex");
    if (codexHome && await hasCodexNativeCredentials(codexHome)) {
      checks.push({
        code: "codex_acpx_native_auth_detected",
        level: "info",
        message: "Codex ACPX can use Codex native authentication.",
        detail: `Credentials found in ${path.join(codexHome, "auth.json")}.`,
      });
    } else {
      checks.push({
        code: "codex_acpx_credentials_missing",
        level: "warn",
        message: "No Codex ACPX credentials were detected.",
        hint: "Set OPENAI_API_KEY or run `codex login` before starting a Codex ACPX agent.",
      });
    }
  }

  const mode = firstNonEmptyString(config.acpMode, config.mode) ?? DEFAULT_ACPX_LOCAL_MODE;
  const warmHandleIdleMs = asNumber(
    config.acpWarmHandleIdleMs ?? config.warmHandleIdleMs,
    DEFAULT_CODEX_LOCAL_ACP_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "codex_acpx_runtime_scaffold",
    level: "info",
    message: "Codex ACPX runtime execution is available through the embedded ACPX adapter.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
