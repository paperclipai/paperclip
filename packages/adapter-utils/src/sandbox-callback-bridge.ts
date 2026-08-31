import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  runWithoutActiveStep,
  runWithRuntimeParent,
  type RuntimeSpanRunner,
  type StartupSpanContext,
} from "./acpx-engine/startup-timing.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import type { RunProcessResult } from "./server-utils.js";

const DEFAULT_BRIDGE_TOKEN_BYTES = 24;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 100;
const DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_BRIDGE_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_BRIDGE_MAX_QUEUE_DEPTH = 64;
const DEFAULT_BRIDGE_MAX_BODY_BYTES = 256 * 1024;
// Per-iteration timeout for one poll-loop client call. A healthy control-plane
// round trip finishes in well under one second, so 10s is far above a normal
// iteration and never false-fires on a slow-but-live call. It is also well
// under the in-sandbox 30s response deadline
// (PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS), so the host loop fails fast and writes
// 503 responses before the in-sandbox client gives up. A silently unresponsive
// sandbox channel makes a client call hang with no reject; this timeout turns
// that hang into a caught error, so the poll loop can back off and retry while
// the watchdog below decides when to fail the queued requests.
const DEFAULT_BRIDGE_ITERATION_TIMEOUT_MS = 10_000;
// Watchdog backstop for a hang that the per-iteration timeout does not catch
// (for example many slow-but-under-timeout calls, or a stall outside the awaited
// calls). It is larger than one iteration timeout, so a single slow iteration
// never trips it, and it stays under the in-sandbox 30s response deadline.
const DEFAULT_BRIDGE_WATCHDOG_TIMEOUT_MS = 20_000;
// Grace period the recovery path gives an aborted in-flight handler to finalize
// its own response. The recovery path aborts the handler, then waits this long.
// A cooperating handler threads the abort signal into its work, rejects, and
// writes its own response inside the grace, so its accurate result wins. A
// handler that ignores the signal and never settles does not write inside the
// grace; the recovery path then writes a non-retryable 504 backstop, so the
// request never strands with no response. The grace is well under the in-sandbox
// 30s response deadline, so the backstop lands before the in-sandbox client
// gives up.
const DEFAULT_BRIDGE_ABORTED_HANDLER_GRACE_MS = 5_000;
// The recovery path retries the 504 backstop write this many times before it
// gives up. A single transient write failure, or one that exceeds the iteration
// timeout, then does not strand the caller with no terminal response.
const MAX_BACKSTOP_WRITE_ATTEMPTS = 3;
// The delay between two 504 backstop write attempts. It is short, so all retries
// finish well under the in-sandbox 30s response deadline.
const BACKSTOP_WRITE_RETRY_MS = 50;
// Backoff cap between poll-loop retries after a transient iteration failure.
// The cap keeps a recovering loop probing often enough to resume before the
// in-sandbox 30s response deadline strands queued callers, while the
// exponential ramp below it keeps a hard-down channel from burning an exec
// call every poll interval.
const MAX_TRANSIENT_ITERATION_BACKOFF_MS = 5_000;
const REMOTE_WRITE_BASE64_CHUNK_SIZE = 32 * 1024;
export const SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT = "paperclip-bridge-server.mjs";
const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";

// The bridge modes the generated gateway supports. The file mode polls a
// request/response queue on disk. The http2 mode runs one Node HTTP/2 client
// session directly on stdin/stdout, after it sends the one READY line the
// host readiness gate expects. The generated `.mjs` selects the mode from
// `PAPERCLIP_API_BRIDGE_MODE`. The generated gateway rejects every other
// value with a fixed startup error, including the retired duplex transport.
// HTTP/2 is the preferred transport. `queue_v1` is the soft-deprecated fallback.
const SANDBOX_CALLBACK_BRIDGE_FILE_MODE = "queue_v1";
/** The active non-file transport mode. */
export const SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE = "http2_v1";

/** Span name that wraps one Paperclip-API callback request — read the request,
 * write the response, and remove the request file. */
const CALLBACK_BRIDGE_RELAY_REQUEST_SPAN = "sandbox.callbackBridge.relayRequest";

/** Span name for a failed or hung bridge worker. The worker runs a throwing
 * function under this span through `input.runtimeSpan`, so the failure lands in
 * the run trace. The run and the orchestrator then see the hang, not only
 * stdout. */
const CALLBACK_BRIDGE_WORKER_FAILED_SPAN = "sandbox.callbackBridge.workerFailed";

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES = DEFAULT_BRIDGE_MAX_BODY_BYTES;

export interface SandboxCallbackBridgeRouteRule {
  method: string;
  path: RegExp;
}

// Routes the in-sandbox heartbeat skill is documented to call. The server
// still enforces actor-level permissions on top of this allowlist; the list
// exists to bound the surface area a compromised CLI could reach via the
// reverse bridge. Keep this in sync with the Paperclip skill in
// `skills/paperclip/SKILL.md` and `references/api-reference.md`.
export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST: readonly SandboxCallbackBridgeRouteRule[] = [
  // Identity, inbox, agent self-management
  { method: "GET", path: /^\/api\/agents\/me$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox-lite$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox\/mine$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/skills$/ },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/skills\/sync$/ },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+\/instructions-path$/ },

  // Company-level reads used to discover work and context
  { method: "GET", path: /^\/api\/companies\/[^/]+$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/dashboard$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/agents$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/projects$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/goals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/org$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/approvals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/skills$/ },
  { method: "GET", path: /^\/api\/projects\/[^/]+$/ },
  { method: "GET", path: /^\/api\/goals\/[^/]+$/ },

  // Issue lifecycle: read context, checkout, update, comment, document, release
  { method: "GET", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/heartbeat-context$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/comments(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents(?:\/[^/]+)?$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+\/revisions$/ },
  { method: "PUT", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/checkout$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/release$/ },
  { method: "PATCH", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/approvals$/ },

  // Work products: publish branch/commit/artifact metadata for completed work.
  { method: "GET", path: /^\/api\/issues\/[^/]+\/work-products$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/work-products$/ },
  { method: "PATCH", path: /^\/api\/work-products\/[^/]+$/ },

  // Issue-thread interactions (create, resolve, verdict, and withdraw)
  { method: "GET", path: /^\/api\/issues\/[^/]+\/interactions(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions\/[^/]+\/(?:accept|reject|respond|verdicts|withdraw)$/ },

  // Subtasks / delegation
  { method: "POST", path: /^\/api\/companies\/[^/]+\/issues$/ },

  // Hiring (paperclip-create-agent skill): adapter/icon discovery, comparing
  // existing agent configs, submitting the hire request, and linking the
  // resulting approval to its source issue. Direct agent creation
  // (POST /api/companies/:id/agents) stays denied — hires must go through the
  // approval-gated agent-hires endpoint, which the server still permission-checks.
  { method: "GET", path: /^\/llms\/agent-configuration\.txt$/ },
  { method: "GET", path: /^\/llms\/agent-configuration\/[^/]+\.txt$/ },
  { method: "GET", path: /^\/llms\/agent-icons\.txt$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/agent-configurations$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/agent-hires$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/approvals$/ },

  // Approvals (request, read, comment)
  { method: "GET", path: /^\/api\/approvals\/[^/]+$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/approvals$/ },

  // Execution workspaces and runtime services (start/stop/restart dev servers)
  { method: "GET", path: /^\/api\/execution-workspaces\/[^/]+$/ },
  { method: "POST", path: /^\/api\/execution-workspaces\/[^/]+\/runtime-services\/(?:start|stop|restart)$/ },

  // Routines (agents manage their own routines and triggers)
  { method: "GET", path: /^\/api\/routines\/[^/]+$/ },
  { method: "GET", path: /^\/api\/routines\/[^/]+\/runs$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[^/]+$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/run$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/triggers$/ },
  { method: "PATCH", path: /^\/api\/routine-triggers\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/routine-triggers\/[^/]+$/ },
] as const;

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
] as const;

export interface SandboxCallbackBridgeRequest {
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /**
   * UTF-8 body contents. The bridge rejects non-JSON request bodies; binary
   * payloads are intentionally out of scope for this queue protocol.
   */
  body: string;
  createdAt: string;
}

export interface SandboxCallbackBridgeResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  completedAt: string;
}

export interface SandboxCallbackBridgeAsset {
  localDir: string;
  entrypoint: string;
  cleanup(): Promise<void>;
}

export interface SandboxCallbackBridgeDirectories {
  rootDir: string;
  requestsDir: string;
  responsesDir: string;
  logsDir: string;
  readyFile: string;
  pidFile: string;
  logFile: string;
}

export interface SandboxCallbackBridgeQueueClient {
  makeDir(remotePath: string): Promise<void>;
  // Optional batched directory create. The built-in clients create every
  // queue directory in one remote exec. A client that predates this method
  // omits it; the worker falls back to sequential `makeDir` calls, so an
  // external implementation stays compatible without a change.
  makeDirs?(remotePaths: string[]): Promise<void>;
  listJsonFiles(remotePath: string): Promise<string[]>;
  readTextFile(remotePath: string): Promise<string>;
  writeTextFile(remotePath: string, body: string): Promise<void>;
  writeResponseFile?(
    responsePath: string,
    body: string,
    options?: {
      requestPath?: string | null;
    },
  ): Promise<{ wrote: boolean }>;
  rename(fromPath: string, toPath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

export interface SandboxCallbackBridgeWorkerHandle {
  stop(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface StartedSandboxCallbackBridgeServer {
  baseUrl: string;
  host: string;
  port: number;
  pid: number;
  directories: SandboxCallbackBridgeDirectories;
  stop(): Promise<void>;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeMethod(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "GET";
}

function normalizeTimeoutMs(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * Race a promise against a timeout. On timeout the returned promise rejects with
 * a clear error. The helper clears the timer on every settle path, so it leaks
 * no `setTimeout`. The wrapped promise is not cancelable; when it never settles,
 * it keeps running in the background, but the caller already moved on through
 * the reject.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function buildRunnerFailureMessage(action: string, result: RunProcessResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout;
  if (result.timedOut) {
    return `${action} timed out${detail ? `: ${detail}` : ""}`;
  }
  return `${action} failed with exit code ${result.exitCode ?? "null"}${detail ? `: ${detail}` : ""}`;
}

async function runShell(
  runner: CommandManagedRuntimeRunner,
  cwd: string,
  script: string,
  timeoutMs: number,
  shellCommand: "bash" | "sh" = "sh",
  stdin?: string,
): Promise<RunProcessResult> {
  return await runner.execute({
    command: shellCommand,
    args: shellCommandArgs(script),
    cwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
    },
    timeoutMs,
    stdin,
    // Every command that rides this helper is bridge control-plane plumbing:
    // input delivery, output read, callback relay, and queue/setup bookkeeping.
    // It must run concurrently with the agent, so force it off the persistent
    // session. In streamed mode the agent holds that single serialized session
    // for the whole run; a control write on the same session queues behind the
    // agent command that never returns — a permanent deadlock.
    bypassSession: true,
  });
}

function requireSuccessfulResult(action: string, result: RunProcessResult): RunProcessResult {
  if (!result.timedOut && result.exitCode === 0) return result;
  throw new Error(buildRunnerFailureMessage(action, result));
}

function base64Chunks(body: string): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < body.length; offset += REMOTE_WRITE_BASE64_CHUNK_SIZE) {
    out.push(body.slice(offset, offset + REMOTE_WRITE_BASE64_CHUNK_SIZE));
  }
  return out;
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.stat(filePath).then(() => true).catch(() => false);
}

function buildRemotePidLockAcquireScript(lockDirExpr: string, timeoutMessage: string): string[] {
  return [
    "attempts=0",
    `while ! mkdir ${lockDirExpr} 2>/dev/null; do`,
    "  holder_pid=\"\"",
    `  if [ -s ${lockDirExpr}/pid ]; then`,
    `    holder_pid="$(cat ${lockDirExpr}/pid 2>/dev/null || true)"`,
    "  fi",
    "  if [ -n \"$holder_pid\" ] && ! kill -0 \"$holder_pid\" 2>/dev/null; then",
    `    rm -rf ${lockDirExpr}`,
    "    continue",
    "  fi",
    "  attempts=$((attempts + 1))",
    "  if [ \"$attempts\" -ge 600 ]; then",
    `    echo ${shellQuote(timeoutMessage)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 0.05",
    "done",
    `printf '%s\\n' "$$" > ${lockDirExpr}/pid`,
  ];
}

function buildRemotePidLockCleanupScript(lockDirExpr: string, cleanupLines: string[]): string[] {
  return [
    "cleanup() {",
    ...cleanupLines.map((line) => `  ${line}`),
    `  rm -rf ${lockDirExpr}`,
    "}",
    "trap cleanup EXIT INT TERM",
  ];
}

export function createSandboxCallbackBridgeToken(bytes = DEFAULT_BRIDGE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function authorizeSandboxCallbackBridgeRequestWithRoutes(
  request: Pick<SandboxCallbackBridgeRequest, "method" | "path">,
  routes: readonly SandboxCallbackBridgeRouteRule[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
): string | null {
  const method = normalizeMethod(request.method);
  return routes.some((route) => route.method === method && route.path.test(request.path))
    ? null
    : `Route not allowed: ${method} ${request.path}`;
}

export function sanitizeSandboxCallbackBridgeHeaders(
  headers: Record<string, string>,
  allowlist: readonly string[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
): Record<string, string> {
  const allowed = new Set(allowlist.map((header) => header.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

export function sandboxCallbackBridgeDirectories(rootDir: string): SandboxCallbackBridgeDirectories {
  return {
    rootDir,
    requestsDir: path.posix.join(rootDir, "requests"),
    responsesDir: path.posix.join(rootDir, "responses"),
    logsDir: path.posix.join(rootDir, "logs"),
    readyFile: path.posix.join(rootDir, "ready.json"),
    pidFile: path.posix.join(rootDir, "server.pid"),
    logFile: path.posix.join(rootDir, "logs", "bridge.log"),
  };
}

export function buildSandboxCallbackBridgeEnv(input: {
  queueDir: string;
  bridgeToken: string;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Record<string, string> {
  return {
    PAPERCLIP_API_BRIDGE_MODE: SANDBOX_CALLBACK_BRIDGE_FILE_MODE,
    PAPERCLIP_BRIDGE_QUEUE_DIR: input.queueDir,
    PAPERCLIP_BRIDGE_TOKEN: input.bridgeToken,
    PAPERCLIP_BRIDGE_HOST: input.host?.trim() || "127.0.0.1",
    PAPERCLIP_BRIDGE_PORT: String(input.port && input.port > 0 ? Math.trunc(input.port) : 0),
    PAPERCLIP_BRIDGE_POLL_INTERVAL_MS: String(
      normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS),
    ),
    PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: String(
      normalizeTimeoutMs(input.responseTimeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS),
    ),
    PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH: String(
      normalizeTimeoutMs(input.maxQueueDepth, DEFAULT_BRIDGE_MAX_QUEUE_DEPTH),
    ),
    PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(
      normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES),
    ),
  };
}

export async function createSandboxCallbackBridgeAsset(): Promise<SandboxCallbackBridgeAsset> {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-asset-"));
  const entrypoint = path.join(localDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  await fs.writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
  return {
    localDir,
    entrypoint,
    cleanup: async () => {
      await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function createFileSystemSandboxCallbackBridgeQueueClient(): SandboxCallbackBridgeQueueClient {
  return {
    makeDir: async (remotePath) => {
      await fs.mkdir(remotePath, { recursive: true });
    },
    makeDirs: async (remotePaths) => {
      for (const remotePath of remotePaths) {
        await fs.mkdir(remotePath, { recursive: true });
      }
    },
    listJsonFiles: async (remotePath) => {
      const entries = await fs.readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => await fs.readFile(remotePath, "utf8"),
    writeTextFile: async (remotePath, body) => {
      await fs.mkdir(path.posix.dirname(remotePath), { recursive: true });
      // Write to a temporary path that does NOT end in `.json`, then rename it
      // onto the final `.json` path. A direct `writeFile` truncates the final
      // path first, so a `.json`-only reader (the stdin poller) can see an
      // empty or partial file. The atomic rename never exposes partial content.
      const tempPath = `${remotePath}.paperclip-upload.decoded`;
      await fs.writeFile(tempPath, body, "utf8");
      await fs.rename(tempPath, remotePath);
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = path.posix.dirname(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const lockPidFile = `${lockDir}/pid`;
      if (options.requestPath) {
        const requestExists = await pathExists(options.requestPath);
        if (!requestExists) {
          return { wrote: false };
        }
      }
      await fs.mkdir(responseDir, { recursive: true });
      // PID-liveness mkdir-mutex: mirrors the shell-based bridge mutex so a
      // crashed holder (SIGKILL / OOM) doesn't deadlock subsequent writers
      // for the full timeout window.
      let attempts = 0;
      while (true) {
        try {
          await fs.mkdir(lockDir);
          await fs.writeFile(lockPidFile, `${process.pid}\n`, "utf8");
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "EEXIST") {
            throw error;
          }
          let holderPid: number | null = null;
          try {
            const raw = await fs.readFile(lockPidFile, "utf8");
            const parsed = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) holderPid = parsed;
          } catch {
            // pid file missing or unreadable — treat as stale lock
          }
          let holderAlive = false;
          if (holderPid !== null) {
            try {
              process.kill(holderPid, 0);
              holderAlive = true;
            } catch {
              holderAlive = false;
            }
          }
          if (!holderAlive) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
          attempts += 1;
          if (attempts >= 600) {
            throw new Error("Timed out acquiring sandbox callback bridge response lock.");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      try {
        if (options.requestPath) {
          const requestExists = await pathExists(options.requestPath);
          if (!requestExists) {
            return { wrote: false };
          }
        }
        const responseExists = await pathExists(responsePath);
        if (responseExists) {
          return { wrote: false };
        }
        await fs.writeFile(tempPath, body, "utf8");
        await fs.rename(tempPath, responsePath);
        return { wrote: true };
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    rename: async (fromPath, toPath) => {
      await fs.mkdir(path.posix.dirname(toPath), { recursive: true });
      await fs.rename(fromPath, toPath);
    },
    remove: async (remotePath) => {
      await fs.rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function createCommandManagedSandboxCallbackBridgeQueueClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): SandboxCallbackBridgeQueueClient {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runChecked = async (action: string, script: string) =>
    requireSuccessfulResult(action, await runShell(input.runner, input.remoteCwd, script, timeoutMs, shellCommand));

  return {
    makeDir: async (remotePath) => {
      await runChecked(`mkdir ${remotePath}`, `mkdir -p ${shellQuote(remotePath)}`);
    },
    makeDirs: async (remotePaths) => {
      if (remotePaths.length === 0) {
        return;
      }
      const quoted = remotePaths.map((remotePath) => shellQuote(remotePath));
      await runChecked(`mkdir ${remotePaths.join(" ")}`, `mkdir -p ${quoted.join(" ")}`);
    },
    listJsonFiles: async (remotePath) => {
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          `if [ -d ${shellQuote(remotePath)} ]; then`,
          `  for file in ${shellQuote(remotePath)}/*.json; do`,
          `    [ -f "$file" ] || continue`,
          "    basename \"$file\"",
          "  done",
          "fi",
        ].join("\n"),
        timeoutMs,
        shellCommand,
      );
      requireSuccessfulResult(`list ${remotePath}`, result);
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => {
      const result = await runChecked(`read ${remotePath}`, `base64 < ${shellQuote(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
    },
    writeTextFile: async (remotePath, body) => {
      const remoteDir = path.posix.dirname(remotePath);
      // Two temporary paths that do NOT end in `.json`, so a `.json`-only
      // reader (the stdin poller) never lists them. The base64 upload lands in
      // `tempPath`. The decode result lands in `decodedPath`. An atomic rename
      // then moves the complete decoded content onto the final `.json` path.
      // A direct `> remotePath` redirect truncates the final path before the
      // decode writes it, so a reader can see an empty or partial file.
      const tempPath = `${remotePath}.paperclip-upload.b64`;
      const decodedPath = `${remotePath}.paperclip-upload.decoded`;
      await runChecked(
        `prepare upload ${remotePath}`,
        `mkdir -p ${shellQuote(remoteDir)} && rm -f ${shellQuote(tempPath)} ${shellQuote(decodedPath)} && : > ${shellQuote(tempPath)}`,
      );
      const base64Body = toBuffer(Buffer.from(body, "utf8")).toString("base64");
      for (const chunk of base64Chunks(base64Body)) {
        await runChecked(
          `append upload chunk ${remotePath}`,
          `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(tempPath)}`,
        );
      }
      await runChecked(
        `finalize upload ${remotePath}`,
        `base64 -d < ${shellQuote(tempPath)} > ${shellQuote(decodedPath)} && mv ${shellQuote(decodedPath)} ${shellQuote(remotePath)} && rm -f ${shellQuote(tempPath)}`,
      );
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = path.posix.dirname(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const requestPath = options.requestPath?.trim() || "";
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          "set -eu",
          `response_dir=${shellQuote(responseDir)}`,
          `response_path=${shellQuote(responsePath)}`,
          `temp_path=${shellQuote(tempPath)}`,
          `lock_dir=${shellQuote(lockDir)}`,
          `request_path=${shellQuote(requestPath)}`,
          "mkdir -p \"$response_dir\"",
          ...buildRemotePidLockAcquireScript("\"$lock_dir\"", "Timed out acquiring sandbox callback bridge response lock."),
          ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
            "rm -f \"$temp_path\"",
          ]),
          "if [ -n \"$request_path\" ] && [ ! -f \"$request_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "if [ -f \"$response_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "cat > \"$temp_path\"",
          "mv \"$temp_path\" \"$response_path\"",
          "printf '{\"wrote\":true}\\n'",
        ].join("\n"),
        timeoutMs,
        shellCommand,
        body,
      );
      requireSuccessfulResult(`write bridge response ${responsePath}`, result);
      try {
        return {
          wrote: JSON.parse(result.stdout.trim())?.wrote === true,
        };
      } catch (error) {
        throw new Error(
          `Sandbox callback bridge response write wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    rename: async (fromPath, toPath) => {
      await runChecked(
        `rename ${fromPath}`,
        `mkdir -p ${shellQuote(path.posix.dirname(toPath))} && mv ${shellQuote(fromPath)} ${shellQuote(toPath)}`,
      );
    },
    remove: async (remotePath) => {
      await runChecked(`remove ${remotePath}`, `rm -rf ${shellQuote(remotePath)}`);
    },
  };
}

async function writeBridgeResponse(
  client: SandboxCallbackBridgeQueueClient,
  requestPath: string,
  responsePath: string,
  response: SandboxCallbackBridgeResponse,
  options: { requireRequestPath?: boolean } = {},
) {
  const body = `${JSON.stringify(response)}\n`;
  if (client.writeResponseFile) {
    await client.writeResponseFile(responsePath, body, options.requireRequestPath === false ? {} : { requestPath });
    return;
  }
  const tempPath = `${responsePath}.tmp`;
  await client.writeTextFile(tempPath, body);
  await client.rename(tempPath, responsePath);
}

export async function startSandboxCallbackBridgeWorker(input: {
  client: SandboxCallbackBridgeQueueClient;
  queueDir: string;
  pollIntervalMs?: number | null;
  // Per-iteration timeout for one poll-loop client call (the `listJsonFiles`
  // poll and one `processRequestFile`). On timeout the loop `catch` runs
  // `failPendingRequests`. Defaults to DEFAULT_BRIDGE_ITERATION_TIMEOUT_MS.
  iterationTimeoutMs?: number | null;
  // Watchdog threshold. When the loop makes no successful iteration within this
  // time, the watchdog runs `failPendingRequests` and surfaces a run-level error
  // through `runtimeSpan`. Defaults to DEFAULT_BRIDGE_WATCHDOG_TIMEOUT_MS.
  watchdogTimeoutMs?: number | null;
  // Grace the recovery path gives an aborted in-flight handler to finalize its
  // own response before the recovery path writes a non-retryable 504 backstop.
  // Defaults to DEFAULT_BRIDGE_ABORTED_HANDLER_GRACE_MS.
  abortedHandlerGraceMs?: number | null;
  authorizeRequest?: (request: SandboxCallbackBridgeRequest) => string | null | Promise<string | null>;
  // Handle one bridge request. The worker passes an `AbortSignal` through
  // `options.signal`. The per-iteration timeout, the watchdog, and worker
  // failure recovery abort it, so a handler that threads the signal into its
  // work (for example a `fetch`) stops and rejects instead of running forever.
  // The handler then finalizes with its own error response, so the request does
  // not strand with no response. A handler that ignores the signal keeps its
  // earlier behavior.
  handleRequest: (
    request: SandboxCallbackBridgeRequest,
    options?: { signal: AbortSignal },
  ) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }>;
  maxBodyBytes?: number | null;
  // Return the current-run parent-context token. The worker reads it per request
  // and runs the request work under it, so the request `sandbox.exec` span
  // parents to the live run span (`agent.turn` during the turn, `task.run`
  // otherwise). When it is absent, the request work runs with an empty store,
  // exactly like the earlier `runWithoutActiveStep` behavior.
  getRuntimeParentContext?: () => StartupSpanContext | undefined;
  // Wrap each Paperclip-API callback request in a
  // `sandbox.callbackBridge.relayRequest` span, so the request's read, write, and
  // remove execs group under one named span. When it is absent, the request work
  // runs under the run parent with no wrapper span, exactly like the earlier
  // behavior.
  runtimeSpan?: RuntimeSpanRunner;
}): Promise<SandboxCallbackBridgeWorkerHandle> {
  const pollIntervalMs = normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS);
  const iterationTimeoutMs = normalizeTimeoutMs(input.iterationTimeoutMs, DEFAULT_BRIDGE_ITERATION_TIMEOUT_MS);
  const watchdogTimeoutMs = normalizeTimeoutMs(input.watchdogTimeoutMs, DEFAULT_BRIDGE_WATCHDOG_TIMEOUT_MS);
  const abortedHandlerGraceMs = normalizeTimeoutMs(
    input.abortedHandlerGraceMs,
    DEFAULT_BRIDGE_ABORTED_HANDLER_GRACE_MS,
  );
  const maxBodyBytes = normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  const queueDirectories = [
    directories.rootDir,
    directories.requestsDir,
    directories.responsesDir,
    directories.logsDir,
  ];
  if (input.client.makeDirs) {
    await input.client.makeDirs(queueDirectories);
  } else {
    // Backward-compatible fallback for a queue client that omits the batched
    // makeDirs method. Create each queue directory with a single makeDir.
    for (const directory of queueDirectories) {
      await input.client.makeDir(directory);
    }
  }

  let stopping = false;
  let inFlight = 0;
  let settled = false;
  let stopDeadline = Number.POSITIVE_INFINITY;
  let settleResolve: (() => void) | null = null;
  const settledPromise = new Promise<void>((resolve) => {
    settleResolve = resolve;
  });
  const authorizeRequest = input.authorizeRequest ??
    ((request: SandboxCallbackBridgeRequest) => authorizeSandboxCallbackBridgeRequestWithRoutes(request));
  const buildWorkerFailureMessage = (error: unknown) =>
    `Sandbox callback bridge worker failed: ${error instanceof Error ? error.message : String(error)}`;

  // Per-attempt finalization guard. Each `processRequestFile` call registers one,
  // keyed by the request file name. The guard is the completion fence between the
  // request handler and the per-iteration timeout or watchdog recovery. Node runs
  // one event loop, so a synchronous check-and-set of `claim` is atomic. The
  // first path to move `claim` off `unclaimed` wins.
  //
  // The `claim` value has three states:
  // - `unclaimed`: no path owns the request yet.
  // - `handler`: the request handler owns finalization. It set this before it
  //   started the host operation, or when it wrote a 400/403/response. It will
  //   write the real response.
  // - `abandon`: the recovery path owns the request. It writes a 503.
  //
  // The recovery path must never write a 503 for a request whose handler already
  // started. The per-iteration timeout and the watchdog cannot cancel a host
  // operation that is in flight. A 503 there makes the caller retry while the
  // original mutation still completes, so the mutation applies twice. So the
  // recovery path abandons only a request that the handler did not yet claim; the
  // handler, when it later reaches the host-operation claim, sees the abandon and
  // does not run the mutation. This keeps a retry after the 503 exactly-once.
  //
  // Each guard also holds an `AbortController`. The recovery path aborts it, so a
  // handler that already started (claim `handler`) stops its work and finalizes
  // with its own error response. The abort turns a stranded request into a prompt
  // error response for a handler that threads the signal into its work.
  //
  // A worker abort reaches the handler only after the host operation started, so
  // the mutation may have committed. The bridge cannot cancel a host operation
  // that is in flight. So the handler finalizes a worker-aborted request with a
  // non-retryable 504, not a retryable 502. The caller must not retry a 504, so
  // it never re-applies a mutation that already committed. A retry-safe 503 comes
  // only from the recovery path, and only before the host operation starts.
  //
  // A handler that ignores the abort signal and never settles would still keep
  // the request without a response, because the recovery path must not write a
  // competing 503 for an in-flight mutation. So the recovery path also arms a
  // backstop timer for each handler-owned request. It aborts the handler, then
  // waits `abortedHandlerGraceMs`. A cooperating handler finalizes inside the
  // grace, so its own response wins and `finalize` clears the timer. A handler
  // that never settles does not finalize inside the grace; the timer then writes
  // a non-retryable 504 backstop, so the request never strands. The backstop is
  // non-retryable for the same reason the handler's own 504 is: the recovery
  // cannot cancel a committed mutation, so the caller must not retry.
  //
  // The `finalized` flag is the single-writer fence between the handler's own
  // `finalize` and the backstop timer. Node runs one event loop, so the
  // synchronous check-and-set is atomic. The first path to set it writes the
  // terminal response; the other bails.
  type RequestFinalizeGuard = {
    claim: "unclaimed" | "handler" | "abandon";
    controller: AbortController;
    finalized: boolean;
    backstopTimer?: ReturnType<typeof setTimeout>;
  };
  const inFlightRequestGuards = new Map<string, RequestFinalizeGuard>();

  const processRequestFile = async (fileName: string) => {
    // Skip a request that already has an active attempt. The guard map holds only
    // in-flight attempts; the attempt's finally removes its guard when it ends. A
    // file that still has a guard is in flight, or it waits for its aborted-handler
    // 504 backstop. A second attempt would register a new guard and re-run the host
    // mutation, so the mutation could apply twice.
    if (inFlightRequestGuards.has(fileName)) {
      return;
    }
    const requestPath = path.posix.join(directories.requestsDir, fileName);
    const responsePath = path.posix.join(directories.responsesDir, fileName);
    const guard: RequestFinalizeGuard = {
      claim: "unclaimed",
      controller: new AbortController(),
      finalized: false,
    };
    inFlightRequestGuards.set(fileName, guard);
    // Claim the request for the handler. Return `false` when the recovery path
    // already claimed it; the caller must then not run the mutation and must not
    // write a response, because the recovery path writes a 503 and the caller
    // may retry.
    const claimForHandler = (): boolean => {
      if (guard.claim === "abandon") {
        return false;
      }
      guard.claim = "handler";
      return true;
    };
    // Finalize the request exactly once. Claim it for the handler first. When the
    // recovery path already won the claim, skip both the write and the remove.
    // The `finalized` fence stops a double write when the backstop timer already
    // wrote a 504 for a handler the recovery path aborted. The handler wins when
    // it settles inside the grace; the backstop wins when the handler never
    // settles.
    const finalize = async (response: SandboxCallbackBridgeResponse) => {
      if (!claimForHandler()) {
        return;
      }
      if (guard.finalized) {
        return;
      }
      guard.finalized = true;
      // This finalize now owns delivery for the request, so drop a pending
      // backstop timer. The handler settled inside the grace, so the backstop no
      // longer needs to wait; `finalize` delivers the terminal response itself,
      // inline, and never leaves the request file for a detached timer that the
      // busy poll loop could starve.
      if (guard.backstopTimer !== undefined) {
        clearTimeout(guard.backstopTimer);
        guard.backstopTimer = undefined;
      }
      // Write the handler response, bounded by the per-iteration timeout so a
      // hung sandbox channel never strands the caller until its own generic
      // deadline. Retry a transient write failure, exactly like the 504 backstop
      // write.
      let lastWriteError = "Sandbox callback bridge could not write the handler response.";
      for (let attempt = 1; attempt <= MAX_BACKSTOP_WRITE_ATTEMPTS; attempt += 1) {
        try {
          await withTimeout(
            writeBridgeResponse(input.client, requestPath, responsePath, response),
            iterationTimeoutMs,
            `Sandbox callback bridge write response for ${response.id}`,
          );
          await input.client.remove(requestPath).catch(() => undefined);
          return;
        } catch (error) {
          lastWriteError = error instanceof Error ? error.message : String(error);
          console.warn(
            `[paperclip] sandbox callback bridge failed to write response for ${response.id} (attempt ${attempt}/${MAX_BACKSTOP_WRITE_ATTEMPTS}): ${lastWriteError}`,
          );
          if (attempt < MAX_BACKSTOP_WRITE_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, BACKSTOP_WRITE_RETRY_MS));
          }
        }
      }
      // Every handler-response write failed. Deliver a non-retryable 504 backstop
      // inline, so the caller gets a terminal response instead of a retryable 503
      // that repeats a possibly-committed mutation, or a strand until its own
      // deadline. Roll the `finalized` fence back so `writeAbortedHandlerBackstop`
      // can proceed; it re-fences, retries the 504 write, and removes the request
      // file. Await it, so the request file does not linger for the poll loop
      // while the loop still runs.
      guard.finalized = false;
      await writeAbortedHandlerBackstop(fileName, guard, lastWriteError);
    };
    try {
      let raw: string;
      try {
        raw = await input.client.readTextFile(requestPath);
      } catch (error) {
        // The gateway deletes a request file when its caller stops waiting
        // (client-side timeout cleanup). A read that fails because the file is
        // gone is that benign race, not a channel fault: confirm the file
        // vanished and skip quietly instead of escalating into a recovery
        // pass. A file that is still listed rethrows, so a real read fault
        // keeps its existing handling.
        const remaining = await input.client.listJsonFiles(directories.requestsDir).catch(() => null);
        if (remaining !== null && !remaining.includes(fileName)) {
          return;
        }
        throw error;
      }
      let request: SandboxCallbackBridgeRequest;
      try {
        request = JSON.parse(raw) as SandboxCallbackBridgeRequest;
      } catch {
        const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
        await finalize({
          id: requestId,
          status: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "Invalid bridge request payload." }),
          completedAt: new Date().toISOString(),
        });
        return;
      }

      const denialReason = await authorizeRequest(request);
      if (denialReason) {
        await finalize({
          id: request.id,
          status: 403,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: denialReason }),
          completedAt: new Date().toISOString(),
        });
        return;
      }

      // Claim the request for the handler before the host operation starts. When
      // the recovery path already claimed it, it writes a 503 and the caller may
      // retry, so do not run the mutation; the retry then applies it once. When
      // the handler claims first, the recovery path leaves the request alone and
      // the handler writes the real response.
      if (!claimForHandler()) {
        return;
      }

      // Build the response, then finalize once. The handler already holds the
      // claim, so `finalize` writes the real response.
      let response: SandboxCallbackBridgeResponse;
      try {
        const result = await input.handleRequest(request, { signal: guard.controller.signal });
        const responseBody = result.body ?? "";
        if (Buffer.byteLength(responseBody, "utf8") > maxBodyBytes) {
          throw new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
        }
        response = {
          id: request.id,
          status: result.status,
          headers: result.headers ?? {},
          body: responseBody,
          completedAt: new Date().toISOString(),
        };
      } catch (error) {
        console.warn(
          `[paperclip] sandbox callback bridge handler failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Tell a worker abort apart from a normal handler failure. The recovery
        // path aborts `guard.controller` when the per-iteration timeout or the
        // watchdog fires. The abort reaches this catch only after the handler
        // claimed the request and started the host operation. The bridge cannot
        // cancel a host operation that is in flight, so the mutation may have
        // committed. A 502 (or 503) is a retryable status: the caller retries it
        // and applies the mutation twice. So return a non-retryable 504 and mark
        // the outcome indeterminate. The caller must not retry a 504 from the
        // bridge, unlike the retry-safe 503 that the recovery path writes only
        // before the host operation starts.
        if (guard.controller.signal.aborted) {
          response = {
            id: request.id,
            status: 504,
            headers: {
              "content-type": "application/json",
              "x-paperclip-bridge-outcome": "indeterminate",
            },
            body: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              outcome: "indeterminate",
              retryable: false,
            }),
            completedAt: new Date().toISOString(),
          };
        } else {
          response = {
            id: request.id,
            status: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
            completedAt: new Date().toISOString(),
          };
        }
      }
      await finalize(response);
    } finally {
      // Drop the guard only when it still points to this attempt. A retry can
      // register a new attempt under the same file name; that new guard must
      // stay in the map. Keep the guard when a backstop is still pending: a
      // failed terminal write re-arms the backstop and keeps the request file,
      // so the guard must stay in the map. The poll loop then skips the file and
      // does not re-run a possibly-committed mutation before the backstop writes
      // its 504.
      if (guard.backstopTimer === undefined && inFlightRequestGuards.get(fileName) === guard) {
        inFlightRequestGuards.delete(fileName);
      }
    }
  };

  // Write the non-retryable 504 backstop for an aborted handler that did not
  // finalize inside the grace. The `finalized` fence makes this a no-op when the
  // handler already wrote its own response. The request file name is the request
  // id plus `.json`, so derive the id from it without another client read that
  // could hang on the same dead channel.
  const writeAbortedHandlerBackstop = async (
    fileName: string,
    guard: RequestFinalizeGuard,
    message: string,
  ) => {
    guard.backstopTimer = undefined;
    if (guard.finalized) {
      return;
    }
    guard.finalized = true;
    const requestPath = path.posix.join(directories.requestsDir, fileName);
    const responsePath = path.posix.join(directories.responsesDir, fileName);
    const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
    for (let attempt = 1; attempt <= MAX_BACKSTOP_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await withTimeout(
          writeBridgeResponse(input.client, requestPath, responsePath, {
            id: requestId,
            status: 504,
            headers: {
              "content-type": "application/json",
              "x-paperclip-bridge-outcome": "indeterminate",
            },
            body: JSON.stringify({ error: message, outcome: "indeterminate", retryable: false }),
            completedAt: new Date().toISOString(),
          }, {
            requireRequestPath: false,
          }),
          iterationTimeoutMs,
          `Sandbox callback bridge write 504 backstop for ${requestId}`,
        );
        // The 504 backstop reached the caller. Remove the request file, so the
        // poll loop does not list it again and re-run the mutation.
        await input.client.remove(requestPath).catch(() => undefined);
        return;
      } catch (error) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to write 504 backstop for ${requestId} (attempt ${attempt}/${MAX_BACKSTOP_WRITE_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < MAX_BACKSTOP_WRITE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, BACKSTOP_WRITE_RETRY_MS));
        }
      }
    }
    // Every backstop write failed. Keep the request file and clear the fence, so a
    // late handler can still finalize its own 504. The guard stays in the map, so
    // the poll loop skips the file and does not re-run the mutation. A removed
    // file plus a set fence would strand the caller until its own deadline and
    // give it a generic 502 instead of the terminal 504.
    //
    // Re-arm the backstop directly. A stuck handler never settles, so its
    // `processRequestFile` never runs the `finally` that drops the guard. The
    // poll loop then skips the file on each iteration, so every iteration
    // succeeds and the watchdog never trips again. No later recovery pass runs,
    // so a re-arm here is the only path that retries the 504 write. Clear the
    // fence before the re-arm, because `scheduleAbortedHandlerBackstop` bails on
    // a set fence. The re-arm only re-writes the 504 response; it never re-runs
    // the mutation, so a retry cannot apply the mutation twice.
    guard.finalized = false;
    scheduleAbortedHandlerBackstop(fileName, guard, message);
  };

  // Arm the backstop timer for a handler the recovery path just aborted. It is
  // idempotent: a second recovery pass (the watchdog and the loop catch both run
  // `failPendingRequests`) does not re-arm a live timer or one that already
  // finalized.
  const scheduleAbortedHandlerBackstop = (
    fileName: string,
    guard: RequestFinalizeGuard,
    message: string,
  ) => {
    if (guard.finalized || guard.backstopTimer !== undefined) {
      return;
    }
    guard.backstopTimer = setTimeout(() => {
      void writeAbortedHandlerBackstop(fileName, guard, message);
    }, abortedHandlerGraceMs);
    if (typeof guard.backstopTimer.unref === "function") {
      guard.backstopTimer.unref();
    }
  };

  // Abort every queued request with a 503. The `abandonInFlight` option controls
  // the completion fence for a request a `processRequestFile` attempt still owns.
  // The timeout and watchdog recovery pass `true`: the loop already gave up on
  // the request. When the handler did not yet start the host operation, claim the
  // request so a later handler claim bails, then write the 503. When the handler
  // already started, skip the 503; the recovery cannot cancel an in-flight host
  // operation, and a 503 there would make the caller retry and apply the mutation
  // twice. The stop drain passes `false` (the default): a request the loop
  // already picked up keeps its normal completion, so a late handler result still
  // wins over the drain 503, exactly like the earlier stop behavior.
  const failPendingRequests = async (
    message: string,
    options: { abandonInFlight?: boolean } = {},
  ) => {
    if (options.abandonInFlight) {
      // Abort every in-flight handler first, then arm its 504 backstop. The loop
      // already gave up on the request. A handler that threads the signal into
      // its work stops, rejects, and finalizes with its own error response inside
      // the grace, so the request does not strand. A handler that ignores the
      // signal and never settles does not finalize inside the grace; the backstop
      // timer then writes a non-retryable 504, so the request still never
      // strands. This reads the guard map directly, so it runs even when the
      // request listing below fails on the same dead channel. It never writes a
      // 503 for a handler-owned request: the recovery cannot cancel a committed
      // host mutation, so a retryable status there could apply the mutation twice.
      for (const [fileName, guard] of inFlightRequestGuards.entries()) {
        if (guard.claim === "handler") {
          guard.controller.abort(new Error(message));
          scheduleAbortedHandlerBackstop(fileName, guard, message);
        }
      }
    }
    // Wrap each client call in the per-iteration timeout. When the sandbox
    // channel is unresponsive, a client call hangs with no reject. The timeout
    // keeps this recovery path fail-fast, so it never re-hangs on the same dead
    // channel that triggered the recovery.
    const fileNames = await withTimeout(
      input.client.listJsonFiles(directories.requestsDir),
      iterationTimeoutMs,
      "Sandbox callback bridge list pending requests",
    ).catch(() => [] as string[]);
    for (const fileName of fileNames) {
      const guard = inFlightRequestGuards.get(fileName);
      if (guard && guard.claim === "handler" && (options.abandonInFlight || guard.controller.signal.aborted)) {
        // The handler already started this request's host operation, or it already
        // finalized the request. The timeout and watchdog cannot cancel a host
        // operation that is in flight. A competing 503 here makes the caller retry
        // while the original mutation still completes, so the mutation applies
        // twice. Leave the request for the handler to finalize, or for the 504
        // backstop to finalize when the handler never settles. The recovery path
        // reaches this skip through `abandonInFlight`. The stop drain reaches it
        // only when the recovery path already aborted the handler, so a request
        // whose 504 backstop write failed and kept its file never gets a competing
        // 503 on stop. A normal in-flight handler at a graceful stop is not
        // aborted, so it still gets the stop drain 503.
        continue;
      }
      if (options.abandonInFlight && guard) {
        // The handler did not start the host operation yet. Claim the request, so
        // the handler bails at its host-operation claim instead of running the
        // mutation. A retry after the 503 then applies the mutation once.
        guard.claim = "abandon";
      }
      const requestPath = path.posix.join(directories.requestsDir, fileName);
      const responsePath = path.posix.join(directories.responsesDir, fileName);
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      let responseId = requestId;
      try {
        const raw = await withTimeout(
          input.client.readTextFile(requestPath),
          iterationTimeoutMs,
          `Sandbox callback bridge read pending request ${requestId}`,
        );
        const parsed = JSON.parse(raw) as Partial<SandboxCallbackBridgeRequest>;
        if (typeof parsed.id === "string" && parsed.id.length > 0) {
          responseId = parsed.id;
        }
      } catch (error) {
        // The read or the parse failed, most likely on the same dead channel that
        // triggered this recovery. Keep the request file, so a later recovery pass
        // can still read it and deliver a terminal 503. A remove here drops the
        // request and strands the caller until its own deadline.
        console.warn(
          `[paperclip] sandbox callback bridge could not read pending request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // Write the 503 first, then remove the request file only after the write
      // lands. Retry a transient failure, bounded by the per-iteration timeout,
      // exactly like the finalize and 504 backstop writes. When every attempt
      // fails, keep the request file. A later recovery pass, or the caller retry,
      // then still finds the queued request and delivers a terminal 503, instead
      // of a silent drop that strands the caller until its own deadline. The
      // request is unclaimed or abandoned, so its host mutation never ran; a later
      // 503 stays exactly-once.
      let wrote503 = false;
      let lastWriteError = "Sandbox callback bridge could not write the recovery 503.";
      for (let attempt = 1; attempt <= MAX_BACKSTOP_WRITE_ATTEMPTS; attempt += 1) {
        try {
          await withTimeout(
            writeBridgeResponse(input.client, requestPath, responsePath, {
              id: responseId,
              status: 503,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ error: message }),
              completedAt: new Date().toISOString(),
            }, {
              requireRequestPath: false,
            }),
            iterationTimeoutMs,
            `Sandbox callback bridge write 503 for ${requestId}`,
          );
          wrote503 = true;
          break;
        } catch (error) {
          lastWriteError = error instanceof Error ? error.message : String(error);
          console.warn(
            `[paperclip] sandbox callback bridge failed to write recovery 503 for ${requestId} (attempt ${attempt}/${MAX_BACKSTOP_WRITE_ATTEMPTS}): ${lastWriteError}`,
          );
          if (attempt < MAX_BACKSTOP_WRITE_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, BACKSTOP_WRITE_RETRY_MS));
          }
        }
      }
      if (wrote503) {
        // The 503 landed. Remove the request file, so the poll loop does not
        // re-process it.
        await input.client.remove(requestPath).catch(() => undefined);
      } else {
        // Every 503 write failed. Keep the request file for a later recovery pass.
        console.warn(
          `[paperclip] sandbox callback bridge kept queued request ${requestId} after every recovery 503 write failed: ${lastWriteError}`,
        );
      }
    }
  };

  // Surface a bridge-worker failure through the run trace, not only stdout. A
  // failed span under `input.runtimeSpan` records the error against the live run
  // span, so the run and the orchestrator see the hang. When no `runtimeSpan`
  // runner is wired (no injected tracer), the helper still writes a warn line,
  // so the failure is never silent.
  const surfaceRunError = async (error: Error) => {
    if (input.runtimeSpan) {
      try {
        await input.runtimeSpan(CALLBACK_BRIDGE_WORKER_FAILED_SPAN, async () => {
          throw error;
        });
      } catch {
        // `runtimeSpan` re-throws after it records the failed span. The error is
        // now on the trace; swallow it here so the worker recovery continues.
      }
    }
    console.warn(`[paperclip] ${error.message}`);
  };

  // The timestamp of the last successful loop iteration. The watchdog compares
  // it to the current time. The idle branch and every processed request update
  // it, so steady progress keeps the watchdog re-armed.
  let lastSuccessfulIterationAt = Date.now();
  let watchdogTrippedAt: number | null = null;
  let watchdogTripInFlight = false;
  // Check often enough to fire soon after the threshold, but not so often that
  // the check adds load. One fifth of the threshold, with a 10ms floor.
  const watchdogCheckIntervalMs = Math.max(10, Math.floor(watchdogTimeoutMs / 5));

  const handleWatchdogTrip = async (idleMs: number) => {
    const message = `Sandbox callback bridge made no successful poll iteration for ${idleMs}ms; the sandbox connection is unresponsive.`;
    await surfaceRunError(new Error(message));
    try {
      await failPendingRequests(message, { abandonInFlight: true });
    } catch (error) {
      console.warn(
        `[paperclip] sandbox callback bridge watchdog failed to abort queued requests: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Start the long-lived poll loop outside the measured startup-step store.
  // The `makeDir` calls above are startup work and must keep the active
  // `bridge.paperclip` step. The loop runs run-time execs for the whole run,
  // so each loop `sandbox.exec` span must not parent to the ended step or copy
  // its `criticalPath` flag. `runWithoutActiveStep` empties the store for the
  // loop only; Node keeps the empty store on every later poll continuation.
  const loop = runWithoutActiveStep(() => (async () => {
    // The watchdog runs on its own timer, so it fires even while the loop is
    // stuck on an awaited client call. It is the backstop for a hang the
    // per-iteration timeout does not catch. `unref` keeps it from holding the
    // process open. The loop `finally` clears it on every exit.
    const watchdogTimer = setInterval(() => {
      if (settled || stopping) return;
      const idleMs = Date.now() - lastSuccessfulIterationAt;
      if (idleMs < watchdogTimeoutMs) return;
      // Fire once per hang period. Re-arm only after the loop advances
      // `lastSuccessfulIterationAt` past the last trip (a new successful
      // iteration), so a persistent hang never fires the watchdog repeatedly.
      if (watchdogTrippedAt !== null && watchdogTrippedAt >= lastSuccessfulIterationAt) return;
      if (watchdogTripInFlight) return;
      watchdogTrippedAt = Date.now();
      watchdogTripInFlight = true;
      void handleWatchdogTrip(idleMs).finally(() => {
        watchdogTripInFlight = false;
      });
    }, watchdogCheckIntervalMs);
    if (typeof watchdogTimer.unref === "function") {
      watchdogTimer.unref();
    }
    try {
      // Consecutive transient poll failures. A single failed list call — one
      // reset or slow sandbox exec — must not end the relay for the rest of the
      // run: the in-sandbox gateway keeps queueing requests, so a dead loop
      // strands every later API call from the agent (its status writes then look
      // like connection failures and the issue loses its disposition). Back off
      // and retry the poll instead. The watchdog stays the escalation path for a
      // sustained outage — it fires after `watchdogTimeoutMs` without a
      // successful iteration and fails the queued requests fast, while this loop
      // keeps probing for recovery.
      let consecutivePollFailures = 0;
      while (true) {
        let fileNames: string[];
        try {
          fileNames = await withTimeout(
            input.client.listJsonFiles(directories.requestsDir),
            iterationTimeoutMs,
            "Sandbox callback bridge list requests",
          );
          consecutivePollFailures = 0;
        } catch (error) {
          if (stopping) {
            break;
          }
          consecutivePollFailures += 1;
          const message = `${buildWorkerFailureMessage(error)} (transient poll failure ${consecutivePollFailures}; retrying)`;
          if (consecutivePollFailures === 1) {
            // Put the first failure of a streak on the run trace; later repeats
            // only warn, so a flapping channel does not spam failed spans.
            await surfaceRunError(new Error(message));
          } else {
            console.warn(`[paperclip] ${message}`);
          }
          const backoffMs = Math.min(
            pollIntervalMs * 2 ** consecutivePollFailures,
            MAX_TRANSIENT_ITERATION_BACKOFF_MS,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        // A file whose attempt is still in flight (or waiting on its 504
        // backstop) is not actionable: `processRequestFile` would skip it via
        // the guard map. Treat an all-guarded listing like an empty one and
        // sleep a poll interval. Re-listing immediately would spin the loop —
        // an exec storm against a real sandbox channel, and with an in-memory
        // client a pure-microtask loop that starves every timer in the process
        // (including the guard's own backstop and abort timers).
        const actionableFileNames = fileNames.filter((fileName) => !inFlightRequestGuards.has(fileName));
        if (actionableFileNames.length === 0) {
          lastSuccessfulIterationAt = Date.now();
          if (stopping) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        for (const fileName of actionableFileNames) {
          if (stopping && Date.now() >= stopDeadline) break;
          inFlight += 1;
          try {
            // A request is run-time work, not startup work. Wrap it in a
            // `sandbox.callbackBridge.relayRequest` span, so its read, write, and
            // remove execs group under one named span that parents to the live
            // run span. The span runner reads the run parent per request: the
            // live parent switches to `agent.turn` during the turn and back to
            // `task.run` after it. Without a runner, the request runs under the
            // run parent with no wrapper span, exactly like the earlier behavior.
            // The per-iteration timeout wraps the whole request, so a hung
            // request rejects and the catch below runs the recovery pass.
            await withTimeout(
              input.runtimeSpan
                ? input.runtimeSpan(CALLBACK_BRIDGE_RELAY_REQUEST_SPAN, () =>
                    processRequestFile(fileName),
                  )
                : runWithRuntimeParent(input.getRuntimeParentContext?.(), () =>
                    processRequestFile(fileName),
                  ),
              iterationTimeoutMs,
              `Sandbox callback bridge process request ${fileName}`,
            );
            lastSuccessfulIterationAt = Date.now();
          } catch (error) {
            // A single request attempt failed or hung. Run the same recovery
            // pass the loop previously died on — abort the in-flight handler
            // (its 504 backstop keeps the caller from stranding) and 503 the
            // unclaimed queued requests — but keep the loop alive afterward. A
            // caller that sees the retry-safe 503 re-queues, and the recovered
            // loop serves the retry; the old terminal catch left every later
            // request to strand instead.
            const message = buildWorkerFailureMessage(error);
            await surfaceRunError(new Error(message));
            try {
              await failPendingRequests(message, { abandonInFlight: true });
            } catch (failPendingError) {
              console.warn(
                `[paperclip] sandbox callback bridge failed to abort queued requests after a request failure: ${failPendingError instanceof Error ? failPendingError.message : String(failPendingError)}`,
              );
            }
          } finally {
            inFlight -= 1;
          }
        }
        lastSuccessfulIterationAt = Date.now();
        if (stopping && Date.now() >= stopDeadline) {
          break;
        }
      }
    } catch (error) {
      const message = buildWorkerFailureMessage(error);
      await surfaceRunError(new Error(message));
      try {
        await failPendingRequests(message, { abandonInFlight: true });
      } catch (failPendingError) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to abort queued requests after worker failure: ${failPendingError instanceof Error ? failPendingError.message : String(failPendingError)}`,
        );
      }
    } finally {
      clearInterval(watchdogTimer);
      settled = true;
      if (settleResolve) {
        settleResolve();
      }
    }
  })());

  void loop;

  return {
    stop: async (options = {}) => {
      stopping = true;
      const drainMs = normalizeTimeoutMs(options.drainTimeoutMs, DEFAULT_BRIDGE_STOP_TIMEOUT_MS);
      stopDeadline = Date.now() + drainMs;
      if (!settled) {
        await Promise.race([
          settledPromise,
          new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
        ]);
      }
      await failPendingRequests("Bridge worker stopped before request could be handled.");
    },
  };
}

/**
 * Content-hash-skip write of a Paperclip-authored text file into the sandbox, in
 * a SINGLE remote exec. The body's sha256 is computed on the host; the one shell
 * round-trip skips the write entirely when the remote file already hashes to the
 * same value (warm start — 0 write execs), otherwise it uploads (base64 over
 * stdin), verifies the decoded bytes, and atomically renames into place. A
 * PID-liveness lock serializes concurrent writers to the same path and the
 * verify step guards against a torn upload.
 *
 * Fail loudly: a non-zero remote exit (surfaced by `requireSuccessfulResult`) or
 * malformed result JSON throws rather than silently re-uploading and masking a
 * failed check. The only intentional degradation is when the remote has neither
 * `sha256sum` nor `shasum` — then the skip cannot be proven and we conservatively
 * re-upload (and the post-upload verify is best-effort, as noted inline).
 */
export async function syncRemoteTextFileWithHashSkip(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  remoteDir: string;
  remotePath: string;
  body: string;
  // Human-readable noun phrase used in fail-loud messages, e.g.
  // "Sandbox callback bridge entrypoint" / "Process session remote script".
  label: string;
  // Short action label for `requireSuccessfulResult`, e.g.
  // "sync sandbox callback bridge entrypoint".
  action: string;
  lockDir: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ uploaded: boolean; sha256: string }> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const remotePartial = `${input.remotePath}.partial`;
  const remoteUploadPath = `${input.remotePath}.paperclip-upload.b64`;
  const base64Body = toBuffer(Buffer.from(input.body, "utf8")).toString("base64");
  const sha256 = createHash("sha256").update(input.body, "utf8").digest("hex");

  const syncResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "set -eu",
      `remote_dir=${shellQuote(input.remoteDir)}`,
      `remote_path=${shellQuote(input.remotePath)}`,
      `remote_partial=${shellQuote(remotePartial)}`,
      `remote_upload=${shellQuote(remoteUploadPath)}`,
      `lock_dir=${shellQuote(input.lockDir)}`,
      `expected_sha=${shellQuote(sha256)}`,
      "hash_file() {",
      "  if command -v sha256sum >/dev/null 2>&1; then",
      "    sha256sum \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  if command -v shasum >/dev/null 2>&1; then",
      "    shasum -a 256 \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  return 127",
      "}",
      "mkdir -p \"$remote_dir\"",
      ...buildRemotePidLockAcquireScript("\"$lock_dir\"", `Timed out acquiring ${input.label} upload lock.`),
      ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
        "rm -f \"$remote_upload\" \"$remote_partial\"",
      ]),
      "current_sha=\"\"",
      "if [ -f \"$remote_path\" ]; then",
      "  current_sha=\"$(hash_file \"$remote_path\" 2>/dev/null)\" || current_sha=\"\"",
      "fi",
      "if [ -n \"$current_sha\" ] && [ \"$current_sha\" = \"$expected_sha\" ]; then",
      "  printf '{\"uploaded\":false}\\n'",
      "  exit 0",
      "fi",
      "rm -f \"$remote_upload\" \"$remote_partial\"",
      "cat > \"$remote_upload\"",
      "base64 -d < \"$remote_upload\" > \"$remote_partial\"",
      // Verify upload integrity. If neither sha256sum nor shasum is on PATH
      // (minimal Alpine/scratch images), surface the missing-tool error
      // instead of a misleading "sha mismatch" — the verify step is then
      // best-effort and we trust base64-decode + atomic rename below.
      "if partial_sha=\"$(hash_file \"$remote_partial\" 2>/dev/null)\"; then",
      "  if [ \"$partial_sha\" != \"$expected_sha\" ]; then",
      `    echo ${shellQuote(`${input.label} upload sha mismatch.`)} >&2`,
      "    exit 1",
      "  fi",
      "else",
      `  echo ${shellQuote(`${input.label} sha verify skipped: no sha256sum/shasum on remote.`)} >&2`,
      "fi",
      "mv \"$remote_partial\" \"$remote_path\"",
      "printf '{\"uploaded\":true}\\n'",
    ].join("\n"),
    timeoutMs,
    shellCommand,
    base64Body,
  );
  requireSuccessfulResult(input.action, syncResult);

  let uploaded = false;
  try {
    uploaded = JSON.parse(syncResult.stdout.trim())?.uploaded === true;
  } catch (error) {
    throw new Error(
      `${input.label} sync wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { uploaded, sha256 };
}

export async function syncSandboxCallbackBridgeEntrypoint(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  bridgeAsset: SandboxCallbackBridgeAsset;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ remoteEntrypoint: string; sha256: string; uploaded: boolean }> {
  const remoteEntrypoint = path.posix.join(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  const entrypointSource = await fs.readFile(input.bridgeAsset.entrypoint, "utf8");
  const { uploaded, sha256 } = await syncRemoteTextFileWithHashSkip({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    remoteDir: input.assetRemoteDir,
    remotePath: remoteEntrypoint,
    body: entrypointSource,
    label: "Sandbox callback bridge entrypoint",
    action: "sync sandbox callback bridge entrypoint",
    lockDir: path.posix.join(input.assetRemoteDir, ".paperclip-bridge-upload.lock"),
    timeoutMs: input.timeoutMs,
    shellCommand: input.shellCommand,
  });

  return {
    remoteEntrypoint,
    sha256,
    uploaded,
  };
}

export async function startSandboxCallbackBridgeServer(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  queueDir: string;
  bridgeToken: string;
  bridgeAsset?: SandboxCallbackBridgeAsset | null;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  timeoutMs?: number | null;
  nodeCommand?: string;
  shellCommand?: "bash" | "sh" | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Promise<StartedSandboxCallbackBridgeServer> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  let remoteEntrypoint = path.posix.join(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  if (input.bridgeAsset) {
    const assetSync = await syncSandboxCallbackBridgeEntrypoint({
      runner: input.runner,
      remoteCwd: input.remoteCwd,
      assetRemoteDir: input.assetRemoteDir,
      bridgeAsset: input.bridgeAsset,
      timeoutMs,
      shellCommand,
    });
    remoteEntrypoint = assetSync.remoteEntrypoint;
  }
  const env = buildSandboxCallbackBridgeEnv({
    queueDir: input.queueDir,
    bridgeToken: input.bridgeToken,
    host: input.host,
    port: input.port,
    pollIntervalMs: input.pollIntervalMs,
    responseTimeoutMs: input.responseTimeoutMs,
    maxQueueDepth: input.maxQueueDepth,
    maxBodyBytes: input.maxBodyBytes,
  });
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const startResult = await input.runner.execute({
    command: shellCommand,
    args: shellCommandArgs(
      [
        `mkdir -p ${shellQuote(directories.requestsDir)} ${shellQuote(directories.responsesDir)} ${shellQuote(directories.logsDir)}`,
        `rm -f ${shellQuote(directories.readyFile)} ${shellQuote(directories.pidFile)}`,
        `nohup ${shellQuote(nodeCommand)} ${shellQuote(remoteEntrypoint)} ` +
          `>> ${shellQuote(directories.logFile)} 2>&1 < /dev/null &`,
        "pid=$!",
        `printf '%s\\n' \"$pid\" > ${shellQuote(directories.pidFile)}`,
        "printf '{\"pid\":%s}\\n' \"$pid\"",
      ].join("\n"),
    ),
    cwd: input.remoteCwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
      ...env,
    },
    timeoutMs,
  });
  requireSuccessfulResult("start sandbox callback bridge", startResult);

  const readyResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "i=0",
      `while [ \"$i\" -lt 200 ]; do`,
      `  if [ -s ${shellQuote(directories.readyFile)} ]; then`,
      `    cat ${shellQuote(directories.readyFile)}`,
      "    exit 0",
      "  fi",
      `  if [ -s ${shellQuote(directories.logFile)} ] && ! kill -0 \"$(cat ${shellQuote(directories.pidFile)} 2>/dev/null)\" 2>/dev/null; then`,
      `    cat ${shellQuote(directories.logFile)} >&2`,
      "    exit 1",
      "  fi",
      "  i=$((i + 1))",
      "  sleep 0.05",
      "done",
      `echo "Timed out waiting for bridge readiness." >&2`,
      `if [ -s ${shellQuote(directories.logFile)} ]; then cat ${shellQuote(directories.logFile)} >&2; fi`,
      "exit 1",
    ].join("\n"),
    timeoutMs,
    shellCommand,
  );
  requireSuccessfulResult("wait for sandbox callback bridge readiness", readyResult);

  let readyData: { host?: string; port?: number; baseUrl?: string; pid?: number };
  try {
    readyData = JSON.parse(readyResult.stdout.trim()) as { host?: string; port?: number; baseUrl?: string; pid?: number };
  } catch (error) {
    throw new Error(
      `Sandbox callback bridge wrote invalid readiness JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const host = typeof readyData.host === "string" && readyData.host.trim().length > 0
    ? readyData.host.trim()
    : "127.0.0.1";
  const port = typeof readyData.port === "number" && Number.isFinite(readyData.port) ? readyData.port : 0;
  if (!port) {
    throw new Error("Sandbox callback bridge did not report a listening port.");
  }
  const baseUrl =
    typeof readyData.baseUrl === "string" && readyData.baseUrl.trim().length > 0
      ? readyData.baseUrl.trim()
      : `http://${host}:${port}`;

  return {
    baseUrl,
    host,
    port,
    pid: typeof readyData.pid === "number" && Number.isFinite(readyData.pid) ? readyData.pid : 0,
    directories,
    stop: async () => {
      const stopResult = await input.runner.execute({
        command: shellCommand,
        args: shellCommandArgs(
          [
            `if [ -s ${shellQuote(directories.pidFile)} ]; then`,
            `  pid="$(cat ${shellQuote(directories.pidFile)})"`,
            "  kill \"$pid\" 2>/dev/null || true",
            "  i=0",
            "  while kill -0 \"$pid\" 2>/dev/null && [ \"$i\" -lt 40 ]; do",
            "    i=$((i + 1))",
            "    sleep 0.05",
            "  done",
            "fi",
            `rm -f ${shellQuote(directories.pidFile)} ${shellQuote(directories.readyFile)}`,
          ].join("\n"),
        ),
        cwd: input.remoteCwd,
        env: {
          [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
        },
        timeoutMs,
      });
      if (stopResult.timedOut) {
        throw new Error(buildRunnerFailureMessage("stop sandbox callback bridge", stopResult));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox HTTP/2 client gateway
//
// This gateway turns each local loopback request into one HTTP/2 stream to
// the host server in `http2-bridge-server.ts`. It sits beside the file-mode
// gateway above; it changes neither of them. The generated in-sandbox
// entrypoint and the transport-selection path already select it.
// ---------------------------------------------------------------------------

/**
 * Constant-time bridge-token compare. Both this sandbox gateway and the host
 * server in `http2-bridge-server.ts` import this one helper, so the gateway
 * check and the independent host check (accepted security fix 4) apply the
 * exact same comparison rule. A length mismatch returns `false` without a
 * `timingSafeEqual` call, because `timingSafeEqual` throws on unequal buffer
 * lengths; both operands are bridge tokens of near-fixed length, so this one
 * length branch leaks no useful timing signal.
 */
export function compareBridgeTokensConstantTime(
  expected: string,
  received: string | null | undefined,
): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(typeof received === "string" ? received : "", "utf8");
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

const SANDBOX_HTTP2_GATEWAY_DEFAULT_AUTHORITY = "bridge.internal";

/** One local request the gateway forwards as one HTTP/2 stream. */
export interface SandboxHttp2BridgeGatewayRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Buffer;
  /**
   * The token the local caller presented. The gateway check (accepted
   * security fix 4 keeps this alongside the independent host check) compares
   * it against the per-run bridge token before it opens a stream.
   */
  receivedToken: string | null | undefined;
}

/** The response one forwarded HTTP/2 stream carried back. */
export interface SandboxHttp2BridgeGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SandboxHttp2BridgeGateway {
  /** Forward one local request as one HTTP/2 stream over the client session. */
  forwardRequest(
    request: SandboxHttp2BridgeGatewayRequest,
  ): Promise<SandboxHttp2BridgeGatewayResponse>;
  /** Close the HTTP/2 client session. Safe to call more than one time. */
  close(): Promise<void>;
}

export interface CreateSandboxHttp2BridgeGatewayOptions {
  /**
   * The per-run bridge token. The gateway checks every request against it,
   * then attaches it to the outbound HTTP/2 stream as the `authorization`
   * header, so the host can run its own independent check.
   */
  bridgeToken: string;
  /**
   * Open the transport the HTTP/2 client session runs on. Returns a `Duplex`
   * already connected to the host — the sandbox process's own channel in
   * production, or one side of a paired in-memory `Duplex` in a test.
   */
  createConnection: () => Duplex;
  /** The `:authority` pseudo-header value. The channel carries no real network
   * address, so this is a fixed label. The default is `bridge.internal`. */
  authority?: string;
  /** The header allowlist applied to every outbound request. The default is
   * {@link DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST}. */
  headerAllowlist?: readonly string[];
  /**
   * The sink for a GOAWAY the host sends. The host names the last client
   * stream ID it processed; a caller classifies each of its own dispatched
   * stream IDs against it with `classifyStreamAgainstGoaway` in
   * `http2-bridge-server.ts` to know which requests need a retry elsewhere.
   */
  onGoaway?: (record: { lastStreamId: number; errorCode: number }) => void;
}

function forwardOneHttp2Request(
  session: http2.ClientHttp2Session,
  request: {
    bridgeToken: string;
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body: Buffer;
  },
): Promise<SandboxHttp2BridgeGatewayResponse> {
  return new Promise((resolve, reject) => {
    const query = request.query.trim();
    const pathWithQuery =
      query.length === 0 ? request.path : `${request.path}${query.startsWith("?") ? query : `?${query}`}`;
    const requestHeaders: http2.OutgoingHttpHeaders = {
      ":method": request.method,
      ":path": pathWithQuery,
      authorization: `Bearer ${request.bridgeToken}`,
      ...request.headers,
    };
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request(requestHeaders, { endStream: request.body.length === 0 });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const chunks: Buffer[] = [];
    let responseHeaders: Record<string, string> = {};
    let status = 502;
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };
    stream.on("response", (headers) => {
      const rawStatus = headers[":status"];
      status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus) || 502;
      responseHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(":") || value == null) continue;
        responseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => settle(() => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) })));
    stream.once("error", (error) =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
    stream.once("aborted", () => settle(() => reject(new Error("Bridge HTTP/2 stream aborted."))));
    if (request.body.length > 0) {
      stream.end(request.body);
    } else if (!stream.writableEnded) {
      stream.end();
    }
  });
}

/**
 * Create the sandbox HTTP/2 client gateway. It opens one HTTP/2 client
 * session on the transport `createConnection` returns, and forwards each
 * local request the caller hands it (already checked against the bridge
 * token — see {@link SandboxHttp2BridgeGatewayRequest.receivedToken}) as one
 * HTTP/2 stream. It keeps the header allowlist on the sandbox side, exactly
 * as the file-mode gateway does.
 */
export function createSandboxHttp2BridgeGateway(
  options: CreateSandboxHttp2BridgeGatewayOptions,
): SandboxHttp2BridgeGateway {
  const authority = options.authority?.trim() || SANDBOX_HTTP2_GATEWAY_DEFAULT_AUTHORITY;
  const headerAllowlist = options.headerAllowlist ?? DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST;
  const session = http2.connect(`http://${authority}`, {
    createConnection: options.createConnection,
  });
  // A session-level fault fails every in-flight `forwardRequest` call through
  // that stream's own `error`/`aborted` handler. This listener only stops
  // Node from raising an unhandled `error` event for the session itself.
  session.on("error", () => undefined);
  session.on("goaway", (errorCode: number, lastStreamId: number) => {
    options.onGoaway?.({ lastStreamId, errorCode });
  });

  return {
    forwardRequest(request: SandboxHttp2BridgeGatewayRequest): Promise<SandboxHttp2BridgeGatewayResponse> {
      // The gateway check (accepted security fix 4 keeps this as well as the
      // independent host-side check): a request whose token does not match
      // the per-run bridge token never opens a stream.
      if (!compareBridgeTokensConstantTime(options.bridgeToken, request.receivedToken)) {
        return Promise.reject(new Error("Invalid bridge token."));
      }
      return forwardOneHttp2Request(session, {
        bridgeToken: options.bridgeToken,
        method: request.method,
        path: request.path,
        query: request.query,
        headers: sanitizeSandboxCallbackBridgeHeaders(request.headers, headerAllowlist),
        body: request.body,
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (session.closed || session.destroyed) {
          resolve();
          return;
        }
        session.close(() => resolve());
      });
    },
  };
}

/**
 * The zero-dependency codec the generated duplex gateway embeds. It is a plain
 * JavaScript copy of the encode side of the host codec in `duplex-frame-codec.ts`.
 * The generated gateway never decodes: it writes exactly one READY line, then
 * hands stdout to its transport. So this copy carries only the frame version and
 * the encode function, not a decoder. It uses only the `Buffer` and `JSON`
 * globals, so the generated `.mjs` needs no workspace import. It carries no
 * template literal and no `${` sequence, so it embeds inside the gateway
 * template literal with no escape.
 *
 * A shared fixture file (`duplex-frame-vectors.json`) proves the host encode side
 * stays wire compatible with this copy. {@link getSandboxDuplexGatewayCodecSource}
 * returns this exact source so a test can run the READY encode vector against it.
 */
const DUPLEX_GATEWAY_CODEC_SOURCE = `const DUPLEX_FRAME_VERSION = 2;

function encodeDuplexFrame(frame) {
  return JSON.stringify(frame) + "\\n";
}`;

/**
 * Return the exact zero-dependency codec source the generated duplex gateway
 * embeds. A test wraps this source and calls `encodeDuplexFrame` to prove the
 * embedded copy encodes the READY frame the same way the host encode side does.
 * The source declares `encodeDuplexFrame` and `DUPLEX_FRAME_VERSION`, but exports
 * neither; a caller wraps it to read those names.
 */
export function getSandboxDuplexGatewayCodecSource(): string {
  return DUPLEX_GATEWAY_CODEC_SOURCE;
}

export function getSandboxCallbackBridgeServerSource(): string {
  return `import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import http2 from "node:http2";
import { Duplex } from "node:stream";

const bridgeMode = process.env.PAPERCLIP_API_BRIDGE_MODE || "${SANDBOX_CALLBACK_BRIDGE_FILE_MODE}";
const queueDir = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR;
const bridgeToken = process.env.PAPERCLIP_BRIDGE_TOKEN;
const host = process.env.PAPERCLIP_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.PAPERCLIP_BRIDGE_PORT || "0");
// The host assigns the loopback port and passes it through the launch
// environment. The gateway binds exactly this port; it never selects a
// different one. The host also passes one random per-open nonce here. The
// gateway echoes it in the READY frame so the host correlates READY with this
// channel open. The nonce is a liveness signal, not authentication.
const bridgeNonce = process.env.PAPERCLIP_BRIDGE_NONCE || "";
const pollIntervalMs = Number(process.env.PAPERCLIP_BRIDGE_POLL_INTERVAL_MS || "100");
const responseTimeoutMs = Number(
  process.env.PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS || "${DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS}",
);
const maxQueueDepth = Number(process.env.PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH || "${DEFAULT_BRIDGE_MAX_QUEUE_DEPTH}");
const maxBodyBytes = Number(process.env.PAPERCLIP_BRIDGE_MAX_BODY_BYTES || "${DEFAULT_BRIDGE_MAX_BODY_BYTES}");
// The header allowlist. Both the file gateway and the http2 gateway strip an
// inbound request to these headers before they forward it. One copy serves both
// modes. The route allowlist stays on the host: both modes forward a request to
// the host, and the host enforces the same route allowlist for each.
const allowedHeaders = new Set(${JSON.stringify([...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST])});

if (!bridgeToken) {
  throw new Error("PAPERCLIP_BRIDGE_TOKEN is required.");
}
// Closed allowlist for the bridge mode. The generated gateway supports exactly
// two transports: http2 and the file-mode queue. Every other value, including
// the retired duplex transport, fails startup at once instead of falling
// through to a mode that never ran. This check runs before the queue-directory
// check below, so an unsupported mode never reaches a state where a missing
// queue directory masks the real problem.
if (
  bridgeMode !== "${SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE}" &&
  bridgeMode !== "${SANDBOX_CALLBACK_BRIDGE_FILE_MODE}"
) {
  throw new Error("Unsupported PAPERCLIP_API_BRIDGE_MODE: " + bridgeMode);
}
if (bridgeMode !== "${SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE}" && !queueDir) {
  throw new Error("PAPERCLIP_BRIDGE_QUEUE_DIR and PAPERCLIP_BRIDGE_TOKEN are required.");
}

// A crashed gateway is a dead loopback port for the rest of the run: nothing
// inside the sandbox respawns this process, and every later agent API call
// then fails at the connection level. Once the gateway is ready, log an
// uncaught fault to stderr (the host redirects it into logs/bridge.log) and
// keep serving — the relay holds no state a fault can corrupt beyond the one
// request it interrupted. Before readiness the same fault means the gateway
// can never become usable (a failed bind, a failed readiness write), so exit
// instead: surviving there only leaves an un-ready zombie behind while the
// host waits out its readiness poll.
let gatewayReady = false;
process.on("uncaughtException", (error) => {
  process.stderr.write(
    "[paperclip-bridge] uncaught exception: " + (error && error.stack ? error.stack : String(error)) + "\\n",
  );
  if (!gatewayReady) {
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  const detail = reason && typeof reason === "object" && "stack" in reason ? reason.stack : String(reason);
  process.stderr.write("[paperclip-bridge] unhandled rejection: " + detail + "\\n");
  if (!gatewayReady) {
    process.exit(1);
  }
});

// The embedded zero-dependency frame codec. The duplex gateway uses it; the file
// gateway ignores it.
${DUPLEX_GATEWAY_CODEC_SOURCE}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const normalizedKey = key.toLowerCase();
    if (!allowedHeaders.has(normalizedKey)) {
      continue;
    }
    out[normalizedKey] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function readBodyBytes(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(nextChunk);
    totalBytes += nextChunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new Error("Bridge request body exceeded the configured size limit.");
    }
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  return (await readBodyBytes(req)).toString("utf8");
}

function tokensMatch(received) {
  const expected = Buffer.from(bridgeToken, "utf8");
  const actual = Buffer.from(typeof received === "string" ? received : "", "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function writeJsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function runFileGateway() {
  const requestsDir = path.posix.join(queueDir, "requests");
  const responsesDir = path.posix.join(queueDir, "responses");
  const logsDir = path.posix.join(queueDir, "logs");
  const readyFile = path.posix.join(queueDir, "ready.json");

  async function queueDepth() {
    const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  }

  // Delete request files older than the response deadline. Every live caller
  // cleans its own request file when it times out, so a file this old is an
  // orphan: its writer was killed mid-wait, or a previous gateway process died
  // and left its queue behind. Orphans otherwise count toward the queue-depth
  // cap forever and wedge the gateway at a permanent 503.
  async function sweepStaleRequests() {
    const staleBefore = Date.now() - responseTimeoutMs - 2000;
    const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.posix.join(requestsDir, entry.name);
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.mtimeMs < staleBefore) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
      }
    }
  }

  async function waitForResponse(requestId) {
    const responsePath = path.posix.join(responsesDir, \`\${requestId}.json\`);
    const deadline = Date.now() + responseTimeoutMs;
    while (Date.now() < deadline) {
      const body = await fs.readFile(responsePath, "utf8").catch(() => null);
      if (body != null) {
        await fs.rm(responsePath, { force: true }).catch(() => undefined);
        return JSON.parse(body);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error("Timed out waiting for host bridge response.");
  }

  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!tokensMatch(receivedToken)) {
        writeJsonResponse(res, 401, { error: "Invalid bridge token." });
        return;
      }

      if (await queueDepth() >= maxQueueDepth) {
        // Reclaim orphaned request files before rejecting; only a queue that
        // is genuinely full of live requests gets the 503.
        await sweepStaleRequests();
        if (await queueDepth() >= maxQueueDepth) {
          writeJsonResponse(res, 503, { error: "Bridge request queue is full." });
          return;
        }
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      if (req.method && req.method !== "GET" && req.method !== "HEAD" && !/json/i.test(contentType)) {
        writeJsonResponse(res, 415, { error: "Bridge only accepts JSON request bodies." });
        return;
      }
      const requestId = randomUUID();
      const requestBody = await readBody(req);
      const payload = {
        id: requestId,
        method: req.method || "GET",
        path: url.pathname,
        query: url.search,
        headers: normalizeHeaders(req.headers),
        body: requestBody,
        createdAt: new Date().toISOString(),
      };
      const requestPath = path.posix.join(requestsDir, \`\${requestId}.json\`);
      const tempPath = \`\${requestPath}.tmp\`;
      await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, "utf8");
      await fs.rename(tempPath, requestPath);

      let response;
      try {
        response = await waitForResponse(requestId);
      } catch (error) {
        // The host never delivered a response inside the deadline. Remove this
        // request's file so it cannot pile up toward the queue-depth cap. The
        // host's normal response write is guarded on the request file, so the
        // removal also tells the host that no caller waits anymore. Without
        // this cleanup a stalled host wedges the gateway at the cap and every
        // later request gets an immediate 503 until run end.
        await fs.rm(requestPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const responseHeaders = response.headers || {};
      // The host marks a possibly-committed mutation with an indeterminate outcome.
      // The host cannot cancel a host operation that is in flight, so the mutation
      // may have committed before the worker aborted the handler. A 5xx status is
      // retryable by convention, so a caller that retries 5xx would apply the
      // mutation twice. Map the indeterminate outcome to a non-retryable 409, so a
      // standard retry policy does not repeat the request. The outcome header and
      // body stay, so a caller that reads them still sees the indeterminate result.
      const bridgeOutcome = responseHeaders["x-paperclip-bridge-outcome"];
      if (bridgeOutcome === "indeterminate") {
        res.statusCode = 409;
      } else {
        res.statusCode = typeof response.status === "number" ? response.status : 200;
      }
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
        res.setHeader(key, value);
      }
      res.end(typeof response.body === "string" ? response.body : "");
    } catch (error) {
      writeJsonResponse(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  async function shutdown() {
    server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await fs.mkdir(requestsDir, { recursive: true });
  await fs.mkdir(responsesDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  // Newer Node runtimes do not reliably surface a failed bind through
  // uncaughtException here: with nothing else keeping the event loop alive,
  // the process can drain and exit 0 before the error event is delivered
  // (observed on Node 24/25; Node 22 delivered it). Attach an explicit error
  // listener and pin the loop with a keepalive until the bind settles, so a
  // startup failure exits 1 with the fault on stderr on every runtime.
  const bindKeepalive = setInterval(() => {}, 1000);
  server.once("error", (error) => {
    clearInterval(bindKeepalive);
    process.stderr.write(
      "[paperclip-bridge] server error: " + (error && error.stack ? error.stack : String(error)) + "\\n",
    );
    if (!gatewayReady) {
      process.exit(1);
    }
  });
  server.listen(port, host, async () => {
    clearInterval(bindKeepalive);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Bridge server did not expose a TCP address.");
    }
    const ready = {
      pid: process.pid,
      host,
      port: address.port,
      baseUrl: \`http://\${host}:\${address.port}\`,
      startedAt: new Date().toISOString(),
    };
    const tempReadyFile = \`\${readyFile}.tmp\`;
    await fs.writeFile(tempReadyFile, JSON.stringify(ready), "utf8");
    await fs.rename(tempReadyFile, readyFile);
    // The readiness file is on disk, so the host will adopt this process.
    // From here on an uncaught fault must not kill the listener.
    gatewayReady = true;
  });
}

// ---------------------------------------------------------------------------
// http2_v1: run one Node HTTP/2 client session directly on stdin/stdout.
//
// This gateway writes exactly one frame-codec line before it hands stdin and
// stdout to the HTTP/2 client: the READY line, so the host readiness gate
// accepts the same handshake it already accepts for every mode. After that
// one write, only the HTTP/2 client touches stdout: this function calls
// writeFrame no more, and it starts no heartbeat timer, so no non-HTTP/2
// writer can put a byte on stdout between the READY line and the client
// connection preface.
// ---------------------------------------------------------------------------

function createStdioDuplex() {
  const duplex = new Duplex({
    read() {
      // process.stdin pushes bytes through the "data" listener below; there
      // is nothing to pull on demand here.
    },
    write(chunk, _encoding, callback) {
      const flushed = process.stdout.write(chunk);
      if (flushed) {
        callback();
      } else {
        process.stdout.once("drain", () => callback());
      }
    },
  });
  process.stdin.on("data", (chunk) => {
    duplex.push(chunk);
  });
  process.stdin.on("end", () => {
    duplex.push(null);
  });
  process.stdin.on("error", (error) => {
    duplex.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return duplex;
}

function runHttp2Gateway() {
  function diag(message) {
    // Diagnostics go to stderr only, the same as every other mode.
    process.stderr.write("[paperclip-bridge] " + message + "\\n");
  }
  function writeFrame(frame) {
    process.stdout.write(encodeDuplexFrame(frame));
  }

  const authority = "bridge.internal";
  let session = null;
  let unavailable = false;

  function openSession() {
    if (session) return session;
    const stdio = createStdioDuplex();
    session = http2.connect("http://" + authority, {
      createConnection: () => stdio,
    });
    session.on("error", () => {
      unavailable = true;
    });
    session.on("close", () => {
      unavailable = true;
    });
    session.on("goaway", (errorCode, lastStreamId) => {
      diag("host sent GOAWAY (errorCode=" + errorCode + ", lastStreamId=" + lastStreamId + ")");
    });
    return session;
  }

  function forwardOverHttp2(request) {
    return new Promise((resolve, reject) => {
      const activeSession = openSession();
      const query = request.query || "";
      const pathWithQuery =
        query.length === 0 ? request.path : request.path + (query.charAt(0) === "?" ? query : "?" + query);
      const outboundHeaders = Object.assign(
        {
          ":method": request.method,
          ":path": pathWithQuery,
          authorization: "Bearer " + bridgeToken,
        },
        request.headers,
      );
      let stream;
      try {
        stream = activeSession.request(outboundHeaders, { endStream: request.body.length === 0 });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const chunks = [];
      let status = 502;
      let responseHeaders = {};
      let settled = false;
      const settle = (run) => {
        if (settled) return;
        settled = true;
        run();
      };
      stream.on("response", (headers) => {
        const raw = headers[":status"];
        status = typeof raw === "number" ? raw : Number(raw) || 502;
        responseHeaders = {};
        for (const [key, value] of Object.entries(headers)) {
          if (key.charAt(0) === ":" || value == null) continue;
          responseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      });
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.once("end", () =>
        settle(() => resolve({ status: status, headers: responseHeaders, body: Buffer.concat(chunks) })),
      );
      stream.once("error", (error) =>
        settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
      stream.once("aborted", () => settle(() => reject(new Error("Bridge HTTP/2 stream aborted."))));
      if (request.body.length > 0) {
        stream.end(request.body);
      } else if (!stream.writableEnded) {
        stream.end();
      }
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!tokensMatch(receivedToken)) {
        writeJsonResponse(res, 401, { error: "Invalid bridge token." });
        return;
      }
      if (unavailable) {
        writeJsonResponse(res, 503, { error: "bridge_unavailable" });
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      if (req.method && req.method !== "GET" && req.method !== "HEAD" && !/json/i.test(contentType)) {
        writeJsonResponse(res, 415, { error: "Bridge only accepts JSON request bodies." });
        return;
      }
      const requestBodyBuffer = await readBodyBytes(req);
      let response;
      try {
        response = await forwardOverHttp2({
          method: req.method || "GET",
          path: url.pathname,
          query: url.search,
          headers: normalizeHeaders(req.headers),
          body: requestBodyBuffer,
        });
      } catch (error) {
        writeJsonResponse(res, 502, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      res.statusCode = typeof response.status === "number" ? response.status : 200;
      for (const [key, value] of Object.entries(response.headers || {})) {
        if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
        res.setHeader(key, value);
      }
      res.end(response.body);
    } catch (error) {
      writeJsonResponse(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  process.on("SIGINT", () => {
    try {
      server.close();
    } catch (error) {
      diag("server close error: " + (error && error.message ? error.message : String(error)));
    }
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    try {
      server.close();
    } catch (error) {
      diag("server close error: " + (error && error.message ? error.message : String(error)));
    }
    process.exit(0);
  });

  // Bind-or-exit, the same rule every mode applies: the host assigns a
  // positive loopback port, and the gateway binds exactly that port or exits
  // nonzero. It never selects a different port.
  if (!Number.isInteger(port) || port <= 0) {
    diag("http2 gateway requires a positive assigned PAPERCLIP_BRIDGE_PORT; got " + String(port));
    process.exit(1);
  }
  server.on("error", (error) => {
    diag(
      "http2 gateway could not bind port " +
        String(port) +
        ": " +
        (error && error.message ? error.message : String(error)),
    );
    process.exit(1);
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      diag("http2 gateway did not expose a TCP address");
      process.exit(1);
      return;
    }
    // Send the one frame-codec line on this path: the READY line the host
    // readiness gate expects. Open the HTTP/2 client session on the very next
    // statement, so the client connection preface is the next byte the host
    // sees after READY, with no other writer in between.
    writeFrame({ version: DUPLEX_FRAME_VERSION, type: "ready", nonce: bridgeNonce });
    gatewayReady = true;
    openSession();
  });
}

// The startup check above already rejected every value except http2 and
// queue, so this dispatch names both modes explicitly and never falls
// through to the queue gateway for an unsupported mode.
if (bridgeMode === "${SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE}") {
  runHttp2Gateway();
} else if (bridgeMode === "${SANDBOX_CALLBACK_BRIDGE_FILE_MODE}") {
  await runFileGateway();
} else {
  throw new Error("Unsupported PAPERCLIP_API_BRIDGE_MODE: " + bridgeMode);
}`;
}
