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
import { randomUUID } from "node:crypto";
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
  LOGIN_PTY_OUTPUT_NOTIFICATION,
  LOGIN_PTY_EXIT_NOTIFICATION,
  DUPLEX_CHANNEL_DATA_NOTIFICATION,
  DUPLEX_CHANNEL_EXIT_NOTIFICATION,
  encodeChannelBytes,
  decodeChannelBytes,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcId,
  PluginInvocationContext,
  PluginInvocationScope,
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  WorkerHostCallContext,
  HostToWorkerMethodName,
  HostToWorkerMethods,
  WorkerToHostMethodName,
  WorkerToHostMethods,
  InitializeParams,
} from "@paperclipai/plugin-sdk";
import { getActiveStepContext } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import {
  isLoginCommandKey,
  validateLoginSessionHome,
  type LoginCommandKey,
} from "./login-command.js";
import { logger } from "../middleware/logger.js";
import { traceparentFromContextToken } from "../instrumentation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Upper bound for the *default* RPC timeout path (15 minutes). Explicit
 * caller-supplied timeouts are not subject to this cap: execute-class RPCs such
 * as `environmentExecute` run entire sandboxed agent sessions in one call and
 * their callers deliberately request multi-hour budgets (see
 * `resolvePluginExecuteRpcTimeoutMs` in plugin-environment-driver.ts).
 * Clamping those explicit budgets here killed long sandboxed runs mid-work.
 */
const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Maximum delay accepted by Node timers before Node clamps the timeout to 1ms.
 * Keep accepted explicit RPC budgets inside this range before calling
 * setTimeout, otherwise a huge timeout can expire almost immediately.
 */
const MAX_NODE_TIMER_TIMEOUT_MS = 2_147_483_647;

/** Timeout for the initialize RPC call. */
const INITIALIZE_TIMEOUT_MS = 15_000;

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

/** Maximum characters accepted for one `execute.log` chunk. A larger chunk is
 * dropped, so a faulty or hostile worker cannot flood the host with one
 * unbounded notification. */
const MAX_EXECUTE_LOG_CHUNK_CHARS = 1_000_000;

/**
 * Maximum characters accepted for one incoming worker stdout line before the
 * host parses it as JSON. The host drops a longer line without a parse, so a
 * faulty or hostile worker cannot force the host to parse an unbounded document
 * and exhaust memory. The bound sits far above the largest legitimate framed
 * message, so a real large command result still passes. A worker can override
 * it through `WorkerStartOptions.executeLogLimits`.
 */
const MAX_WORKER_MESSAGE_CHARS = 128 * 1024 * 1024;

/**
 * Default ceiling for the total characters one execute call may stream through
 * `execute.log`. The host counts the delivered characters for each active
 * execute route and drops further chunks past this bound, so one runaway or
 * hostile execution cannot flood the host and the run-log sink without limit.
 * The final command result still delivers the complete output through its own
 * capture path. A worker can override it through
 * `WorkerStartOptions.executeLogLimits`.
 */
const MAX_EXECUTE_LOG_TOTAL_CHARS = 128 * 1024 * 1024;

/** Maximum characters for one live login pseudo-terminal output notification. */
const MAX_LOGIN_PTY_CHUNK_CHARS = 1_000_000;
/** Maximum cumulative output characters for one login pseudo-terminal route. */
const MAX_LOGIN_PTY_TOTAL_CHARS = 8 * 1024 * 1024;
/** Default maximum output and exit records the host queues before the bind. */
const MAX_LOGIN_PTY_PRE_BIND_FRAMES = 10_000;
/** Default maximum cumulative output characters the host queues before the bind. */
const MAX_LOGIN_PTY_PRE_BIND_CHARS = 8 * 1024 * 1024;
/** The default open timeout for one login pseudo-terminal route, in milliseconds. */
const LOGIN_PTY_OPEN_TIMEOUT_MS = 30_000;
/** The default close timeout for one login pseudo-terminal route, in milliseconds. */
const LOGIN_PTY_CLOSE_TIMEOUT_MS = 10_000;
/**
 * The fixed non-secret error a disallowed login command key returns. The manager
 * forwards only a closed login command key to the worker pseudo-terminal. It
 * rejects a key outside the closed set before the worker call, so a caller cannot
 * select an arbitrary command in the sandbox.
 */
const LOGIN_PTY_COMMAND_NOT_ALLOWED = "LOGIN_PTY_COMMAND_NOT_ALLOWED";
/** The fixed non-secret error a rejected second credential open returns. */
const LOGIN_PTY_ROUTE_BUSY = "LOGIN_PTY_ROUTE_BUSY";
/** The fixed non-secret error a failed open returns. */
const LOGIN_PTY_OPEN_FAILED = "LOGIN_PTY_OPEN_FAILED";

// Bounds and timeouts for the generic duplex channel route. The route mirrors the
// login pseudo-terminal route, but it carries no command allowlist and adds seven
// explicit bounds the pseudo-terminal route lacks. Each bound ends the route when
// it passes the limit, so a faulty or hostile worker cannot flood the host.
/** The default maximum characters for one duplex channel data notification. This
 * matches the host duplex frame bound ({@link DEFAULT_MAX_DUPLEX_FRAME_BYTES} in
 * `duplex-frame-codec.ts`), so one chunk always fits inside one frame. */
const MAX_DUPLEX_CHANNEL_CHUNK_CHARS = 262_144;
/**
 * The default maximum cumulative bytes the host retains, on one duplex channel
 * route, for input the worker has not yet delivered: the pre-bind hold (before
 * the worker session id binds), the post-bind buffered queue (bound, before a
 * data listener attaches), and the terminal buffer (a route that ended before
 * a listener attached). All three representations share this one route-local
 * bound, so a worker cannot grow any of them past it. This bound is a fixed
 * share of the fixed per-route byte budget the host now bounds every duplex
 * retention site against; it holds no measurement of real traffic.
 */
export const DUPLEX_ROUTE_INPUT_MAX_BYTES = 393_216;
/**
 * The default maximum number of data frames the host buffers for one duplex
 * channel route before a data listener attaches.
 */
const MAX_DUPLEX_CHANNEL_PRE_BIND_FRAMES = 10_000;
/**
 * The margin the pre-bind hold ceiling keeps above the pre-bind buffered-frame
 * bound (`maxDuplexChannelPreBindFrames`). A worker can batch data and exit
 * frames with the open reply, so the host reads them before the route binds and
 * before it can apply the per-frame bounds. The host holds these frames and
 * replays them after the bind. The hold ceiling bounds that hold, so a worker
 * that floods frames before the open reply cannot make the host hold an
 * unbounded number of frames.
 *
 * The hold ceiling derives from the buffered bound, not a fixed constant. A
 * fixed ceiling at or below a caller-configured buffered bound would drop the
 * frame that must instead trip the buffered bound during replay, so the route
 * would never end. One frame of margin is enough. It lets the frame that
 * exceeds the buffered bound reach the hold, so the replay's buffered-bound
 * check, not the hold, ends the route.
 */
const DUPLEX_CHANNEL_PRE_BIND_HOLD_MARGIN_FRAMES = 1;
/**
 * The default maximum number of in-flight host→worker requests for one duplex
 * channel route. A worker that never replies cannot make the host hold an
 * unbounded number of pending requests.
 */
const MAX_DUPLEX_CHANNEL_PENDING_REQUESTS = 256;
/** The default maximum characters for one host→worker duplex channel write. This
 * matches the host duplex frame bound, so one write always fits inside one
 * frame. */
const MAX_DUPLEX_CHANNEL_WRITE_CHARS = 262_144;
/**
 * The default maximum cumulative bytes the host retains, on one duplex channel
 * route, for a host→worker write the worker has not yet acknowledged: the raw
 * write payload and the serialized child-stdin frame the host built from it.
 * This bound is route-local and independent of the pending-request count
 * bound above; a worker that never replies still cannot make one route hold
 * an unbounded number of write bytes, even under a raised pending-request
 * count. This bound is a fixed share of the fixed per-route byte budget; it
 * holds no measurement of real traffic.
 */
export const DUPLEX_ROUTE_PENDING_WRITE_MAX_BYTES = 393_216;
/**
 * The default maximum number of protocol errors for one duplex channel route.
 * A protocol error is one malformed or mismatched data frame. The route ends
 * when the count passes this budget, so a flood of bad frames bounds the route.
 */
const MAX_DUPLEX_CHANNEL_PROTOCOL_ERRORS = 100;
/**
 * The default maximum cumulative bytes the host forwards for one duplex channel
 * route over its whole life. The host counts the bytes of every inbound chunk,
 * before and after a data listener attaches. The route ends when the count
 * passes this cap, so an active route with a bound listener cannot stream an
 * unbounded number of bytes.
 */
const MAX_DUPLEX_CHANNEL_TOTAL_DATA_BYTES = 256 * 1024 * 1024;
/**
 * The default maximum lifetime for one duplex channel route, in milliseconds.
 * The host starts a timer when the route opens and ends the route when the
 * timer expires, so a route cannot live without limit.
 */
const MAX_DUPLEX_CHANNEL_DURATION_MS = 60 * 60 * 1000;
/** The default open timeout for one duplex channel route, in milliseconds. */
const DUPLEX_CHANNEL_OPEN_TIMEOUT_MS = 30_000;
/** The default close timeout for one duplex channel route, in milliseconds. */
const DUPLEX_CHANNEL_CLOSE_TIMEOUT_MS = 10_000;
/** The fixed non-secret error a rejected second duplex channel open returns. */
const DUPLEX_CHANNEL_ROUTE_BUSY = "DUPLEX_CHANNEL_ROUTE_BUSY";
/** The fixed non-secret error a failed duplex channel open returns. */
const DUPLEX_CHANNEL_OPEN_FAILED = "DUPLEX_CHANNEL_OPEN_FAILED";

// The process-scoped monotonic route-generation source. The host mints one
// strictly increasing, non-reusable `hostRouteId` on each duplex channel open,
// across every worker in the process. A retired generation never returns, so a
// late frame for a closed pair never collides with a new open. The host owns the
// value; no worker field sets it.
let duplexHostRouteIdSequence = 0;
/** Mint the next monotonic, non-reusable host route identifier for a duplex channel open. */
function nextDuplexHostRouteId(): string {
  duplexHostRouteIdSequence += 1;
  return `duplex-route-${duplexHostRouteIdSequence}`;
}

// The separator between the two identifiers of a duplex route pair key. It is a
// null byte, which appears in neither a host route id nor a worker session id, so
// two distinct pairs never collapse to one key.
const DUPLEX_PAIR_KEY_SEPARATOR = "\u0000";
/** Build the exact-pair routing key from the host route id and the worker session id. */
function duplexPairKey(hostRouteId: string, workerSessionId: string): string {
  return `${hostRouteId}${DUPLEX_PAIR_KEY_SEPARATOR}${workerSessionId}`;
}

// The maximum number of tombstoned duplex pairs one worker retains. The worker
// keeps every tombstone until it retires, so a closed pair never returns. Before
// the set would exceed this bound, the host retires the worker, which drops every
// route and every tombstone at once. A tombstone overflow fails closed; the host
// never evicts a tombstone and lets a pair return.
const MAX_DUPLEX_ROUTE_TOMBSTONES = 4096;

/** Minimum time between two dropped-`execute.log` debug records. The router
 * rate-limits the record so a flood of dropped chunks writes at most one line
 * per window with a running count. */
const EXECUTE_LOG_DROP_LOG_INTERVAL_MS = 1_000;

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
  context?: WorkerHostCallContext,
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
 * Resolve the effective timeout for an RPC call.
 *
 * An explicit, positive, finite caller-supplied timeout bypasses the 15-minute
 * RPC cap after normalization to Node's timer-safe integer range. Callers that
 * pass one (e.g. the environment driver for `environmentExecute`) own their
 * budget, and independent inactivity/safety guards bound hung runs. Only the
 * default path (no usable explicit timeout) is clamped to MAX_RPC_TIMEOUT_MS so
 * ordinary plugin calls stay bounded.
 */
export function resolveRpcCallTimeoutMs(
  explicitTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  if (
    explicitTimeoutMs !== undefined &&
    Number.isFinite(explicitTimeoutMs) &&
    explicitTimeoutMs > 0
  ) {
    return Math.min(Math.max(Math.trunc(explicitTimeoutMs), 1), MAX_NODE_TIMER_TIMEOUT_MS);
  }
  return Math.min(defaultTimeoutMs, MAX_RPC_TIMEOUT_MS);
}

/**
 * Options for starting a worker process.
 */
/**
 * The process-scoped aggregate route-slot controller. The manager injects one
 * shared instance into every worker handle, so the ceiling counts every
 * concurrent duplex route across the process, not one agent's setting.
 */
export interface DuplexRouteSlotController {
  /** Reserve one route slot. Return true when a slot was free and is now held. */
  tryAcquire(): boolean;
  /** Release one held route slot. */
  release(): void;
}

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
   * The process-scoped aggregate route-slot controller for the duplex channel
   * ceiling. The manager injects one shared instance into every worker handle.
   * When it is absent, the worker admits every duplex open unbounded (a unit test
   * constructs a handle this way).
   */
  duplexRouteSlots?: DuplexRouteSlotController | null;
  /**
   * Companies this worker may act on from proactive (no-invocation) worker→host
   * calls — the plugin's configured companies. Seeded onto the handle at
   * creation, BEFORE the child process spawns, so a proactive plugin that
   * issues host calls during setup() (e.g. the chat gateway's one-shot
   * `events.subscribe`, which runs while `startWorker` is still awaiting the
   * initialize response) is already authorized when those calls arrive. The set
   * can still be replaced at runtime via `setProactiveCompanyScopes` (e.g. on a
   * config change). Never widens access beyond the listed companies (LOOA-695).
   */
  proactiveCompanyScopes?: readonly string[];
  /**
   * Callback for stream notifications from the worker (streams.open/emit/close).
   * The host wires this to the PluginStreamBus to fan out events to SSE clients.
   */
  onStreamNotification?: (method: string, params: Record<string, unknown>) => void;
  /**
   * Framing and flood limits for the `execute.log` route. The defaults bound
   * one incoming line before the JSON parse and the total streamed output for
   * one execute call. A test overrides them to exercise the drop paths without
   * huge inputs.
   */
  executeLogLimits?: {
    /** Max characters for one incoming worker line before the JSON parse. */
    maxIncomingMessageChars?: number;
    /** Max total characters one execute call may stream through `execute.log`. */
    maxTotalCharsPerExecute?: number;
  };

  /**
   * Bounds and timeouts for the login pseudo-terminal route. The
   * defaults bound one output notification, the cumulative output per route, and
   * the open and the close timeouts. A test overrides them to exercise the
   * terminalize paths without huge inputs or long waits.
   */
  loginPtyLimits?: {
    /** Max characters for one login pseudo-terminal output notification. */
    maxChunkChars?: number;
    /** Max cumulative output characters for one login pseudo-terminal route. */
    maxTotalChars?: number;
    /** Max number of pre-bind output and exit records the host queues before the bind. */
    maxPreBindFrames?: number;
    /** Max cumulative output characters the host queues before the bind. */
    maxPreBindChars?: number;
    /** The open timeout for one login pseudo-terminal route, in milliseconds. */
    openTimeoutMs?: number;
    /** The close timeout for one login pseudo-terminal route, in milliseconds. */
    closeTimeoutMs?: number;
  };

  /**
   * Bounds and timeouts for the generic duplex channel route. The defaults bound
   * one data notification, the pre-bind buffer, the in-flight request count, one
   * host→worker write, the protocol-error budget, and the open and close
   * timeouts. A test overrides them to exercise each bound without huge inputs or
   * long waits.
   */
  duplexChannelLimits?: {
    /** Max characters for one duplex channel data notification. */
    maxChunkChars?: number;
    /** Max cumulative characters the host buffers before a data listener attaches. */
    maxPreBindBufferedChars?: number;
    /** Max number of data frames the host buffers before a data listener attaches. */
    maxPreBindBufferedFrames?: number;
    /** Max number of in-flight host→worker requests for one route. */
    maxPendingRequests?: number;
    /** Max characters for one host→worker duplex channel write. */
    maxWriteChars?: number;
    /** Max cumulative bytes the host retains, for one route, for a
     * host→worker write pending the worker's acknowledgement. */
    maxPendingWriteBytes?: number;
    /** Max number of protocol errors for one route before the route ends. */
    maxProtocolErrors?: number;
    /** Max cumulative bytes the host forwards for one route over its whole life. */
    maxTotalDataBytes?: number;
    /** The maximum lifetime for one route, in milliseconds. */
    maxDurationMs?: number;
    /** The open timeout for one duplex channel route, in milliseconds. */
    openTimeoutMs?: number;
    /** The close timeout for one duplex channel route, in milliseconds. */
    closeTimeoutMs?: number;
  };
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
  /** Active host-owned invocation id attached to this host→worker call. */
  invocationId?: string;
}

interface ActiveInvocation {
  scope: PluginInvocationScope;
  timer?: ReturnType<typeof setTimeout>;
  // The host-minted W3C `traceparent` for the active startup span, or undefined
  // when no startup span is active. The span host handler reads it to mint the
  // parentage, so a worker never supplies the parent itself.
  traceparent?: string;
}

/**
 * Sink for one incremental output chunk of an active `environmentExecute` call.
 * The host runner passes it to `call` for the execute method, and the manager
 * delivers each `execute.log` chunk to it. The sink may return a promise; the
 * caller owns the ordering.
 */
export type ExecuteLogSink = (
  stream: "stdout" | "stderr",
  chunk: string,
) => void | Promise<void>;

/**
 * The input the manager needs to open one live login pseudo-terminal route. The
 * manager mints the host route identifier; the caller supplies the sandbox scope,
 * the provider lease id, and the host-resolved launch descriptor. The launch
 * descriptor carries a closed command key and a validated session home. It
 * carries no command string, so a caller cannot select the command.
 */
export interface LoginPtyOpenInput {
  /** The environment driver key. It routes the worker; it confers no command authority. */
  driverKey: string;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  /** The host-resolved fixed command identity. The worker maps it to a compile-time command. */
  loginCommandKey: LoginCommandKey;
  /**
   * The server-controlled, validated session home. The shape is exact:
   * `/tmp/paperclip-adapter-login/<uuid>`.
   */
  sessionHome: string;
}

/**
 * One live login pseudo-terminal session the manager hands to the login
 * transport. The shape matches the sandbox provider login
 * pseudo-terminal session, so the transport consumes it with no adapter.
 */
export interface LoginPtyHostSession {
  /** Registers the one output listener. The session streams each raw chunk in order. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal. */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends or the route terminalizes. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Closes the route and releases the terminal. Safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * The input the manager needs to open one generic duplex channel. The manager
 * mints the host route identifier. The caller supplies the sandbox scope, the
 * provider lease id, and the command. The duplex channel carries no command
 * allowlist, so the caller owns the command.
 */
export interface DuplexChannelOpenInput {
  driverKey: string;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  /**
   * The command argument vector the worker runs on the channel. Element 0 is the
   * program. The worker runs the vector with no shell, so a shell metacharacter
   * in an element cannot inject a command.
   */
  command: readonly string[];
}

/**
 * One live duplex channel the manager hands to a caller. The shape matches the
 * login pseudo-terminal session, so a caller consumes one live bidirectional
 * stream with the same methods.
 */
export interface DuplexChannelHostSession {
  /** Registers the one data listener. The session streams each raw byte chunk in order. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Writes raw input bytes to the channel. */
  write(data: Uint8Array): void;
  /**
   * Resolves when the command ends or the route ends. A numeric `exitCode` is a
   * real process exit. `transportClosed` is true when the provider transport
   * closed with no exit data, so the broker can tell a real process exit from a
   * reason-less transport close.
   */
  wait(): Promise<{ exitCode: number | null; transportClosed?: boolean }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Closes the route and releases the channel. Safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * Host-owned route for one active execute call. The host mints the invocation
 * id and stores the exact company id and log sink here. A worker never selects
 * this record; the host looks it up by the host-issued invocation id on the
 * message envelope. The company id is the single authority for the delivery
 * target, so an `execute.log` notification never carries a company id.
 */
interface ExecuteLogRoute {
  companyId: string;
  onLog: ExecuteLogSink;
  /**
   * The count of characters delivered through this route. The router bounds the
   * per-execute total and drops chunks past the configured ceiling.
   */
  deliveredChars: number;
  /**
   * Latched when the router cannot bind the shared worker pipe to a single
   * company, because a second company's execute overlapped this one. After the
   * latch the router drops every further chunk for this route and lets the final
   * command result deliver the complete output. The latch keeps the delivered
   * prefix contiguous, so the run log never shows a gap.
   */
  crossCompanyBlocked: boolean;
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
    executeLogSink?: ExecuteLogSink,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Send a fire-and-forget notification to the worker (no response expected).
   */
  notify(method: string, params: unknown): void;

  /**
   * Open one live login pseudo-terminal route on this worker. The
   * manager mints the host route identifier, reserves the route, drives the open,
   * binds the worker session identifier one time, and returns a session the login
   * transport drives. It permits one active credential pseudo-terminal per worker.
   */
  openLoginPtySession(
    input: LoginPtyOpenInput,
  ): Promise<LoginPtyHostSession>;

  /**
   * Open one generic duplex channel on this worker. The manager mints the host
   * route identifier, reserves the route, drives the open, binds the worker
   * session identifier one time, and returns a session a caller drives. It
   * permits one active duplex channel per worker. It enforces five explicit
   * bounds and ends the route when a bound passes its limit.
   */
  openDuplexChannel(
    input: DuplexChannelOpenInput,
  ): Promise<DuplexChannelHostSession>;

  /**
   * Authorize the set of companies this worker may act on from proactive
   * (non-invocation) context. Replaces any previously-authorized set. See the
   * proactive-company-scope note in `createPluginWorkerHandle` for rationale.
   */
  setProactiveCompanyScopes(companyIds: readonly string[]): void;

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
   * Authorize the companies a plugin's worker may act on from proactive
   * (non-invocation) context. No-op if the worker is not registered.
   */
  setProactiveCompanyScopes(pluginId: string, companyIds: readonly string[]): void;

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
    executeLogSink?: ExecuteLogSink,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Open one live login pseudo-terminal route on a specific plugin worker
   * See {@link PluginWorkerHandle.openLoginPtySession}.
   *
   * @throws if the worker is not registered.
   */
  openLoginPtySession(
    pluginId: string,
    input: LoginPtyOpenInput,
  ): Promise<LoginPtyHostSession>;
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
  const activeInvocations = new Map<string, ActiveInvocation>();
  // Host-owned execute routes, keyed by the host-issued invocation id. Only an
  // `environmentExecute` call with a log sink registers a route here. The
  // `execute.log` router delivers only through this map — never through the
  // generic `activeInvocations` record — so a non-execute call can never become
  // a log target.
  const activeExecuteRoutes = new Map<string, ExecuteLogRoute>();
  // Rate-limit state for dropped `execute.log` notifications. The debug record
  // never carries chunk bytes.
  let executeLogDropCount = 0;
  let executeLogDropLoggedAtMs = 0;
  // Rate-limit state for dropped oversized worker lines. The warn record carries
  // only the length, never the line bytes.
  let oversizedLineDropCount = 0;
  let oversizedLineLoggedAtMs = 0;

  // Framing and flood limits for the `execute.log` route. The defaults bound one
  // incoming line before the JSON parse and the total streamed output for one
  // execute call. A caller (a test) can lower them.
  const maxIncomingMessageChars =
    options.executeLogLimits?.maxIncomingMessageChars ?? MAX_WORKER_MESSAGE_CHARS;
  const maxExecuteLogTotalChars =
    options.executeLogLimits?.maxTotalCharsPerExecute ?? MAX_EXECUTE_LOG_TOTAL_CHARS;

  // Bounds and timeouts for the login pseudo-terminal route. A caller
  // (a test) can lower them to exercise the terminalize paths.
  const maxLoginPtyChunkChars =
    options.loginPtyLimits?.maxChunkChars ?? MAX_LOGIN_PTY_CHUNK_CHARS;
  const maxLoginPtyTotalChars =
    options.loginPtyLimits?.maxTotalChars ?? MAX_LOGIN_PTY_TOTAL_CHARS;
  const maxLoginPtyPreBindFrames =
    options.loginPtyLimits?.maxPreBindFrames ?? MAX_LOGIN_PTY_PRE_BIND_FRAMES;
  const maxLoginPtyPreBindChars =
    options.loginPtyLimits?.maxPreBindChars ?? MAX_LOGIN_PTY_PRE_BIND_CHARS;
  const loginPtyOpenTimeoutMs =
    options.loginPtyLimits?.openTimeoutMs ?? LOGIN_PTY_OPEN_TIMEOUT_MS;
  const loginPtyCloseTimeoutMs =
    options.loginPtyLimits?.closeTimeoutMs ?? LOGIN_PTY_CLOSE_TIMEOUT_MS;

  // Bounds and timeouts for the generic duplex channel route. A caller (a test)
  // can lower them to exercise each bound and the terminalize paths. Each
  // "Chars" name is a historical holdover: the channel now carries `Uint8Array`
  // chunks, so every one of these bounds counts raw bytes (`.length` on a
  // `Uint8Array` is its byte count), not UTF-16 code units.
  const maxDuplexChannelChunkChars =
    options.duplexChannelLimits?.maxChunkChars ?? MAX_DUPLEX_CHANNEL_CHUNK_CHARS;
  const maxDuplexChannelPreBindChars =
    options.duplexChannelLimits?.maxPreBindBufferedChars ??
    DUPLEX_ROUTE_INPUT_MAX_BYTES;
  const maxDuplexChannelPreBindFrames =
    options.duplexChannelLimits?.maxPreBindBufferedFrames ??
    MAX_DUPLEX_CHANNEL_PRE_BIND_FRAMES;
  // The pre-bind hold ceiling stays one frame above the buffered bound, so the
  // replay, not the hold, ends the route on the buffered bound. See
  // DUPLEX_CHANNEL_PRE_BIND_HOLD_MARGIN_FRAMES for why the margin must hold.
  const maxDuplexChannelPreBindHoldFrames =
    maxDuplexChannelPreBindFrames + DUPLEX_CHANNEL_PRE_BIND_HOLD_MARGIN_FRAMES;
  const maxDuplexChannelPendingRequests =
    options.duplexChannelLimits?.maxPendingRequests ??
    MAX_DUPLEX_CHANNEL_PENDING_REQUESTS;
  const maxDuplexChannelWriteChars =
    options.duplexChannelLimits?.maxWriteChars ?? MAX_DUPLEX_CHANNEL_WRITE_CHARS;
  const maxDuplexRoutePendingWriteBytes =
    options.duplexChannelLimits?.maxPendingWriteBytes ?? DUPLEX_ROUTE_PENDING_WRITE_MAX_BYTES;
  const maxDuplexChannelProtocolErrors =
    options.duplexChannelLimits?.maxProtocolErrors ??
    MAX_DUPLEX_CHANNEL_PROTOCOL_ERRORS;
  const maxDuplexChannelTotalDataBytes =
    options.duplexChannelLimits?.maxTotalDataBytes ??
    MAX_DUPLEX_CHANNEL_TOTAL_DATA_BYTES;
  const maxDuplexChannelDurationMs =
    options.duplexChannelLimits?.maxDurationMs ?? MAX_DUPLEX_CHANNEL_DURATION_MS;
  const duplexChannelOpenTimeoutMs =
    options.duplexChannelLimits?.openTimeoutMs ?? DUPLEX_CHANNEL_OPEN_TIMEOUT_MS;
  const duplexChannelCloseTimeoutMs =
    options.duplexChannelLimits?.closeTimeoutMs ?? DUPLEX_CHANNEL_CLOSE_TIMEOUT_MS;

  // ------------------------------------------------------------------
  // Proactive company scopes (LOOA-629)
  // ------------------------------------------------------------------
  // A proactive plugin (e.g. the chat gateway) does company-scoped work from
  // its own timers/loops — not inside a host-issued top-level invocation
  // (onEvent/performAction/executeTool/configChanged). Those worker→host calls
  // carry no `paperclipInvocationId`, so the governed-access gate
  // (host-client-factory.ts) rejects any company-scoped request with
  // "company context is required" (regression class from #9557). The host
  // authorizes a bounded set of companies — the plugin's configured companies,
  // set by the loader after startup config delivery — for such proactive work.
  // A no-invocation call that references one of these companies resolves to
  // that company's scope; a call referencing any other company stays denied,
  // and in-invocation calls keep their strict single-company match.
  //
  // Seeded from options at handle creation — before the child process is
  // spawned — so a proactive plugin's setup()-time host calls (which land while
  // `startWorker` is still awaiting initialize) are authorized in time. The
  // loader used to call setProactiveCompanyScopes only AFTER startWorker
  // resolved, which was too late for the gateway's one-shot events.subscribe
  // and left outbound push permanently dead (LOOA-695).
  const proactiveCompanyScopes = new Set<string>();
  for (const id of options.proactiveCompanyScopes ?? []) {
    const trimmed = readNonEmptyString(id);
    if (trimmed) proactiveCompanyScopes.add(trimmed);
  }

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

  function sendMessage(message: unknown): void {
    if (!childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    const serialized = serializeMessage(message as any);
    childProcess.stdin.write(serialized);
  }

  function errorCodeForWorkerHostError(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    const pluginErrorCodes: readonly number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    return typeof code === "number" && pluginErrorCodes.includes(code)
      ? code
      : JSONRPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function handleLine(line: string): void {
    if (!line.trim()) return;

    // Enforce the framing bound BEFORE the JSON parse. A line longer than the
    // limit is dropped without a parse, so a faulty or hostile worker cannot
    // force the host to parse an unbounded document and exhaust memory.
    if (line.length > maxIncomingMessageChars) {
      dropOversizedLine(line.length);
      return;
    }

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

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function deriveInvocationScope(
    method: HostToWorkerMethodName | string,
    params: unknown,
  ): PluginInvocationScope | null {
    if (!isRecord(params)) return null;

    const directCompanyId = readNonEmptyString(params.companyId);
    if (directCompanyId) return { companyId: directCompanyId };

    if (method === "performAction" && isRecord(params.actorContext)) {
      const companyId = readNonEmptyString(params.actorContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "executeTool" && isRecord(params.runContext)) {
      const companyId = readNonEmptyString(params.runContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "onEvent" && isRecord(params.event)) {
      const companyId = readNonEmptyString(params.event.companyId);
      return companyId ? { companyId } : null;
    }

    return null;
  }

  function registerInvocation(scope: PluginInvocationScope, ttlMs?: number): PluginInvocationContext {
    // Mint a W3C `traceparent` from the active startup span, so the worker's
    // provider span can parent to it. The host keeps the value on its own record
    // (below) and never trusts the worker to supply the parent. Outside a
    // measured startup step there is no active span, so this is undefined.
    const activeStep = getActiveStepContext();
    const traceparent = activeStep
      ? traceparentFromContextToken(activeStep.parentContext)
      : undefined;
    const invocation: PluginInvocationContext = {
      id: randomUUID(),
      scope,
      ...(traceparent ? { traceparent } : {}),
    };
    const entry: ActiveInvocation = { scope, traceparent };
    if (ttlMs !== undefined) {
      entry.timer = setTimeout(() => {
        activeInvocations.delete(invocation.id);
      }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    activeInvocations.set(invocation.id, entry);
    return invocation;
  }

  function clearInvocation(invocation: PluginInvocationContext | null): void {
    if (!invocation) return;
    const entry = activeInvocations.get(invocation.id);
    if (entry?.timer) clearTimeout(entry.timer);
    activeInvocations.delete(invocation.id);
  }

  // Store the host-owned execute route for one active execute call. The host
  // holds the exact company id and log sink; the worker never supplies them.
  function registerExecuteRoute(
    invocationId: string,
    companyId: string,
    onLog: ExecuteLogSink,
  ): void {
    activeExecuteRoutes.set(invocationId, {
      companyId,
      onLog,
      deliveredChars: 0,
      crossCompanyBlocked: false,
    });
  }

  function clearExecuteRoute(invocationId: string | undefined): void {
    if (invocationId) activeExecuteRoutes.delete(invocationId);
  }

  // Drop an oversized incoming worker line before the JSON parse. Write a
  // rate-limited warn record with the length and a running drop count. The
  // record never carries the line bytes.
  function dropOversizedLine(lineLength: number): void {
    oversizedLineDropCount += 1;
    const nowMs = Date.now();
    if (nowMs - oversizedLineLoggedAtMs >= EXECUTE_LOG_DROP_LOG_INTERVAL_MS) {
      log.warn(
        { lineLength, maxIncomingMessageChars, droppedSinceLastLog: oversizedLineDropCount },
        "dropping oversized worker line before JSON parse",
      );
      oversizedLineLoggedAtMs = nowMs;
      oversizedLineDropCount = 0;
    }
  }

  // Drop an `execute.log` notification. Write a rate-limited debug record with
  // the reason and a running drop count. The record never carries the chunk
  // bytes, the company id, or command data.
  function dropExecuteLogNotification(reason: string): void {
    executeLogDropCount += 1;
    const nowMs = Date.now();
    if (nowMs - executeLogDropLoggedAtMs >= EXECUTE_LOG_DROP_LOG_INTERVAL_MS) {
      log.debug(
        { reason, droppedSinceLastLog: executeLogDropCount },
        "dropping execute.log notification",
      );
      executeLogDropLoggedAtMs = nowMs;
      executeLogDropCount = 0;
    }
  }

  // Route one `execute.log` notification to its host-owned execute route. The
  // route is the single authority for the delivery target and the company
  // binding. This never reads a company id from the notification and never
  // routes through the generic active-invocation record.
  //
  // Complete mediation: the host and the worker share one stdio pipe, and the
  // worker process sees every active invocation id. So the host cannot prove
  // which concurrent invocation produced a notification, and it must NOT treat
  // the worker-supplied `paperclipInvocationId` alone as proof of origin. The
  // host validates the exact company scope instead: it delivers only while every
  // active execute route on this worker belongs to ONE company. When a second
  // company's execute overlaps, the host fails closed — it latches the active
  // routes and drops the chunk — so a worker that runs company A can never forge
  // company B's active id and inject output into B's route. The final command
  // result still delivers the complete output, so no byte is lost; only the live
  // stream pauses while two companies overlap.
  function routeExecuteLogNotification(notification: JsonRpcNotification): void {
    const invocationId = readNonEmptyString(
      (notification as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    const params = isRecord(notification.params) ? notification.params : {};
    const stream = params.stream;
    const chunk = params.chunk;
    // Runtime-validate the payload. Drop invalid input without a throw.
    if (stream !== "stdout" && stream !== "stderr") {
      dropExecuteLogNotification("invalid-stream");
      return;
    }
    if (
      typeof chunk !== "string" ||
      chunk.length === 0 ||
      chunk.length > MAX_EXECUTE_LOG_CHUNK_CHARS
    ) {
      dropExecuteLogNotification("invalid-chunk");
      return;
    }
    if (!invocationId) {
      dropExecuteLogNotification("missing-invocation");
      return;
    }
    const route = activeExecuteRoutes.get(invocationId);
    if (!route) {
      // No active execute route for this id: a late chunk after settlement or
      // timeout, a non-execute invocation, or an unknown id. Drop it.
      dropExecuteLogNotification("no-active-route");
      return;
    }
    // The route already lost single-company attribution earlier in its life, so
    // it stays closed for the rest of the call.
    if (route.crossCompanyBlocked) {
      dropExecuteLogNotification("cross-company-scope");
      return;
    }
    // Validate the exact company scope. Deliver only while every active execute
    // route on this worker belongs to one company. A second company's active
    // route makes the shared pipe ambiguous, so the host fails closed: it
    // latches every active route and drops the chunk.
    let onlyCompanyId: string | null = null;
    let crossCompany = false;
    for (const active of activeExecuteRoutes.values()) {
      if (onlyCompanyId === null) {
        onlyCompanyId = active.companyId;
      } else if (onlyCompanyId !== active.companyId) {
        crossCompany = true;
        break;
      }
    }
    if (crossCompany) {
      for (const active of activeExecuteRoutes.values()) {
        active.crossCompanyBlocked = true;
      }
      dropExecuteLogNotification("cross-company-scope");
      return;
    }
    // Bound the total characters one execute call may stream. Past the ceiling
    // the host drops further chunks, so one runaway or hostile execution cannot
    // flood the host and the run-log sink without limit.
    if (route.deliveredChars + chunk.length > maxExecuteLogTotalChars) {
      dropExecuteLogNotification("execute-output-cap");
      return;
    }
    route.deliveredChars += chunk.length;
    try {
      const delivery = route.onLog(stream, chunk);
      if (delivery && typeof (delivery as Promise<void>).then === "function") {
        void (delivery as Promise<void>).catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "execute.log delivery failed",
          );
        });
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "execute.log delivery threw",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Host-owned login pseudo-terminal route gate
  // -----------------------------------------------------------------------
  // The manager owns one live login pseudo-terminal route per worker. It mints a
  // host-owned opaque route identifier, carries it in the open call, and keys the
  // close on it, so it closes a worker-created terminal even when the open reply
  // was lost and no worker session identifier arrived. It binds the worker
  // session identifier one time while the route is `opening`, for output only. It
  // never trusts a worker-supplied identifier as proof of origin: it delivers
  // output only while the route is `open` and the notification carries the exact
  // bound identifier and valid bounded bytes, and it never logs the raw bytes. It
  // terminalizes the route exactly once on every open failure path, closes the
  // terminal by the host route identifier, and admits a new open only after it
  // verifies a close acknowledgement bound to that identifier; it retires the
  // worker on an unconfirmed close.

  // A single-consumer route state. The login pseudo-terminal route and the
  // generic duplex channel route share it.
  type RouteState = "reserved" | "opening" | "open" | "closed";

  // Shared route-binding helpers. The login pseudo-terminal route and the duplex
  // channel route both use them, so the two routes bind and settle one way.

  // Settle the route wait exactly once. Replace the settler with a no-op, so a
  // later exit or terminalize never settles the wait a second time.
  function settleRouteWait(
    route: { settleWait: (value: { exitCode: number | null; transportClosed?: boolean }) => void },
    value: { exitCode: number | null; transportClosed?: boolean },
  ): void {
    const settle = route.settleWait;
    route.settleWait = () => {};
    settle(value);
  }

  // Read the worker session identifier from an open reply, but only when the
  // route can still bind. Return null for a malformed reply, or for a route that
  // already left `opening` or terminalized. A late or a duplicate reply never
  // binds, revives, or reopens a route.
  function readBindableWorkerSessionId(
    route: { state: RouteState; terminalized: boolean },
    openResult: unknown,
  ): string | null {
    const workerSessionId = readNonEmptyString(
      isRecord(openResult) ? openResult.workerSessionId : null,
    );
    if (!workerSessionId || route.state !== "opening" || route.terminalized) {
      return null;
    }
    return workerSessionId;
  }

  type LoginPtyRouteState = RouteState;

  // One pre-bind login pseudo-terminal record: an output chunk or an exit,
  // normalized to a narrow scalar shape (never the raw notification object).
  interface LoginPtyPreBindOutputRecord {
    kind: "output";
    workerSessionId: string;
    chunk: string;
  }

  interface LoginPtyPreBindExitRecord {
    kind: "exit";
    workerSessionId: string;
    exitCode: number | null;
  }

  type LoginPtyPreBindRecord = LoginPtyPreBindOutputRecord | LoginPtyPreBindExitRecord;

  interface LoginPtyRoute {
    hostRouteId: string;
    state: LoginPtyRouteState;
    workerSessionId: string | null;
    listener: ((chunk: string) => void) | null;
    buffered: string[];
    deliveredChars: number;
    terminalized: boolean;
    settleWait: (value: { exitCode: number | null }) => void;
    // Every output and exit record that arrived before the bind, in arrival order.
    preBind: LoginPtyPreBindRecord[];
    // The cumulative characters `preBind` holds. Each record charges its
    // `workerSessionId` characters, plus the `chunk` characters for an output
    // record.
    preBindChars: number;
  }
  // At most one active credential pseudo-terminal per worker. A non-null route
  // blocks a second open until the manager confirms the first route's close.
  let loginPtyRoute: LoginPtyRoute | null = null;

  // Close the worker terminal by the host route identifier and verify the bound
  // acknowledgement. Return true only when the worker returns an acknowledgement
  // that carries the exact host route identifier. An absent, malformed,
  // mismatched, or timed-out acknowledgement returns false, so the caller fails
  // closed.
  async function closeLoginPtyTerminal(hostRouteId: string): Promise<boolean> {
    try {
      const ack = await callInternal(
        "loginPtyClose",
        { hostRouteId },
        loginPtyCloseTimeoutMs,
      );
      return isRecord(ack) && readNonEmptyString(ack.hostRouteId) === hostRouteId;
    } catch {
      return false;
    }
  }

  // Terminalize the route exactly once. Resolve the login wait, close the worker
  // terminal by the host route identifier, and free the per-worker slot only
  // after the close resolves. Retire the worker when the close is unconfirmed.
  async function terminalizeLoginPtyRoute(route: LoginPtyRoute): Promise<void> {
    if (route.terminalized) return;
    route.terminalized = true;
    route.state = "closed";
    route.listener = null;
    route.buffered = [];
    // A terminalized route never replays a queued pre-bind record.
    route.preBind = [];
    route.preBindChars = 0;
    // A terminalized route reports a null exit code, which the runner treats as a
    // failure.
    settleRouteWait(route, { exitCode: null });
    const confirmed = await closeLoginPtyTerminal(route.hostRouteId);
    if (loginPtyRoute === route) loginPtyRoute = null;
    if (!confirmed) {
      // The worker did not acknowledge the close, so the host cannot prove the
      // terminal is gone. Fail closed: retire the worker before any reuse.
      log.error(
        { pluginId },
        "login pseudo-terminal close not acknowledged; retiring worker",
      );
      void killProcess();
    }
  }

  // Route one login pseudo-terminal output notification to the per-session
  // listener. Deliver only while the route is `open` and the notification carries
  // the exact bound worker session identifier and valid bounded bytes. Queue the
  // notification while the route is still `opening`. Drop an unknown, late,
  // malformed, or mismatched notification. Never log the raw bytes.
  function routeLoginPtyOutput(notification: JsonRpcNotification): void {
    const route = loginPtyRoute;
    if (!route) return;
    if (route.state === "opening") {
      queuePreBindLoginPtyOutput(route, notification);
      return;
    }
    if (route.state !== "open") return;
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId || workerSessionId !== route.workerSessionId) return;
    const chunk = params.chunk;
    if (
      typeof chunk !== "string" ||
      chunk.length === 0 ||
      chunk.length > maxLoginPtyChunkChars
    ) {
      return;
    }
    if (route.deliveredChars + chunk.length > maxLoginPtyTotalChars) {
      // The cumulative output passed the per-route bound. Terminalize the route.
      void terminalizeLoginPtyRoute(route);
      return;
    }
    route.deliveredChars += chunk.length;
    if (route.listener) route.listener(chunk);
    else route.buffered.push(chunk);
  }

  // Route one login pseudo-terminal exit notification to the login wait. Resolve
  // only while the route is `open` and the notification carries the exact bound
  // worker session identifier. Queue the notification while the route is still
  // `opening`. A resolved exit moves the state off `open`, so a later record —
  // live or replayed — finds a closed route and drops there.
  function routeLoginPtyExit(notification: JsonRpcNotification): void {
    const route = loginPtyRoute;
    if (!route) return;
    if (route.state === "opening") {
      queuePreBindLoginPtyExit(route, notification);
      return;
    }
    if (route.state !== "open") return;
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId || workerSessionId !== route.workerSessionId) return;
    const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
    route.state = "closed";
    settleRouteWait(route, { exitCode });
  }

  // Queue one login pseudo-terminal output notification that arrived before the
  // bind, in arrival order. Terminalize the route fail-closed on a frame-count
  // or character-bound breach. Never log the raw chunk.
  function queuePreBindLoginPtyOutput(
    route: LoginPtyRoute,
    notification: JsonRpcNotification,
  ): void {
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    const chunk = params.chunk;
    if (
      !workerSessionId ||
      typeof chunk !== "string" ||
      chunk.length === 0 ||
      chunk.length > maxLoginPtyChunkChars
    ) {
      return;
    }
    // Charge the record's full retained size: the worker session identifier
    // plus the chunk. A record that retains only the identifier still counts.
    const recordChars = workerSessionId.length + chunk.length;
    if (
      route.preBind.length + 1 > maxLoginPtyPreBindFrames ||
      route.preBindChars + recordChars > maxLoginPtyPreBindChars
    ) {
      log.warn(
        { pluginId },
        "login pseudo-terminal pre-bind queue exceeded a bound; terminalizing route",
      );
      void terminalizeLoginPtyRoute(route);
      return;
    }
    route.preBind.push({ kind: "output", workerSessionId, chunk });
    route.preBindChars += recordChars;
  }

  // Queue one login pseudo-terminal exit notification that arrived before the
  // bind, in the same queue the output records use. An exit record carries no
  // chunk, but it still retains a worker session identifier, so it charges
  // against the character bound too.
  function queuePreBindLoginPtyExit(
    route: LoginPtyRoute,
    notification: JsonRpcNotification,
  ): void {
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId) return;
    const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
    const recordChars = workerSessionId.length;
    if (
      route.preBind.length + 1 > maxLoginPtyPreBindFrames ||
      route.preBindChars + recordChars > maxLoginPtyPreBindChars
    ) {
      log.warn(
        { pluginId },
        "login pseudo-terminal pre-bind queue exceeded a bound; terminalizing route",
      );
      void terminalizeLoginPtyRoute(route);
      return;
    }
    route.preBind.push({ kind: "exit", workerSessionId, exitCode });
    route.preBindChars += recordChars;
  }

  // Replay the records a route held before it bound, in arrival order,
  // through the same live router the open route uses (`routeLoginPtyOutput`,
  // `routeLoginPtyExit`), so a forged worker session identifier still fails
  // the exact-match gate and a replayed exit still closes the route and
  // drops every record behind it.
  function replayPreBindLoginPtyRecords(route: LoginPtyRoute): void {
    const held = route.preBind;
    route.preBind = [];
    route.preBindChars = 0;
    for (const record of held) {
      if (route.terminalized) return;
      if (record.kind === "output") {
        routeLoginPtyOutput({
          jsonrpc: "2.0",
          method: LOGIN_PTY_OUTPUT_NOTIFICATION,
          params: { workerSessionId: record.workerSessionId, chunk: record.chunk },
        });
      } else {
        routeLoginPtyExit({
          jsonrpc: "2.0",
          method: LOGIN_PTY_EXIT_NOTIFICATION,
          params: { workerSessionId: record.workerSessionId, exitCode: record.exitCode },
        });
      }
    }
  }

  // Close the one route on a worker exit. The worker is gone, so the manager
  // resolves the login wait with the fixed non-secret exit and clears the route
  // one time. The pending pseudo-terminal calls reject through `rejectAllPending`.
  function closeLoginPtyRouteOnWorkerExit(): void {
    const route = loginPtyRoute;
    if (!route) return;
    loginPtyRoute = null;
    route.terminalized = true;
    route.state = "closed";
    route.listener = null;
    route.buffered = [];
    route.preBind = [];
    route.preBindChars = 0;
    settleRouteWait(route, { exitCode: null });
  }

  // Open one live login pseudo-terminal route. Reserve the route
  // before the open call, bind the worker session identifier one time on the
  // first successful open reply, and return a session the login transport drives.
  // Terminalize the route on every open failure path.
  async function openLoginPtySession(
    input: LoginPtyOpenInput,
  ): Promise<LoginPtyHostSession> {
    if (!isLoginCommandKey(input.loginCommandKey)) {
      // Allowlist the login command key. Only a key in the closed set may open a
      // sandbox pseudo-terminal. Reject a key outside the set with one fixed
      // non-secret error before the worker call, so a caller cannot select an
      // arbitrary command in the sandbox pseudo-terminal.
      throw new Error(LOGIN_PTY_COMMAND_NOT_ALLOWED);
    }
    // Revalidate the server-controlled session home shape before the worker RPC.
    // The binding validated it at the service boundary; this is the last host gate
    // before the worker call, so a malformed home fails closed here too.
    validateLoginSessionHome(input.sessionHome);
    if (loginPtyRoute) {
      // A route for this worker is not yet closed and confirmed. Reject the
      // second open with one fixed non-secret error before it reaches the worker.
      throw new Error(LOGIN_PTY_ROUTE_BUSY);
    }
    const hostRouteId = randomUUID();
    let settleWait: (value: { exitCode: number | null }) => void = () => {};
    const waitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      settleWait = resolve;
    });
    const route: LoginPtyRoute = {
      hostRouteId,
      state: "reserved",
      workerSessionId: null,
      listener: null,
      buffered: [],
      deliveredChars: 0,
      terminalized: false,
      settleWait,
      preBind: [],
      preBindChars: 0,
    };
    loginPtyRoute = route;

    route.state = "opening";
    let openResult: HostToWorkerMethods["loginPtyOpen"][1];
    try {
      openResult = await callInternal(
        "loginPtyOpen",
        {
          hostRouteId,
          driverKey: input.driverKey,
          companyId: input.companyId,
          environmentId: input.environmentId,
          providerLeaseId: input.providerLeaseId,
          loginCommandKey: input.loginCommandKey,
          sessionHome: input.sessionHome,
        },
        loginPtyOpenTimeoutMs,
      );
    } catch (err) {
      // A send failure, an RPC rejection, or an open timeout. Terminalize the
      // route exactly once and fail closed.
      await terminalizeLoginPtyRoute(route);
      throw err instanceof Error ? err : new Error(LOGIN_PTY_OPEN_FAILED);
    }

    const workerSessionId = readBindableWorkerSessionId(route, openResult);
    if (!workerSessionId) {
      // A malformed reply, or a route that already left `opening`. A late or a
      // duplicate reply never binds, revives, or reopens a route.
      await terminalizeLoginPtyRoute(route);
      throw new Error(LOGIN_PTY_OPEN_FAILED);
    }
    // Bind the worker session identifier one time and move the route to `open`.
    route.workerSessionId = workerSessionId;
    route.state = "open";
    // Replay every record the route queued before the bind, in arrival order.
    replayPreBindLoginPtyRecords(route);

    return {
      onData(listener: (chunk: string) => void): void {
        route.listener = listener;
        if (route.buffered.length > 0) {
          const pending = route.buffered;
          route.buffered = [];
          for (const chunk of pending) listener(chunk);
        }
      },
      write(data: string): void {
        const sid = route.workerSessionId;
        if (route.state !== "open" || !sid) return;
        void callInternal(
          "loginPtyInput",
          { workerSessionId: sid, data },
          loginPtyOpenTimeoutMs,
        ).catch(() => {});
      },
      wait(): Promise<{ exitCode: number | null }> {
        return waitPromise;
      },
      kill(): void {
        const sid = route.workerSessionId;
        if (!sid) return;
        void callInternal(
          "loginPtyStop",
          { workerSessionId: sid },
          loginPtyOpenTimeoutMs,
        ).catch(() => {});
      },
      async close(): Promise<void> {
        await terminalizeLoginPtyRoute(route);
      },
    };
  }

  // -----------------------------------------------------------------------
  // Host-owned generic duplex channel route
  // -----------------------------------------------------------------------
  // The duplex channel route mirrors the login pseudo-terminal route model. The
  // host owns the route identifier, binds the worker session identifier one time
  // on a valid open reply, and keys the close on the host route identifier. It
  // rejects a late or a duplicate open reply, and it retires the worker on an
  // unconfirmed close. The duplex channel carries no command allowlist, so the
  // caller owns the command.
  //
  // The route adds seven explicit bounds the pseudo-terminal route lacks. Each
  // bound ends the route when it passes its limit:
  //   1. pre-bind buffered bytes — the cumulative characters the host buffers
  //      before a data listener attaches;
  //   2. pre-bind buffered frame count — the number of data frames the host
  //      buffers before a data listener attaches;
  //   3. pending request count — the number of in-flight host→worker requests;
  //   4. host→worker write size — the characters for one write;
  //   5. protocol error rate — the count of malformed or mismatched data frames;
  //   6. total data bytes — the cumulative inbound bytes over the whole life,
  //      counted before and after a data listener attaches;
  //   7. route lifetime — the milliseconds from the open to the terminal end.

  // One buffered data chunk retained for a late listener drain. It carries the raw
  // chunk bytes.
  interface BufferedDuplexChunk {
    chunk: Uint8Array;
  }
  // One pre-bind data event, normalized to the narrow duplex-event schema. The host
  // retains only these bounded scalar fields, never the original arbitrary
  // notification graph. The bind re-resolves the pair from `workerSessionId`, so a
  // frame whose pair does not match the bound pair still fails closed.
  interface HeldDuplexEvent {
    workerSessionId: string;
    chunk: Uint8Array;
  }
  // One pre-bind exit event, normalized to the narrow duplex-event schema.
  interface HeldDuplexExitEvent {
    workerSessionId: string;
    exitCode: number | null;
    transportClosed?: boolean;
  }

  interface DuplexChannelRoute {
    hostRouteId: string;
    state: RouteState;
    workerSessionId: string | null;
    listener: ((chunk: Uint8Array) => void) | null;
    buffered: BufferedDuplexChunk[];
    bufferedChars: number;
    pendingRequests: number;
    protocolErrors: number;
    totalDataBytes: number;
    lifetimeTimer: ReturnType<typeof setTimeout> | null;
    terminalized: boolean;
    settleWait: (value: { exitCode: number | null; transportClosed?: boolean }) => void;
    // The bounded raw data events that arrived before the bind, held in order. The
    // bind replays them through the exact-pair routing, so an early frame is never
    // lost and a frame whose pair does not match the bound pair still fails closed.
    // The hold ceiling is `maxDuplexChannelPreBindHoldFrames`, one frame above the
    // buffered bound, so the replay's buffered-bound check ends the route, not the
    // hold. The host never retains the original arbitrary notification graph.
    preBind: HeldDuplexEvent[];
    // The cumulative raw bytes `preBind` holds. `DUPLEX_ROUTE_INPUT_MAX_BYTES`
    // bounds this route-local counter, so a worker cannot flood the pre-bind
    // hold with bytes the frame-count ceiling alone does not catch (a handful
    // of large frames, each well under the frame-count limit). This counter
    // covers only the hold; the post-bind buffered queue counts its own bytes
    // in `bufferedChars`, against the same named bound.
    preBindBytes: number;
    // The single bounded exit event that arrived before the bind. An exit never
    // consumes a data hold slot, so a worker that batches an exit among enough data
    // frames to fill the hold cannot crowd out a data frame. The bind replays the
    // held data events first, then this exit last.
    preBindExit: HeldDuplexExitEvent | null;
    // The cumulative raw payload bytes of every host→worker write this route
    // has sent but the worker has not yet acknowledged. The window this
    // counter tracks spans both retained representations of a pending write:
    // the raw payload the pending request object holds, and the serialized
    // child-stdin frame the host builds from it and writes before the request
    // settles. `DUPLEX_ROUTE_PENDING_WRITE_MAX_BYTES` bounds this route-local
    // counter, independent of `pendingRequests`: a worker that never replies
    // cannot make one route hold an unbounded number of write bytes, even
    // under a raised pending-request count. `sendBoundedRequest` increments it
    // before the send and decrements it once the request settles, on every
    // path: a reply, a rejection, a timeout, a worker exit, or a shutdown.
    pendingWriteBytes: number;
  }
  // The live duplex routes on this worker, keyed by the exact
  // `{ hostRouteId, workerSessionId }` pair. The host binds one pair once, at
  // open, and routes each data, exit, and close frame only to the route that owns
  // its exact pair. The host never routes by the worker session id alone.
  const liveDuplexRoutes = new Map<string, DuplexChannelRoute>();
  // The reserved-or-opening routes, keyed by the host route id. A route lives here
  // from the open call until the worker session id binds. The host then moves it
  // to `liveDuplexRoutes` under the exact pair key.
  const openingDuplexRoutes = new Map<string, DuplexChannelRoute>();
  // The tombstoned pairs on this worker, keyed by the exact pair key. The host
  // installs a tombstone atomically when it removes a live binding, and retains it
  // until the worker retires. A late frame for a tombstoned pair reaches no
  // listener. A closed pair never returns.
  const duplexPairTombstones = new Set<string>();

  // The process-scoped aggregate route-slot controller. The manager injects it, so
  // the ceiling counts every duplex route across every worker in the process, not
  // one agent's setting. When it is absent, the worker admits every open, so the
  // handle runs unbounded in isolation (a unit test constructs it this way).
  const duplexRouteSlots = options.duplexRouteSlots ?? null;
  // The routes that currently hold one aggregate slot. The host releases a slot one
  // time per route, so a double terminalize never releases two slots.
  const duplexRouteSlotHolders = new Set<DuplexChannelRoute>();

  // The terminalized routes that still hold buffered bytes for a late listener
  // drain. A terminalized route leaves the opening and live maps, so this registry
  // keeps the worker-exit sweep able to clear its still-buffered representations.
  const terminalDuplexRoutes = new Set<DuplexChannelRoute>();

  // Try to reserve one aggregate route slot for a route. Return true when the
  // route holds a slot after the call. When no controller is present, the route
  // always holds a slot.
  function acquireDuplexRouteSlot(route: DuplexChannelRoute): boolean {
    if (!duplexRouteSlots) return true;
    if (!duplexRouteSlots.tryAcquire()) return false;
    duplexRouteSlotHolders.add(route);
    return true;
  }

  // Release the aggregate route slot a route holds, one time. A route that never
  // held a slot releases nothing.
  function releaseDuplexRouteSlot(route: DuplexChannelRoute): void {
    if (!duplexRouteSlotHolders.delete(route)) return;
    duplexRouteSlots?.release();
  }

  // Retire the worker at once. The host kills the process, so every live route,
  // every reserved route, and every tombstone drops together. The host uses this
  // as the fail-closed response to an ownership violation and to a tombstone-set
  // overflow. The host never logs the raw frame content on a violation.
  function retireDuplexWorkerOnViolation(reason: string): void {
    log.error({ pluginId }, `duplex channel ownership violation (${reason}); retiring worker`);
    void killProcess();
  }

  // Install a tombstone for a bound pair atomically with the removal of its live
  // binding. This runs in one synchronous step, before any slot release or reuse,
  // so a late frame for the pair reaches no listener. Before the set would exceed
  // its hard bound, retire the worker, which drops every route and every tombstone
  // at once. A tombstone overflow fails closed; the host never evicts a tombstone
  // and lets a pair return.
  function tombstoneBoundDuplexPair(route: DuplexChannelRoute): void {
    if (route.workerSessionId === null) return;
    const pairKey = duplexPairKey(route.hostRouteId, route.workerSessionId);
    liveDuplexRoutes.delete(pairKey);
    if (!duplexPairTombstones.has(pairKey)) {
      if (duplexPairTombstones.size >= MAX_DUPLEX_ROUTE_TOMBSTONES) {
        // The set is full. Do not evict a tombstone. Retire the worker, which
        // drops every route and every tombstone together, so no closed pair ever
        // returns.
        retireDuplexWorkerOnViolation("tombstone set overflow");
        return;
      }
      duplexPairTombstones.add(pairKey);
    }
  }

  // Close the worker channel by the host route identifier and verify the bound
  // acknowledgement. Return true only when the worker returns an acknowledgement
  // for the exact pair. Before a session binds, the acknowledgement carries the
  // host route identifier only, so a lost open reply still permits a route-only
  // close. After a session binds, the acknowledgement must echo both the host
  // route identifier and the bound worker session identifier. An absent,
  // malformed, mismatched, or timed-out acknowledgement returns false, so the
  // caller fails closed.
  async function closeDuplexChannelTerminal(
    hostRouteId: string,
    boundWorkerSessionId: string | null,
  ): Promise<boolean> {
    try {
      const ack = await callInternal(
        "duplexChannelClose",
        { hostRouteId },
        duplexChannelCloseTimeoutMs,
      );
      if (!isRecord(ack) || readNonEmptyString(ack.hostRouteId) !== hostRouteId) {
        return false;
      }
      if (boundWorkerSessionId !== null) {
        // A bound close: the acknowledgement must echo the exact worker session
        // identifier. A missing or a mismatched identifier is invalid.
        return readNonEmptyString(ack.workerSessionId) === boundWorkerSessionId;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Terminalize the route exactly once. Resolve the wait, close the worker
  // channel by the host route identifier, and free the per-worker slot only
  // after the close resolves. Retire the worker when the close is unconfirmed.
  // Clear the route lifetime timer one time. Every terminal path and the
  // worker-exit path calls this, so a timer never fires after the route ends.
  function clearDuplexChannelLifetimeTimer(route: DuplexChannelRoute): void {
    if (route.lifetimeTimer) {
      clearTimeout(route.lifetimeTimer);
      route.lifetimeTimer = null;
    }
  }

  async function terminalizeDuplexChannelRoute(route: DuplexChannelRoute): Promise<void> {
    if (route.terminalized) return;
    route.terminalized = true;
    route.state = "closed";
    route.listener = null;
    // Stop admission first. Keep the buffered chunks the host accepted before the
    // route ended, so a listener that attaches after the end still drains them. A
    // frame can end the route during the pre-bind replay, before a listener
    // attaches, and the chunks the host accepted before that frame are valid data
    // the listener must still receive. The buffered bytes stay bounded by the
    // pre-bind buffered bound, and `onData` clears them once it drains them.
    // Register the route in the terminal registry, so the worker-exit sweep can
    // clear the still-buffered chunks later.
    route.preBind = [];
    route.preBindBytes = 0;
    route.preBindExit = null;
    if (route.buffered.length > 0) {
      terminalDuplexRoutes.add(route);
    }
    clearDuplexChannelLifetimeTimer(route);
    // Remove the live binding and install the tombstone in one synchronous step,
    // before the worker close and before any reuse. A reserved route that never
    // bound leaves the opening map only; it has no pair to tombstone, and the
    // monotonic host route id never returns.
    openingDuplexRoutes.delete(route.hostRouteId);
    tombstoneBoundDuplexPair(route);
    releaseDuplexRouteSlot(route);
    // A terminalized route reports a null exit code, which the caller treats as a
    // failure.
    settleRouteWait(route, { exitCode: null });
    const confirmed = await closeDuplexChannelTerminal(route.hostRouteId, route.workerSessionId);
    if (!confirmed) {
      // The worker did not acknowledge the close, so the host cannot prove the
      // channel is gone. Fail closed: retire the worker before any reuse.
      log.error(
        { pluginId },
        "duplex channel close not acknowledged; retiring worker",
      );
      void killProcess();
    }
  }

  // Count one protocol error for the route. End the route when the count passes
  // the per-route budget, so a flood of malformed or mismatched frames bounds the
  // route.
  function recordDuplexChannelProtocolError(route: DuplexChannelRoute): void {
    route.protocolErrors += 1;
    if (route.protocolErrors > maxDuplexChannelProtocolErrors) {
      void terminalizeDuplexChannelRoute(route);
    }
  }

  // Deliver one duplex channel chunk to the bound listener in isolation. A
  // listener that throws must not escape the worker stdout notification handler
  // or the buffered replay, so a throw here breaks neither the notification
  // dispatch loop nor the pre-bind drain. The manager catches the error and logs
  // it without the raw bytes. This mirrors the `execute.log` delivery isolation.
  function deliverDuplexChannelChunk(
    listener: (chunk: Uint8Array) => void,
    chunk: Uint8Array,
  ): void {
    try {
      listener(chunk);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "duplex channel data delivery threw",
      );
    }
  }

  // Route one duplex channel data notification to the per-session listener.
  // Deliver only while the route is `open` and the notification carries the exact
  // bound worker session identifier and a valid chunk. Count a mismatched or
  // malformed frame as a protocol error. End the route at once when one chunk is
  // larger than the per-chunk limit or when the cumulative bytes pass the total
  // cap. Buffer a valid frame under the pre-bind bounds when no listener has
  // attached yet. Never log the raw bytes.
  // Resolve one inbound duplex frame to its owning route by the exact pair. Return
  // the live route on an exact live-pair match. Return `"tombstoned"` for a late
  // frame whose exact pair the host already closed; that frame reaches no listener
  // and changes no state. Return `"violation"` for any unknown, foreign,
  // duplicate, ambiguous, or malformed pair; the caller fails closed and retires
  // the worker. The lookup never routes by the worker session id alone.
  function resolveDuplexRouteByPair(
    hostRouteId: string | null,
    workerSessionId: string | null,
  ): DuplexChannelRoute | "tombstoned" | "opening" | "violation" {
    if (!hostRouteId || !workerSessionId) return "violation";
    const pairKey = duplexPairKey(hostRouteId, workerSessionId);
    const live = liveDuplexRoutes.get(pairKey);
    if (live && live.state === "open") return live;
    if (duplexPairTombstones.has(pairKey)) return "tombstoned";
    // A frame whose host route id names a route that is still opening arrived
    // before the bind. It is the host's own reserved route, not a foreign frame.
    // The caller defers it, so the bind replays it through the exact-pair routing.
    if (openingDuplexRoutes.has(hostRouteId)) return "opening";
    return "violation";
  }

  // Route one duplex channel data frame. On a live route with a listener, deliver
  // the chunk transiently. On a live route with no listener, buffer the chunk.
  function routeDuplexChannelData(notification: JsonRpcNotification): void {
    const params = isRecord(notification.params) ? notification.params : {};
    const hostRouteId = readNonEmptyString(params.hostRouteId);
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    const resolved = resolveDuplexRouteByPair(hostRouteId, workerSessionId);
    if (resolved === "tombstoned") {
      // A late frame for a closed pair. It reaches no listener and changes no
      // state. A bind replay never lands here, because the replayed route is live;
      // a carried token stays on its route and the terminal cleanup releases it.
      // Never log the raw frame content.
      return;
    }
    if (resolved === "violation") {
      // An unknown, foreign, duplicate, ambiguous, or malformed pair. Fail closed:
      // retire the worker. Never log the raw frame content.
      retireDuplexWorkerOnViolation("data frame pair");
      return;
    }
    if (resolved === "opening") {
      // The frame arrived before the bind. A replay never lands here, because the
      // route is live during replay. Hold the live frame; the bind replays it.
      bufferPreBindDuplexFrame(hostRouteId, notification);
      return;
    }
    const route = resolved;
    // The wire carries the chunk as a base64 string (JSON has no binary type; see
    // `ChannelBytesWireValue` in protocol.ts). Decode it back to raw bytes before
    // any bound check, so every bound below counts real bytes, not base64 text.
    // A bind replay (`replayPreBindDuplexFrames`) reuses this function with a
    // held event whose chunk the host already decoded once; it carries the
    // already-decoded `Uint8Array` straight through with no second decode.
    const rawChunk = params.chunk;
    const chunk = rawChunk instanceof Uint8Array ? rawChunk : decodeChannelBytes(rawChunk);
    if (chunk === null || chunk.byteLength === 0) {
      // The exact pair matches, but the chunk is malformed or empty. Count one
      // per-route protocol error.
      recordDuplexChannelProtocolError(route);
      return;
    }
    if (chunk.byteLength > maxDuplexChannelChunkChars) {
      // One inbound chunk is larger than the per-chunk limit. End the route at
      // once. Do not count the chunk as a protocol error.
      void terminalizeDuplexChannelRoute(route);
      return;
    }
    // Enforce the cumulative total-byte cap before and after a listener attaches.
    // End the route when the cap is exceeded, so a bound listener cannot receive
    // data past the cap.
    const chunkBytes = chunk.byteLength;
    if (route.totalDataBytes + chunkBytes > maxDuplexChannelTotalDataBytes) {
      void terminalizeDuplexChannelRoute(route);
      return;
    }
    route.totalDataBytes += chunkBytes;
    if (route.listener) {
      // A listener is attached. Deliver the chunk transiently.
      deliverDuplexChannelChunk(route.listener, chunk);
      return;
    }
    // No listener attached yet. Buffer the frame under the pre-bind bounds. End
    // the route when the cumulative bytes or the frame count passes the bound.
    if (
      route.buffered.length + 1 > maxDuplexChannelPreBindFrames ||
      route.bufferedChars + chunk.length > maxDuplexChannelPreBindChars
    ) {
      void terminalizeDuplexChannelRoute(route);
      return;
    }
    route.buffered.push({ chunk });
    route.bufferedChars += chunk.length;
  }

  // Route one duplex channel exit notification to the wait. Resolve only while
  // the route is `open` and the notification carries the exact bound worker
  // session identifier.
  function routeDuplexChannelExit(notification: JsonRpcNotification): void {
    const params = isRecord(notification.params) ? notification.params : {};
    const hostRouteId = readNonEmptyString(params.hostRouteId);
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    const resolved = resolveDuplexRouteByPair(hostRouteId, workerSessionId);
    if (resolved === "tombstoned") {
      // A late exit for a closed pair. It reaches no wait and changes no state.
      return;
    }
    if (resolved === "violation") {
      // An unknown, foreign, duplicate, ambiguous, or malformed pair. Fail closed:
      // retire the worker.
      retireDuplexWorkerOnViolation("exit frame pair");
      return;
    }
    if (resolved === "opening") {
      // The exit arrived before the bind. Hold it; the bind replays it through the
      // exact-pair routing.
      bufferPreBindDuplexFrame(hostRouteId, notification);
      return;
    }
    const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
    // A reason-less transport close carries `transportClosed`; a real process exit
    // does not. Carry the discriminator to the wait only when it is a transport
    // close, so a real exit keeps the plain `{ exitCode }` result and the broker
    // still keeps the two apart in the loss taxonomy.
    if (params.transportClosed === true) {
      settleRouteWait(resolved, { exitCode, transportClosed: true });
      return;
    }
    settleRouteWait(resolved, { exitCode });
  }

  // Hold one frame that arrived before its route bound, in order. The bind replays
  // the held frames through the exact-pair routing. An exit frame never consumes a
  // data hold slot; the host holds it in the single `preBindExit` slot instead, so
  // a worker that batches an exit among enough data frames to fill the hold cannot
  // crowd out a data frame. The data hold ceiling stays one frame above the
  // buffered bound, so the replay's buffered-bound check, not the hold, ends the
  // route. The host counts one protocol error for each data frame past the ceiling,
  // so an early flood bounds the hold instead of growing without limit.
  function bufferPreBindDuplexFrame(
    hostRouteId: string | null,
    notification: JsonRpcNotification,
  ): void {
    if (!hostRouteId) return;
    const route = openingDuplexRoutes.get(hostRouteId);
    if (!route) return;
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId) {
      // A malformed pair. Count one per-route protocol error and hold nothing.
      recordDuplexChannelProtocolError(route);
      return;
    }
    if (notification.method === DUPLEX_CHANNEL_EXIT_NOTIFICATION) {
      // Normalize the exit to the narrow duplex-event schema. A replaced exit
      // simply overwrites the earlier held exit.
      const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
      route.preBindExit = {
        workerSessionId,
        exitCode,
        ...(params.transportClosed === true ? { transportClosed: true } : {}),
      };
      return;
    }
    // A data event. Validate and normalize it to the narrow duplex-event schema
    // before any retention. The wire carries the chunk as base64; decode it back
    // to raw bytes before any bound check or retention.
    const chunk = decodeChannelBytes(params.chunk);
    if (chunk === null || chunk.byteLength === 0) {
      recordDuplexChannelProtocolError(route);
      return;
    }
    if (route.preBind.length >= maxDuplexChannelPreBindHoldFrames) {
      recordDuplexChannelProtocolError(route);
      return;
    }
    // The route-local input bound covers the pre-bind hold directly. A handful
    // of large frames can pass the frame-count ceiling above while still
    // flooding the host with bytes, so this route ends at once on the byte
    // bound, the same way the post-bind buffered queue already does.
    if (route.preBindBytes + chunk.byteLength > maxDuplexChannelPreBindChars) {
      void terminalizeDuplexChannelRoute(route);
      return;
    }
    route.preBind.push({ workerSessionId, chunk });
    route.preBindBytes += chunk.byteLength;
  }

  // Replay the frames a route held before it bound. The route is live now, so the
  // exact-pair routing delivers each held frame or fails closed on a mismatch.
  // Replay the held data frames first, in order, then the held exit last, so the
  // data delivers before the exit resolves the wait, which matches a real worker's
  // order. A frame that ends the route terminalizes it, and every later frame in
  // the replay is a no-op, because the routing functions drop a frame for a route
  // that is not `open`.
  function replayPreBindDuplexFrames(route: DuplexChannelRoute): void {
    const held = route.preBind;
    route.preBind = [];
    route.preBindBytes = 0;
    for (const event of held) {
      if (route.terminalized) {
        // The route ended mid-replay. The remaining held events are dropped.
        continue;
      }
      // Reconstruct a transient data notification for the exact-pair routing. The
      // host holds only the bounded event, so it builds this notification for the
      // routing step and discards it at once.
      routeDuplexChannelData({
        jsonrpc: "2.0",
        method: DUPLEX_CHANNEL_DATA_NOTIFICATION,
        params: {
          hostRouteId: route.hostRouteId,
          workerSessionId: event.workerSessionId,
          chunk: event.chunk,
        },
      });
    }
    const heldExit = route.preBindExit;
    route.preBindExit = null;
    if (heldExit) {
      // Resolve the wait through the exact-pair routing when the route still lives.
      if (!route.terminalized) {
        routeDuplexChannelExit({
          jsonrpc: "2.0",
          method: DUPLEX_CHANNEL_EXIT_NOTIFICATION,
          params: {
            hostRouteId: route.hostRouteId,
            workerSessionId: heldExit.workerSessionId,
            exitCode: heldExit.exitCode,
            ...(heldExit.transportClosed === true ? { transportClosed: true } : {}),
          },
        });
      }
    }
  }

  // Close every route on a worker exit. The worker is gone, so the manager
  // resolves each wait with the fixed non-secret exit, releases each aggregate
  // slot, and clears the live, opening, and tombstone state. A worker exit is a
  // worker retirement, so the host drops every tombstone; the monotonic host route
  // id never returns, so no closed pair can revive on a restart. The pending
  // channel calls reject through `rejectAllPending`.
  function closeDuplexChannelRouteOnWorkerExit(): void {
    // Enumerate the opening index, the live index, and the terminal registry. A
    // terminalized route left the opening and live maps but may still hold buffered
    // bytes for a late listener; the worker is gone, so the host releases them now.
    const routes = [
      ...openingDuplexRoutes.values(),
      ...liveDuplexRoutes.values(),
      ...terminalDuplexRoutes,
    ];
    openingDuplexRoutes.clear();
    liveDuplexRoutes.clear();
    duplexPairTombstones.clear();
    for (const route of routes) {
      if (!route.terminalized) {
        route.terminalized = true;
        route.state = "closed";
        route.listener = null;
        route.bufferedChars = 0;
        clearDuplexChannelLifetimeTimer(route);
        releaseDuplexRouteSlot(route);
        settleRouteWait(route, { exitCode: null });
      }
      // Clear the route's retained buffers, exactly once. A route already drained
      // by a late listener holds nothing, so this is harmless.
      route.preBind = [];
      route.preBindBytes = 0;
      route.preBindExit = null;
      route.buffered = [];
      route.bufferedChars = 0;
      terminalDuplexRoutes.delete(route);
    }
    // Clear the terminal registry. Every route in it was just discarded above.
    terminalDuplexRoutes.clear();
  }

  // Open one live generic duplex channel route. Reserve the route before the open
  // call, bind the worker session identifier one time on the first successful
  // open reply, and return a session a caller drives. Terminalize the route on
  // every open failure path.
  async function openDuplexChannel(
    input: DuplexChannelOpenInput,
  ): Promise<DuplexChannelHostSession> {
    const hostRouteId = nextDuplexHostRouteId();
    let settleWait: (value: { exitCode: number | null; transportClosed?: boolean }) => void =
      () => {};
    const waitPromise = new Promise<{ exitCode: number | null; transportClosed?: boolean }>(
      (resolve) => {
        settleWait = resolve;
      },
    );
    const route: DuplexChannelRoute = {
      hostRouteId,
      state: "reserved",
      workerSessionId: null,
      listener: null,
      buffered: [],
      bufferedChars: 0,
      pendingRequests: 0,
      protocolErrors: 0,
      totalDataBytes: 0,
      lifetimeTimer: null,
      terminalized: false,
      settleWait,
      preBind: [],
      preBindBytes: 0,
      preBindExit: null,
      pendingWriteBytes: 0,
    };
    // Reserve one aggregate route slot before any work. When the process-scoped
    // ceiling is full, reject with the fixed route-busy error and open nothing, so
    // an active channel never downgrades and the ceiling never overcommits.
    if (!acquireDuplexRouteSlot(route)) {
      throw new Error(DUPLEX_CHANNEL_ROUTE_BUSY);
    }
    openingDuplexRoutes.set(hostRouteId, route);

    route.state = "opening";
    let openResult: HostToWorkerMethods["duplexChannelOpen"][1];
    try {
      openResult = await callInternal(
        "duplexChannelOpen",
        {
          hostRouteId,
          driverKey: input.driverKey,
          companyId: input.companyId,
          environmentId: input.environmentId,
          providerLeaseId: input.providerLeaseId,
          command: input.command,
        },
        duplexChannelOpenTimeoutMs,
      );
    } catch (err) {
      // A send failure, an RPC rejection, or an open timeout. Terminalize the
      // route exactly once and fail closed.
      await terminalizeDuplexChannelRoute(route);
      throw err instanceof Error ? err : new Error(DUPLEX_CHANNEL_OPEN_FAILED);
    }

    const workerSessionId = readBindableWorkerSessionId(route, openResult);
    // Verify the worker echoed the exact host route id the open request carried.
    // A reply with a missing or a mismatched host route id never binds, so the
    // host binds only a reply that proves the worker holds the exact pair.
    const echoedHostRouteId = isRecord(openResult)
      ? readNonEmptyString(openResult.hostRouteId)
      : null;
    if (!workerSessionId || echoedHostRouteId !== hostRouteId) {
      // A malformed reply, a mismatched host route id, or a route that already
      // left `opening`. A late or a duplicate reply never binds, revives, or
      // reopens a route.
      await terminalizeDuplexChannelRoute(route);
      throw new Error(DUPLEX_CHANNEL_OPEN_FAILED);
    }
    const pairKey = duplexPairKey(hostRouteId, workerSessionId);
    if (liveDuplexRoutes.has(pairKey) || duplexPairTombstones.has(pairKey)) {
      // The worker returned a pair that is already live or already tombstoned. Fail
      // closed: terminalize this route and retire the worker before any reuse.
      await terminalizeDuplexChannelRoute(route);
      retireDuplexWorkerOnViolation("duplicate bound pair");
      throw new Error(DUPLEX_CHANNEL_OPEN_FAILED);
    }
    // Bind the worker session identifier one time and move the route from the
    // opening map to the live map under the exact pair key.
    route.workerSessionId = workerSessionId;
    route.state = "open";
    openingDuplexRoutes.delete(hostRouteId);
    liveDuplexRoutes.set(pairKey, route);

    // Start the route lifetime timer now the route is open. The route ends when
    // the timer expires. Every terminal path and the worker-exit path clears the
    // timer. Unreference the timer so it never blocks the host process shutdown.
    route.lifetimeTimer = setTimeout(() => {
      void terminalizeDuplexChannelRoute(route);
    }, maxDuplexChannelDurationMs);
    route.lifetimeTimer.unref?.();

    // Replay any frame that arrived before the bind. The route is live now, so the
    // exact-pair routing delivers each held frame or fails closed on a mismatch.
    replayPreBindDuplexFrames(route);

    // Send one host→worker request under the pending-request bound. End the route
    // when too many requests are in-flight, so a worker that never replies cannot
    // make the host hold an unbounded number of pending requests.
    const sendBoundedRequest = <
      M extends "duplexChannelWrite" | "duplexChannelStop",
    >(
      method: M,
      params: HostToWorkerMethods[M][0],
      // The exact raw byte count of a `duplexChannelWrite` payload, before base64
      // encoding. The caller supplies it: `params.data` on the wire is the base64
      // form (`ChannelBytesWireValue`), so its string length no longer equals the
      // real payload bytes. A stop request carries no payload and omits this.
      writeByteCount?: number,
    ): void => {
      if (route.state !== "open") return;
      if (route.pendingRequests >= maxDuplexChannelPendingRequests) {
        void terminalizeDuplexChannelRoute(route);
        return;
      }
      // The route-local pending-write byte bound: a worker that never replies
      // cannot make one route hold an unbounded number of write bytes, even
      // under a raised pending-request count. A stop request carries no
      // payload, so it never counts against this bound.
      const pendingWriteBytesToCharge = method === "duplexChannelWrite" ? writeByteCount ?? 0 : 0;
      if (route.pendingWriteBytes + pendingWriteBytesToCharge > maxDuplexRoutePendingWriteBytes) {
        void terminalizeDuplexChannelRoute(route);
        return;
      }
      route.pendingRequests += 1;
      route.pendingWriteBytes += pendingWriteBytesToCharge;
      void callInternal(method, params, duplexChannelOpenTimeoutMs, undefined)
        // A send failure, an RPC rejection, a timeout, or a worker exit ends up
        // here. The route already handles a lost write through its own state
        // (a worker exit or a stop rejects every pending request through the
        // normal call machinery), so this fire-and-forget call swallows the
        // rejection instead of leaving it unhandled.
        .catch(() => {})
        .finally(() => {
          route.pendingRequests -= 1;
          // Release the route-local pending-write bytes one time, after the RPC
          // settles on any path: success, error, timeout, worker exit, or
          // shutdown.
          route.pendingWriteBytes -= pendingWriteBytesToCharge;
        });
    };

    return {
      onData(listener: (chunk: Uint8Array) => void): void {
        route.listener = listener;
        if (route.buffered.length > 0) {
          const pending = route.buffered;
          route.buffered = [];
          route.bufferedChars = 0;
          for (const record of pending) {
            // Deliver each buffered record before the drain proceeds to the next
            // record. A terminal route drains through this same code.
            deliverDuplexChannelChunk(listener, record.chunk);
          }
          // The buffered records are gone, so the route no longer holds terminal
          // bytes for a late listener.
          terminalDuplexRoutes.delete(route);
        }
      },
      write(data: Uint8Array): void {
        const sid = route.workerSessionId;
        if (route.state !== "open" || !sid) return;
        if (data.byteLength > maxDuplexChannelWriteChars) {
          // The write is larger than the size bound. End the route before the
          // write reaches the worker.
          void terminalizeDuplexChannelRoute(route);
          return;
        }
        // Encode the raw bytes to the wire-safe base64 form (JSON carries no
        // binary type) and pass the exact raw byte count separately, so the
        // pending-write byte bound charges the real payload bytes, not the
        // inflated base64 string length.
        sendBoundedRequest(
          "duplexChannelWrite",
          {
            hostRouteId: route.hostRouteId,
            workerSessionId: sid,
            data: encodeChannelBytes(data),
          },
          data.byteLength,
        );
      },
      wait(): Promise<{ exitCode: number | null }> {
        return waitPromise;
      },
      kill(): void {
        const sid = route.workerSessionId;
        if (!sid) return;
        sendBoundedRequest("duplexChannelStop", { hostRouteId: route.hostRouteId, workerSessionId: sid });
      },
      async close(): Promise<void> {
        await terminalizeDuplexChannelRoute(route);
      },
    };
  }

  /**
   * Extract the single company a worker→host call references, mirroring the SDK
   * governed-access gate's own derivation (host-client-factory.ts
   * `requestedCompanyScope`) so a proactive call resolves to exactly the company
   * the gate would require:
   *   - explicit `params.companyId`;
   *   - a company-scoped state key (`scopeKind: "company"` + `scopeId`);
   *   - `events.subscribe`'s `params.filter.companyId` (how the SDK's
   *     `ctx.events.on(name, { companyId }, fn)` issues its subscribe).
   *
   * Returns null whenever the gate treats the call as a wildcard (`companies.list`,
   * a `scopeKind: "company"` key with no `scopeId`) or as referencing no company
   * (instance-scoped state, an unfiltered subscribe). A wildcard is deliberately
   * NOT granted proactively: proactive resolution only ever admits a single,
   * explicit company, never "all". This keeps the resolver and the gate in
   * lockstep in the functional direction (LOOA-693 AC#4 / LOOA-695).
   */
  function referencedCompanyId(method: string, params: unknown): string | null {
    // Gate returns { kind: "all" } for companies.list regardless of params —
    // never a single company — so proactive access declines it here.
    if (method === "companies.list") return null;
    if (!isRecord(params)) return null;
    const direct = readNonEmptyString(params.companyId);
    if (direct) return direct;
    if (params.scopeKind === "company") {
      // scopeId present → that company; absent → wildcard ("all") in the gate,
      // which we never grant proactively → null.
      return readNonEmptyString(params.scopeId);
    }
    if (method === "events.subscribe" && isRecord(params.filter)) {
      return readNonEmptyString(params.filter.companyId);
    }
    return null;
  }

  function contextForWorkerMessage(message: JsonRpcRequest | JsonRpcNotification): WorkerHostCallContext {
    const invocationId = readNonEmptyString(
      (message as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    if (!invocationId) {
      // No host-issued invocation is being echoed. This is a genuinely
      // proactive worker→host call (timer/loop). If it references a company the
      // plugin is authorized to act on proactively, resolve it to that
      // company's scope so the governed-access gate admits it. This never
      // widens access beyond the plugin's configured companies, and only
      // applies when the worker is NOT inside a host-issued invocation (which
      // would carry an id and keep its strict single-company match below).
      const proactiveCompanyId = referencedCompanyId(
        message.method,
        (message as { params?: unknown }).params,
      );
      if (proactiveCompanyId && proactiveCompanyScopes.has(proactiveCompanyId)) {
        return { invocationScope: { companyId: proactiveCompanyId } };
      }
      const hasActiveInvocation = activeInvocations.size > 0 ||
        Array.from(pendingRequests.values()).some((pending) => pending.invocationId);
      return hasActiveInvocation ? { invalidInvocationScope: true } : {};
    }
    const entry = activeInvocations.get(invocationId);
    if (!entry) return { invalidInvocationScope: true };
    return { invocationScope: entry.scope, traceparent: entry.traceparent };
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method as WorkerToHostMethodName;
    const handler = options.hostHandlers[method] as
      | ((params: unknown, context?: WorkerHostCallContext) => Promise<unknown>)
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
      const result = await handler(request.params, contextForWorkerMessage(request));
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
            errorCodeForWorkerHostError(err),
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

    // Execute-log notifications: deliver one incremental output chunk to the
    // host-owned execute route for the active execute call.
    if (notification.method === "execute.log") {
      routeExecuteLogNotification(notification);
      return;
    }

    // Login pseudo-terminal notifications: deliver output
    // and the exit to the one host-owned login route, bound by the worker session
    // identifier while the route is open.
    if (notification.method === LOGIN_PTY_OUTPUT_NOTIFICATION) {
      routeLoginPtyOutput(notification);
      return;
    }
    if (notification.method === LOGIN_PTY_EXIT_NOTIFICATION) {
      routeLoginPtyExit(notification);
      return;
    }

    // Duplex channel notifications: deliver data and the exit to the one
    // host-owned duplex route, bound by the worker session identifier while the
    // route is open.
    if (notification.method === DUPLEX_CHANNEL_DATA_NOTIFICATION) {
      routeDuplexChannelData(notification);
      return;
    }
    if (notification.method === DUPLEX_CHANNEL_EXIT_NOTIFICATION) {
      routeDuplexChannelExit(notification);
      return;
    }

    // Stream notifications: forward to the stream bus via callback
    if (
      notification.method === "streams.open" ||
      notification.method === "streams.emit" ||
      notification.method === "streams.close"
    ) {
      const params = (notification.params ?? {}) as Record<string, unknown>;
      const companyId = String(params.companyId ?? "");
      const context = contextForWorkerMessage(notification);
      if (context.invalidInvocationScope) {
        log.warn(
          { method: notification.method, companyId },
          "dropping plugin stream notification with invalid invocation scope",
        );
        return;
      }
      const allowedCompanyId = context.invocationScope?.companyId;
      if (allowedCompanyId && companyId !== allowedCompanyId) {
        log.warn(
          { method: notification.method, companyId, allowedCompanyId },
          "dropping plugin stream notification outside invocation company scope",
        );
        return;
      }

      // Track open channels so we can emit synthetic close on crash
      if (notification.method === "streams.open") {
        const ch = String(params.channel ?? "");
        if (ch) openStreamChannels.set(ch, companyId);
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
      ...options.env,
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
      PAPERCLIP_PLUGIN_ID: pluginId,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TZ: process.env.TZ ?? "UTC",
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

    // The `error` listener stops an unhandled EPIPE from a child that closed its
    // stdin.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.on("close", () => {});
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

    // Close the one login pseudo-terminal route with a fixed non-secret exit and
    // clear the route one time. The pending pseudo-terminal calls
    // already rejected through `rejectAllPending`.
    closeLoginPtyRouteOnWorkerExit();

    // Close the one duplex channel route the same way. The pending channel calls
    // already rejected through `rejectAllPending`.
    closeDuplexChannelRouteOnWorkerExit();

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
    for (const invocation of activeInvocations.values()) {
      if (invocation.timer) clearTimeout(invocation.timer);
    }
    activeInvocations.clear();
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
    executeLogSink?: ExecuteLogSink,
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
      const timeout = resolveRpcCallTimeoutMs(timeoutMs, rpcTimeoutMs);
      const invocationScope = deriveInvocationScope(method, params);
      const invocation = invocationScope ? registerInvocation(invocationScope) : null;
      // Register the host-owned execute route only for an execute call that
      // carries a log sink. The company id comes from the host-derived
      // invocation scope, never from the worker. This binds the sink to the
      // exact company for the life of the call.
      if (invocation && invocationScope && executeLogSink && method === "environmentExecute") {
        registerExecuteRoute(invocation.id, invocationScope.companyId, executeLogSink);
      }

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
        clearInvocation(invocation);
        clearExecuteRoute(invocation?.id);
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
        invocationId: invocation?.id,
      };

      pendingRequests.set(id, pending);

      try {
        const request = {
          ...createRequest(method, params, id),
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        };
        sendMessage(request);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        clearInvocation(invocation);
        clearExecuteRoute(invocation?.id);
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
      executeLogSink?: ExecuteLogSink,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return callInternal(method, params, timeoutMs, executeLogSink);
    },

    openLoginPtySession(input: LoginPtyOpenInput) {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot open a login pseudo-terminal — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return openLoginPtySession(input);
    },

    openDuplexChannel(input: DuplexChannelOpenInput) {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot open a duplex channel — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return openDuplexChannel(input);
    },

    notify(method: string, params: unknown) {
      if (status !== "running") return;
      const invocationScope = deriveInvocationScope(method, params);
      // Notifications have no response to settle on, so the invocation scope
      // is GC'd by TTL. Call-path invocations are registered without a TTL and
      // cleared on settlement, so they survive arbitrarily long call timeouts.
      const invocation = invocationScope ? registerInvocation(invocationScope, MAX_RPC_TIMEOUT_MS) : null;
      try {
        sendMessage({
          jsonrpc: JSONRPC_VERSION,
          method,
          params,
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        });
      } catch {
        clearInvocation(invocation);
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

    setProactiveCompanyScopes(companyIds: readonly string[]): void {
      proactiveCompanyScopes.clear();
      for (const id of companyIds) {
        const trimmed = readNonEmptyString(id);
        if (trimmed) proactiveCompanyScopes.add(trimmed);
      }
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
   * The process-scoped aggregate ceiling for concurrent duplex channel routes,
   * across every worker in the process. The manager builds one shared slot
   * controller from it and injects it into every worker handle, so one tenant can
   * never exhaust the manager-wide resource. The manager validates it and falls
   * back to {@link DEFAULT_MAX_CONCURRENT_DUPLEX_ROUTES} for an absent or an
   * invalid value. It is not the per-agent `heartbeat.maxConcurrentRuns`, which
   * stays upstream admission only.
   */
  maxConcurrentDuplexRoutes?: number | null;
}

/**
 * The default process-scoped aggregate ceiling for concurrent duplex channel
 * routes. It caps the manager-wide resource, not one agent's run budget. The host
 * reports an explicit route-busy outcome when the ceiling is full.
 *
 * Known aggregate behavior: this ceiling bounds route count only, not
 * retained bytes. Each HTTP/2 bridge route bounds its own retained body
 * bytes to 8,388,608 bytes (see `HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS` in
 * `http2-bridge-server.ts`), so this route ceiling caps the process's
 * aggregate retained body bytes at 128 * 8,388,608 = 1,073,741,824 bytes
 * (1 GiB). This is accepted, known behavior, not a defect: the process
 * tracks no aggregate byte ledger across routes.
 */
export const DEFAULT_MAX_CONCURRENT_DUPLEX_ROUTES = 128;

/**
 * Build one process-scoped aggregate route-slot controller. The controller holds a
 * strictly positive integer ceiling and a live count. `tryAcquire` reserves one
 * slot only when a slot is free, so the count never passes the ceiling.
 */
export function createDuplexRouteSlotController(maxRoutes?: number | null): DuplexRouteSlotController {
  const ceiling =
    typeof maxRoutes === "number" && Number.isInteger(maxRoutes) && maxRoutes > 0
      ? maxRoutes
      : DEFAULT_MAX_CONCURRENT_DUPLEX_ROUTES;
  let active = 0;
  return {
    tryAcquire(): boolean {
      if (active >= ceiling) return false;
      active += 1;
      return true;
    },
    release(): void {
      if (active > 0) active -= 1;
    },
  };
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
  // The one shared, process-scoped aggregate route-slot controller. The manager
  // injects it into every worker handle, so the duplex route ceiling counts every
  // concurrent route across the process, not one agent's setting.
  const duplexRouteSlots = createDuplexRouteSlotController(
    managerOptions?.maxConcurrentDuplexRoutes,
  );

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

      const handle = createPluginWorkerHandle(pluginId, {
        // Inject the shared process-scoped route-slot controller, unless the
        // caller already supplied its own (a test may inject its own).
        duplexRouteSlots,
        ...options,
      });
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

    setProactiveCompanyScopes(pluginId: string, companyIds: readonly string[]): void {
      workers.get(pluginId)?.setProactiveCompanyScopes(companyIds);
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
      executeLogSink?: ExecuteLogSink,
    ): Promise<HostToWorkerMethods[M][1]> {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.call(method, params, timeoutMs, executeLogSink);
    },

    openLoginPtySession(pluginId: string, input: LoginPtyOpenInput) {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.openLoginPtySession(input);
    },
  };
}
