import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  overrideAdapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
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
import { createWorkspaceRestoreTeardown } from "@paperclipai/adapter-utils/workspace-restore-teardown";
import { normalizeCodexModel } from "../index.js";
import { classifyCodexAuthRefreshFailure } from "./parse.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import { buildCodexAuthInboundProvision } from "./codex-auth-merge-scripts.js";
import {
  codexHomeHasUsableAuth,
  evaluateCodexCredentialReadiness,
  resolveSharedCodexHomeDir,
  stageCodexHomeForSync,
} from "./codex-home.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";
import {
  classifyCodexProbeAuth,
  snapshotDurableCodexProbeAuth,
} from "./codex-probe-auth.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "24.11.0";
const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;
const CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_AUTH_JSON",
  "_PAPERCLIP_CODEX_AUTH_JSON",
] as const;
const CODEX_ACP_PROBE_AUTH_ENV_KEYS = new Set<string>(
  CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES,
);
const CODEX_ACP_PROBE_HOME_STAGE_SCRIPT = [
  "set -eu",
  "umask 077",
  `node -e '${[
    'const fs=require("node:fs")',
    'const path=require("node:path")',
    'const home=process.env.CODEX_HOME',
    'if(!home)throw new Error("missing probe home")',
    'const parent=path.dirname(home)',
    'fs.mkdirSync(parent,{recursive:true,mode:0o700})',
    'fs.chmodSync(parent,0o700)',
    'const parentStat=fs.lstatSync(parent)',
    'if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw new Error("invalid probe parent")',
    'fs.mkdirSync(home,{mode:0o700})',
    'const homeStat=fs.lstatSync(home)',
    'if(!homeStat.isDirectory()||homeStat.isSymbolicLink())throw new Error("invalid probe home")',
    'const payload=JSON.parse(fs.readFileSync(0,"utf8"))',
    'if(typeof payload.authJson==="string")fs.writeFileSync(path.join(home,"auth.json"),Buffer.from(payload.authJson,"base64"),{mode:0o600,flag:"wx"})',
  ].join(";")}'`,
].join("; ");

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
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.workspaceRealization?.mode === "in_place") {
    if (selection.explicit && selection.engine === "acp") {
      throw new Error("In-place workspace realization requires the Codex CLI engine; ACP archive staging is not supported.");
    }
    return {
      engine: "cli",
      explicit: selection.explicit,
      ...(!selection.explicit
        ? { fallbackReason: "In-place workspace realization must run without ACP archive staging." }
        : {}),
    };
  }
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
  // Rewrite legacy model aliases (e.g. bare gpt-5.6) to the concrete slug Codex has metadata for,
  // so the ACP session config matches the CLI lane and avoids the fallback-metadata warning.
  const normalizedModel = normalizeCodexModel(
    typeof config.model === "string" ? config.model : "",
  );

  return {
    ...config,
    agent: "codex",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(normalizedModel ? { model: normalizedModel } : {}),
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
    // Fail-soft: a teardown copy-back miss loses this rotation and surfaces
    // loudly as refresh_token_reused on the next host Codex use (re-auth
    // recovers) — never silent host-credential corruption, so it must not
    // mask the run result.
    teardown: createWorkspaceRestoreTeardown({
      stagedRuntime,
      onLog,
      startMessage: "[paperclip] Restoring workspace changes and Codex auth from the sandbox.\n",
      failurePrefix: "[paperclip] Codex ACP teardown restore/copy-back failed",
    }),
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

type CodexAcpLiveProbeExecutor = (
  ctx: AdapterExecutionContext,
) => Promise<AdapterExecutionResult>;

type CodexAcpLiveProbeOptions = {
  execute?: CodexAcpLiveProbeExecutor;
  createExecutor?: (options: CodexAcpExecutorOptions) => CodexAcpLiveProbeExecutor;
};

function buildCodexAcpAuthRequiredChecks(targetIsSandbox: boolean): AdapterEnvironmentCheck[] {
  const checks: AdapterEnvironmentCheck[] = [
    {
      code: "codex_hello_probe_auth_required",
      level: "warn",
      message: "Codex is available, but authentication is not ready.",
      hint: "Configure Codex authentication in the selected environment and retry the live test.",
    },
  ];
  if (targetIsSandbox) {
    checks.push({
      code: ADAPTER_AUTH_MISSING_CHECK_CODE,
      level: "warn",
      message: "This environment has no ready authentication for this adapter.",
      hint: "Provide credentials for this adapter, or start login in the environment.",
    });
  }
  return checks;
}

function classifyCodexAcpLiveProbeResult(
  result: AdapterExecutionResult,
  targetIsSandbox: boolean,
): AdapterEnvironmentCheck[] {
  const resultJson = parseObject(result.resultJson);
  if (isNonEmpty(resultJson.workspaceRestoreFailure)) {
    return [{
      code: "codex_hello_probe_cleanup_failed",
      level: "error",
      message: "Codex replied, but environment cleanup did not complete safely.",
      hint: "Repair Codex authentication in the selected environment, then retry the live test.",
    }];
  }

  if (result.timedOut) {
    return [{
      code: "codex_hello_probe_timed_out",
      level: "warn",
      message: "Codex hello probe timed out.",
      hint: "Retry the live test after verifying Codex can reach its model provider.",
    }];
  }

  const summary = result.summary?.trim() ?? "";
  if ((result.exitCode ?? 1) === 0) {
    const hasHello = summary === "Hello.";
    return [{
      code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Codex hello probe succeeded."
        : "Codex probe ran but did not return `hello` as expected.",
      ...(hasHello ? { detail: "Hello." } : {}),
      ...(!hasHello ? { hint: "Retry the live test before hiring this agent." } : {}),
    }];
  }

  const classifiedError = firstNonEmptyString(
    result.errorCode,
    result.errorFamily,
    resultJson.errorFamily,
  );
  if (
    classifiedError === "acpx_auth_required" ||
    classifiedError?.startsWith("refresh_token_")
  ) {
    return buildCodexAcpAuthRequiredChecks(targetIsSandbox);
  }

  const stopReason = asString(resultJson.stopReason, "");
  const authEvidence = [result.errorMessage ?? "", summary, stopReason].join("\n");
  if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
    return buildCodexAcpAuthRequiredChecks(targetIsSandbox);
  }
  return [{
    code: "codex_hello_probe_failed",
    level: "error",
    message: "Codex hello probe failed.",
    hint: "Verify the selected Codex model, authentication, and execution environment, then retry.",
  }];
}

function isCodexAcpCleanupFailureLog(
  stream: "stdout" | "stderr",
  chunk: string,
): boolean {
  if (stream !== "stderr") return false;
  return (
    (chunk.includes('[paperclip] ACPX teardown step "') && chunk.includes('" failed:')) ||
    chunk.includes("[paperclip] Failed to remove staged Codex home ") ||
    chunk.includes("[paperclip] Codex ACP teardown restore/copy-back failed:")
  );
}

function codexAcpProbeFailedCheck(): AdapterEnvironmentCheck[] {
  return [{
    code: "codex_hello_probe_failed",
    level: "error",
    message: "Codex hello probe failed.",
    hint: "Verify the selected Codex model, authentication, and execution environment, then retry.",
  }];
}

function codexAcpProbeCleanupFailedCheck(): AdapterEnvironmentCheck[] {
  return [{
    code: "codex_hello_probe_cleanup_failed",
    level: "error",
    message: "Codex replied, but environment cleanup did not complete safely.",
    hint: "Retry the live test after checking the selected environment's runtime health.",
  }];
}

function stripCodexAcpProbeAuthEnv(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !CODEX_ACP_PROBE_AUTH_ENV_KEYS.has(entry[0].toUpperCase()),
    ),
  );
}

async function materializeCodexAcpProbeHome(input: {
  probeRoot: string;
  runId: string;
  companyId: string;
  config: Record<string, unknown>;
  targetIsSandbox: boolean;
}): Promise<{
  probeHome: string;
}> {
  const configEnv = parseObject(input.config.env);
  const configuredCodexHome = isNonEmpty(configEnv.CODEX_HOME)
    ? configEnv.CODEX_HOME
    : null;
  const readiness = await evaluateCodexCredentialReadiness({
    env: process.env,
    companyId: input.companyId,
    configuredCodexHome,
    configuredApiKey: null,
  });
  const sourceHome = readiness.managed &&
      !(await codexHomeHasUsableAuth(readiness.effectiveHome))
    ? readiness.sharedSourceHome
    : readiness.effectiveHome;
  const configuredAuthJson = firstNonEmptyString(
    configEnv.CODEX_AUTH_JSON,
    configEnv._PAPERCLIP_CODEX_AUTH_JSON,
  );
  const configDefinesApiKey =
    Object.prototype.hasOwnProperty.call(configEnv, "OPENAI_API_KEY") ||
    Object.prototype.hasOwnProperty.call(configEnv, "CODEX_API_KEY");
  const configuredApiKey = firstNonEmptyString(
    configEnv.OPENAI_API_KEY,
    configEnv.CODEX_API_KEY,
  );
  const hostApiKey = input.targetIsSandbox || configDefinesApiKey
    ? null
    : firstNonEmptyString(process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY);
  const apiKey = configuredApiKey ?? hostApiKey;
  const authJson = configuredAuthJson ?? (
    apiKey ? JSON.stringify({ OPENAI_API_KEY: apiKey }) : null
  );
  if (authJson && classifyCodexProbeAuth(Buffer.from(authJson, "utf8")) !== "api_key") {
    throw new Error("codex_probe_nonpersistent_subscription_auth_unsupported");
  }
  const durableSnapshot = authJson
    ? null
    : await snapshotDurableCodexProbeAuth(sourceHome).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
  if (durableSnapshot?.kind === "unsupported") {
    throw new Error("codex_probe_auth_format_unsupported");
  }
  if (durableSnapshot?.kind === "subscription") {
    if (input.targetIsSandbox) {
      // A sandbox can rotate a refresh token before the result is copied back.
      // A host crash in that interval would destroy the only usable token, so
      // subscription-backed probes stay local until the runner offers a
      // transactional credential channel. Local probes use the durable home
      // directly, making any Codex rotation durable at the write boundary.
      throw new Error("codex_probe_remote_subscription_auth_unsupported");
    }
    // The probe executor disables all Paperclip skill preparation before it
    // points Codex at this durable home. That leaves refresh-token rotation on
    // its crash-durable path without reconciling or rewriting operator skills.
    return { probeHome: sourceHome };
  }
  const probeHome = path.join(input.probeRoot, "codex-home");
  try {
    // The probe home starts empty. Copying the operator home would also copy
    // config.toml, which can contain MCP bearer headers and tool definitions.
    // Authentication is the only state this bounded proof needs.
    await fs.mkdir(probeHome, { mode: 0o700 });
  } catch {
    throw new Error("codex_probe_home_materialization_failed");
  }

  if (authJson) {
    const authPath = path.join(probeHome, "auth.json");
    await fs.rm(authPath, { force: true });
    await fs.writeFile(authPath, authJson, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(authPath, 0o600);
  } else if (durableSnapshot) {
    const authPath = path.join(probeHome, "auth.json");
    await fs.rm(authPath, { force: true });
    await fs.writeFile(authPath, durableSnapshot.bytes, { mode: 0o600, flag: "wx" });
    await fs.chmod(authPath, 0o600);
  }
  await fs.chmod(probeHome, 0o700);
  return { probeHome };
}

async function prepareCodexAcpProbeRemoteManagedHome(
  input: AcpxRemoteManagedHomeContext,
): Promise<AcpxRemoteManagedHomeResult> {
  // The credential home was staged separately over stdin so credential bytes
  // never enter the generic archive uploader's command text. This callback
  // stages only the workspace and preserves the already-bound remote home.
  return { stagedRuntime: await input.stage([]) };
}

async function stageCodexAcpRemoteProbeHome(input: {
  ctx: AdapterEnvironmentTestContext;
  runId: string;
  localProbeHome: string;
  remoteProbeHome: string;
}): Promise<void> {
  // Never forward config.toml: it can contain MCP Authorization headers. The
  // bounded proof receives only auth.json; model/runtime settings travel via
  // the non-secret run config built below.
  const authJson = await fs.readFile(path.join(input.localProbeHome, "auth.json")).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const stageTarget = overrideAdapterExecutionTargetRemoteCwd(input.ctx.executionTarget, "/tmp");
  const staged = await runAdapterExecutionTargetProcess(
    `${input.runId}-auth-stage`,
    stageTarget,
    "sh",
    ["-c", CODEX_ACP_PROBE_HOME_STAGE_SCRIPT],
    {
      cwd: "/tmp",
      env: { CODEX_HOME: input.remoteProbeHome },
      denyEnvironmentKeys: CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES,
      stdin: JSON.stringify({
        authJson: authJson?.toString("base64") ?? null,
      }),
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    },
  );
  if (!adapterProcessSucceeded(staged)) {
    throw new Error("codex_probe_auth_stage_failed");
  }
}

function adapterProcessSucceeded(result: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}): boolean {
  return !result.timedOut && result.signal === null && result.exitCode === 0;
}

async function removeAndVerifyCodexAcpRemoteProbeRoot(input: {
  ctx: AdapterEnvironmentTestContext;
  runId: string;
  remoteProbeRoot: string;
}): Promise<boolean> {
  const cleanupTarget = overrideAdapterExecutionTargetRemoteCwd(
    input.ctx.executionTarget,
    "/tmp",
  );
  let succeeded = true;
  try {
    const removal = await runAdapterExecutionTargetProcess(
      `${input.runId}-cleanup`,
      cleanupTarget,
      "rm",
      ["-rf", "--", input.remoteProbeRoot],
      {
        cwd: "/tmp",
        env: {},
        denyEnvironmentKeys: CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES,
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if (!adapterProcessSucceeded(removal)) succeeded = false;
  } catch {
    succeeded = false;
  }
  try {
    const verification = await runAdapterExecutionTargetProcess(
      `${input.runId}-cleanup-verify`,
      cleanupTarget,
      "sh",
      ["-c", '[ ! -e "$1" ] && [ ! -L "$1" ]', "sh", input.remoteProbeRoot],
      {
        cwd: "/tmp",
        env: {},
        denyEnvironmentKeys: CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES,
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if (!adapterProcessSucceeded(verification)) succeeded = false;
  } catch {
    succeeded = false;
  }
  return succeeded;
}

/** Run one bounded ACP turn without exposing provider output in diagnostics. */
export async function probeCodexAcpLiveReply(
  ctx: AdapterEnvironmentTestContext,
  config: Record<string, unknown>,
  options: CodexAcpLiveProbeOptions = {},
): Promise<AdapterEnvironmentCheck[]> {
  const runId = `codex-acp-envtest-${randomUUID()}`;
  let probeRoot: string;
  try {
    probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-envtest-"));
  } catch {
    return codexAcpProbeFailedCheck();
  }
  const workspaceDir = path.join(probeRoot, "workspace");
  const warmHandles: NonNullable<AcpxEngineExecutorOptions["warmHandles"]> = new Map();
  const stagedRuntimes: NonNullable<AcpxEngineExecutorOptions["stagedRuntimes"]> = new Map();
  const stagingLocks: NonNullable<AcpxEngineExecutorOptions["stagingLocks"]> = new Map();
  const {
    paperclipRuntimeSkills: _paperclipRuntimeSkills,
    paperclipSkillSync: _paperclipSkillSync,
    agentCommand: _agentCommand,
    acpAgentCommand: _acpAgentCommand,
    ...probeBaseConfig
  } = config;
  const targetIsSandbox =
    ctx.executionTarget?.kind === "remote" && ctx.executionTarget.transport === "sandbox";
  const remoteProbeRoot = targetIsSandbox
    ? path.posix.join("/tmp", `paperclip-codex-acp-envtest-${runId}`)
    : null;
  const probeExecutionTarget = remoteProbeRoot
    ? overrideAdapterExecutionTargetRemoteCwd(ctx.executionTarget, remoteProbeRoot)
    : ctx.executionTarget;
  let probeAuth: {
    probeHome: string;
  } | null = null;
  let activeProbeHome: string | null = null;
  let checks = codexAcpProbeFailedCheck();
  let cleanupFailed = false;
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    probeAuth = await materializeCodexAcpProbeHome({
      probeRoot,
      runId,
      companyId: ctx.companyId,
      config: probeBaseConfig,
      targetIsSandbox,
    });
    activeProbeHome = probeAuth.probeHome;
    if (remoteProbeRoot) {
      activeProbeHome = path.posix.join(remoteProbeRoot, "codex-home");
      await stageCodexAcpRemoteProbeHome({
        ctx,
        runId,
        localProbeHome: probeAuth.probeHome,
        remoteProbeHome: activeProbeHome,
      });
    }
    const probeConfig = {
      ...probeBaseConfig,
      env: {
        ...stripCodexAcpProbeAuthEnv(parseObject(probeBaseConfig.env)),
        CODEX_HOME: activeProbeHome,
      },
      engine: "acp",
      mode: "oneshot",
      permissionMode: "deny-all",
      nonInteractivePermissions: "fail",
      warmHandleIdleMs: 0,
      cwd: workspaceDir,
      stateDir: path.join(probeRoot, "state"),
      timeoutSec: targetIsSandbox ? 90 : 45,
      instructionsFilePath: "",
      bootstrapPromptTemplate: "",
      promptTemplate: "Reply with exactly Hello. Do not use tools.",
    };
    const execute = options.execute ?? (options.createExecutor ?? createCodexAcpExecutor)({
      warmHandles,
      stagedRuntimes,
      stagingLocks,
      denyEnvironmentKeys: CODEX_ACP_PROBE_AUTH_ENV_KEY_NAMES,
      // A local subscription probe must use the durable auth home directly so
      // token rotation survives a host crash. Do not let this read-only proof
      // reconcile skills or write the managed-skill manifest in that home.
      skipRuntimeSkillPreparation: true,
      prepareRemoteManagedHome: prepareCodexAcpProbeRemoteManagedHome,
      onTeardownFailure: () => {
        cleanupFailed = true;
      },
    });
    const result = await execute({
      runId,
      agent: {
        id: runId,
        companyId: ctx.companyId,
        name: "Codex connection test",
        adapterType: ctx.adapterType,
        adapterConfig: probeConfig,
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: probeConfig,
      // The proof never grants Paperclip API authority. A non-secret, invalid
      // run-local token satisfies the bridge transport contract while any
      // accidental Paperclip tool call remains unauthorized.
      authToken: runId,
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_workspace",
          workspaceId: runId,
        },
      },
      executionTarget: probeExecutionTarget,
      onLog: async (stream, chunk) => {
        if (isCodexAcpCleanupFailureLog(stream, chunk)) cleanupFailed = true;
      },
    });
    checks = classifyCodexAcpLiveProbeResult(result, targetIsSandbox);
  } catch {
    checks = codexAcpProbeFailedCheck();
  } finally {
    for (const entry of warmHandles.values()) {
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      try {
        await entry.runtime.close({
          handle: entry.handle,
          reason: "paperclip environment test cleanup",
          discardPersistentState: true,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    warmHandles.clear();
    for (const entry of stagedRuntimes.values()) {
      try {
        await entry.dispose?.();
      } catch {
        cleanupFailed = true;
      }
    }
    stagedRuntimes.clear();
    stagingLocks.clear();
    if (remoteProbeRoot) {
      const removed = await removeAndVerifyCodexAcpRemoteProbeRoot({
        ctx,
        runId,
        remoteProbeRoot,
      });
      if (!removed) cleanupFailed = true;
    }
    try {
      await fs.rm(probeRoot, { recursive: true, force: true });
      if (await fs.lstat(probeRoot).catch(() => null)) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    return codexAcpProbeCleanupFailedCheck();
  }
  return checks;
}

type CodexAcpEnvironmentTestOptions = {
  liveProbe?: (
    ctx: AdapterEnvironmentTestContext,
    config: Record<string, unknown>,
  ) => Promise<AdapterEnvironmentCheck[]>;
};

export async function testCodexAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
  options: CodexAcpEnvironmentTestOptions = {},
): Promise<AdapterEnvironmentTestResult> {
  let checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";

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
    if (!targetIsSandbox) {
      checks.push({
        code: "codex_acp_remote_target_unsupported",
        level: "error",
        message: "Codex ACP live testing supports local and sandbox environments only.",
        hint: "Use the Codex CLI engine for this remote environment, or select a sandbox environment with a process-session runner.",
      });
    } else if (!sandboxTargetHasProcessSessionBridge(target)) {
      checks.push({
        code: "codex_acp_sandbox_runner_missing",
        level: "error",
        message: "This sandbox cannot run a live Codex ACP session.",
        hint: "Select a sandbox environment with a bidirectional process-session runner.",
      });
    }
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    if (target?.kind === "remote") {
      if (!target.remoteCwd.trim() || !path.posix.isAbsolute(target.remoteCwd)) {
        throw new Error("invalid_remote_cwd");
      }
    } else {
      await fs.mkdir(cwd, { recursive: true });
    }
    checks.push({
      code: "codex_acp_cwd_valid",
      level: "info",
      message: "Working directory is valid.",
    });
  } catch {
    checks.push({
      code: "codex_acp_cwd_invalid",
      level: "error",
      message: "Working directory is invalid or inaccessible.",
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

  const configuredAgentCommand = firstNonEmptyString(
    config.agentCommand,
    config.acpAgentCommand,
  );
  if (configuredAgentCommand) {
    checks.push({
      code: "codex_acp_custom_command_unsupported_for_live_proof",
      level: "error",
      message: "Codex ACP live proof requires the canonical Codex ACP command.",
      hint: "Remove the custom ACP agent command and retry the live test.",
    });
  } else {
    const command = await resolveCodexAcpCommandForTarget(config, target);
    const commandResolvable = await commandIsResolvable(command, {
      config,
      executionTarget: ctx.executionTarget,
    });
    checks.push({
      code: commandResolvable ? "codex_acp_command_resolvable" : "codex_acp_command_missing",
      level: commandResolvable ? "info" : "error",
      message: commandResolvable
        ? "Codex ACP server command is executable."
        : "Codex ACP server command is not available.",
      hint: commandResolvable
        ? undefined
        : "Install dependencies so @agentclientprotocol/codex-acp is present.",
    });
  }

  const envConfig = parseObject(config.env);
  if (!targetIsRemote) {
    const configApiKey = firstNonEmptyString(envConfig.OPENAI_API_KEY, envConfig.CODEX_API_KEY) ?? null;
    const configDefinesApiKey =
      Object.prototype.hasOwnProperty.call(envConfig, "OPENAI_API_KEY") ||
      Object.prototype.hasOwnProperty.call(envConfig, "CODEX_API_KEY");
    const hostApiKey =
      configDefinesApiKey
        ? null
        : firstNonEmptyString(process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY) ?? null;
    const configuredApiKey = configApiKey ?? hostApiKey;
    const configuredCodexHome = isNonEmpty(envConfig.CODEX_HOME) ? envConfig.CODEX_HOME : null;
    const credentialReadiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: ctx.companyId,
      configuredCodexHome,
      configuredApiKey,
    });

    if (credentialReadiness.ready && credentialReadiness.authMode === "api") {
      checks.push({
        code: "codex_acp_openai_api_key_detected",
        level: "info",
        message: "An API key is set for Codex ACP authentication.",
      });
    } else if (credentialReadiness.ready && !credentialReadiness.managed) {
      checks.push({
        code: "codex_acp_external_home_configured",
        level: "info",
        message: "Codex ACP will use an externally managed CODEX_HOME.",
      });
    } else if (credentialReadiness.ready) {
      checks.push({
        code: "codex_acp_native_auth_detected",
        level: "info",
        message: "Codex ACP can use Codex native authentication.",
      });
    } else {
      checks.push({
        code: "codex_acp_credentials_missing",
        level: "warn",
        message: "No Codex ACP credentials visible to the Paperclip server were detected.",
        hint: "Set OPENAI_API_KEY in the agent adapter env, set it in the Paperclip server environment, or run `codex login` for the same OS user that runs the Paperclip server before starting a Codex ACP agent. A `/login` in a separate Codex/chat session does not authenticate the server.",
      });
    }
  } else if (targetIsSandbox) {
    // Predict readiness from credentials Paperclip can seed, but let the live
    // sandbox turn decide because the selected environment may provide its own auth.
    const configApiKey = firstNonEmptyString(envConfig.OPENAI_API_KEY, envConfig.CODEX_API_KEY) ?? null;
    const configuredCodexHome = isNonEmpty(envConfig.CODEX_HOME) ? envConfig.CODEX_HOME : null;
    const credentialReadiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: ctx.companyId,
      configuredCodexHome,
      configuredApiKey: configApiKey,
    });
    if (!credentialReadiness.ready) {
      // Emit the neutral canonical check so the user interface can decide login
      // eligibility from a stable code. The user interface does not read the
      // message text or the top-level status.
      checks.push({
        code: ADAPTER_AUTH_MISSING_CHECK_CODE,
        level: "warn",
        message: "This environment has no ready authentication for this adapter.",
        hint: "Provide credentials for this adapter, or start login in the environment.",
      });
    }
  }

  const canRunLiveProbe = !checks.some((check) => check.level === "error");
  if (canRunLiveProbe) {
    const liveChecks = await (options.liveProbe ?? probeCodexAcpLiveReply)(ctx, config);
    if (
      liveChecks.some(
        (check) => check.code === "codex_hello_probe_passed" && check.level === "info",
      )
    ) {
      const predictiveAuthWarnings = new Set([
        "codex_acp_credentials_missing",
        ADAPTER_AUTH_MISSING_CHECK_CODE,
      ]);
      const retainedChecks = checks.filter((check) => !predictiveAuthWarnings.has(check.code));
      checks = [...retainedChecks, ...liveChecks];
    } else {
      checks.push(...liveChecks);
    }
  }

  checks.push({
    code: "codex_acp_runtime_scaffold",
    level: "info",
    message: "Codex ACP runtime execution is available through the shared ACP engine.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
