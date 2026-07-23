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
import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";
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
import { classifyCodexAuthRefreshFailure } from "./parse.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import { buildCodexAuthInboundProvision } from "./codex-auth-merge-scripts.js";
import {
  resolveSharedCodexHomeDir,
  stageCodexHomeForSync,
} from "./codex-home.js";

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
  const filesystemScope = parseLocalProcessFilesystemScope(input.config.filesystemScope);
  const networkScope = parseLocalProcessNetworkScope(input.config.networkScope);
  if (filesystemScope || networkScope) {
    if (selection.explicit && selection.engine === "acp") {
      throw new Error("Local filesystem/network confinement requires the Codex CLI engine; ACP confinement is not supported.");
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

/**
 * Codex remote managed-home seed + auth copy-back for the runner-backed remote
 * sandbox ACP lane. Mirrors the codex CLI lane (`codex-local/execute.ts`): stage
 * the managed `CODEX_HOME` (auth.json + config.toml + skills) into the sandbox
 * as the `home` asset — carrying the inbound auth-merge `provision` and the
 * outbound `restore` copy-back seams — then repoint `CODEX_HOME` onto the
 * in-sandbox `assetDirs.home` path. The copy-back rides the asset `restore`,
 * which fires inside `restoreWorkspace()` at teardown.
 *
 * The engine already resolved+seeded the host managed Codex home and set
 * `env.CODEX_HOME` to it (a HOST path) before this seam runs, so `env.CODEX_HOME`
 * is exactly the home to stage. Seed inbound and copy-back outbound land together
 * (never seed-without-copy-back): Codex refresh tokens are single-use, so a
 * refreshed sandbox token that is never copied back would spend the host's token
 * and corrupt the host credential.
 */
async function prepareCodexRemoteManagedHome(
  input: AcpxRemoteManagedHomeContext,
): Promise<AcpxRemoteManagedHomeResult> {
  const { env, runId, onLog } = input;
  // The host managed Codex home the engine seeded and set on env.CODEX_HOME.
  const effectiveCodexHome = env.CODEX_HOME;
  if (!effectiveCodexHome) {
    // No managed home resolved (e.g. custom CODEX_HOME cleared) — stage the
    // workspace with no home asset, identical to the no-seam fallback.
    return { stagedRuntime: await input.stage([]) };
  }
  // Curated allowlist temp dir (auth/config/skills only); caller owns cleanup.
  const stagedCodexHomeDir = await stageCodexHomeForSync(effectiveCodexHome, { runId });
  let stagedRuntime;
  try {
    stagedRuntime = await input.stage([
      {
        key: "home",
        localDir: stagedCodexHomeDir,
        followSymlinks: true,
        // Inbound (host→sandbox) auth-merge: keeps whichever credential is newer
        // when the sandbox image already carries a Codex auth.json.
        provision: buildCodexAuthInboundProvision(),
        // Outbound (sandbox→host) copy-back at teardown, under the same
        // direction-agnostic decision predicate + directory merge-lock +
        // atomic-rename + 0600 guard. Target is the SHARED host auth.json
        // (the symlink source managed homes point at), never an in-sandbox copy.
        restore: async ({ assetDir, readFile }) =>
          void (await copyBackCodexAuth({
            readSandboxAuth: () => readFile(path.posix.join(assetDir, "auth.json")),
            hostAuthPath: path.join(resolveSharedCodexHomeDir(process.env), "auth.json"),
            log: (line) => onLog("stdout", `${line}\n`),
          })),
      },
    ]);
  } catch (err) {
    await fs.rm(stagedCodexHomeDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // Repoint CODEX_HOME from the HOST path onto the seeded in-sandbox home.
  env.CODEX_HOME =
    stagedRuntime.assetDirs.home ??
    path.posix.join(stagedRuntime.runtimeRootDir ?? "", "home");

  return {
    stagedRuntime,
    // Per-run copy-back: fires on EVERY run's teardown (including a compatible
    // resume that reuses this staged runtime). It reads the sandbox auth.json /
    // workspace live and copies back to the host; it does NOT remove the staged
    // in-sandbox home, so re-running it across resumes can't leave a later run
    // without its staged home. Host staged-temp removal is deliberately NOT here
    // — see `disposeStaged` — so caching this runtime for reuse never destroys
    // resources the next resume needs.
    teardown: async () => {
      try {
        await onLog(
          "stdout",
          "[paperclip] Restoring workspace changes and Codex auth from the sandbox.\n",
        );
        await stagedRuntime.restoreWorkspace((line) => onLog("stdout", line));
      } catch (err) {
        // Fail-soft: a teardown copy-back miss loses this rotation and surfaces
        // loudly as refresh_token_reused on the next host Codex use (re-auth
        // recovers) — never silent host-credential corruption, so it must not
        // mask the run result.
        await onLog(
          "stderr",
          `[paperclip] Codex ACP teardown restore/copy-back failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    },
    // One-time cleanup of the HOST staged home temp dir. Fired ONLY when the
    // staged runtime is dropped (failed/cancelled/timed-out turn, incompatible
    // re-stage, idle eviction) — never on a clean turn that keeps the runtime
    // warm — so it can't remove the staged home while a reuse still depends on
    // it. Idempotent: `force: true` no-ops if it was already removed.
    disposeStaged: async () => {
      await fs.rm(stagedCodexHomeDir, { recursive: true, force: true }).catch(async (error) => {
        await onLog(
          "stderr",
          `[paperclip] Failed to remove staged Codex home "${stagedCodexHomeDir}": ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    },
  };
}

function withCodexAcpDefaults(options: CodexAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    resolveBillingIdentity: resolveCodexAcpBillingIdentity,
    prepareRemoteManagedHome: prepareCodexRemoteManagedHome,
    ...options,
    adapterType: "codex_local",
    moduleDir,
    packageRootDir,
  };
}

function withCodexAuthRefreshFailureClassification(result: AdapterExecutionResult): AdapterExecutionResult {
  if ((result.exitCode ?? 0) === 0) return result;
  const resultJson = parseObject(result.resultJson);
  const stopReason = asString(resultJson.stopReason, "");
  const authFailure = classifyCodexAuthRefreshFailure({
    errorMessage: [result.errorMessage ?? "", result.summary ?? "", stopReason]
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
  });
  if (!authFailure) return result;

  return {
    ...result,
    errorCode: authFailure,
    errorFamily: authFailure,
    resultJson: {
      ...(result.resultJson ?? {}),
      errorFamily: authFailure,
    },
  };
}

/**
 * Classify billing the same way the Codex CLI lane does so ACP runs land in
 * the cost ledger with a real provider/billingType instead of acpx/unknown.
 * Host env only counts for local execution targets; remote targets see just
 * the adapter-config env.
 */
export function resolveCodexAcpBillingIdentity(
  ctx: Pick<AdapterExecutionContext, "config"> &
    Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const envConfig = parseObject(parseObject(ctx.config).env);
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const considerHostEnv = target?.kind !== "remote";
  const mergedEnv: NodeJS.ProcessEnv = {
    ...(considerHostEnv ? process.env : {}),
    ...Object.fromEntries(
      Object.entries(envConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
  const apiKey = typeof mergedEnv.OPENAI_API_KEY === "string" && mergedEnv.OPENAI_API_KEY.trim().length > 0;
  const billingType: AdapterBillingType = apiKey ? "api" : "subscription";
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(mergedEnv, "openai");
  const biller =
    openAiCompatibleBiller === "openrouter"
      ? "openrouter"
      : billingType === "subscription"
      ? "chatgpt"
      : openAiCompatibleBiller ?? "openai";
  return { provider: "openai", biller, billingType };
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
    const result = await currentExecutor({
      ...ctx,
      config: buildCodexAcpConfig(ctx.config),
    });
    return withCodexAuthRefreshFailureClassification(result);
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

async function commandIsResolvable(
  command: string,
  input?: CodexEngineResolutionInput,
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

async function resolveCodexAcpCommand(config: Record<string, unknown>): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  return (
    (await findAncestorBin(packageRootDir, "codex-acp")) ??
    (await findCommandOnPath("codex-acp")) ??
    path.join(packageRootDir, "node_modules", ".bin", "codex-acp")
  );
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function resolveCodexAcpCommandForTarget(
  config: Record<string, unknown>,
  target: ReturnType<typeof readAdapterExecutionTarget>,
): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  if (target?.kind === "remote") return "codex-acp";
  return resolveCodexAcpCommand(config);
}

async function defaultCodexAcpFallbackReason(
  input: CodexEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Codex ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Codex ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsCodexAcpMinimum()) {
    return `Node ${process.version} does not satisfy Codex ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = await resolveCodexAcpCommandForTarget(input.config, target);
  if (!(await commandIsResolvable(command, input))) {
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
      code: "codex_acp_remote_target",
      level: "info",
      message: "Codex ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
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

  const command = await resolveCodexAcpCommandForTarget(config, target);
  const commandResolvable = await commandIsResolvable(command, {
    config,
    executionTarget: ctx.executionTarget,
  });
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
