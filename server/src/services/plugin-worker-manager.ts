/**
 * PluginWorkerManager — spawns and manages out-of-process plugin worker child
 * processes, routes JSON-RPC 2.0 calls over stdio, and handles lifecycle
 * management including crash recovery with exponential backoff.
 *
 * Each installed plugin gets one dedicated worker process. The host sends
 * JSON-RPC requests over the child's stdin and reads responses from stdout.
 * Worker stderr is captured and forwarded to the host logger.
 *
 * Process Model (from PLUGIN_SPEC.md §12):
 * - One worker process per installed plugin
 * - Failure isolation: plugin crashes do not affect the host
 * - Graceful shutdown: 10-second drain, then SIGTERM, then SIGKILL
 * - Automatic restart with exponential backoff on unexpected exits
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */

import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  JsonRpcParseError,
  JsonRpcCallError,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcId,
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  HostToWorkerMethodName,
  HostToWorkerMethods,
  WorkerToHostMethodName,
  WorkerToHostMethods,
  InitializeParams,
} from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. Bumped from 30s to 120s
 * because plugin actions like Linear `trigger-import` legitimately exceed 30s
 * for medium workspaces (~500 issues) and TIMEOUT was bubbling up to the UI
 * even when the worker eventually completed the work. Per-call overrides
 * still possible via `timeoutMs`; hard cap stays at MAX_RPC_TIMEOUT_MS. */
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

/** Hard upper bound for any RPC timeout (15 minutes). Prevents unbounded waits. */
const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Timeout for the initialize RPC call.
 *
 * Bumped from 15s → 60s to absorb the boot-time SDK install race: when the
 * paperclip pod first comes up after a deploy, the entrypoint runs
 * `npm install` to materialize @paperclipai/plugin-sdk/dist while the plugin
 * host begins spawning workers. Workers that race the SDK install see a
 * partial or absent SDK and hang on the import, then the 15s timeout fires
 * and the catch block (around line ~860) threw back to the plugin manager,
 * which marked plugin status='error' permanently — every plugin had to be
 * manually re-enabled after every deploy.
 *
 * 60s comfortably covers the SDK install on a loaded boot. Tracked as a
 * recurring deploy regression in memory entry paperclip_plugin_sdk_install_race.
 */
const INITIALIZE_TIMEOUT_MS = 60_000;

/** Timeout for the shutdown RPC call before escalating to SIGTERM. */
const SHUTDOWN_DRAIN_MS = 10_000;

/** Time to wait after SIGTERM before sending SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

/** Minimum backoff delay for crash recovery (1 second). */
const MIN_BACKOFF_MS = 1_000;

/** Maximum backoff delay for crash recovery (5 minutes). */
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Backoff multiplier on each consecutive crash. */
const BACKOFF_MULTIPLIER = 2;

/** Maximum number of consecutive crashes before giving up on auto-restart. */
const MAX_CONSECUTIVE_CRASHES = 10;

/** Time window in which crashes are considered consecutive (10 minutes). */
const CRASH_WINDOW_MS = 10 * 60 * 1_000;

/** Maximum number of stderr characters retained for worker failure context. */
const MAX_STDERR_EXCERPT_CHARS = 8_000;

/**
 * Maximum number of bytes allowed to sit un-drained in a worker's stdin pipe
 * before droppable (fire-and-forget) messages are discarded instead of queued.
 *
 * Host→worker notifications — especially `agents.sessions.event` carrying every
 * agent Job-pod log chunk — are written to the worker's stdin pipe. `write()`
 * queues un-flushed chunks as native Buffers (off-heap) when the worker drains
 * slower than the host produces. Under bursty agent-log load this grows process
 * RSS off-heap until the container is cgroup-OOMKilled (the JS heap is
 * separately capped by --max-old-space-size, so it is not the heap that
 * overflows). Bounding the backlog for droppable traffic caps that growth:
 * lossy delivery of best-effort notifications is preferable to an OOM that
 * kills every in-flight run. RPC requests/responses are never dropped.
 */
export const MAX_WORKER_STDIN_BACKLOG_BYTES = 8 * 1_024 * 1_024;

/**
 * Decide whether a droppable (fire-and-forget) worker message should be
 * discarded given the current un-drained stdin backlog. Pure for testability.
 */
export function shouldDropDroppableMessage(
  writableLength: number,
  cap: number = MAX_WORKER_STDIN_BACKLOG_BYTES,
): boolean {
  return writableLength > cap;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of a managed worker process.
 */
export type WorkerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "backoff";

/**
 * Worker-to-host method handler. The host registers these to service calls
 * that the plugin worker makes back to the host (e.g. state.get, events.emit).
 */
export type WorkerToHostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A map of all worker-to-host method handlers provided by the host.
 */
export type WorkerToHostHandlers = {
  [M in WorkerToHostMethodName]?: WorkerToHostHandler<M>;
};

/**
 * Events emitted by a PluginWorkerHandle.
 */
export interface WorkerHandleEvents {
  /** Worker process started and is ready (initialize succeeded). */
  "ready": { pluginId: string };
  /** Worker process exited. */
  "exit": { pluginId: string; code: number | null; signal: NodeJS.Signals | null };
  /** Worker process crashed unexpectedly. */
  "crash": { pluginId: string; code: number | null; signal: NodeJS.Signals | null; willRestart: boolean };
  /** Worker process errored (e.g. spawn failure). */
  "error": { pluginId: string; error: Error };
  /** Worker status changed. */
  "status": { pluginId: string; status: WorkerStatus; previousStatus: WorkerStatus };
}

type WorkerHandleEventName = keyof WorkerHandleEvents;

export function appendStderrExcerpt(current: string, chunk: string): string {
  const next = current ? `${current}\n${chunk}` : chunk;
  return next.length <= MAX_STDERR_EXCERPT_CHARS
    ? next
    : next.slice(-MAX_STDERR_EXCERPT_CHARS);
}

export function formatWorkerFailureMessage(message: string, stderrExcerpt: string): string {
  const excerpt = stderrExcerpt.trim();
  if (!excerpt) return message;
  if (message.includes(excerpt)) return message;
  return `${message}\n\nWorker stderr:\n${excerpt}`;
}

/**
 * Host env vars that steer the `@anthropic-ai/sdk` client. The platform points
 * these at ccrotate-serve so all Anthropic traffic flows through the pooled
 * OAuth proxy instead of api.anthropic.com.
 */
const ANTHROPIC_ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Build the Anthropic routing slice of a plugin worker's env, forwarding only
 * the keys that are actually set on the host. Empty values are dropped so an
 * unset `ANTHROPIC_BASE_URL` never clobbers the SDK's built-in default.
 *
 * This is an intentional, narrow widening of the worker env allowlist (see
 * `spawnProcess`): plugins that talk to Anthropic must reach the same pooled
 * endpoint the rest of the platform uses, or the pooled bearer is rejected
 * with "401 invalid x-api-key".
 */
export function anthropicRoutingEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ANTHROPIC_ROUTING_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Options for starting a worker process.
 */
export interface WorkerStartOptions {
  /** Absolute path to the plugin worker entrypoint (CJS bundle). */
  entrypointPath: string;
  /** Plugin manifest. */
  manifest: PaperclipPluginManifestV1;
  /** Resolved plugin configuration. */
  config: Record<string, unknown>;
  /** Host instance information for the initialize call. */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
  /** Host-derived plugin database namespace, when declared. */
  databaseNamespace?: string | null;
  /** Handlers for worker→host RPC calls. */
  hostHandlers: WorkerToHostHandlers;
  /** Default timeout for RPC calls (ms). Defaults to 30s. */
  rpcTimeoutMs?: number;
  /** Whether to auto-restart on crash. Defaults to true. */
  autoRestart?: boolean;
  /** Node.js execArgv passed to the child process. */
  execArgv?: string[];
  /** Environment variables passed to the child process. */
  env?: Record<string, string>;
  /**
   * Callback for stream notifications from the worker (streams.open/emit/close).
   * The host wires this to the PluginStreamBus to fan out events to SSE clients.
   */
  onStreamNotification?: (method: string, params: Record<string, unknown>) => void;
}

/**
 * A pending RPC call waiting for a response from the worker.
 */
interface PendingRequest {
  /** The request ID. */
  id: JsonRpcId;
  /** Method name (for logging). */
  method: string;
  /** Resolve the promise with the response. */
  resolve: (response: JsonRpcResponse) => void;
  /** Timeout timer handle. */
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when the request was sent. */
  sentAt: number;
}

// ---------------------------------------------------------------------------
// PluginWorkerHandle — manages a single worker process
// ---------------------------------------------------------------------------

/**
 * Handle for a single plugin worker process.
 *
 * Callers use `start()` to spawn the worker, `call()` to send RPC requests,
 * and `stop()` to gracefully shut down. The handle manages crash recovery
 * with exponential backoff automatically when `autoRestart` is enabled.
 */
export interface PluginWorkerHandle {
  /** The plugin ID this worker serves. */
  readonly pluginId: string;

  /** Current worker status. */
  readonly status: WorkerStatus;

  /** Start the worker process. Resolves when initialize completes. */
  start(): Promise<void>;

  /**
   * Stop the worker process gracefully.
   *
   * Sends a `shutdown` RPC call, waits up to 10 seconds for the worker to
   * exit, then escalates to SIGTERM, and finally SIGKILL if needed.
   */
  stop(): Promise<void>;

  /**
   * Restart the worker process (stop + start).
   */
  restart(): Promise<void>;

  /**
   * Send a typed host→worker RPC call.
   *
   * @param method - The RPC method name
   * @param params - Method parameters
   * @param timeoutMs - Optional per-call timeout override
   * @returns The method result
   * @throws {JsonRpcCallError} if the worker returns an error response
   * @throws {Error} if the worker is not running or the call times out
   */
  call<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Send a fire-and-forget notification to the worker (no response expected).
   */
  notify(method: string, params: unknown): void;

  /** Subscribe to worker events. */
  on<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Unsubscribe from worker events. */
  off<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Optional methods the worker reported during initialization. */
  readonly supportedMethods: string[];

  /** Get diagnostic info about the worker. */
  diagnostics(): WorkerDiagnostics;
}

/**
 * Diagnostic information about a worker process.
 */
export interface WorkerDiagnostics {
  pluginId: string;
  status: WorkerStatus;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

// ---------------------------------------------------------------------------
// PluginWorkerManager — manages all plugin workers
// ---------------------------------------------------------------------------

/**
 * The top-level manager that holds all plugin worker handles.
 *
 * Provides a registry of workers keyed by plugin ID, with convenience methods
 * for starting/stopping all workers and routing RPC calls.
 */
export interface PluginWorkerManager {
  /**
   * Register and start a worker for a plugin.
   *
   * @returns The worker handle
   * @throws if a worker is already registered for this plugin
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle>;

  /**
   * Stop and unregister a specific plugin worker.
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Get the worker handle for a plugin.
   */
  getWorker(pluginId: string): PluginWorkerHandle | undefined;

  /**
   * Check if a worker is registered and running for a plugin.
   */
  isRunning(pluginId: string): boolean;

  /**
   * Stop all managed workers. Called during server shutdown.
   */
  stopAll(): Promise<void>;

  /**
   * Get diagnostic info for all workers.
   */
  diagnostics(): WorkerDiagnostics[];

  /**
   * Send an RPC call to a specific plugin worker.
   *
   * @throws if the worker is not running
   */
  call<M extends HostToWorkerMethodName>(
    pluginId: string,
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
  ): Promise<HostToWorkerMethods[M][1]>;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerHandle
// ---------------------------------------------------------------------------

/**
 * Create a handle for a single plugin worker process.
 *
 * @internal Exported for testing; consumers should use `createPluginWorkerManager`.
 */
export function createPluginWorkerHandle(
  pluginId: string,
  options: WorkerStartOptions,
): PluginWorkerHandle {
  const log = logger.child({ service: "plugin-worker", pluginId });
  const emitter = new EventEmitter();
  /**
   * Higher than default (10) to accommodate multiple subscribers to
   * crash/ready/exit events during integration tests and runtime monitoring.
   */
  emitter.setMaxListeners(50);

  // Worker process state
  let childProcess: ChildProcess | null = null;
  let readline: ReadlineInterface | null = null;
  let stderrReadline: ReadlineInterface | null = null;
  let status: WorkerStatus = "stopped";
  let startedAt: number | null = null;
  let stderrExcerpt = "";

  // Pending RPC requests awaiting a response
  const pendingRequests = new Map<string | number, PendingRequest>();
  let nextRequestId = 1;

  // Optional methods reported by the worker during initialization
  let supportedMethods: string[] = [];

  // Crash tracking for exponential backoff
  let consecutiveCrashes = 0;
  let totalCrashes = 0;
  let lastCrashAt: number | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRestartAt: number | null = null;

  // Track open stream channels so we can emit synthetic close on crash.
  // Maps channel → companyId.
  const openStreamChannels = new Map<string, string>();

  // Shutdown coordination
  let intentionalStop = false;

  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const autoRestart = options.autoRestart ?? true;

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  function setStatus(newStatus: WorkerStatus): void {
    const prev = status;
    if (prev === newStatus) return;
    status = newStatus;
    log.debug({ from: prev, to: newStatus }, "worker status change");
    emitter.emit("status", { pluginId, status: newStatus, previousStatus: prev });
  }

  // -----------------------------------------------------------------------
  // JSON-RPC message sending
  // -----------------------------------------------------------------------

  // Throttle the "dropped notification" warning so a sustained backlog does not
  // itself spam the logs (which would add to the pressure it is reporting on).
  let lastDropWarnAt = 0;
  let droppedSinceWarn = 0;

  function sendMessage(message: unknown, opts?: { droppable?: boolean }): boolean {
    if (!childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    // Best-effort notifications are dropped when the stdin pipe is backed up,
    // rather than queued as unbounded off-heap Buffers. RPC traffic
    // (droppable=false) is always written so request/response stays correct.
    if (
      opts?.droppable &&
      shouldDropDroppableMessage(childProcess.stdin.writableLength)
    ) {
      droppedSinceWarn += 1;
      const now = Date.now();
      if (now - lastDropWarnAt > 5_000) {
        log.warn(
          {
            backlogBytes: childProcess.stdin.writableLength,
            cap: MAX_WORKER_STDIN_BACKLOG_BYTES,
            droppedSinceLastWarn: droppedSinceWarn,
          },
          "worker stdin backlogged; dropping fire-and-forget notification(s)",
        );
        lastDropWarnAt = now;
        droppedSinceWarn = 0;
      }
      return false;
    }
    const serialized = serializeMessage(message as any);
    childProcess.stdin.write(serialized);
    return true;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = parseMessage(line);
    } catch (err) {
      if (err instanceof JsonRpcParseError) {
        log.warn({ rawLine: line.slice(0, 200) }, "unparseable message from worker");
      } else {
        log.warn({ err }, "error parsing worker message");
      }
      return;
    }

    if (isJsonRpcResponse(message)) {
      handleResponse(message);
    } else if (isJsonRpcRequest(message)) {
      handleWorkerRequest(message as JsonRpcRequest);
    } else if (isJsonRpcNotification(message)) {
      handleWorkerNotification(message as JsonRpcNotification);
    } else {
      log.warn("unknown message type from worker");
    }
  }

  /**
   * Handle a JSON-RPC response from the worker (matching a pending request).
   */
  function handleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) {
      log.warn("received response with null/undefined id");
      return;
    }

    const pending = pendingRequests.get(id);
    if (!pending) {
      log.warn({ id }, "received response for unknown request id");
      return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method as WorkerToHostMethodName;
    const handler = options.hostHandlers[method] as
      | ((params: unknown) => Promise<unknown>)
      | undefined;

    if (!handler) {
      log.warn({ method }, "worker called unregistered host method");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Host does not handle method "${method}"`,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }

    try {
      const result = await handler(request.params);
      sendMessage({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ method, err: errorMessage }, "host handler error");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.INTERNAL_ERROR,
            errorMessage,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
    }
  }

  /**
   * Handle a JSON-RPC notification from the worker (fire-and-forget).
   *
   * The `log` notification is the primary case — worker `ctx.logger` calls
   * arrive here. We append structured plugin context (pluginId, timestamp,
   * level) so that every log entry is queryable per the spec (§26.1).
   */
  function handleWorkerNotification(notification: JsonRpcNotification): void {
    if (notification.method === "log") {
      const params = notification.params as {
        level?: string;
        message?: string;
        meta?: Record<string, unknown>;
      } | null;
      const level = params?.level ?? "info";
      const msg = params?.message ?? "";
      const meta = params?.meta;

      // Build a structured log object that includes the plugin context fields
      // required by §26.1: pluginId, timestamp, level, message, and metadata.
      // The child logger already carries `pluginId` in its bindings, but we
      // add explicit `pluginLogLevel` and `pluginTimestamp` so downstream
      // consumers (log storage, UI queries) can filter without parsing.
      const logFields: Record<string, unknown> = {
        ...meta,
        pluginLogLevel: level,
        pluginTimestamp: new Date().toISOString(),
      };

      if (level === "error") {
        log.error(logFields, `[plugin] ${msg}`);
      } else if (level === "warn") {
        log.warn(logFields, `[plugin] ${msg}`);
      } else if (level === "debug") {
        log.debug(logFields, `[plugin] ${msg}`);
      } else {
        log.info(logFields, `[plugin] ${msg}`);
      }
      return;
    }

    // Stream notifications: forward to the stream bus via callback
    if (
      notification.method === "streams.open" ||
      notification.method === "streams.emit" ||
      notification.method === "streams.close"
    ) {
      const params = (notification.params ?? {}) as Record<string, unknown>;

      // Track open channels so we can emit synthetic close on crash
      if (notification.method === "streams.open") {
        const ch = String(params.channel ?? "");
        const co = String(params.companyId ?? "");
        if (ch) openStreamChannels.set(ch, co);
      } else if (notification.method === "streams.close") {
        openStreamChannels.delete(String(params.channel ?? ""));
      }

      if (options.onStreamNotification) {
        try {
          options.onStreamNotification(notification.method, params);
        } catch (err) {
          log.error(
            {
              method: notification.method,
              err: err instanceof Error ? err.message : String(err),
            },
            "stream notification handler failed",
          );
        }
      }
      return;
    }

    log.debug({ method: notification.method }, "received notification from worker");
  }

  // -----------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------

  function spawnProcess(): ChildProcess {
    // Security: Do NOT spread process.env into the worker. Plugins should only
    // receive a minimal, controlled environment to prevent leaking host
    // secrets (like DATABASE_URL, internal API keys, etc.).
    const workerEnv: Record<string, string> = {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
      PAPERCLIP_PLUGIN_ID: pluginId,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TZ: process.env.TZ ?? "UTC",
      // Anthropic routing passthrough. The platform routes all Anthropic
      // traffic through ccrotate-serve via ANTHROPIC_BASE_URL plus a pooled
      // bearer (see deploy/helm/paperclip/values.blockcast.yaml — the same
      // vars the claude_k8s adapter copies onto agent Job pods). Plugin
      // workers that use @anthropic-ai/sdk must inherit these or the SDK
      // falls back to api.anthropic.com and the pooled token is rejected with
      // "401 invalid x-api-key". Forwarded only when set on the host (an
      // empty ANTHROPIC_BASE_URL would clobber the SDK default); this is a
      // narrow, explicit allowlist — the rest of process.env is still withheld.
      ...anthropicRoutingEnv(),
      // options.env is spread last so per-plugin overrides (like NODE_PATH
      // pointing to a local SDK build) take precedence over defaults.
      ...options.env,
    };

    const child = fork(options.entrypointPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: options.execArgv ?? [],
      env: workerEnv,
      // Don't let the child keep the parent alive
      detached: false,
    });

    return child;
  }

  function attachStdioHandlers(child: ChildProcess): void {
    // Read NDJSON from stdout
    if (child.stdout) {
      readline = createInterface({ input: child.stdout });
      readline.on("line", handleLine);
    }

    // Capture stderr for logging
    if (child.stderr) {
      stderrReadline = createInterface({ input: child.stderr });
      stderrReadline.on("line", (line: string) => {
        stderrExcerpt = appendStderrExcerpt(stderrExcerpt, line);
        log.warn({ stream: "stderr" }, `[plugin stderr] ${line}`);
      });
    }

    // Handle process exit
    child.on("exit", (code, signal) => {
      handleProcessExit(code, signal);
    });

    // Handle process errors (e.g. spawn failure)
    child.on("error", (err) => {
      log.error({ err: err.message }, "worker process error");
      if (emitter.listenerCount("error") > 0) {
        emitter.emit("error", { pluginId, error: err });
      }
      if (status === "starting") {
        setStatus("crashed");
        rejectAllPending(
          new Error(formatWorkerFailureMessage(
            `Worker process failed to start: ${err.message}`,
            stderrExcerpt,
          )),
        );
      }
    });
  }

  function handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasIntentional = intentionalStop;

    // Clean up readline interfaces
    if (readline) {
      readline.close();
      readline = null;
    }
    if (stderrReadline) {
      stderrReadline.close();
      stderrReadline = null;
    }
    childProcess = null;
    startedAt = null;

    // Reject all pending requests
    rejectAllPending(
      new Error(formatWorkerFailureMessage(
        `Worker process exited (code=${code}, signal=${signal})`,
        stderrExcerpt,
      )),
    );

    // Emit synthetic close for any orphaned stream channels so SSE clients
    // are notified instead of hanging indefinitely.
    if (openStreamChannels.size > 0 && options.onStreamNotification) {
      for (const [channel, companyId] of openStreamChannels) {
        try {
          options.onStreamNotification("streams.close", { channel, companyId });
        } catch {
          // Best-effort cleanup — don't let it interfere with exit handling
        }
      }
      openStreamChannels.clear();
    }

    emitter.emit("exit", { pluginId, code, signal });

    if (wasIntentional) {
      // Graceful stop — status is already "stopping" or will be set to "stopped"
      setStatus("stopped");
      log.info({ code, signal }, "worker process stopped");
      return;
    }

    // Unexpected exit — crash recovery
    totalCrashes++;
    const now = Date.now();

    // Reset consecutive crash counter if enough time passed
    if (lastCrashAt !== null && now - lastCrashAt > CRASH_WINDOW_MS) {
      consecutiveCrashes = 0;
    }
    consecutiveCrashes++;
    lastCrashAt = now;

    log.error(
      { code, signal, consecutiveCrashes, totalCrashes },
      "worker process crashed",
    );

    const willRestart =
      autoRestart && consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES;

    setStatus("crashed");
    emitter.emit("crash", { pluginId, code, signal, willRestart });

    if (willRestart) {
      scheduleRestart();
    } else {
      log.error(
        { consecutiveCrashes, maxCrashes: MAX_CONSECUTIVE_CRASHES },
        "max consecutive crashes reached, not restarting",
      );
    }
  }

  function rejectAllPending(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(
          pending.id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          error.message,
        ) as JsonRpcResponse,
      );
    }
    pendingRequests.clear();
  }

  // -----------------------------------------------------------------------
  // Crash recovery with exponential backoff
  // -----------------------------------------------------------------------

  function computeBackoffMs(): number {
    // Exponential backoff: MIN_BACKOFF * MULTIPLIER^(consecutiveCrashes - 1)
    const delay =
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveCrashes - 1);
    // Add jitter: ±25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.round(delay + jitter), MAX_BACKOFF_MS);
  }

  function scheduleRestart(): void {
    const delay = computeBackoffMs();
    nextRestartAt = Date.now() + delay;

    setStatus("backoff");

    log.info(
      { delayMs: delay, consecutiveCrashes },
      "scheduling restart with backoff",
    );

    backoffTimer = setTimeout(async () => {
      backoffTimer = null;
      nextRestartAt = null;
      try {
        await startInternal();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "restart after backoff failed",
        );
      }
    }, delay);
  }

  function cancelPendingRestart(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
      nextRestartAt = null;
    }
  }

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  async function startInternal(): Promise<void> {
    if (status === "running" || status === "starting") {
      throw new Error(`Worker for plugin "${pluginId}" is already ${status}`);
    }

    intentionalStop = false;
    setStatus("starting");
    stderrExcerpt = "";

    const child = spawnProcess();
    childProcess = child;
    attachStdioHandlers(child);
    startedAt = Date.now();

    // Send the initialize RPC call
    const initParams: InitializeParams = {
      manifest: options.manifest,
      config: options.config,
      instanceInfo: options.instanceInfo,
      apiVersion: options.apiVersion,
      databaseNamespace: options.databaseNamespace ?? null,
    };

    try {
      const result = await callInternal(
        "initialize",
        initParams,
        INITIALIZE_TIMEOUT_MS,
      ) as { ok?: boolean; supportedMethods?: string[] } | undefined;
      if (!result || !result.ok) {
        throw new Error("Worker initialize returned ok=false");
      }
      supportedMethods = result.supportedMethods ?? [];
    } catch (err) {
      // Initialize failed — kill the process and propagate
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "worker initialize failed");
      await killProcess();
      setStatus("crashed");
      throw new Error(`Worker initialize failed for "${pluginId}": ${msg}`);
    }

    // Reset crash counter on successful start
    consecutiveCrashes = 0;
    setStatus("running");
    emitter.emit("ready", { pluginId });
    log.info({ pid: child.pid }, "worker process started and initialized");
  }

  async function stopInternal(): Promise<void> {
    cancelPendingRestart();

    if (status === "stopped" || status === "stopping") {
      return;
    }

    intentionalStop = true;
    setStatus("stopping");

    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 1: Send shutdown RPC and wait for the worker to exit gracefully.
    // We race the shutdown call against a timeout. The worker should process
    // the shutdown and exit on its own within the drain period.
    try {
      await Promise.race([
        callInternal("shutdown", {} as Record<string, never>, SHUTDOWN_DRAIN_MS),
        waitForExit(SHUTDOWN_DRAIN_MS),
      ]);
    } catch {
      // Shutdown call failed or timed out — proceed to kill
      log.warn("shutdown RPC failed or timed out, escalating to SIGTERM");
    }

    // Give the process a brief moment to exit after the shutdown response
    if (childProcess) {
      await waitForExit(500);
    }

    // Check if process already exited
    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 2: Send SIGTERM and wait
    log.info("worker did not exit after shutdown RPC, sending SIGTERM");
    await killWithSignal("SIGTERM", SIGTERM_GRACE_MS);

    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 3: Forcefully kill with SIGKILL
    log.warn("worker did not exit after SIGTERM, sending SIGKILL");
    await killWithSignal("SIGKILL", 2_000);

    if (childProcess) {
      log.error("worker process still alive after SIGKILL — this should not happen");
    }

    setStatus("stopped");
  }

  /**
   * Wait for the child process to exit, up to `timeoutMs`.
   * Resolves immediately if the process is already gone.
   */
  function waitForExit(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, timeoutMs);

      childProcess.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function killWithSignal(
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve();
      }, waitMs);

      childProcess.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        childProcess.kill(signal);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async function killProcess(): Promise<void> {
    if (!childProcess) return;
    intentionalStop = true;
    try {
      childProcess.kill("SIGKILL");
    } catch {
      // Process may already be dead
    }
    // Wait briefly for exit event
    await new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        resolve();
      }, 1_000);
      childProcess.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -----------------------------------------------------------------------
  // RPC call implementation
  // -----------------------------------------------------------------------

  function callInternal<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
  ): Promise<HostToWorkerMethods[M][1]> {
    const rpcPromise = new Promise<HostToWorkerMethods[M][1]>((resolve, reject) => {
      if (!childProcess?.stdin?.writable) {
        reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is not running`,
          ),
        );
        return;
      }

      const id = nextRequestId++;
      const timeout = Math.min(timeoutMs ?? rpcTimeoutMs, MAX_RPC_TIMEOUT_MS);

      // Guard against double-settlement. When a process exits all pending
      // requests are rejected via rejectAllPending(), but the timeout timer
      // may still be running. Without this guard the timer's reject fires on
      // an already-settled promise, producing an unhandled rejection.
      let settled = false;

      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingRequests.delete(id);
        fn(value);
      };

      const timer = setTimeout(() => {
        settle(
          reject,
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: `RPC call "${method}" timed out after ${timeout}ms`,
          }),
        );
      }, timeout);

      const pending: PendingRequest = {
        id,
        method,
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as HostToWorkerMethods[M][1]);
          } else if ("error" in response && response.error) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer,
        sentAt: Date.now(),
      };

      pendingRequests.set(id, pending);

      try {
        const request = createRequest(method, params, id);
        sendMessage(request);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(
          new Error(
            `Failed to send "${method}" to worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });

    // Some call sites hand these promises across async boundaries before
    // attaching their own handlers. Mark the promise as handled here so a
    // worker-side JSON-RPC error can fail the caller without killing the host
    // process via an unhandled rejection.
    void rpcPromise.catch(() => undefined);

    return rpcPromise;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const handle: PluginWorkerHandle = {
    get pluginId() {
      return pluginId;
    },

    get status() {
      return status;
    },

    get supportedMethods() {
      return supportedMethods;
    },

    async start() {
      await startInternal();
    },

    async stop() {
      await stopInternal();
    },

    async restart() {
      await stopInternal();
      await startInternal();
    },

    call<M extends HostToWorkerMethodName>(
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return callInternal(method, params, timeoutMs);
    },

    notify(method: string, params: unknown) {
      if (status !== "running") return;
      try {
        // Notifications are fire-and-forget: drop them under stdin backpressure
        // instead of queuing unbounded off-heap Buffers (see
        // MAX_WORKER_STDIN_BACKLOG_BYTES).
        sendMessage(
          {
            jsonrpc: JSONRPC_VERSION,
            method,
            params,
          },
          { droppable: true },
        );
      } catch {
        log.warn({ method }, "failed to send notification to worker");
      }
    },

    on<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.on(event, listener);
    },

    off<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.off(event, listener);
    },

    diagnostics(): WorkerDiagnostics {
      return {
        pluginId,
        status,
        pid: childProcess?.pid ?? null,
        uptime:
          startedAt !== null && status === "running"
            ? Date.now() - startedAt
            : null,
        consecutiveCrashes,
        totalCrashes,
        pendingRequests: pendingRequests.size,
        lastCrashAt,
        nextRestartAt,
      };
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerManager
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginWorkerManager.
 */
export interface PluginWorkerManagerOptions {
  /**
   * Optional callback invoked when a worker emits a lifecycle event
   * (crash, restart). Used by the server to publish global live events.
   */
  onWorkerEvent?: (event: {
    type: "plugin.worker.crashed" | "plugin.worker.restarted";
    pluginId: string;
    code?: number | null;
    signal?: string | null;
    willRestart?: boolean;
  }) => void;
  /**
   * Global callback for stream notifications from any worker (streams.open/emit/close).
   * Wired to the PluginStreamBus to fan out events to SSE clients.
   */
  onStreamNotification?: (pluginId: string, method: string, params: Record<string, unknown>) => void;
}

/**
 * Create a new PluginWorkerManager.
 *
 * The manager holds all plugin worker handles and provides a unified API for
 * starting, stopping, and communicating with plugin workers.
 *
 * @example
 * ```ts
 * const manager = createPluginWorkerManager();
 *
 * const handle = await manager.startWorker("acme.linear", {
 *   entrypointPath: "/path/to/worker.cjs",
 *   manifest,
 *   config: resolvedConfig,
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 *   apiVersion: 1,
 *   hostHandlers: { "config.get": async () => resolvedConfig, ... },
 * });
 *
 * // Send RPC call to the worker
 * const health = await manager.call("acme.linear", "health", {});
 *
 * // Shutdown all workers on server exit
 * await manager.stopAll();
 * ```
 */
export function createPluginWorkerManager(
  managerOptions?: PluginWorkerManagerOptions,
): PluginWorkerManager {
  const log = logger.child({ service: "plugin-worker-manager" });
  const workers = new Map<string, PluginWorkerHandle>();
  /** Per-plugin startup locks to prevent concurrent spawn races. */
  const startupLocks = new Map<string, Promise<PluginWorkerHandle>>();

  return {
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<PluginWorkerHandle> {
      // Mutex: if a start is already in-flight for this plugin, wait for it
      const inFlight = startupLocks.get(pluginId);
      if (inFlight) {
        log.warn({ pluginId }, "concurrent startWorker call — waiting for in-flight start");
        return inFlight;
      }

      const existing = workers.get(pluginId);
      if (existing && existing.status !== "stopped") {
        throw new Error(
          `Worker already registered for plugin "${pluginId}" (status: ${existing.status})`,
        );
      }

      // Wire manager-level stream notification callback into per-worker options
      const mergedOptions = managerOptions?.onStreamNotification && !options.onStreamNotification
        ? {
            ...options,
            onStreamNotification: (method: string, params: Record<string, unknown>) => {
              managerOptions.onStreamNotification!(pluginId, method, params);
            },
          }
        : options;
      const handle = createPluginWorkerHandle(pluginId, mergedOptions);
      workers.set(pluginId, handle);

      // Subscribe to crash/ready events for live event forwarding
      if (managerOptions?.onWorkerEvent) {
        const notify = managerOptions.onWorkerEvent;
        handle.on("crash", (payload) => {
          notify({
            type: "plugin.worker.crashed",
            pluginId: payload.pluginId,
            code: payload.code,
            signal: payload.signal,
            willRestart: payload.willRestart,
          });
        });
        handle.on("ready", (payload) => {
          // Only emit restarted if this was a crash recovery (totalCrashes > 0)
          const diag = handle.diagnostics();
          if (diag.totalCrashes > 0) {
            notify({
              type: "plugin.worker.restarted",
              pluginId: payload.pluginId,
            });
          }
        });
      }

      log.info({ pluginId }, "starting plugin worker");

      // Set the lock before awaiting start() to prevent concurrent spawns
      const startPromise = handle.start().then(() => handle).finally(() => {
        startupLocks.delete(pluginId);
      });
      startupLocks.set(pluginId, startPromise);

      return startPromise;
    },

    async stopWorker(pluginId: string): Promise<void> {
      const handle = workers.get(pluginId);
      if (!handle) {
        log.warn({ pluginId }, "no worker registered for plugin, nothing to stop");
        return;
      }

      log.info({ pluginId }, "stopping plugin worker");
      await handle.stop();
      workers.delete(pluginId);
    },

    getWorker(pluginId: string): PluginWorkerHandle | undefined {
      return workers.get(pluginId);
    },

    isRunning(pluginId: string): boolean {
      const handle = workers.get(pluginId);
      return handle?.status === "running";
    },

    async stopAll(): Promise<void> {
      log.info({ count: workers.size }, "stopping all plugin workers");
      const promises = Array.from(workers.values()).map(async (handle) => {
        try {
          await handle.stop();
        } catch (err) {
          log.error(
            {
              pluginId: handle.pluginId,
              err: err instanceof Error ? err.message : String(err),
            },
            "error stopping worker during shutdown",
          );
        }
      });
      await Promise.all(promises);
      workers.clear();
    },

    diagnostics(): WorkerDiagnostics[] {
      return Array.from(workers.values()).map((h) => h.diagnostics());
    },

    call<M extends HostToWorkerMethodName>(
      pluginId: string,
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
    ): Promise<HostToWorkerMethods[M][1]> {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.call(method, params, timeoutMs);
    },
  };
}
