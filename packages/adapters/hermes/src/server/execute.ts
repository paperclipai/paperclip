/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { startHermesProgress } from "./runtime-progress.js";

/**
 * Shared regular expression escaping utility from @paperclipai/adapter-utils.
 * Exported via @paperclipai/adapter-utils/regex and root @paperclipai/adapter-utils.
 */
import { escapeRegExp } from "@paperclipai/adapter-utils/regex";
import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";
import { createRunHome, type RunHome } from "@paperclipai/adapter-utils/run-home";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  buildPaperclipAgentPromptTemplate,
  parseMemoryAgentGuidanceContextResult,
  type MemoryAgentGuidanceContext,
  joinPromptSections,
  selectPaperclipPromptSections,
  resolveEffectiveMemoryHardeningFlags,
  resolveMemoryHardeningFlags,
  type MemoryHardeningFlags,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveEffectiveRunConfig,
} from "./detect-model.js";
import { normalizeConfiguredModel } from "./model-arg.js";
import { reconcileHermesPaperclipSkills, resolveHostHermesDir } from "./skills.js";
import { prepareHermesMcpHome, cleanupHermesMcpHome } from "./mcp-config.js";
import { preflightHermesMcpServers } from "./mcp-preflight.js";
import {
  HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE,
  hasExplicitHermesProviderCredential,
  hermesHostIsolationEnabled,
} from "./isolation.js";
import {
  validateHermesMemoryConfig,
  extractMemorySensitiveValues,
  createChunkAwareStreamingRedactor,
  redactSensitiveString,
  canSafelyRedactSecret,
  MAX_CONFIG_STRING_LENGTH,
  type ValidatedHermesMemoryConfig,
  resolveHermesMemoryProvider,
  type HermesMemoryProvider,
} from "./memory-config.js";
import { applyCommandScanPolicy, getHermesCommandScanMode } from "./command-scan-policy.js";
import {
  RAMP_ROUTER_API_KEY_ENV,
  ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE,
  ROUTER_KEY_MISSING_MESSAGE,
  ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE,
  ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES,
  isRemoteExecutionTarget,
  probeHermesRouterSupport,
  readRouterApiKey,
  resolveRouterLaunchPlan,
  routerEnvNamesToStrip,
} from "./router-readiness.js";
import dotenv from "dotenv";
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

/**
 * Raw key/value view of the operator's host Hermes `.env` (local, non-isolated runs only). Used to
 * check Router readiness and endpoint overrides; values never reach logs.
 */
async function readHostHermesDotenv(config: Record<string, unknown>): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(resolveHostHermesDir(config), ".env"), "utf8");
    return dotenv.parse(content);
  } catch {
    return {};
  }
}

export const HERMES_FORBIDDEN_ENV_VARS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
  "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL",
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PAPERCLIP_DB_BACKUP_DIR",
] as const;

export const HERMES_LIBPQ_ENV_VARS = HERMES_FORBIDDEN_ENV_VARS;

/**
 * Classifies whether a stderr log line is benign and should be reclassified as stdout
 * to avoid appearing as a spurious error in the Paperclip UI.
 *
 * Rules:
 * - Reject any line indicating errors, critical failures, fatal crashes, or tracebacks (even if timestamped).
 * - Allow structured timestamps only if accompanied by benign levels (INFO, DEBUG, WARN, WARNING) or neutral status.
 * - Allow anchored log levels: [INFO], INFO:, etc. with strict word and punctuation boundaries.
 * - Allow anchored MCP lifecycle and application initialization messages.
 */
export function isBenignStderrLog(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true; // empty lines on stderr should not appear as alarm errors

  // Never classify genuine errors, fatal issues, or tracebacks as benign
  if (/\b(?:ERROR|CRITICAL|FATAL)\b|Traceback \(most recent call last\):/i.test(trimmed)) {
    return false;
  }

  // Structured timestamps followed by benign log levels or neutral status
  const timestampPrefixMatch = trimmed.match(
    /^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*(?:-\s+)?/,
  );
  if (timestampPrefixMatch) {
    const afterTimestamp = trimmed.slice(timestampPrefixMatch[0].length).trim();
    return (
      /^\[(?:INFO|DEBUG|WARN|WARNING)\](?:\s*[:-]|\s+|$)/i.test(afterTimestamp) ||
      /^(?:[A-Za-z0-9_.-]+:\s*)?(?:INFO|DEBUG|WARN|WARNING):\s*/i.test(afterTimestamp) ||
      /^(?:[A-Za-z0-9_.-]+\s+-\s+)?\b(?:INFO|DEBUG|WARN|WARNING)\b(?:\s*[:-]|\s+)/i.test(
        afterTimestamp,
      ) ||
      /^(?:Application initialized|Successfully registered all tools|Registered MCP tool|MCP [Ss]erver(?::|\s+(?:connected|initialized|ready|running|started)\b)|(?:MCP\s+)?tool registered successfully\b)/i.test(
        afterTimestamp,
      )
    );
  }

  // Anchored log levels without timestamps (must have explicit brackets, colon, or dash delimiters)
  if (
    /^\[(?:INFO|DEBUG|WARN|WARNING)\](?:\s*[:-]|\s+|$)/i.test(trimmed) ||
    /^(?:[A-Za-z0-9_.-]+:\s*)?(?:INFO|DEBUG|WARN|WARNING):\s*/i.test(trimmed) ||
    /^(?:[A-Za-z0-9_.-]+\s+-\s+)?\b(?:INFO|DEBUG|WARN|WARNING)\b(?:\s*[:-]|\s+)/i.test(trimmed)
  ) {
    return true;
  }

  // Anchored MCP lifecycle and application initialization patterns
  return (
    /^(?:\[INFO\]\s*)?Successfully registered all tools\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?Registered MCP tool\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?(?:MCP\s+)?tool registered successfully\b/i.test(trimmed) ||
    /^(?:\[INFO\]\s*)?MCP [Ss]erver(?::|\s+(?:connected|initialized|ready|running|started)\b)/i.test(
      trimmed,
    ) ||
    /^(?:\[INFO\]\s*)?Application initialized\b/i.test(trimmed)
  );
}

/**
 * Sentinel file placed in /opt/hermes during production Docker image builds.
 * Verifies that the hash-locked requirements closure was baked into the image.
 */
export const HERMES_PRODUCTION_CLOSURE_SENTINEL = ".hermes-production-closure";

/**
 * Required Python modules for Hermes runtime memory capability (mem0 + pgvector).
 * Bundled in the production Docker image closure under /opt/hermes.
 */
export const HERMES_MEMORY_REQUIRED_MODULES = ["mem0", "psycopg", "psycopg2"] as const;

/**
 * Standard Python import statement and structured probe for verifying runtime memory capability.
 * Runs in an isolated subprocess, suppresses noise by redirecting to os.devnull, and outputs strict JSON exclusively.
 */
export const HERMES_MEMORY_PYTHON_IMPORT_CHECK = `import sys, os, json, importlib
mods = ${JSON.stringify(HERMES_MEMORY_REQUIRED_MODULES)}
allow = {"ImportError", "AttributeError", "RuntimeError", "SyntaxError", "TypeError", "ValueError", "OSError", "NameError"}
res = {"r": "ok"}
real_out = sys.stdout
try:
    devnull = open(os.devnull, "w")
    sys.stdout = devnull
    sys.stderr = devnull
except Exception:
    pass
for m in mods:
    try:
        importlib.import_module(m)
    except ModuleNotFoundError as e:
        name = getattr(e, "name", None)
        tr = not (name == m or (isinstance(name, str) and name.startswith(m + ".")))
        res = {"r": "missing", "module": m, "transitive": bool(tr)}
        break
    except Exception as e:
        cls = e.__class__.__name__
        res = {"r": "import_error", "module": m, "exc": cls if cls in allow else "other"}
        break
real_out.write(json.dumps(res))
real_out.flush()`;

/**
 * Default timeout for the Hermes memory import probe (5000 ms).
 */
export const DEFAULT_MEMORY_PROBE_TIMEOUT_MS = 5000;

/**
 * Maximum buffer size for the memory probe stdout/stderr (4 KiB).
 */
export const MEMORY_PROBE_MAX_BUFFER = 4096;

/**
 * Normalized failure reasons for the memory import probe.
 */
export type MemoryProbeReason =
  | "ok"
  | "missing_module"
  | "missing_transitive"
  | "import_error"
  | "timeout"
  | "spawn_error"
  | "signal"
  | "unclassified";

export interface MemoryProbeResult {
  ok: boolean;
  reason: MemoryProbeReason;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  module?: string;
  transitive?: boolean;
  excClass?: string;
  spawnCode?: string;
}

export interface HermesMemoryCapabilityOptions {
  timeoutMs?: number;
  /**
   * Reuse a prior successful probe of the same interpreter + production-closure sentinel for the
   * life of this process. The image's dependency closure cannot change underneath a running
   * container, so one successful import check per container is sufficient evidence.
   */
  cacheSuccess?: boolean;
  /**
   * Extra probe attempts (same budget each) when a probe ends in `timeout`. Applies to both the
   * marked production closure and an unmarked environment with its own interpreter.
   */
  timeoutRetries?: number;
  /**
   * With the hash-pinned production-closure sentinel present, treat a persistent `timeout` as
   * available-with-warning instead of a failure: a timeout is CPU starvation, not evidence of a
   * missing dependency (the structured probe reports those explicitly and they still fail).
   * Sentinel-only, like `cacheSuccess`: in an unmarked environment there is no pinned closure to
   * stand in for probe evidence, so a timeout there stays a failure.
   */
  timeoutFailOpen?: boolean;
}

export interface HermesMemoryCapabilityResult {
  available: boolean;
  error?: string;
  probeResult?: MemoryProbeResult;
  /** Set when the run may proceed but the operator should know why no probe evidence exists. */
  warning?: string;
  /** True when the result came from the per-process success cache (no probe was spawned). */
  cached?: boolean;
  /** Probes spawned (or joined in flight) to reach this result; 0 for a cache hit. */
  attempts?: number;
}

/**
 * Per-process cache of successful production-closure probes, keyed by interpreter path plus the
 * sentinel's content (the closure hash the build wrote). Only successes are cached; timeouts and
 * failures are not. A probe already in flight for the same key is shared by concurrent callers,
 * so N cold-start runs spawn one probe rather than N.
 */
const memoryCapabilityCache = new Map<string, MemoryProbeResult>();
const memoryCapabilityInFlight = new Map<string, Promise<MemoryProbeOutcome>>();

interface MemoryProbeOutcome {
  probeResult: MemoryProbeResult;
  attempts: number;
}

/** Test-only: clears the success cache and in-flight bookkeeping between cases. */
export function resetHermesMemoryCapabilityCacheForTests(): void {
  memoryCapabilityCache.clear();
  memoryCapabilityInFlight.clear();
}

async function probeWithTimeoutRetries(
  pythonBin: string,
  timeoutMs: number | undefined,
  timeoutRetries: number,
): Promise<MemoryProbeOutcome> {
  let probeResult = await runMemoryImportProbe(pythonBin, { timeoutMs });
  let attempts = 1;
  while (!probeResult.ok && probeResult.reason === "timeout" && attempts <= timeoutRetries) {
    probeResult = await runMemoryImportProbe(pythonBin, { timeoutMs });
    attempts += 1;
  }
  return { probeResult, attempts };
}

/**
 * Probe budget for the run path. Production always gets the full default budget. Only under
 * `NODE_ENV === "test"` may `PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS` shorten it (never extend
 * it), so the timeout paths can be exercised quickly; it is ignored everywhere else, the same
 * gate `resolveOptHermesPath` applies to `PAPERCLIP_HERMES_OPT_PATH`, so no environment variable
 * can force every probe to time out and ride `timeoutFailOpen` past the preflight.
 */
export function resolveRunMemoryProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.NODE_ENV !== "test") return DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
  const raw = env.PAPERCLIP_HERMES_MEMORY_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), DEFAULT_MEMORY_PROBE_TIMEOUT_MS);
}

export const ALLOWLISTED_EXCEPTION_CLASSES = [
  "ImportError",
  "AttributeError",
  "RuntimeError",
  "SyntaxError",
  "TypeError",
  "ValueError",
  "OSError",
  "NameError",
] as const;

export const ALLOWLISTED_SPAWN_CODES = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "EINVAL",
  "EMFILE",
  "ENFILE",
] as const;

export const ALLOWLISTED_SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGBUS",
  "SIGSEGV",
] as const;

function normalizeSpawnCode(code: unknown): string {
  if (typeof code === "string" && (ALLOWLISTED_SPAWN_CODES as readonly string[]).includes(code)) {
    return code;
  }
  return "other";
}

function normalizeSignal(signal: unknown): string {
  if (typeof signal === "string" && (ALLOWLISTED_SIGNALS as readonly string[]).includes(signal)) {
    return signal;
  }
  return "other";
}

function buildProbeResult(params: {
  ok: boolean;
  reason: MemoryProbeReason;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  module?: string;
  transitive?: boolean;
  excClass?: string;
  spawnCode?: string;
}): MemoryProbeResult {
  return {
    ok: params.ok,
    reason: params.reason,
    elapsedMs: params.elapsedMs,
    exitCode: params.exitCode,
    signal: params.signal,
    ...(params.module ? { module: params.module } : {}),
    ...(params.transitive !== undefined ? { transitive: params.transitive } : {}),
    ...(params.excClass ? { excClass: params.excClass } : {}),
    ...(params.spawnCode ? { spawnCode: params.spawnCode } : {}),
  };
}

/**
 * Shared bounded runner for probing Python memory dependency imports.
 * Enforces bounded timeout, strict JSON parsing, fail-closed handling,
 * and normalized error classifications without leaking raw strings or secrets.
 */
export async function runMemoryImportProbe(
  pythonBin: string,
  opts?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  },
): Promise<MemoryProbeResult> {
  const timeoutMs =
    typeof opts?.timeoutMs === "number" &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0 &&
    opts.timeoutMs <= DEFAULT_MEMORY_PROBE_TIMEOUT_MS
      ? opts.timeoutMs
      : DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
  const maxBuffer = opts?.maxBuffer ?? MEMORY_PROBE_MAX_BUFFER;
  const env = opts?.env ?? buildAgentChildBaseEnv(process.env);

  return new Promise<MemoryProbeResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;
    let observedExitCode: number | null = null;
    let observedSignal: string | null = null;
    const startTime = Date.now();

    const clearAllTimers = () => {
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const settle = (result: MemoryProbeResult) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolve(result);
    };

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore if already exited
        }
        try {
          child.stdout?.destroy();
        } catch {
          // ignore
        }
        try {
          child.stderr?.destroy();
        } catch {
          // ignore
        }
        try {
          child.stdin?.destroy();
        } catch {
          // ignore
        }
      }

      // If callback does not arrive (e.g. held stdio from grandchild or kill failure),
      // force-settle within bounded fallback grace without inventing unobserved signals.
      fallbackTimer = setTimeout(() => {
        const elapsedMs = Math.max(0, Date.now() - startTime);
        settle(
          buildProbeResult({
            ok: false,
            reason: "timeout",
            elapsedMs,
            exitCode: observedExitCode,
            signal: observedSignal,
          }),
        );
      }, 150);
    }, timeoutMs);

    try {
      child = execFile(
        pythonBin,
        ["-c", HERMES_MEMORY_PYTHON_IMPORT_CHECK],
        {
          env,
          maxBuffer,
        },
        (error, stdout, _stderr) => {
          const elapsedMs = Math.max(0, Date.now() - startTime);

          if (timedOut) {
            const sig = error?.signal ? normalizeSignal(error.signal) : observedSignal;
            const code = typeof error?.code === "number" ? error.code : observedExitCode;
            settle(
              buildProbeResult({
                ok: false,
                reason: "timeout",
                elapsedMs,
                exitCode: code,
                signal: sig,
              }),
            );
            return;
          }

          if (error) {
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              settle(
                buildProbeResult({
                  ok: false,
                  reason: "unclassified",
                  elapsedMs,
                  exitCode: null,
                  signal: null,
                }),
              );
              return;
            }

            if (typeof error.code === "string") {
              settle(
                buildProbeResult({
                  ok: false,
                  reason: "spawn_error",
                  elapsedMs,
                  exitCode: null,
                  signal: null,
                  spawnCode: normalizeSpawnCode(error.code),
                }),
              );
              return;
            }

            if (error.signal || observedSignal) {
              settle(
                buildProbeResult({
                  ok: false,
                  reason: "signal",
                  elapsedMs,
                  exitCode: null,
                  signal: normalizeSignal(error.signal || observedSignal),
                }),
              );
              return;
            }

            const exitCode = typeof error.code === "number" ? error.code : (observedExitCode ?? 1);
            settle(
              buildProbeResult({
                ok: false,
                reason: "unclassified",
                elapsedMs,
                exitCode,
                signal: null,
              }),
            );
            return;
          }

          const trimmed = (stdout || "").trim();
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              settle(
                buildProbeResult({
                  ok: false,
                  reason: "unclassified",
                  elapsedMs,
                  exitCode: 0,
                  signal: null,
                }),
              );
              return;
            }

            if (parsed.r === "ok") {
              settle(
                buildProbeResult({
                  ok: true,
                  reason: "ok",
                  elapsedMs,
                  exitCode: 0,
                  signal: null,
                }),
              );
              return;
            }

            if (
              parsed.r === "missing" &&
              typeof parsed.module === "string" &&
              (HERMES_MEMORY_REQUIRED_MODULES as readonly string[]).includes(parsed.module) &&
              typeof parsed.transitive === "boolean"
            ) {
              settle(
                buildProbeResult({
                  ok: false,
                  reason: parsed.transitive ? "missing_transitive" : "missing_module",
                  elapsedMs,
                  exitCode: 0,
                  signal: null,
                  module: parsed.module,
                  transitive: parsed.transitive,
                }),
              );
              return;
            }

            if (
              parsed.r === "import_error" &&
              typeof parsed.module === "string" &&
              (HERMES_MEMORY_REQUIRED_MODULES as readonly string[]).includes(parsed.module) &&
              typeof parsed.exc === "string"
            ) {
              const excClass = (ALLOWLISTED_EXCEPTION_CLASSES as readonly string[]).includes(
                parsed.exc,
              )
                ? parsed.exc
                : "other";
              settle(
                buildProbeResult({
                  ok: false,
                  reason: "import_error",
                  elapsedMs,
                  exitCode: 0,
                  signal: null,
                  module: parsed.module,
                  excClass,
                }),
              );
              return;
            }

            settle(
              buildProbeResult({
                ok: false,
                reason: "unclassified",
                elapsedMs,
                exitCode: 0,
                signal: null,
              }),
            );
          } catch {
            settle(
              buildProbeResult({
                ok: false,
                reason: "unclassified",
                elapsedMs,
                exitCode: 0,
                signal: null,
              }),
            );
          }
        },
      );

      child.on("exit", (code, sig) => {
        if (typeof code === "number") observedExitCode = code;
        if (sig) observedSignal = normalizeSignal(sig);
      });
    } catch (syncErr: any) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      settle(
        buildProbeResult({
          ok: false,
          reason: "spawn_error",
          elapsedMs,
          exitCode: null,
          signal: null,
          spawnCode: normalizeSpawnCode(syncErr?.code),
        }),
      );
    }
  });
}

/**
 * Resolves the Hermes opt directory path for capability checks.
 * In production environments, this is strictly "/opt/hermes".
 * PAPERCLIP_HERMES_OPT_PATH is strictly constrained to test environments (NODE_ENV === "test")
 * to prevent accidental or malicious bypass of the production preflight check.
 */
export function resolveOptHermesPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env.NODE_ENV === "production") {
    return "/opt/hermes";
  }
  if (process.env.NODE_ENV === "test") {
    return process.env.PAPERCLIP_HERMES_OPT_PATH || "/opt/hermes";
  }
  return "/opt/hermes";
}

/**
 * Detects whether execution is occurring inside a Paperclip production container.
 */
export function isPaperclipProductionContainer(): boolean {
  return (
    existsSync("/paperclip") ||
    process.env.PAPERCLIP_HOME === "/paperclip" ||
    process.env.HOME === "/paperclip"
  );
}

/**
 * Actionable preflight check for Hermes memory capability in Docker/local environments.
 * Nonblocking async implementation.
 *
 * Distinguishes between:
 * 1. Production Docker image: marked with .hermes-production-closure sentinel in optHermesPath.
 *    Fails explicitly if Python interpreter is missing or required modules (mem0, psycopg, psycopg2) fail to import.
 * 2. Stale pre-sentinel Paperclip production image:
 *    Paperclip container detected without the sentinel; reports that the production container is stale.
 * 3. Unmarked environment (e.g. Daytona runner or custom /opt/hermes):
 *    Verifies required modules if Python exists, but produces a Daytona-appropriate error rather than claiming stale production image.
 * 4. Local/ambient environment (optHermesPath does not exist):
 *    Permits execution without requiring /opt/hermes when running outside a recognized production container.
 */
export async function checkHermesMemoryCapability(
  optHermesPath?: string,
  options?: HermesMemoryCapabilityOptions,
): Promise<HermesMemoryCapabilityResult> {
  const resolvedOptPath = resolveOptHermesPath(optHermesPath);
  const isProductionContainer = isPaperclipProductionContainer();

  if (!existsSync(resolvedOptPath)) {
    if (isProductionContainer) {
      return {
        available: false,
        error: `Hermes runtime memory is enabled, but the production environment is missing the required Hermes directory (${resolvedOptPath}). Rebuild or pull the latest Paperclip image containing the Hermes memory closure.`,
      };
    }
    return { available: true };
  }

  const sentinelPath = path.join(resolvedOptPath, HERMES_PRODUCTION_CLOSURE_SENTINEL);
  const isProductionClosure = existsSync(sentinelPath);
  const pythonBin = path.join(resolvedOptPath, "bin", "python3");

  if (isProductionClosure) {
    if (!existsSync(pythonBin)) {
      return {
        available: false,
        error: `Hermes runtime memory is enabled, but the marked production closure (${resolvedOptPath}) is missing the Python interpreter (${pythonBin}). The container image appears corrupted. Rebuild or pull the latest Paperclip image.`,
      };
    }

    let cacheKey: string | null = null;
    if (options?.cacheSuccess) {
      try {
        const closureDigest = (await fs.readFile(sentinelPath, "utf8")).trim();
        cacheKey = `${pythonBin}::${sentinelPath}::${closureDigest}`;
      } catch {
        // Unreadable sentinel: no stable identity to cache under, so every call probes.
        cacheKey = null;
      }
      const cachedProbe = cacheKey ? memoryCapabilityCache.get(cacheKey) : undefined;
      if (cachedProbe) {
        return { available: true, probeResult: cachedProbe, cached: true, attempts: 0 };
      }
    }

    const timeoutRetries = Math.max(0, Math.floor(options?.timeoutRetries ?? 0));
    let outcome: MemoryProbeOutcome;
    const inFlight = cacheKey ? memoryCapabilityInFlight.get(cacheKey) : undefined;
    if (inFlight) {
      outcome = await inFlight;
    } else {
      const pending = probeWithTimeoutRetries(pythonBin, options?.timeoutMs, timeoutRetries);
      if (cacheKey) memoryCapabilityInFlight.set(cacheKey, pending);
      try {
        outcome = await pending;
      } finally {
        if (cacheKey) memoryCapabilityInFlight.delete(cacheKey);
      }
    }
    const { probeResult, attempts } = outcome;
    if (probeResult.ok) {
      if (cacheKey) memoryCapabilityCache.set(cacheKey, probeResult);
      return { available: true, probeResult, attempts };
    }

    const timeoutDuration = options?.timeoutMs ?? DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
    if (probeResult.reason === "timeout" && options?.timeoutFailOpen) {
      return {
        available: true,
        probeResult,
        attempts,
        warning: `Hermes runtime memory preflight probe timed out ${attempts} time(s) at ${timeoutDuration}ms each; the hash-pinned production closure (${sentinelPath}) is present, so the run proceeds without probe evidence. A timeout indicates CPU starvation, not a missing dependency; check task CPU headroom.`,
      };
    }
    switch (probeResult.reason) {
      case "missing_module": {
        const modName = probeResult.module || HERMES_MEMORY_REQUIRED_MODULES.join("/");
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory is enabled, but the production Docker image lacks required dependencies (${modName}). The container image appears stale. Rebuild or pull the latest Paperclip image containing the updated Hermes requirements closure.`,
        };
      }
      case "missing_transitive": {
        const modName = probeResult.module || HERMES_MEMORY_REQUIRED_MODULES.join("/");
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory is enabled, but the production Docker image lacks required dependencies (transitive dependency for ${modName}). The container image appears stale. Rebuild or pull the latest Paperclip image containing the updated Hermes requirements closure.`,
        };
      }
      case "timeout": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory preflight check timed out after ${timeoutDuration}ms while probing dependencies in ${resolvedOptPath}. The probe expired before completion and does not provide evidence of missing dependencies. Check host performance or CPU constraints.`,
        };
      }
      case "spawn_error": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed to spawn Python interpreter (${pythonBin}): process spawn error (${probeResult.spawnCode ?? "unknown"}).`,
        };
      }
      case "import_error": {
        const modName = probeResult.module || "memory dependencies";
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed while importing ${modName} (${probeResult.excClass ?? "error"}). Check dependency configuration.`,
        };
      }
      case "signal": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe was terminated by signal (${probeResult.signal ?? "unknown"}).`,
        };
      }
      case "unclassified":
      default: {
        const exitInfo =
          probeResult.exitCode !== null
            ? `exit code ${probeResult.exitCode}`
            : "unexpected termination";
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed with an unclassified error (${exitInfo}).`,
        };
      }
    }
  }

  // Pre-sentinel stale Paperclip production image:
  // Running in a Paperclip container environment, but lacking the production closure sentinel
  if (isProductionContainer) {
    return {
      available: false,
      error:
        "Hermes runtime memory is enabled, but the current Paperclip production container image is stale (pre-sentinel image missing the memory requirements closure). Rebuild or pull the latest Paperclip image containing the updated Hermes requirements closure.",
    };
  }

  // Unmarked environment where resolvedOptPath exists (e.g. Daytona runner or custom /opt/hermes)
  if (existsSync(pythonBin)) {
    // No pinned closure here: timeoutRetries applies, but cacheSuccess and timeoutFailOpen do not
    // (nothing stands in for probe evidence), so a persistent timeout is still a failure.
    const { probeResult, attempts } = await probeWithTimeoutRetries(
      pythonBin,
      options?.timeoutMs,
      Math.max(0, Math.floor(options?.timeoutRetries ?? 0)),
    );
    if (probeResult.ok) {
      return { available: true, probeResult, attempts };
    }

    const timeoutDuration = options?.timeoutMs ?? DEFAULT_MEMORY_PROBE_TIMEOUT_MS;
    switch (probeResult.reason) {
      case "missing_module":
      case "missing_transitive": {
        const modName = probeResult.module || HERMES_MEMORY_REQUIRED_MODULES.join("/");
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory is enabled, but the environment (${resolvedOptPath}) lacks the required memory dependencies (${modName}) and is not a Paperclip production image with the baked memory closure. Daytona and custom environments require installing the Hermes memory closure.`,
        };
      }
      case "timeout": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory preflight check timed out after ${timeoutDuration}ms while probing dependencies in ${resolvedOptPath}. The probe expired before completion and does not provide evidence of missing dependencies. Check host performance or CPU constraints.`,
        };
      }
      case "spawn_error": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed to spawn Python interpreter (${pythonBin}): process spawn error (${probeResult.spawnCode ?? "unknown"}).`,
        };
      }
      case "import_error": {
        const modName = probeResult.module || "memory dependencies";
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed while importing ${modName} (${probeResult.excClass ?? "error"}). Check dependency configuration.`,
        };
      }
      case "signal": {
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe was terminated by signal (${probeResult.signal ?? "unknown"}).`,
        };
      }
      case "unclassified":
      default: {
        const exitInfo =
          probeResult.exitCode !== null
            ? `exit code ${probeResult.exitCode}`
            : "unexpected termination";
        return {
          available: false,
          probeResult,
          error: `Hermes runtime memory probe failed with an unclassified error (${exitInfo}).`,
        };
      }
    }
  }

  return {
    available: false,
    error: `Hermes runtime memory is enabled, but Python interpreter (${pythonBin}) was not found in ${resolvedOptPath}.`,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
export function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
export function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}
function cfgEnvString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && "value" in v) {
    const value = (v as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

/**
 * TECH-7895: the launch env a Router readiness probe receives, derived from a FINAL child env.
 *
 * Shared by the run and the environment test so both probe the same launcher with the same import
 * context: only the strict OS/runtime allowlist survives (no keys or app tokens), and Python module
 * resolution is pinned exactly as the run pins it — the stripped names are removed and an explicitly
 * empty PATH stays empty rather than being defaulted later.
 */
export function buildRouterProbeLaunchEnv(finalEnv: Record<string, string | undefined>): Record<string, string> {
  const launchEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(finalEnv)) {
    if (value !== undefined) launchEnv[name] = value;
  }
  const base = buildAgentChildBaseEnv(launchEnv as NodeJS.ProcessEnv) as Record<string, string>;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) result[name] = value;
  }
  // buildAgentChildBaseEnv keeps an empty PATH value as-is; assert the final env's own keys so a
  // deliberately empty PATH is never silently replaced by a platform default.
  if (launchEnv.PATH !== undefined) result.PATH = launchEnv.PATH;
  if (launchEnv.PYTHONNOUSERSITE !== undefined) result.PYTHONNOUSERSITE = launchEnv.PYTHONNOUSERSITE;
  for (const name of ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES) delete result[name];
  return result;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

export const LINUX_MAX_ARG_STRLEN_BYTES = 128 * 1024;
export const HERMES_SYSTEM_PROMPT_ENV_KEY = "HERMES_EPHEMERAL_SYSTEM_PROMPT";
export const HERMES_SYSTEM_PROMPT_ENV_PREFIX = `${HERMES_SYSTEM_PROMPT_ENV_KEY}=`;
export const HERMES_SYSTEM_PROMPT_ENV_OVERHEAD_BYTES =
  Buffer.byteLength(HERMES_SYSTEM_PROMPT_ENV_PREFIX, "utf8") + 1; // 31 + 1 NUL = 32 bytes
export const HERMES_MAX_SYSTEM_PROMPT_BYTES =
  LINUX_MAX_ARG_STRLEN_BYTES - HERMES_SYSTEM_PROMPT_ENV_OVERHEAD_BYTES; // 131040 bytes

const HERMES_STATIC_RUNTIME_IDENTITY_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- API base: {{paperclipApiUrl}}",
].join("\n");

const HERMES_RUN_CONTEXT_TEMPLATE = [
  "Paperclip invocation:",
  "- Run ID: {{run.id}}",
].join("\n");

const HERMES_RUNTIME_IDENTITY_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
].join("\n");

const HERMES_SYSTEM_PROMPT_API_GUIDANCE = [
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/$PAPERCLIP_TASK_ID\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
].join("\n");

// Hermes applies this overlay at each API call, including after compaction,
// without storing it in conversation history. Keep run/task deltas (such as Run ID
// and task briefs) in -q to preserve provider prompt-cache prefix reuse across runs.
const HERMES_SYSTEM_PROMPT_TEMPLATE = [
  HERMES_SYSTEM_PROMPT_API_GUIDANCE,
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

export function renderHermesSystemPrompt(
  agent: unknown,
  options: { includeDefaultIdentity?: boolean; agentPromptTemplate?: string } = {},
): string {
  const includeDefaultIdentity = options.includeDefaultIdentity ?? true;
  const agentTemplate = options.agentPromptTemplate ?? DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  if (includeDefaultIdentity) {
    if (!options.agentPromptTemplate) {
      return renderTemplate(HERMES_SYSTEM_PROMPT_TEMPLATE, { agent });
    }
    const fullTemplate = [
      HERMES_SYSTEM_PROMPT_API_GUIDANCE,
      "",
      agentTemplate,
    ].join("\n");
    return renderTemplate(fullTemplate, { agent });
  }
  const identityRegex = /^You are agent \{\{agent\.id\}\} \(\{\{agent\.name\}\}\)\.\r?\n\r?\n?/;
  if (!identityRegex.test(agentTemplate)) {
    throw new Error(
      "renderHermesSystemPrompt: failed to strip default identity line from agent template; template format may have changed",
    );
  }
  const strippedAgentTemplate = agentTemplate.replace(
    identityRegex,
    "",
  );
  const promptTemplate = [
    HERMES_SYSTEM_PROMPT_API_GUIDANCE,
    "",
    strippedAgentTemplate,
  ].join("\n");
  return renderTemplate(promptTemplate, { agent });
}

export async function resolveMemoryGuidance(
  ctx: AdapterExecutionContext,
  options: { usingIsolatedHome: boolean },
): Promise<MemoryAgentGuidanceContext | undefined> {
  const result = parseMemoryAgentGuidanceContextResult(ctx.paperclipMemoryGuidance);
  if (result.status === "valid") {
    if (options.usingIsolatedHome && result.data.capabilities.hermesBuiltInStores) {
      await ctx.onLog(
        "stdout",
        "[hermes] Isolation override: disabling Hermes built-in stores guidance\n",
      );
      return {
        ...result.data,
        capabilities: {
          ...result.data.capabilities,
          hermesBuiltInStores: false,
        },
      };
    }
    return result.data;
  }
  if (result.status === "malformed") {
    await ctx.onLog(
      "stderr",
      `[hermes] Malformed paperclipMemoryGuidance context received; falling back to legacy memory guidance: ${result.error.message}\n`,
    );
  }
  return undefined;
}

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export interface HermesBuiltPrompt {
  query: string;
  systemSections: string[];
  hermesPromptSplit: boolean;
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean; returnSections: true; hardeningFlags?: MemoryHardeningFlags },
): HermesBuiltPrompt;
export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options?: { resumedSession?: boolean; returnSections?: false; hardeningFlags?: MemoryHardeningFlags },
): string;
export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options?: { resumedSession?: boolean; returnSections?: boolean; hardeningFlags?: MemoryHardeningFlags },
): string | HermesBuiltPrompt {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const resolvedHardeningFlags = options?.hardeningFlags ?? resolveEffectiveMemoryHardeningFlags(
    process.env,
    (config.env ?? ctx.config?.env) as Record<string, string | undefined> | undefined,
  );
  const hermesPromptSplit = resolvedHardeningFlags.hermesPromptSplit;

  const { taskContextNote: taskContextMarkdown, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: options?.resumedSession === true,
    includeCommunicationGuidance: !hermesPromptSplit,
  });
  // Keep the historical variable available to custom templates. Automatic
  // assembly uses the ownership-aware assignment variant below.
  const paperclipTaskMarkdown = cfgString(context.paperclipTaskMarkdown)?.trim() || "";
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const fullTaskMarkdown = cfgString(
    context.paperclipTaskMarkdownAssignment ?? context.paperclipTaskMarkdown,
  )?.trim() || "";
  const hasTask = Boolean(fullTaskMarkdown);
  const isResumed = options?.resumedSession === true;
  const includeInitialGuidance = hasTask && !isResumed;

  const taskCommunicationGuidance = includeInitialGuidance
    ? cfgString(context.paperclipTaskCommunicationGuidance)?.trim() || ""
    : "";
  const freshSessionHandoffMarkdown = includeInitialGuidance
    ? cfgString(context.paperclipFreshSessionHandoffMarkdown)?.trim() || ""
    : "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    taskContextMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const runtimeGuidance = cfgString(ctx.runtimeTools?.guidance)?.trim() || "";

  const rendered = template && !isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? renderTemplate(renderConditionalSections(template, vars), vars)
    : "";

  let query: string;
  let systemSections: string[];

  if (hermesPromptSplit) {
    query = joinPromptSections([
      freshSessionHandoffMarkdown,
      taskContextMarkdown,
      wakePrompt,
      sessionHandoffMarkdown,
      rendered,
      renderTemplate(HERMES_RUN_CONTEXT_TEMPLATE, vars),
    ]);
    systemSections = [
      renderTemplate(HERMES_STATIC_RUNTIME_IDENTITY_TEMPLATE, vars),
      taskCommunicationGuidance,
      runtimeGuidance,
    ].filter(Boolean);
  } else {
    query = joinPromptSections([
      renderTemplate(HERMES_RUNTIME_IDENTITY_TEMPLATE, vars),
      wakePrompt,
      sessionHandoffMarkdown,
      runtimeGuidance,
      taskContextMarkdown,
      rendered,
    ]);
    systemSections = [];
  }

  if (options?.returnSections === true) {
    return { query, systemSections, hermesPromptSplit };
  }
  return query;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

export interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/**
 * Hermes CLI advisories printed to stdout ahead of the model's reply, even in quiet mode.
 * They are operator notices about the runtime, not part of the agent's answer, and in a
 * chat-connected run every surviving stdout line is published to the provider thread
 * verbatim. Matched after ANSI stripping; each pattern is anchored to the start of a line.
 */
const HERMES_CLI_ADVISORY_RES: readonly RegExp[] = [
  // cli.py _ensure_tirith_security: "⚠ tirith security scanner enabled but not available — ..."
  /^\u26A0\uFE0F?\s*tirith security scanner\b/u,
  // cli_model_switch_mixin: "⚠️  Normalized model 'x' to 'y' for <provider>."
  /^\u26A0\uFE0F?\s*Normalized model '/u,
];

// Terminal escapes Hermes may emit around advisories or errors: CSI sequences (colour/dim/
// cursor, e.g. `ESC[2m`) and OSC sequences (e.g. `ESC]8;;url BEL` hyperlinks), terminated by BEL or
// ESC. Other escape families are not expected from Hermes and are left alone.
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-9;]*[A-Za-z]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

export function isHermesCliAdvisoryLine(line: string): boolean {
  const t = line.replace(ANSI_ESCAPE_RE, "").trim();
  return HERMES_CLI_ADVISORY_RES.some((re) => re.test(t));
}

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(ANSI_ESCAPE_RE, ""))
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (isHermesCliAdvisoryLine(t)) return false;
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    // The regex's `[\d.]+` capture can be punctuation only (e.g. "cost." in prose), which
    // parseFloat turns into NaN. A NaN costUsd fails the adapter result schema and marks an
    // otherwise successful run failed, so treat a non-finite value as "cost not reported".
    const parsedCost = parseFloat(costMatch[1]);
    if (Number.isFinite(parsedCost) && parsedCost >= 0) {
      result.costUsd = parsedCost;
    }
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

/**
 * Augments error messages when stderr specifically indicates missing mem0ai/psycopg dependencies.
 * Narrows detection to actual module import errors, avoiding spurious augmentation on benign
 * log mentions of class names.
 */
export function augmentStaleImageError(
  message: string,
  memoryConfig: unknown,
  stderr: string,
): string {
  const modulePattern = HERMES_MEMORY_REQUIRED_MODULES.map(escapeRegExp).join("|");
  const regex = new RegExp(
    `(?:ModuleNotFoundError|ImportError).*?\\b(?:${modulePattern})\\b|No module named ['"](?:${modulePattern})['"]`,
    "i",
  );
  if (memoryConfig != null && regex.test(stderr)) {
    return `${message} (Stale Docker image detected: missing mem0ai/psycopg dependencies in container. Please update to the latest image.)`;
  }
  return message;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  // TECH-8174: a remote target (sandbox; SSH is refused there) takes the separate sandbox path, so
  // nothing below runs on the host on its behalf. Local runs continue unchanged.
  const remoteTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (remoteTarget?.kind === "remote") {
    // Loaded on demand: the sandbox module imports helpers from this one, and a static import in
    // both directions would make module initialization order-dependent.
    const { executeHermesOnRemoteTarget } = await import("./execute-sandbox.js");
    return executeHermesOnRemoteTarget(ctx, remoteTarget);
  }

  // Validate command scan policy mode FIRST before any spawn or capability probe
  getHermesCommandScanMode();

  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // Resolve memory hardening flags once early from agreed server and agent env sources (additive)
  const userEnvForHardening = (config.env ?? ctx.config?.env) as Record<string, string | undefined> | undefined;
  let hardeningFlags: MemoryHardeningFlags;
  try {
    hardeningFlags = resolveEffectiveMemoryHardeningFlags(process.env, userEnvForHardening);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[hermes] Invalid PAPERCLIP_MEMORY_HARDENING configuration: ${reason}\n`);
    throw err;
  }

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const configuredModel = normalizeConfiguredModel(cfgString(config.model));
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  // ── Resolve runtime memory ─────────────────────────────────────────────
  let memoryConfig: ValidatedHermesMemoryConfig | null = null;
  if (ctx.runtimeMemory) {
    try {
      const rawMemory = await ctx.runtimeMemory.getConfig();
      memoryConfig = validateHermesMemoryConfig(rawMemory);
    } catch {
      await ctx.onLog(
        "stderr",
        "[hermes] Failed to resolve runtime memory configuration (details omitted for credential safety).\n",
      );
      throw new Error("Failed to resolve runtime memory configuration");
    }
  }

  // Optional per-agent provider selection for env-configured memory (for example an external
  // mem0-compatible server through MEM0_HOST). Runtime memory, when present, owns the run.
  let memoryProvider: HermesMemoryProvider | undefined;
  try {
    memoryProvider = resolveHermesMemoryProvider(config);
  } catch (err) {
    await ctx.onLog("stderr", `[hermes] ${err instanceof Error ? err.message : "Invalid adapterConfig.memoryProvider"}\n`);
    throw err;
  }
  if (memoryConfig != null) {
    if (memoryProvider) {
      await ctx.onLog("stdout", "[hermes] adapterConfig.memoryProvider ignored: Paperclip runtime memory is active for this run.\n");
    }
    memoryProvider = undefined;
  }

  const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  // TECH-7102: in a hosted deployment a Hermes run never touches the server host's ~/.hermes; it
  // gets a fresh per-run home and only an explicit provider credential from its own adapter env.
  const hostIsolated = hermesHostIsolationEnabled();
  // Final value is decided after provider resolution: every Ramp Router run also uses a fresh home.
  const needsIsolatedHomeForRuntime = hostIsolated || runtimeMcpServers.length > 0 || memoryConfig != null || memoryProvider != null;

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  const wantsPaperclipRuntimeSkills = Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills");

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  // Hermes' own default model is also needed when no model is configured, to
  // decide whether `-m` can be omitted; an explicit "auto" may defer to the host default too.
  if (!hostIsolated && (!explicitProvider || explicitProvider === "auto" || !configuredModel)) {
    try {
      detectedConfig = await detectModel(path.join(resolveHostHermesDir(config), "config.yaml"));
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  // TECH-7895: provider, its source and the `-m` decision are resolved together, BEFORE any Router
  // gate (remote target, extraArgs, fresh home, session, key, probe), so a host config whose default
  // is Ramp Router can never run without those gates. Hosted runs never read the host (null here).
  const effective = resolveEffectiveRunConfig({
    explicitProvider,
    configuredModel,
    detected: detectedConfig,
  });
  const { provider: resolvedProvider, resolvedFrom } = effective;
  // Auto mode can select Anthropic from its explicit API credential in Hermes.
  // An unused Anthropic-only setting must not block other providers or local runs.
  const usesAnthropicRequestTimeout = hostIsolated &&
    (resolvedProvider === "anthropic" || resolvedProvider === "auto");
  let anthropicRequestTimeoutSec: number | undefined;
  if (usesAnthropicRequestTimeout) {
    const value = config.requestTimeoutSec ?? 300;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error("Hermes requestTimeoutSec must be a positive finite number");
    }
    anthropicRequestTimeoutSec = value;
  }


  // TECH-7895: Ramp Router runs are only supported where this adapter actually executes (the local
  // host). Never probe the host on behalf of a remote/sandbox target, and never swap providers.
  const isRouterRun = effective.isRouter;
  if (isRouterRun && isRemoteExecutionTarget(ctx)) {
    await ctx.onLog("stderr", `[hermes] ${ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE}\n`);
    throw new Error(ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE);
  }
  if (isRouterRun && extraArgs && extraArgs.length > 0) {
    // Hermes parses these before Paperclip's own flags (e.g. --profile/-p or abbreviations), so they
    // could select another profile, provider or endpoint. Router runs accept none.
    await ctx.onLog("stderr", `[hermes] ${ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE}\n`);
    throw new Error(ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE);
  }
  // Every Router run gets a fresh per-run home and Hermes profile (never the host's Hermes dir, its
  // auth/credential pools, provider plugins or sessions). Non-Router runs keep their existing rules.
  const usingIsolatedHome = needsIsolatedHomeForRuntime || isRouterRun;

  // Runs with a fresh home reconcile into that home below instead of the host Hermes skills dir.
  if (wantsPaperclipRuntimeSkills && !hostIsolated && !isRouterRun) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  if (!effective.ok) {
    await ctx.onLog("stderr", `[hermes] ${effective.message}\n`);
    throw new Error(effective.message);
  }
  const modelArg = { arg: effective.modelArg };
  const model = effective.effectiveModel;

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, reapply that bundle through Hermes's native system overlay.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt and environment ───────────────────────────────────────
  const userEnvForPrompt = config.env as Record<string, unknown> | undefined;
  const promptConfig: Record<string, unknown> = { ...config };
  if (!cfgString(promptConfig.paperclipApiUrl) && userEnvForPrompt && typeof userEnvForPrompt === "object") {
    const configuredPaperclipApiUrl = cfgEnvString(userEnvForPrompt.PAPERCLIP_API_URL);
    if (configuredPaperclipApiUrl) {
      promptConfig.paperclipApiUrl = configuredPaperclipApiUrl;
    }
  }

  // Isolated per-run HERMES_HOME runs (runtime MCP, memory, host isolation) have ephemeral
  // native session state, so they never resume a prior Hermes session.
  const sessionId = persistSession && !usingIsolatedHome ? prevSessionId : undefined;
  const builtPrompt = buildPrompt(ctx, promptConfig, {
    resumedSession: Boolean(sessionId),
    returnSections: true,
    hardeningFlags,
  });

  const userEnv = config.env as Record<string, string> | undefined;
  // TECH-7076: never spread the whole server process.env into the agent. It carries
  // server-only secrets (SSO provider definitions, Better Auth secret, secrets master
  // key, database URLs, cloud credentials, the server's own provider keys) that the
  // agent's terminal tool could print before log redaction. Start from the strict
  // allowlisted base; credentials come only from explicit config/managed AI connection.
  const env: Record<string, string> = {
    ...(buildAgentChildBaseEnv(process.env) as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
  };

  let prompt = builtPrompt.query;
  let finalSystemPrompt: string;

  const memoryGuidance = await resolveMemoryGuidance(ctx, { usingIsolatedHome });
  const agentPromptTemplate = memoryGuidance
    ? buildPaperclipAgentPromptTemplate(memoryGuidance)
    : undefined;

  if (builtPrompt.hermesPromptSplit) {
    const candidateOverlay = joinPromptSections([
      env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
      agentInstructions,
      ...builtPrompt.systemSections,
      renderHermesSystemPrompt(ctx.agent, {
        includeDefaultIdentity: false,
        agentPromptTemplate,
      }),
    ]);
    if (Buffer.byteLength(candidateOverlay, "utf8") > HERMES_MAX_SYSTEM_PROMPT_BYTES) {
      // Ephemeral system prompt would exceed Linux MAX_ARG_STRLEN (128 KiB).
      // Fall back: keep relocated sections in the query (-q / --query-file) instead of the system prompt.
      await ctx.onLog(
        "stderr",
        "[hermes] Ephemeral system prompt exceeds size limit; keeping relocated sections in query.\n",
      );
      const fallbackPrompt = buildPrompt(ctx, promptConfig, {
        resumedSession: Boolean(sessionId),
        returnSections: true,
        hardeningFlags: { ...hardeningFlags, hermesPromptSplit: false },
      });
      prompt = fallbackPrompt.query;
      finalSystemPrompt = joinPromptSections([
        env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
        agentInstructions,
        renderHermesSystemPrompt(ctx.agent, {
          includeDefaultIdentity: true,
          agentPromptTemplate,
        }),
      ]);
    } else {
      finalSystemPrompt = candidateOverlay;
    }
  } else {
    finalSystemPrompt = joinPromptSections([
      env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
      agentInstructions,
      renderHermesSystemPrompt(ctx.agent, {
        includeDefaultIdentity: true,
        agentPromptTemplate,
      }),
    ]);
  }

  // Scope the overlay to this child process. Read the current bundle on every
  // invocation; never infer its availability from a persisted session ID.
  // Preserve an operator's explicit overlay before Paperclip's instructions.
  const finalSystemPromptBytes = Buffer.byteLength(finalSystemPrompt, "utf8");
  if (finalSystemPromptBytes > HERMES_MAX_SYSTEM_PROMPT_BYTES) {
    const errorMsg = `[hermes] HERMES_EPHEMERAL_SYSTEM_PROMPT exceeds maximum argument size (${finalSystemPromptBytes} bytes > ${HERMES_MAX_SYSTEM_PROMPT_BYTES} bytes limit)`;
    await ctx.onLog("stderr", `${errorMsg}\n`);
    throw new Error(errorMsg);
  }

  env.HERMES_EPHEMERAL_SYSTEM_PROMPT = finalSystemPrompt;

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false;
  const promptViaFile = Buffer.byteLength(prompt, "utf8") >= 128 * 1024;
  const args: string[] = promptViaFile
    ? ["chat", "--query-file", "-"]
    : ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  // Never pass a placeholder: omit -m so Hermes uses its configured default.
  if (modelArg.arg) {
    args.push("-m", modelArg.arg);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.).
  //
  // Security posture: A --yolo agent process must not persist code or
  // toolchain modifications across runs. In production Docker containers,
  // /opt/hermes is root-owned and non-writable by the runtime node user,
  // and HERMES_DISABLE_LAZY_INSTALLS=1 blocks runtime pip installs so
  // missing optional dependencies fail closed rather than mutating the environment.
  args.push("--yolo");

  // Failed resumes remain failures. Do not infer a safe restart from CLI text.
  if (sessionId) args.push("--resume", sessionId);
  if (extraArgs?.length) args.push(...extraArgs);
  // TECH-7895: a Router run needs the canonical RAMP_ROUTER_API_KEY itself; another provider's key
  // never satisfies it, and the provider is never switched. Key precedence:
  //   1. The agent's own env binding, if present at all. An explicit blank value is a deliberate
  //      (broken) binding and never falls back to the host.
  //   2. Local (non-hosted) runs only: the operator's host Hermes .env canonical key, projected
  //      explicitly into the child env. Router runs use a fresh profile, so nothing else from the
  //      host Hermes dir (endpoint overrides, auth/credential pools, plugins) is used.
  // Hosted runs never read the host. Checked before anything is created or spawned.
  //
  // Redaction is separate from that credential check and covers EVERY run: any canonical key value
  // seen in any layer (agent env, host projection, prepared profile env, final env) is enrolled for
  // redaction, raw and trimmed, when it can be redacted safely — including values a later layer
  // overwrote. Only the final child env decides pass/fail: a Router run with a missing or
  // unredactable final key is refused; on any other run an unusable key is simply removed from the
  // child env (and unset) rather than failing the run.
  const routerKeyCandidates = new Set<string>();
  const noteRouterKeyCandidate = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const variant of [value, value.trim()]) {
      if (variant) routerKeyCandidates.add(variant);
    }
  };
  const agentBindsRouterKey =
    !!userEnv && typeof userEnv === "object" && Object.prototype.hasOwnProperty.call(userEnv, RAMP_ROUTER_API_KEY_ENV);
  if (agentBindsRouterKey) noteRouterKeyCandidate(userEnv[RAMP_ROUTER_API_KEY_ENV]);
  let hostRouterKeyProjection: string | undefined;
  if (isRouterRun) {
    if (!hostIsolated && !agentBindsRouterKey) {
      const hostDotenv = await readHostHermesDotenv(config);
      noteRouterKeyCandidate(hostDotenv[RAMP_ROUTER_API_KEY_ENV]);
      hostRouterKeyProjection = readRouterApiKey(hostDotenv);
    }
    const effectiveRouterKey = agentBindsRouterKey ? readRouterApiKey(userEnv) : hostRouterKeyProjection;
    if (!effectiveRouterKey) {
      await ctx.onLog("stderr", `[hermes] ${ROUTER_KEY_MISSING_MESSAGE}\n`);
      throw new Error(ROUTER_KEY_MISSING_MESSAGE);
    }
    if (hostRouterKeyProjection) env[RAMP_ROUTER_API_KEY_ENV] = hostRouterKeyProjection;
  }
  // Endpoint overrides and legacy aliases never reach the child, whichever layer supplied them.
  // Every name removed at any stage is also passed to unsetEnvKeys at spawn.
  const routerStrippedEnvNames = new Set<string>(routerEnvNamesToStrip(env, isRouterRun));
  for (const name of routerStrippedEnvNames) delete env[name];

  // TECH-7102: an isolated run must carry its own explicit provider credential (the agent's
  // company secret reference resolved into adapter env). Never fall back to the host HOME or the
  // server's ambient provider env; fail clearly before anything is created or spawned.
  if (hostIsolated && !hasExplicitHermesProviderCredential(userEnv)) {
    await ctx.onLog("stderr", `[hermes] ${HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE}\n`);
    throw new Error(HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE);
  }

  // Ensure no duplicate or leaked runtime tools credentials reach the child
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")) {
      delete env[key];
    }
  }

  // Ensure Hermes lazy package installation is disabled so the agent
  // fails closed on unavailable optional plugins and never executes runtime pip installs.
  // This is a protected security invariant that cannot be overridden by user config.env.
  env.HERMES_DISABLE_LAZY_INSTALLS = "1";

  // Unconditionally strip forbidden database and credential environment variables
  const strippedForbiddenEnvKeys: string[] = [];
  // The strict base env already drops these from the server environment, so also
  // count keys present on the server (names only) to keep the operator notice honest.
  for (const key of HERMES_FORBIDDEN_ENV_VARS) {
    const presentOnServer = process.env[key] !== undefined;
    if (key in env) {
      delete env[key];
    }
    if (presentOnServer || key in (userEnv ?? {})) {
      strippedForbiddenEnvKeys.push(key);
    }
  }

  // Unconditionally disable mem0 telemetry on every run
  env.MEM0_TELEMETRY = "False";

  // TECH-8574: For env-configured Mem0 agents (adapterConfig.memoryProvider='mem0', no runtime
  // memory) running under the mem0AutoSyncOff flag, disable automatic turn fact extraction by
  // projecting MEM0_AUTO_SYNC=false into the child environment. Agents on runtime memory receive
  // auto_sync: false via mem0.json instead. Agent-provided MEM0_AUTO_SYNC in config.env cannot
  // defeat the flag when active.
  if (hardeningFlags.mem0AutoSyncOff && memoryProvider === "mem0") {
    env.MEM0_AUTO_SYNC = "false";
  }

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  // Wake context travels in the prompt; drop both inherited and configured copies.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // ── Resolve working directory ──────────────────────────────────────────
  const workspace = ctx.context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object"
    ? cfgString((workspace as Record<string, unknown>).cwd)
    : undefined;
  const cwd =
    cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model ?? "hermes-default"}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (strippedForbiddenEnvKeys.length > 0) {
    await ctx.onLog(
      "stdout",
      `[hermes] Notice: Stripped ${strippedForbiddenEnvKeys.length} forbidden database environment variable(s) from execution environment: ${strippedForbiddenEnvKeys.join(", ")}.\n`,
    );
  } else {
    await ctx.onLog(
      "stdout",
      `[hermes] Notice: Database environment sanitization active (0 forbidden DB env keys present).\n`,
    );
  }

  // Preflight check for runtime memory capability when memory is enabled
  if (memoryConfig != null) {
    // Run path: one successful probe per container is enough evidence; a timeout under CPU
    // starvation retries once and then, with the pinned production closure present, proceeds
    // with a logged warning. Missing-dependency results still fail the run (below).
    const probeTimeoutMs = resolveRunMemoryProbeTimeoutMs();
    const memoryPreflight = await checkHermesMemoryCapability(undefined, {
      timeoutMs: probeTimeoutMs,
      cacheSuccess: true,
      timeoutRetries: 1,
      timeoutFailOpen: true,
    });
    if (memoryPreflight.available) {
      if (memoryPreflight.warning) {
        await ctx.onLog(
          "stdout",
          `[hermes] Memory preflight: ${memoryPreflight.warning} (last elapsed_ms=${memoryPreflight.probeResult?.elapsedMs ?? "n/a"})\n`,
        );
      } else if (memoryPreflight.cached) {
        await ctx.onLog("stdout", `[hermes] Memory preflight: cached ok (no probe spawned)\n`);
      } else if (memoryPreflight.probeResult) {
        await ctx.onLog(
          "stdout",
          `[hermes] Memory preflight: ok (attempts=${memoryPreflight.attempts ?? 1} elapsed_ms=${memoryPreflight.probeResult.elapsedMs} budget_ms=${probeTimeoutMs})\n`,
        );
      }
    }
    if (!memoryPreflight.available) {
      if (memoryPreflight.probeResult) {
        const { reason, elapsedMs, exitCode, signal } = memoryPreflight.probeResult;
        await ctx.onLog(
          "stderr",
          `[hermes] Memory preflight probe: reason=${reason} elapsed_ms=${elapsedMs} exit_code=${exitCode ?? "none"} signal=${signal ?? "none"}\n`,
        );
      }
      if (memoryPreflight.error) {
        await ctx.onLog("stderr", `[hermes] Error: ${memoryPreflight.error}\n`);
        throw new Error(memoryPreflight.error);
      }
    }
  }
  if (prevSessionId) {
    if (usingIsolatedHome) {
      const reason = runtimeMcpServers.length > 0 && memoryConfig != null
        ? "runtime MCP servers and memory"
        : memoryConfig != null
        ? "runtime memory"
        : runtimeMcpServers.length > 0
        ? "runtime MCP servers"
        : "the per-run isolated home";
      await ctx.onLog(
        "stdout",
        `[hermes] Resuming session suppressed: isolated HERMES_HOME is active for ${reason}.\n`,
      );
    } else if (sessionId) {
      await ctx.onLog(
        "stdout",
        `[hermes] Resuming session: ${sessionId}\n`,
      );
    }
  }

  // ── Secret scrubbing ───────────────────────────────────────────────────
  const sensitiveValues: string[] = [];
  if (memoryConfig) {
    sensitiveValues.push(...extractMemorySensitiveValues(memoryConfig));
  }
  for (const s of runtimeMcpServers) {
    if (s.token && s.token.length > 0) {
      if (s.token.length > MAX_CONFIG_STRING_LENGTH) {
        const safeServerName =
          (typeof s.name === "string" ? s.name.replace(/[\r\n\0]/g, " ").trim().slice(0, 100) : "") || "unknown";
        const errorMsg = `Cannot safely redact MCP server token: token for server '${safeServerName}' exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`;
        await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
      sensitiveValues.push(s.token);
    }
    // A URL that carries credentials (userinfo or query string) must never reach logs or
    // errors either; plain host/path URLs are not sensitive and stay readable. Redact both
    // the raw string and its normalized form (what the URL parser / SDK may print).
    if (typeof s.url === "string") {
      if (s.url.length > MAX_CONFIG_STRING_LENGTH) {
        const safeServerName =
          (typeof s.name === "string" ? s.name.replace(/[\r\n\0]/g, " ").trim().slice(0, 100) : "") || "unknown";
        const errorMsg = `Cannot safely redact MCP server URL: URL for server '${safeServerName}' exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`;
        await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
      try {
        const parsed = new URL(s.url);
        if (parsed.search || parsed.username || parsed.password) {
          sensitiveValues.push(s.url, parsed.href);
          if (parsed.password) sensitiveValues.push(parsed.password);
        }
      } catch {
        // Malformed URLs are rejected by validateMcpServer / classified by the preflight.
      }
    }
  }
  // Sort descending by length so longer patterns are redacted before shorter ones
  sensitiveValues.sort((a, b) => b.length - a.length);

  // Defense-in-depth pre-spawn credential gate: ensure all collected secrets are within length limits
  // and contain boundary-safe characters before spawning child process.
  for (const secret of sensitiveValues) {
    if (secret.length > MAX_CONFIG_STRING_LENGTH) {
      const errorMsg = `Cannot safely redact sensitive credential: collected secret exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`;
      await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
      throw new Error(errorMsg);
    }
    if (!canSafelyRedactSecret(secret)) {
      const errorMsg = "Cannot safely redact sensitive credential: collected secret contains no boundary-safe characters";
      await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
      throw new Error(errorMsg);
    }
  }

  // Built only after the final child env is known (see below), so Router credentials inherited
  // from a profile are covered too; the streaming redactor snapshots its secret list on creation.
  let redactor: ReturnType<typeof createChunkAwareStreamingRedactor> | null = null;

  const scrubSecrets = (text: string): string => {
    return redactSensitiveString(text, sensitiveValues);
  };

  const emitClassifiedChunk = async (stream: "stdout" | "stderr", rawChunk: string, redactedChunk: string) => {
    if (stream === "stderr") {
      // Evaluate raw lines before redaction so short-secret replacements (e.g. replacing milliseconds in timestamps)
      // do not cause benign log patterns to fail classification.
      if (rawChunk.includes("\n") || rawChunk.includes("\r")) {
        const rawLines = rawChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [rawChunk];
        const redactedLines = redactedChunk.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g) || [redactedChunk];
        for (let i = 0; i < rawLines.length; i++) {
          const rawLine = rawLines[i];
          const redactedLine = redactedLines[i] ?? scrubSecrets(rawLine);
          const streamToUse = isBenignStderrLog(rawLine) ? "stdout" : "stderr";
          await ctx.onLog(streamToUse, redactedLine);
        }
        return;
      }
      const streamToUse = isBenignStderrLog(rawChunk) ? "stdout" : "stderr";
      return ctx.onLog(streamToUse, redactedChunk);
    }
    return ctx.onLog(stream, redactedChunk);
  };

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Classify raw chunks with isBenignStderrLog before redaction, while passing only
  // the redacted text downstream for storage and display.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (!redactor) throw new Error("Hermes output redactor is not initialized");
    const items = redactor.processDetailed(stream, chunk);
    for (const item of items) {
      await emitClassifiedChunk(stream, item.raw, item.redacted);
    }
  };

  const onCleanupWarning = (msg: string) => {
    void ctx.onLog("stdout", `[hermes] Warning: ${msg}\n`).catch(() => {});
  };

  let tempHome: string | null = null;
  let runHome: RunHome | null = null;
  let promptHome: RunHome | null = null;
  try {
    if (promptViaFile) {
      promptHome = await createRunHome({ prefix: "paperclip-hermes-prompt-" });
      const promptPath = path.join(promptHome.path, "query.txt");
      await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
      args[2] = promptPath;
    }
    if (usingIsolatedHome) {
      // Home placement and host inheritance are separate decisions: hosted runs and every Router run
      // get a fresh per-run home with the Hermes profile inside it (never the host profiles tree);
      // only hosted runs are cut off from the host's sanitized config/skills.
      if (hostIsolated || isRouterRun) runHome = await createRunHome();
      const preparedHome = await prepareHermesMcpHome({
        servers: runtimeMcpServers,
        memory: memoryConfig ?? undefined,
        ...(memoryProvider ? { memoryProvider } : {}),
        config,
        flags: hardeningFlags,
        onWarning: onCleanupWarning,
        canonicalRouterEndpoint: isRouterRun,
        isolatedFromHost: hostIsolated,
        ...(anthropicRequestTimeoutSec !== undefined
          ? { anthropicRequestTimeoutSec } : {}),
        ...(runHome ? { tempDirPrefix: path.join(runHome.path, "hermes-") } : {}),
      });
      tempHome = preparedHome.homeDir;
      env.HERMES_HOME = tempHome;
      // An inherited profile may carry a canonical Router key (on any run); enroll it for redaction
      // even if it is not the value the child ends up with.
      noteRouterKeyCandidate(preparedHome.env?.[RAMP_ROUTER_API_KEY_ENV]);
      noteRouterKeyCandidate(preparedHome.providerEnv?.[RAMP_ROUTER_API_KEY_ENV]);
      Object.assign(env, preparedHome.env);
      // Router runs take no host provider env: their only credential is the canonical key resolved
      // (and, for local runs, explicitly projected) above.
      if (preparedHome.providerEnv && !isRouterRun) {
        for (const [key, value] of Object.entries(preparedHome.providerEnv)) {
          // The host Router key is not this run's credential, and it is only projected for Router
          // runs (above), so never inherit it implicitly. An agent's explicit config.env binding is
          // already in `env` and is left untouched. Still enrolled for redaction above.
          if (key === RAMP_ROUTER_API_KEY_ENV) continue;
          if (env[key] === undefined) {
            env[key] = value;
          }
        }
      }
      if (runtimeMcpServers.length > 0) {
        // Fail closed before the model runs: every projected server must accept the run
        // credential, handshake, and list every allowlisted tool. Diagnostics carry only
        // server keys, HTTP status and configured tool names, never URLs or tokens.
        let preflight: Awaited<ReturnType<typeof preflightHermesMcpServers>>;
        try {
          preflight = await preflightHermesMcpServers(runtimeMcpServers, preparedHome.serverKeys);
        } catch (err) {
          const detail = redactSensitiveString(err instanceof Error ? err.message : String(err), sensitiveValues);
          await ctx.onLog("stderr", `[hermes] MCP preflight error: ${detail}\n`);
          throw new Error(`Hermes MCP preflight error; run aborted before model execution: ${detail}`);
        }
        if (!preflight.ok) {
          const lines = preflight.failures.map((failure) => redactSensitiveString(failure.message, sensitiveValues));
          for (const line of lines) {
            await ctx.onLog("stderr", `[hermes] MCP preflight failed: ${line}\n`);
          }
          throw new Error(
            `Hermes MCP preflight failed for ${preflight.failures.length} of ${runtimeMcpServers.length} runtime MCP server(s); run aborted before model execution: ${lines.join("; ")}`,
          );
        }
        for (const server of preflight.servers) {
          await ctx.onLog(
            "stdout",
            `[hermes] MCP preflight ok: '${server.serverKey}' lists exactly ${server.listedToolCount} allowlisted tool(s).\n`,
          );
        }
      }
      if ((hostIsolated || isRouterRun) && wantsPaperclipRuntimeSkills) {
        try {
          const selectedSkills = await reconcileHermesPaperclipSkills(config, undefined, {
            skillsHome: path.join(tempHome, "skills"),
          });
          if (selectedSkills.length > 0) {
            await ctx.onLog(
              "stdout",
              `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the isolated Hermes home.\n`,
            );
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
          throw err;
        }
      }
      if (memoryProvider) {
        const hasMem0Host = Boolean(cfgEnvString((userEnv as Record<string, unknown> | undefined)?.MEM0_HOST));
        await ctx.onLog(
          "stdout",
          `[hermes] Memory provider ${memoryProvider} selected through adapterConfig (settings come from env${hasMem0Host ? "" : "; MEM0_HOST is not set, so the provider may be unavailable"}).\n`,
        );
      }
      if (runtimeMcpServers.length > 0 && memoryConfig != null) {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with runtime memory and ${runtimeMcpServers.length} runtime MCP server(s).\n`,
        );
      } else if (memoryConfig != null) {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with runtime memory.\n`,
        );
      } else if (runtimeMcpServers.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Prepared isolated HERMES_HOME with ${runtimeMcpServers.length} runtime MCP server(s).\n`,
        );
      } else {
        await ctx.onLog("stdout", `[hermes] Prepared isolated HERMES_HOME inside a per-run home.\n`);
      }
    }

    // Applied LAST so no config.env / profile / provider merge can redirect HOME, XDG_* or TMPDIR
    // back to the server host's home.
    if (runHome) Object.assign(env, runHome.env);

    // Re-enforce protected security invariants after all runtime profile & provider merges
    env.HERMES_DISABLE_LAZY_INSTALLS = "1";
    if (hardeningFlags.mem0AutoSyncOff && memoryProvider === "mem0") {
      env.MEM0_AUTO_SYNC = "false";
    }

    let scanPolicy: ReturnType<typeof applyCommandScanPolicy>;
    try {
      scanPolicy = applyCommandScanPolicy({ env, hermesCmd, args });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Command scan policy rejection: ${msg}\n`);
      throw err;
    }
    const finalHermesCmd = scanPolicy.hermesCmd;
    const finalArgs = scanPolicy.args;
    const finalEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(scanPolicy.env)) {
      if (v !== undefined) {
        finalEnv[k] = v;
      }
    }

    // TECH-7895: enforce the Router endpoint/alias exclusions on the FINAL child env (after config
    // env, inherited profile env and scan-policy merges), and pass the same names to unsetEnvKeys so
    // no later layer can restore them.
    for (const name of routerEnvNamesToStrip(finalEnv, isRouterRun)) routerStrippedEnvNames.add(name);
    for (const name of routerStrippedEnvNames) delete finalEnv[name];
    if (isRouterRun) {
      // The readiness probe strips these too; removing them from the run keeps both import contexts
      // identical, so the registry that was verified is the registry that loads.
      for (const name of ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES) {
        routerStrippedEnvNames.add(name);
        delete finalEnv[name];
      }
    }

    // Authoritative canonical-key decision on what the child will actually receive.
    const isRedactableRouterKey = (value: string) =>
      value.length <= MAX_CONFIG_STRING_LENGTH && canSafelyRedactSecret(value);
    const finalRouterKey = finalEnv[RAMP_ROUTER_API_KEY_ENV];
    const finalRouterKeyUsable =
      finalRouterKey !== undefined &&
      !!readRouterApiKey(finalEnv) &&
      isRedactableRouterKey(finalRouterKey) &&
      isRedactableRouterKey(finalRouterKey.trim());
    if (isRouterRun) {
      if (!readRouterApiKey(finalEnv)) {
        await ctx.onLog("stderr", `[hermes] ${ROUTER_KEY_MISSING_MESSAGE}\n`);
        throw new Error(ROUTER_KEY_MISSING_MESSAGE);
      }
      if (!finalRouterKeyUsable) {
        const errorMsg = "Cannot safely redact the Ramp Router API key; refusing to start";
        await ctx.onLog("stderr", `[hermes] Error: ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
    } else if (finalRouterKey !== undefined && !finalRouterKeyUsable) {
      // Not this run's credential: an unusable (blank or unredactable) key is dropped, not fatal.
      delete finalEnv[RAMP_ROUTER_API_KEY_ENV];
      routerStrippedEnvNames.add(RAMP_ROUTER_API_KEY_ENV);
    }
    noteRouterKeyCandidate(finalEnv[RAMP_ROUTER_API_KEY_ENV]);

    // Every safely redactable canonical key variant joins the redaction set BEFORE the streaming
    // redactor is built (once), so it is scrubbed from streamed chunks, including across chunk
    // boundaries, and from captured/returned output. Unredactable variants that did not reach the
    // child are skipped; the final key was validated above.
    const redactionSet = new Set(sensitiveValues);
    for (const value of routerKeyCandidates) {
      if (isRedactableRouterKey(value)) redactionSet.add(value);
    }
    sensitiveValues.splice(
      0,
      sensitiveValues.length,
      ...[...redactionSet].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)),
    );
    redactor = createChunkAwareStreamingRedactor(sensitiveValues);

    // The command and cwd actually launched. A Router run binds its launcher ONCE (after command-scan
    // policy) against its absolute cwd and normalized PATH, probes that exact descriptor, and then
    // executes the bound absolute launcher with the same PATH and cwd — nothing re-resolves it.
    let launchCommand = finalHermesCmd;
    let launchCwd = cwd;
    if (isRouterRun) {
      const bound = resolveRouterLaunchPlan({ command: finalHermesCmd, pathEnv: finalEnv.PATH, cwd });
      if (!bound.ok) {
        await ctx.onLog("stderr", `[hermes] ${bound.message}\n`);
        throw new Error(bound.message);
      }
      if (finalEnv.PATH !== undefined) finalEnv.PATH = bound.plan.path;
      // Bounded, inference-free registry probe of the bound launcher. It receives only OS
      // essentials — never keys or app tokens — and runs in its own fresh HOME/XDG/HERMES_HOME,
      // not this run's profile.
      const capability = await probeHermesRouterSupport({
        command: finalHermesCmd,
        env: buildRouterProbeLaunchEnv(finalEnv),
        cwd: bound.plan.cwd,
        launch: bound.plan,
      });
      if (!capability.supported) {
        await ctx.onLog("stderr", `[hermes] ${capability.message}\n`);
        throw new Error(capability.message);
      }
      await ctx.onLog("stdout", `[hermes] Ramp Router provider verified for ${finalHermesCmd}\n`);
      launchCommand = bound.plan.executable;
      launchCwd = bound.plan.cwd;
    }

    // Quiet CLI output remains clean. Progress comes from metadata in this run's
    // own ephemeral database, never from another agent's/host's conversation.
    const progress = tempHome && ctx.onEvent ? startHermesProgress(tempHome, ctx.onEvent) : null;
    const result = await (async () => {
      try {
        return await runChildProcess(ctx.runId, launchCommand, finalArgs, {
          cwd: launchCwd,
          env: finalEnv,
          timeoutSec,
          graceSec,
          onLog: wrappedOnLog,
          onSpawn: ctx.onSpawn,
          unsetEnvKeys: [...HERMES_FORBIDDEN_ENV_VARS, ...[...routerStrippedEnvNames].sort()],
        });
      } finally {
        await progress?.stop();
      }
    })();

    const flushedLogs = redactor.flushDetailed();
    for (const fl of flushedLogs) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk);
    }

    // ── Parse output ───────────────────────────────────────────────────────
    const scrubbedStdout = scrubSecrets(result.stdout || "");
    const scrubbedStderr = scrubSecrets(result.stderr || "");
    const parsed = parseHermesOutput(scrubbedStdout, scrubbedStderr);

    await ctx.onLog(
      "stdout",
      `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
    );
    if (parsed.sessionId) {
      await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
    }

    // ── Build result ───────────────────────────────────────────────────────
    const executionResult: AdapterExecutionResult = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      provider: resolvedProvider,
      model,
    };

    if (usingIsolatedHome) {
      executionResult.clearSession = true;
    }

    // A non-zero exit means whatever Hermes printed is a failure report (an HTTP error, a
    // provider refusal, a traceback summary), not an answer. Paperclip publishes the summary /
    // resultJson.result of a chat-connected run to the provider thread regardless of run status,
    // so that text must not become the summary; it is kept in errorMessage for the run detail.
    // Only a numeric non-zero exit counts. Timed-out runs were ended by Paperclip and keep their
    // partial stdout as the summary (unchanged); signal exits are cancellations (pause/cancel send
    // SIGTERM) and are deliberately not labelled as failures here, see execute.onspawn.test.ts.
    const hermesFailed = !result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0;
    const failedOutputExcerpt = hermesFailed && parsed.response
      ? scrubSecrets(parsed.response.split("\n").find((line) => line.trim().length > 0) ?? "").slice(0, 300)
      : "";

    if (parsed.errorMessage) {
      executionResult.errorMessage = augmentStaleImageError(
        scrubSecrets(parsed.errorMessage),
        memoryConfig,
        scrubbedStderr,
      );
    } else if (hermesFailed) {
      executionResult.errorMessage = augmentStaleImageError(
        failedOutputExcerpt
          ? `Hermes exited with code ${result.exitCode}: ${failedOutputExcerpt}`
          : `Hermes exited with code ${result.exitCode}`,
        memoryConfig,
        scrubbedStderr,
      );
    }

    if (parsed.usage) {
      executionResult.usage = parsed.usage;
    }

    if (parsed.costUsd !== undefined) {
      executionResult.costUsd = parsed.costUsd;
    }

    // Summary from agent response: not for a non-zero exit (hermesFailed above). Timed-out and
    // signal-ended runs still publish their partial stdout, as before.
    if (parsed.response && !hermesFailed) {
      executionResult.summary = scrubSecrets(parsed.response.slice(0, 2000));
    }

    // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
    executionResult.resultJson = {
      result: hermesFailed ? "" : scrubSecrets(parsed.response || ""),
      session_id: parsed.sessionId || null,
      usage: parsed.usage || null,
      cost_usd: parsed.costUsd ?? null,
    };

    // Store session ID for next run
    if (persistSession && parsed.sessionId && !usingIsolatedHome) {
      executionResult.sessionParams = { sessionId: parsed.sessionId };
      executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
    }

    return executionResult;
  } finally {
    if (promptHome) {
      await promptHome.cleanup().catch(() => onCleanupWarning("Temporary prompt cleanup encountered an error"));
    }
    const remainingFlushed = redactor?.flushDetailed() ?? [];
    for (const fl of remainingFlushed) {
      await emitClassifiedChunk(fl.stream, fl.rawChunk, fl.chunk).catch(() => {});
    }
    if (tempHome) {
      await cleanupHermesMcpHome(tempHome, onCleanupWarning);
    }
    if (runHome) {
      await runHome.cleanup().catch(() => onCleanupWarning("Temporary run home cleanup encountered an error"));
    }
  }
}
