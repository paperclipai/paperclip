/**
 * Worker-side RPC host — runs inside the child process spawned by the host.
 *
 * This module is the worker-side counterpart to the server's
 * `PluginWorkerManager`. It:
 *
 * 1. Reads newline-delimited JSON-RPC 2.0 requests from **stdin**
 * 2. Dispatches them to the appropriate plugin handler (events, jobs, tools, …)
 * 3. Writes JSON-RPC 2.0 responses back on **stdout**
 * 4. Provides a concrete `PluginContext` whose SDK client methods (e.g.
 *    `ctx.state.get()`, `ctx.events.emit()`) send JSON-RPC requests to the
 *    host on stdout and await responses on stdin.
 *
 * ## Message flow
 *
 * ```
 * Host (parent)                          Worker (this module)
 *   |                                        |
 *   |--- request(initialize) ------------->  |  → calls plugin.setup(ctx)
 *   |<-- response(ok:true) ----------------  |
 *   |                                        |
 *   |--- notification(onEvent) ----------->  |  → dispatches to registered handler
 *   |                                        |
 *   |<-- request(state.get) ---------------  |  ← SDK client call from plugin code
 *   |--- response(result) ---------------->  |
 *   |                                        |
 *   |--- request(shutdown) --------------->  |  → calls plugin.onShutdown()
 *   |<-- response(void) ------------------  |
 *   |                                        (process exits)
 * ```
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */

import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

import type { PaperclipPlugin } from "./define-plugin.js";
import type {
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
} from "./define-plugin.js";
import type {
  PluginContext,
  PluginEvent,
  PluginJobContext,
  PluginLauncherRegistration,
  ScopeKey,
  ToolRunContext,
  ToolResult,
  EventFilter,
  AgentSessionEvent,
} from "./types.js";
import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  ConfigChangedParams,
  ValidateConfigParams,
  OnEventParams,
  RunJobParams,
  GetDataParams,
  PerformActionParams,
  ExecuteToolParams,
  WorkerToHostMethodName,
  WorkerToHostMethods,
} from "./protocol.js";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  parseMessage,
  serializeMessage,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  JsonRpcParseError,
  JsonRpcCallError,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for starting the worker-side RPC host.
 */
export interface WorkerRpcHostOptions {
  /**
   * The plugin definition returned by `definePlugin()`.
   *
   * The worker entrypoint should import its plugin and pass it here.
   */
  plugin: PaperclipPlugin;

  /**
   * Input stream to read JSON-RPC messages from.
   * Defaults to `process.stdin`.
   */
  stdin?: NodeJS.ReadableStream;

  /**
   * Output stream to write JSON-RPC messages to.
   * Defaults to `process.stdout`.
   */
  stdout?: NodeJS.WritableStream;

  /**
   * Default timeout (ms) for worker→host RPC calls.
   * Defaults to 30 000 ms.
   */
  rpcTimeoutMs?: number;
}

/**
 * A running worker RPC host instance.
 *
 * Returned by `startWorkerRpcHost()`. Callers (usually just the worker
 * bootstrap) hold a reference so they can inspect status or force-stop.
 */
export interface WorkerRpcHost {
  /** Whether the host is currently running and listening for messages. */
  readonly running: boolean;

  /**
   * Stop the RPC host immediately. Closes readline, rejects pending
   * outbound calls, and does NOT call the plugin's shutdown hook (that
   * should have already been called via the `shutdown` RPC method).
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Internal: event registration
// ---------------------------------------------------------------------------

interface EventRegistration {
  name: string;
  filter?: EventFilter;
  fn: (event: PluginEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for worker→host RPC calls. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// startWorkerRpcHost
// ---------------------------------------------------------------------------

/**
 * Options for runWorker when testing (optional stdio to avoid using process streams).
 * When both stdin and stdout are provided, the "is main module" check is skipped
 * and the host is started with these streams. Used by tests.
 */
export interface RunWorkerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/**
 * Start the worker when this module is the process entrypoint.
 *
 * Call this at the bottom of your worker file so that when the host runs
 * `node dist/worker.js`, the RPC host starts and the process stays alive.
 * When the module is imported (e.g. for re-exports or tests), nothing runs.
 *
 * When `options.stdin` and `options.stdout` are provided (e.g. in tests),
 * the main-module check is skipped and the host is started with those streams.
 *
 * @example
 * ```ts
 * const plugin = definePlugin({ ... });
 * export default plugin;
 * runWorker(plugin, import.meta.url);
 * ```
 */
export function runWorker(
  plugin: PaperclipPlugin,
  moduleUrl: string,
  options?: RunWorkerOptions,
): WorkerRpcHost | void {
  if (
    options?.stdin != null &&
    options?.stdout != null
  ) {
    return startWorkerRpcHost({
      plugin,
      stdin: options.stdin,
      stdout: options.stdout,
    });
  }
  const entry = process.argv[1];
  if (typeof entry !== "string") return;
  const thisFile = path.resolve(fileURLToPath(moduleUrl));
  const entryPath = path.resolve(entry);
  if (thisFile === entryPath) {
    startWorkerRpcHost({ plugin });
  }
}

/**
 * Start the worker-side RPC host.
 *
 * This function is typically called from a thin bootstrap script that is the
 * actual entrypoint of the child process:
 *
 * ```ts
 * // worker-bootstrap.ts
 * import plugin from "./worker.js";
 * import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
 *
 * startWorkerRpcHost({ plugin });
 * ```
 *
 * The host begins listening on stdin immediately. It does NOT call
 * `plugin.definition.setup()` yet — that happens when the host sends the
 * `initialize` RPC.
 *
 * @returns A handle for inspecting or stopping the RPC host
 */
export function startWorkerRpcHost(options: WorkerRpcHostOptions): WorkerRpcHost {
  const { plugin } = options;
  const stdinStream = options.stdin ?? process.stdin;
  const stdoutStream = options.stdout ?? process.stdout;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let running = true;
  let initialized = false;
  let manifest: PaperclipPluginManifestV1 | null = null;
  let currentConfig: Record<string, unknown> = {};

  // Plugin handler registrations (populated during setup())
  const eventHandlers: EventRegistration[] = [];
  const jobHandlers = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const launcherRegistrations = new Map<string, PluginLauncherRegistration>();
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const toolHandlers = new Map<string, {
    declaration: Pick<import("@paperclipai/shared").PluginToolDeclaration, "displayName" | "description" | "parametersSchema">;
    fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;
  }>();

  // Agent session event callbacks (populated by sendMessage, cleared by close)
  const sessionEventCallbacks = new Map<string, (event: AgentSessionEvent) => void>();

  // Pending outbound (worker→host) requests
  const pendingRequests = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextOutboundId = 1;
  const MAX_OUTBOUND_ID = Number.MAX_SAFE_INTEGER - 1;

  // -----------------------------------------------------------------------
  // Outbound messaging (worker → host)
  // -----------------------------------------------------------------------

  function sendMessage(message: unknown): void {
    if (!running) return;
    const serialized = serializeMessage(message as any);
    stdoutStream.write(serialized);
  }

  /**
   * Send a typed JSON-RPC request to the host and await the response.
   */
  function callHost<M extends WorkerToHostMethodName>(
    method: M,
    params: WorkerToHostMethods[M][0],
    timeoutMs?: number,
  ): Promise<WorkerToHostMethods[M][1]> {
    return new Promise<WorkerToHostMethods[M][1]>((resolve, reject) => {
      if (!running) {
        reject(new Error(`Cannot call "${method}" — worker RPC host is not running`));
        return;
      }

      if (nextOutboundId >= MAX_OUTBOUND_ID) {
        nextOutboundId = 1;
      }
      const id = nextOutboundId++;
      const timeout = timeoutMs ?? rpcTimeoutMs;
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
            message: `Worker→host call "${method}" timed out after ${timeout}ms`,
          }),
        );
      }, timeout);

      pendingRequests.set(id, {
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as WorkerToHostMethods[M][1]);
          } else if (isJsonRpcErrorResponse(response)) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer,
      });

      try {
        const request = createRequest(method, params, id);
        sendMessage(request);
      } catch (err) {
        settle(reject, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC notification to the host (fire-and-forget).
   */
  function notifyHost(method: string, params: unknown): void {
    try {
      sendMessage(createNotification(method, params));
    } catch {
      // Swallow — the host may have closed stdin
    }
  }

  // -----------------------------------------------------------------------
  // Build the PluginContext (SDK surface for plugin code)
  // -----------------------------------------------------------------------

  function buildContext(): PluginContext {
    return {
      get manifest() {
        if (!manifest) throw new Error("Plugin context accessed before initialization");
        return manifest;
      },

      config: {
        async get() {
          return callHost("config.get", {} as Record<string, never>);
        },
      },

      events: {
        on(
          name: string,
          filterOrFn: EventFilter | ((event: PluginEvent) => Promise<void>),
          maybeFn?: (event: PluginEvent) => Promise<void>,
        ): () => void {
          let registration: EventRegistration;
          if (typeof filterOrFn === "function") {
            registration = { name, fn: filterOrFn };
          } else {
            if (!maybeFn) throw new Error("Event handler function is required");
            registration = { name, filter: filterOrFn, fn: maybeFn };
          }
          eventHandlers.push(registration);
          // Register subscription on the host so events are forwarded to this worker
          void callHost("events.subscribe", { eventPattern: name, filter: registration.filter ?? null }).catch((err) => {
            notifyHost("log", {
              level: "warn",
              message: `Failed to subscribe to event "${name}" on host: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
          return () => {
            const idx = eventHandlers.indexOf(registration);
            if (idx !== -1) eventHandlers.splice(idx, 1);
          };
        },

        async emit(name: string, companyId: string, payload: unknown): Promise<void> {
          await callHost("events.emit", { name, companyId, payload });
        },
      },

      jobs: {
        register(key: string, fn: (job: PluginJobContext) => Promise<void>): void {
          jobHandlers.set(key, fn);
        },
      },

      launchers: {
        register(launcher: PluginLauncherRegistration): void {
          launcherRegistrations.set(launcher.id, launcher);
        },
      },

      http: {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          const serializedInit: Record<string, unknown> = {};
          if (init) {
            if (init.method) serializedInit.method = init.method;
            if (init.headers) {
              // Normalize headers to a plain object
              if (init.headers instanceof Headers) {
                const obj: Record<string, string> = {};
                init.headers.forEach((v, k) => { obj[k] = v; });
                serializedInit.headers = obj;
              } else if (Array.isArray(init.headers)) {
                const obj: Record<string, string> = {};
                for (const [k, v] of init.headers) obj[k] = v;
                serializedInit.headers = obj;
              } else {
                serializedInit.headers = init.headers;
              }
            }
            if (init.body !== undefined && init.body !== null) {
              serializedInit.body = typeof init.body === "string"
                ? init.body
                : String(init.body);
            }
          }

          const result = await callHost("http.fetch", {
            url,
            init: Object.keys(serializedInit).length > 0 ? serializedInit : undefined,
          });

          // Reconstruct a Response-like object from the serialized result
          return new Response(result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          });
        },
      },

      secrets: {
        async resolve(secretRef: string): Promise<string> {
          return callHost("secrets.resolve", { secretRef });
        },
      },

      activity: {
        async log(entry): Promise<void> {
          await callHost("activity.log", {
            companyId: entry.companyId,
            message: entry.message,
            entityType: entry.entityType,
            entityId: entry.entityId,
            metadata: entry.metadata,
          });
        },
      },

      state: {
        async get(input: ScopeKey): Promise<unknown> {
          return callHost("state.get", {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            namespace: input.namespace,
            stateKey: input.stateKey,
          });
        },

        async set(input: ScopeKey, value: unknown): Promise<void> {
          await callHost("state.set", {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            namespace: input.namespace,
            stateKey: input.stateKey,
            value,
          });
        },

        async delete(input: ScopeKey): Promise<void> {
          await callHost("state.delete", {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            namespace: input.namespace,
            stateKey: input.stateKey,
          });
        },
      },

      entities: {
        async upsert(input) {
          return callHost("entities.upsert", {
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            externalId: input.externalId,
            title: input.title,
            status: input.status,
            data: input.data,
          });
        },

        async list(query) {
          return callHost("entities.list", {
            entityType: query.entityType,
            scopeKind: query.scopeKind,
            scopeId: query.scopeId,
            externalId: query.externalId,
            limit: query.limit,
            offset: query.offset,
          });
        },
      },

      projects: {
        async list(input) {
          return callHost("projects.list", {
            companyId: input.companyId,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(projectId: string, companyId: string) {
          return callHost("projects.get", { projectId, companyId });
        },

        async listWorkspaces(projectId: string, companyId: string) {
          return callHost("projects.listWorkspaces", { projectId, companyId });
        },

        async getPrimaryWorkspace(projectId: string, companyId: string) {
          return callHost("projects.getPrimaryWorkspace", { projectId, companyId });
        },

        async getWorkspaceForIssue(issueId: string, companyId: string) {
          return callHost("projects.getWorkspaceForIssue", { issueId, companyId });
        },
      },

      companies: {
        async list(input) {
          return callHost("companies.list", {
            limit: input?.limit,
            offset: input?.offset,
          });
        },

        async get(companyId: string) {
          return callHost("companies.get", { companyId });
        },
      },

      issues: {
        async list(input) {
          return callHost("issues.list", {
            companyId: input.companyId,
            projectId: input.projectId,
            assigneeAgentId: input.assigneeAgentId,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(issueId: string, companyId: string) {
          return callHost("issues.get", { issueId, companyId });
        },

        async create(input) {
          return callHost("issues.create", {
            companyId: input.companyId,
            projectId: input.projectId,
            goalId: input.goalId,
            parentId: input.parentId,
            inheritExecutionWorkspaceFromIssueId: input.inheritExecutionWorkspaceFromIssueId,
            title: input.title,
            description: input.description,
            priority: input.priority,
            assigneeAgentId: input.assigneeAgentId,
          });
        },

        async update(issueId: string, patch, companyId: string) {
          return callHost("issues.update", {
            issueId,
            patch: patch as Record<string, unknown>,
            companyId,
          });
        },

        async listComments(issueId: string, companyId: string) {
          return callHost("issues.listComments", { issueId, companyId });
        },

        async createComment(issueId: string, body: string, companyId: string, options?: { authorAgentId?: string }) {
          return callHost("issues.createComment", { issueId, body, companyId, authorAgentId: options?.authorAgentId });
        },

        documents: {
          async list(issueId: string, companyId: string) {
            return callHost("issues.documents.list", { issueId, companyId });
          },

          async get(issueId: string, key: string, companyId: string) {
            return callHost("issues.documents.get", { issueId, key, companyId });
          },

          async upsert(input) {
            return callHost("issues.documents.upsert", {
              issueId: input.issueId,
              key: input.key,
              body: input.body,
              companyId: input.companyId,
              title: input.title,
              format: input.format,
              changeSummary: input.changeSummary,
            });
          },

          async delete(issueId: string, key: string, companyId: string) {
            return callHost("issues.documents.delete", { issueId, key, companyId });
          },
        },
      },

      agents: {
        async list(input) {
          return callHost("agents.list", {
            companyId: input.companyId,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(agentId: string, companyId: string) {
          return callHost("agents.get", { agentId, companyId });
        },

        async pause(agentId: string, companyId: string) {
          return callHost("agents.pause", { agentId, companyId });
        },

        async resume(agentId: string, companyId: string) {
          return callHost("agents.resume", { agentId, companyId });
        },

        async invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }) {
          return callHost("agents.invoke", { agentId, companyId, prompt: opts.prompt, reason: opts.reason });
        },

        sessions: {
          async create(agentId: string, companyId: string, opts?: { taskKey?: string; reason?: string }) {
            return callHost("agents.sessions.create", {
              agentId,
              companyId,
              taskKey: opts?.taskKey,
              reason: opts?.reason,
            });
          },

          async list(agentId: string, companyId: string) {
            return callHost("agents.sessions.list", { agentId, companyId });
          },

          async sendMessage(sessionId: string, companyId: string, opts: {
            prompt: string;
            reason?: string;
            onEvent?: (event: AgentSessionEvent) => void;
          }) {
            if (opts.onEvent) {
              sessionEventCallbacks.set(sessionId, opts.onEvent);
            }
            try {
              return await callHost("agents.sessions.sendMessage", {
                sessionId,
                companyId,
                prompt: opts.prompt,
                reason: opts.reason,
              });
            } catch (err) {
              sessionEventCallbacks.delete(sessionId);
              throw err;
            }
          },

          async close(sessionId: string, companyId: string) {
            sessionEventCallbacks.delete(sessionId);
            await callHost("agents.sessions.close", { sessionId, companyId });
          },
        },
      },

      goals: {
        async list(input) {
          return callHost("goals.list", {
            companyId: input.companyId,
            level: input.level,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(goalId: string, companyId: string) {
          return callHost("goals.get", { goalId, companyId });
        },

        async create(input) {
          return callHost("goals.create", {
            companyId: input.companyId,
            title: input.title,
            description: input.description,
            level: input.level,
            status: input.status,
            parentId: input.parentId,
            ownerAgentId: input.ownerAgentId,
          });
        },

        async update(goalId: string, patch, companyId: string) {
          return callHost("goals.update", {
            goalId,
            patch: patch as Record<string, unknown>,
            companyId,
          });
        },
      },

      data: {
        register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
          dataHandlers.set(key, handler);
        },
      },

      actions: {
        register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
          actionHandlers.set(key, handler);
        },
      },

      streams: (() => {
        // Track channel → companyId so emit/close don't require companyId
        const channelCompanyMap = new Map<string, string>();
        return {
          open(channel: string, companyId: string): void {
            channelCompanyMap.set(channel, companyId);
            notifyHost("streams.open", { channel, companyId });
          },
          emit(channel: string, event: unknown): void {
            const companyId = channelCompanyMap.get(channel) ?? "";
            notifyHost("streams.emit", { channel, companyId, event });
          },
          close(channel: string): void {
            const companyId = channelCompanyMap.get(channel) ?? "";
            channelCompanyMap.delete(channel);
            notifyHost("streams.close", { channel, companyId });
          },
        };
      })(),

      tools: {
        register(
          name: string,
          declaration: Pick<import("@paperclipai/shared").PluginToolDeclaration, "displayName" | "description" | "parametersSchema">,
          fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>,
        ): void {
          toolHandlers.set(name, { declaration, fn });
        },
      },

      metrics: {
        async write(name: string, value: number, tags?: Record<string, string>): Promise<void> {
          await callHost("metrics.write", { name, value, tags });
        },
      },

      telemetry: {
        async track(
          eventName: string,
          dimensions?: Record<string, string | number | boolean>,
        ): Promise<void> {
          await callHost("telemetry.track", { eventName, dimensions });
        },
      },

      logger: {
        info(message: string, meta?: Record<string, unknown>): void {
          notifyHost("log", { level: "info", message, meta });
        },
        warn(message: string, meta?: Record<string, unknown>): void {
          notifyHost("log", { level: "warn", message, meta });
        },
        error(message: string, meta?: Record<string, unknown>): void {
          notifyHost("log", { level: "error", message, meta });
        },
        debug(message: string, meta?: Record<string, unknown>): void {
          notifyHost("log", { level: "debug", message, meta });
        },
      },
    };
  }

  const ctx = buildContext();

  // -----------------------------------------------------------------------
  // Inbound message handling (host → worker)
  // -----------------------------------------------------------------------

  /**
   * Handle an incoming JSON-RPC request from the host.
   *
   * Dispatches to the correct handler based on the method name.
   */
  async function handleHostRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      const result = await dispatchMethod(method, params);
      sendMessage(createSuccessResponse(id, result ?? null));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Propagate specific error codes from handler errors (e.g.
      // METHOD_NOT_FOUND, METHOD_NOT_IMPLEMENTED) — fall back to
      // WORKER_ERROR for untyped exceptions.
      const errorCode =
        typeof (err as any)?.code === "number"
          ? (err as any).code
          : PLUGIN_RPC_ERROR_CODES.WORKER_ERROR;

      sendMessage(createErrorResponse(id, errorCode, errorMessage));
    }
  }

  /**
   * Dispatch a host→worker method call to the appropriate handler.
   */
  async function dispatchMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return handleInitialize(params as InitializeParams);

      case "health":
        return handleHealth();

      case "shutdown":
        return handleShutdown();

      case "validateConfig":
        return handleValidateConfig(params as ValidateConfigParams);

      case "configChanged":
        return handleConfigChanged(params as ConfigChangedParams);

      case "onEvent":
        return handleOnEvent(params as OnEventParams);

      case "runJob":
        return handleRunJob(params as RunJobParams);

      case "handleWebhook":
        return handleWebhook(params as PluginWebhookInput);

      case "getData":
        return handleGetData(params as GetDataParams);

      case "performAction":
        return handlePerformAction(params as PerformActionParams);

      case "executeTool":
        return handleExecuteTool(params as ExecuteToolParams);

      default:
        throw Object.assign(
          new Error(`Unknown method: ${method}`),
          { code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND },
        );
    }
  }

  // -----------------------------------------------------------------------
  // Host→Worker method handlers
  // -----------------------------------------------------------------------

  async function handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    if (initialized) {
      throw new Error("Worker already initialized");
    }

    manifest = params.manifest;
    currentConfig = params.config;

    // Call the plugin's setup function
    await plugin.definition.setup(ctx);

    initialized = true;

    // Report which optional methods this plugin implements
    const supportedMethods: string[] = [];
    if (plugin.definition.onValidateConfig) supportedMethods.push("validateConfig");
    if (plugin.definition.onConfigChanged) supportedMethods.push("configChanged");
    if (plugin.definition.onHealth) supportedMethods.push("health");
    if (plugin.definition.onShutdown) supportedMethods.push("shutdown");

    return { ok: true, supportedMethods };
  }

  async function handleHealth(): Promise<PluginHealthDiagnostics> {
    if (plugin.definition.onHealth) {
      return plugin.definition.onHealth();
    }
    // Default: report OK if the worker is alive
    return { status: "ok" };
  }

  async function handleShutdown(): Promise<void> {
    if (plugin.definition.onShutdown) {
      await plugin.definition.onShutdown();
    }

    // Schedule cleanup after we send the response.
    // Use setImmediate to let the response flush before exiting.
    // Only call process.exit() when running with real process streams.
    // When custom streams are provided (tests), just clean up.
    setImmediate(() => {
      cleanup();
      if (!options.stdin && !options.stdout) {
        process.exit(0);
      }
    });
  }

  async function handleValidateConfig(
    params: ValidateConfigParams,
  ): Promise<PluginConfigValidationResult> {
    if (!plugin.definition.onValidateConfig) {
      throw Object.assign(
        new Error("validateConfig is not implemented by this plugin"),
        { code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED },
      );
    }
    return plugin.definition.onValidateConfig(params.config);
  }

  async function handleConfigChanged(params: ConfigChangedParams): Promise<void> {
    currentConfig = params.config;

    if (plugin.definition.onConfigChanged) {
      await plugin.definition.onConfigChanged(params.config);
    }
  }

  async function handleOnEvent(params: OnEventParams): Promise<void> {
    const event = params.event;

    for (const registration of eventHandlers) {
      // Check event type match
      const exactMatch = registration.name === event.eventType;
      const wildcardPluginAll =
        registration.name === "plugin.*" &&
        event.eventType.startsWith("plugin.");
      const wildcardPluginOne =
        registration.name.endsWith(".*") &&
        event.eventType.startsWith(registration.name.slice(0, -1));

      if (!exactMatch && !wildcardPluginAll && !wildcardPluginOne) continue;

      // Check filter
      if (registration.filter && !allowsEvent(registration.filter, event)) continue;

      try {
        await registration.fn(event);
      } catch (err) {
        // Log error but continue processing other handlers so one failing
        // handler doesn't prevent the rest from running.
        notifyHost("log", {
          level: "error",
          message: `Event handler for "${registration.name}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          meta: { eventType: event.eventType, stack: err instanceof Error ? err.stack : undefined },
        });
      }
    }
  }

  async function handleRunJob(params: RunJobParams): Promise<void> {
    const handler = jobHandlers.get(params.job.jobKey);
    if (!handler) {
      throw new Error(`No handler registered for job "${params.job.jobKey}"`);
    }
    await handler(params.job);
  }

  async function handleWebhook(params: PluginWebhookInput): Promise<void> {
    if (!plugin.definition.onWebhook) {
      throw Object.assign(
        new Error("handleWebhook is not implemented by this plugin"),
        { code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED },
      );
    }
    await plugin.definition.onWebhook(params);
  }

  async function handleGetData(params: GetDataParams): Promise<unknown> {
    const handler = dataHandlers.get(params.key);
    if (!handler) {
      throw new Error(`No data handler registered for key "${params.key}"`);
    }
    return handler(
      params.renderEnvironment === undefined
        ? params.params
        : { ...params.params, renderEnvironment: params.renderEnvironment },
    );
  }

  async function handlePerformAction(params: PerformActionParams): Promise<unknown> {
    const handler = actionHandlers.get(params.key);
    if (!handler) {
      throw new Error(`No action handler registered for key "${params.key}"`);
    }
    return handler(
      params.renderEnvironment === undefined
        ? params.params
        : { ...params.params, renderEnvironment: params.renderEnvironment },
    );
  }

  async function handleExecuteTool(params: ExecuteToolParams): Promise<ToolResult> {
    const entry = toolHandlers.get(params.toolName);
    if (!entry) {
      throw new Error(`No tool handler registered for "${params.toolName}"`);
    }
    return entry.fn(params.parameters, params.runContext);
  }

  // -----------------------------------------------------------------------
  // Event filter helper
  // -----------------------------------------------------------------------

  function allowsEvent(filter: EventFilter, event: PluginEvent): boolean {
    const payload = event.payload as Record<string, unknown> | undefined;

    if (filter.companyId !== undefined) {
      const companyId = event.companyId ?? String(payload?.companyId ?? "");
      if (companyId !== filter.companyId) return false;
    }

    if (filter.projectId !== undefined) {
      const projectId = event.entityType === "project"
        ? event.entityId
        : String(payload?.projectId ?? "");
      if (projectId !== filter.projectId) return false;
    }

    if (filter.agentId !== undefined) {
      const agentId = event.entityType === "agent"
        ? event.entityId
        : String(payload?.agentId ?? "");
      if (agentId !== filter.agentId) return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Inbound response handling (host → worker, response to our outbound call)
  // -----------------------------------------------------------------------

  function handleHostResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) return;

    const pending = pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  // -----------------------------------------------------------------------
  // Incoming line handler
  // -----------------------------------------------------------------------

  function handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = parseMessage(line);
    } catch (err) {
      if (err instanceof JsonRpcParseError) {
        // Send parse error response
        sendMessage(
          createErrorResponse(
            null,
            JSONRPC_ERROR_CODES.PARSE_ERROR,
            `Parse error: ${err.message}`,
          ),
        );
      }
      return;
    }

    if (isJsonRpcResponse(message)) {
      // This is a response to one of our outbound worker→host calls
      handleHostResponse(message);
    } else if (isJsonRpcRequest(message)) {
      // This is a host→worker RPC call — dispatch it
      handleHostRequest(message as JsonRpcRequest).catch((err) => {
        // Unhandled error in the async handler — send error response
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorCode = (err as any)?.code ?? PLUGIN_RPC_ERROR_CODES.WORKER_ERROR;
        try {
          sendMessage(
            createErrorResponse(
              (message as JsonRpcRequest).id,
              typeof errorCode === "number" ? errorCode : PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
              errorMessage,
            ),
          );
        } catch {
          // Cannot send response, stdout may be closed
        }
      });
    } else if (isJsonRpcNotification(message)) {
      // Dispatch host→worker push notifications
      const notif = message as { method: string; params?: unknown };
      if (notif.method === "agents.sessions.event" && notif.params) {
        const event = notif.params as AgentSessionEvent;
        const cb = sessionEventCallbacks.get(event.sessionId);
        if (cb) cb(event);
      } else if (notif.method === "onEvent" && notif.params) {
        // Plugin event bus notifications — dispatch to registered event handlers
        handleOnEvent(notif.params as OnEventParams).catch((err) => {
          notifyHost("log", {
            level: "error",
            message: `Failed to handle event notification: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  function cleanup(): void {
    running = false;

    // Close readline
    if (readline) {
      readline.close();
      readline = null;
    }

    // Reject all pending outbound calls
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(
          id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          "Worker RPC host is shutting down",
        ) as JsonRpcResponse,
      );
    }
    pendingRequests.clear();
    sessionEventCallbacks.clear();
  }

  // -----------------------------------------------------------------------
  // Bootstrap: wire up stdin readline
  // -----------------------------------------------------------------------

  let readline: ReadlineInterface | null = createInterface({
    input: stdinStream as NodeJS.ReadableStream,
    crlfDelay: Infinity,
  });

  readline.on("line", handleLine);

  // If stdin closes, we should exit gracefully
  readline.on("close", () => {
    if (running) {
      cleanup();
      if (!options.stdin && !options.stdout) {
        process.exit(0);
      }
    }
  });

  // Handle uncaught errors in the worker process.
  // Only install these when using the real process streams (not in tests
  // where the caller provides custom streams).
  if (!options.stdin && !options.stdout) {
    process.on("uncaughtException", (err) => {
      notifyHost("log", {
        level: "error",
        message: `Uncaught exception: ${err.message}`,
        meta: { stack: err.stack },
      });
      // Give the notification a moment to flush, then exit
      setTimeout(() => process.exit(1), 100);
    });

    process.on("unhandledRejection", (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      notifyHost("log", {
        level: "error",
        message: `Unhandled rejection: ${message}`,
        meta: { stack },
      });
    });
  }

  // -----------------------------------------------------------------------
  // Return the handle
  // -----------------------------------------------------------------------

  return {
    get running() {
      return running;
    },

    stop() {
      cleanup();
    },
  };
}
