import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginCategory,
} from "@paperclipai/shared";
import {
  startWorkerRpcHost,
  runWorker,
  definePlugin,
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import type {
  PaperclipPlugin,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  InitializeParams,
  WorkerRpcHost,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function makeManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "test.plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin",
    categories: ["connector" as PluginCategory],
    capabilities: [
      "events.subscribe" as PluginCapability,
      "plugin.state.read" as PluginCapability,
      "plugin.state.write" as PluginCapability,
      "jobs.schedule" as PluginCapability,
      "agent.tools.register" as PluginCapability,
    ],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

function makeInitializeParams(
  overrides: Partial<InitializeParams> = {},
): InitializeParams {
  return {
    manifest: makeManifest(),
    config: { myKey: "myValue" },
    instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    ...overrides,
  };
}

/**
 * Simulates the host side of the stdio channel.
 *
 * `hostStdin` is what the host writes to → the worker reads from it.
 * `hostStdout` is what the worker writes to → the host reads from it.
 */
class MockStdio {
  /** Stream that the worker reads from (simulates the worker's stdin). */
  workerStdin: PassThrough;
  /** Stream that the worker writes to (simulates the worker's stdout). */
  workerStdout: PassThrough;

  /** Accumulated stdout data for parsing responses. */
  private _outBuffer = "";
  /** Queue of pending output resolvers. */
  private _outWaiters: Array<(data: string) => void> = [];

  constructor() {
    this.workerStdin = new PassThrough();
    this.workerStdout = new PassThrough();

    this.workerStdout.on("data", (chunk: Buffer) => {
      this._outBuffer += chunk.toString();
      this._flushWaiters();
    });
  }

  private _flushWaiters(): void {
    while (this._outWaiters.length > 0 && this._outBuffer.includes("\n")) {
      const idx = this._outBuffer.indexOf("\n");
      const line = this._outBuffer.slice(0, idx);
      this._outBuffer = this._outBuffer.slice(idx + 1);
      const waiter = this._outWaiters.shift()!;
      waiter(line);
    }
  }

  /** Send a JSON-RPC message to the worker (write to worker's stdin). */
  sendToWorker(message: unknown): void {
    this.workerStdin.write(JSON.stringify(message) + "\n");
  }

  /** Read the next complete JSON-RPC message from the worker's stdout. */
  readNextMessage<T = unknown>(): Promise<T> {
    return new Promise((resolve) => {
      if (this._outBuffer.includes("\n")) {
        const idx = this._outBuffer.indexOf("\n");
        const line = this._outBuffer.slice(0, idx);
        this._outBuffer = this._outBuffer.slice(idx + 1);
        resolve(JSON.parse(line) as T);
      } else {
        this._outWaiters.push((line) => resolve(JSON.parse(line) as T));
      }
    });
  }

  /**
   * Send a request to the worker and wait for the response.
   */
  async request<TResult = unknown>(
    id: number,
    method: string,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    this.sendToWorker({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    });
    return this.readNextMessage<JsonRpcResponse>();
  }

  /**
   * Send an initialize request and expect a success response.
   */
  async initialize(params?: Partial<InitializeParams>): Promise<JsonRpcSuccessResponse> {
    const response = await this.request(1, "initialize", makeInitializeParams(params));
    return response as JsonRpcSuccessResponse;
  }

  destroy(): void {
    this.workerStdin.destroy();
    this.workerStdout.destroy();
    this._outWaiters = [];
  }
}

// ---------------------------------------------------------------------------
// Override process.exit for tests so the worker doesn't kill the test process
// ---------------------------------------------------------------------------

let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
});

afterEach(() => {
  processExitSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startWorkerRpcHost", () => {
  let stdio: MockStdio;
  let host: WorkerRpcHost;

  beforeEach(() => {
    stdio = new MockStdio();
  });

  afterEach(() => {
    if (host?.running) {
      host.stop();
    }
    stdio.destroy();
  });

  // -----------------------------------------------------------------------
  // Basic lifecycle
  // -----------------------------------------------------------------------

  describe("basic lifecycle", () => {
    it("starts in running state", () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });
      expect(host.running).toBe(true);
    });

    it("stops when stop() is called", () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });
      host.stop();
      expect(host.running).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Initialize RPC
  // -----------------------------------------------------------------------

  describe("initialize", () => {
    it("calls plugin.setup() and returns ok:true", async () => {
      const setupFn = vi.fn(async () => {});
      const plugin = definePlugin({ setup: setupFn });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      const response = await stdio.initialize();

      expect(response.result).toEqual({ ok: true });
      expect(setupFn).toHaveBeenCalledOnce();
    });

    it("provides the manifest to the plugin context", async () => {
      let receivedManifest: PaperclipPluginManifestV1 | undefined;
      const plugin = definePlugin({
        async setup(ctx) {
          receivedManifest = ctx.manifest;
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      const manifest = makeManifest({ id: "my.awesome.plugin" });
      await stdio.initialize({ manifest });

      expect(receivedManifest).toBeDefined();
      expect(receivedManifest!.id).toBe("my.awesome.plugin");
    });

    it("rejects double initialize", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      // First initialize succeeds
      const res1 = await stdio.initialize();
      expect(res1.result).toEqual({ ok: true });

      // Second initialize fails
      const res2 = await stdio.request(2, "initialize", makeInitializeParams());
      expect((res2 as JsonRpcErrorResponse).error).toBeDefined();
      expect((res2 as JsonRpcErrorResponse).error.message).toContain("already initialized");
    });

    it("returns error if setup() throws", async () => {
      const plugin = definePlugin({
        async setup() {
          throw new Error("Setup failed!");
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      const response = await stdio.request(1, "initialize", makeInitializeParams());
      expect((response as JsonRpcErrorResponse).error).toBeDefined();
      expect((response as JsonRpcErrorResponse).error.message).toContain("Setup failed!");
    });
  });

  // -----------------------------------------------------------------------
  // Health RPC
  // -----------------------------------------------------------------------

  describe("health", () => {
    it("returns default health when onHealth is not implemented", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "health", {});
      expect((response as JsonRpcSuccessResponse).result).toEqual({ status: "ok" });
    });

    it("returns custom health from onHealth()", async () => {
      const plugin = definePlugin({
        async setup() {},
        async onHealth() {
          return { status: "degraded", message: "High load" };
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "health", {});
      expect((response as JsonRpcSuccessResponse).result).toEqual({
        status: "degraded",
        message: "High load",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown RPC
  // -----------------------------------------------------------------------

  describe("shutdown", () => {
    it("calls onShutdown() when implemented", async () => {
      const shutdownFn = vi.fn(async () => {});
      const plugin = definePlugin({
        async setup() {},
        onShutdown: shutdownFn,
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "shutdown", {});
      expect((response as JsonRpcSuccessResponse).result).toBeNull();
      expect(shutdownFn).toHaveBeenCalledOnce();
    });

    it("responds even when onShutdown is not implemented", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "shutdown", {});
      expect((response as JsonRpcSuccessResponse).result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Event dispatching
  // -----------------------------------------------------------------------

  describe("onEvent", () => {
    it("dispatches events to registered handlers", async () => {
      const eventHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", eventHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "onEvent", {
        event: {
          eventId: "evt-1",
          eventType: "issue.created",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: { title: "Bug fix" },
        },
      });

      expect((response as JsonRpcSuccessResponse).result).toBeNull();
      expect(eventHandler).toHaveBeenCalledOnce();
      expect(eventHandler.mock.calls[0][0].eventType).toBe("issue.created");
    });

    it("does not dispatch events that don't match", async () => {
      const eventHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", eventHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      await stdio.request(2, "onEvent", {
        event: {
          eventId: "evt-2",
          eventType: "issue.updated",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });

      expect(eventHandler).not.toHaveBeenCalled();
    });

    it("supports wildcard plugin.* subscriptions", async () => {
      const eventHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          (ctx.events as any).on("plugin.*", eventHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      await stdio.request(2, "onEvent", {
        event: {
          eventId: "evt-3",
          eventType: "plugin.acme.linear.sync-done",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });

      expect(eventHandler).toHaveBeenCalledOnce();
    });

    it("applies event filters", async () => {
      const eventHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", { companyId: "company-1" }, eventHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Should NOT match
      await stdio.request(2, "onEvent", {
        event: {
          eventId: "evt-4",
          eventType: "issue.created",
          companyId: "company-2",
          occurredAt: new Date().toISOString(),
          payload: { companyId: "company-2" },
        },
      });
      expect(eventHandler).not.toHaveBeenCalled();

      // Should match
      await stdio.request(3, "onEvent", {
        event: {
          eventId: "evt-5",
          eventType: "issue.created",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: { companyId: "company-1" },
        },
      });
      expect(eventHandler).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Job dispatching
  // -----------------------------------------------------------------------

  describe("runJob", () => {
    it("dispatches to registered job handler", async () => {
      const jobHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.jobs.register("sync", jobHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "runJob", {
        job: {
          jobKey: "sync",
          runId: "run-1",
          trigger: "schedule",
          scheduledAt: new Date().toISOString(),
        },
      });

      expect((response as JsonRpcSuccessResponse).result).toBeNull();
      expect(jobHandler).toHaveBeenCalledOnce();
      expect(jobHandler.mock.calls[0][0].jobKey).toBe("sync");
    });

    it("returns error for unregistered job key", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "runJob", {
        job: {
          jobKey: "nonexistent",
          runId: "run-2",
          trigger: "manual",
          scheduledAt: new Date().toISOString(),
        },
      });

      expect((response as JsonRpcErrorResponse).error).toBeDefined();
      expect((response as JsonRpcErrorResponse).error.message).toContain("nonexistent");
    });
  });

  // -----------------------------------------------------------------------
  // Tool execution
  // -----------------------------------------------------------------------

  describe("executeTool", () => {
    it("dispatches to registered tool handler", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.tools.register(
            "search",
            { displayName: "Search", description: "Search things", parametersSchema: {} },
            async (params, runCtx) => {
              return {
                content: `Searched for: ${(params as any).query}`,
                data: { agentId: runCtx.agentId },
              };
            },
          );
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "executeTool", {
        toolName: "search",
        parameters: { query: "hello" },
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      });

      const result = (response as JsonRpcSuccessResponse).result as any;
      expect(result.content).toBe("Searched for: hello");
      expect(result.data.agentId).toBe("agent-1");
    });
  });

  // -----------------------------------------------------------------------
  // getData / performAction
  // -----------------------------------------------------------------------

  describe("getData", () => {
    it("dispatches to registered data handler", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.data.register("health", async (params) => {
            return { status: "ok", param: params.foo };
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "getData", {
        key: "health",
        params: { foo: "bar" },
      });

      const result = (response as JsonRpcSuccessResponse).result as any;
      expect(result.status).toBe("ok");
      expect(result.param).toBe("bar");
    });

    it("returns error for unregistered data key", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "getData", {
        key: "unknown",
        params: {},
      });

      expect((response as JsonRpcErrorResponse).error).toBeDefined();
    });
  });

  describe("performAction", () => {
    it("dispatches to registered action handler", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.actions.register("resync", async (params) => {
            return { triggered: true };
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "performAction", {
        key: "resync",
        params: {},
      });

      const result = (response as JsonRpcSuccessResponse).result as any;
      expect(result.triggered).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // validateConfig
  // -----------------------------------------------------------------------

  describe("validateConfig", () => {
    it("calls onValidateConfig when implemented", async () => {
      const plugin = definePlugin({
        async setup() {},
        async onValidateConfig(config) {
          if (!config.apiKey) {
            return { ok: false, errors: ["apiKey is required"] };
          }
          return { ok: true };
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Valid config
      const response1 = await stdio.request(2, "validateConfig", {
        config: { apiKey: "abc" },
      });
      expect((response1 as JsonRpcSuccessResponse).result).toEqual({ ok: true });

      // Invalid config
      const response2 = await stdio.request(3, "validateConfig", {
        config: {},
      });
      expect((response2 as JsonRpcSuccessResponse).result).toEqual({
        ok: false,
        errors: ["apiKey is required"],
      });
    });

    it("returns METHOD_NOT_IMPLEMENTED when not implemented", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "validateConfig", {
        config: {},
      });

      expect((response as JsonRpcErrorResponse).error).toBeDefined();
      expect((response as JsonRpcErrorResponse).error.code).toBe(
        PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      );
    });
  });

  // -----------------------------------------------------------------------
  // configChanged
  // -----------------------------------------------------------------------

  describe("configChanged", () => {
    it("calls onConfigChanged when implemented", async () => {
      const configChangedFn = vi.fn(async () => {});
      const plugin = definePlugin({
        async setup() {},
        onConfigChanged: configChangedFn,
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "configChanged", {
        config: { apiKey: "new-key" },
      });

      expect((response as JsonRpcSuccessResponse).result).toBeNull();
      expect(configChangedFn).toHaveBeenCalledWith({ apiKey: "new-key" });
    });

    it("succeeds silently when onConfigChanged is not implemented", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "configChanged", {
        config: { newSetting: "value" },
      });

      expect((response as JsonRpcSuccessResponse).result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // handleWebhook
  // -----------------------------------------------------------------------

  describe("handleWebhook", () => {
    it("dispatches to onWebhook when implemented", async () => {
      const webhookFn = vi.fn(async () => {});
      const plugin = definePlugin({
        async setup() {},
        onWebhook: webhookFn,
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const webhookInput = {
        endpointKey: "github",
        headers: { "content-type": "application/json" },
        rawBody: '{"action":"push"}',
        parsedBody: { action: "push" },
        requestId: "req-1",
      };

      const response = await stdio.request(2, "handleWebhook", webhookInput);

      expect((response as JsonRpcSuccessResponse).result).toBeNull();
      expect(webhookFn).toHaveBeenCalledWith(webhookInput);
    });

    it("returns METHOD_NOT_IMPLEMENTED when not implemented", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "handleWebhook", {
        endpointKey: "github",
        headers: {},
        rawBody: "",
        requestId: "req-2",
      });

      expect((response as JsonRpcErrorResponse).error.code).toBe(
        PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Worker→Host SDK calls (outbound RPC)
  // -----------------------------------------------------------------------

  describe("worker→host SDK calls", () => {
    it("ctx.state.get sends request to host and returns result", async () => {
      let stateResult: unknown;

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async () => {
            stateResult = await ctx.state.get({
              scopeKind: "instance",
              stateKey: "last-sync",
            });
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Send an event to trigger the handler that calls ctx.state.get
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 100,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-1",
            eventType: "issue.created",
            companyId: "company-1",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Read the state.get request from the worker
      const stateRequest = await stdio.readNextMessage<JsonRpcRequest>();
      expect(stateRequest.method).toBe("state.get");
      expect((stateRequest.params as any).scopeKind).toBe("instance");
      expect((stateRequest.params as any).stateKey).toBe("last-sync");

      // Respond with a state value
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: stateRequest.id,
        result: "2024-01-01T00:00:00Z",
      });

      // Now wait for the onEvent response
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).id).toBe(100);
      expect((eventResponse as JsonRpcSuccessResponse).result).toBeNull();

      // Verify the state result was received
      expect(stateResult).toBe("2024-01-01T00:00:00Z");
    });

    it("ctx.events.emit sends request to host", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async (event) => {
            await ctx.events.emit("sync-done", event.companyId, { count: 5 });
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Trigger the event handler
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 200,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-1",
            eventType: "issue.created",
            companyId: "comp-1",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Read the events.emit request from the worker
      const emitRequest = await stdio.readNextMessage<JsonRpcRequest>();
      expect(emitRequest.method).toBe("events.emit");
      expect((emitRequest.params as any).name).toBe("sync-done");
      expect((emitRequest.params as any).companyId).toBe("comp-1");
      expect((emitRequest.params as any).payload).toEqual({ count: 5 });

      // Respond
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: emitRequest.id,
        result: null,
      });

      // Read the onEvent response
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).id).toBe(200);
    });

    it("ctx.logger sends fire-and-forget notifications", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async () => {
            ctx.logger.info("Got issue", { id: "123" });
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Trigger the event handler
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 300,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-1",
            eventType: "issue.created",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Read the log notification
      const logNotification = await stdio.readNextMessage<any>();
      expect(logNotification.method).toBe("log");
      expect(logNotification.params.level).toBe("info");
      expect(logNotification.params.message).toBe("Got issue");
      expect(logNotification.params.meta).toEqual({ id: "123" });
      // Should be a notification (no id)
      expect(logNotification.id).toBeUndefined();

      // Read the onEvent response
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).id).toBe(300);
    });

    it("ctx.config.get sends request to host", async () => {
      let configResult: Record<string, unknown> | undefined;

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async () => {
            configResult = await ctx.config.get();
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Trigger
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 400,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-1",
            eventType: "issue.created",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Read config.get request
      const configRequest = await stdio.readNextMessage<JsonRpcRequest>();
      expect(configRequest.method).toBe("config.get");

      // Respond with config
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: configRequest.id,
        result: { apiKey: "test-key", region: "us-east" },
      });

      // Read onEvent response
      await stdio.readNextMessage<JsonRpcResponse>();

      expect(configResult).toEqual({ apiKey: "test-key", region: "us-east" });
    });
  });

  // -----------------------------------------------------------------------
  // Unknown method
  // -----------------------------------------------------------------------

  describe("unknown method", () => {
    it("returns METHOD_NOT_FOUND for unknown methods", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      const response = await stdio.request(2, "nonexistent.method", {});
      expect((response as JsonRpcErrorResponse).error.code).toBe(
        JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Parse error handling
  // -----------------------------------------------------------------------

  describe("parse errors", () => {
    it("returns PARSE_ERROR for invalid JSON", async () => {
      const plugin = definePlugin({ async setup() {} });
      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      // Write invalid JSON
      stdio.workerStdin.write("this is not json\n");

      const response = await stdio.readNextMessage<JsonRpcErrorResponse>();
      expect(response.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple concurrent requests
  // -----------------------------------------------------------------------

  describe("concurrent requests", () => {
    it("handles multiple host→worker requests in sequence", async () => {
      const eventHandler = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", eventHandler);
          ctx.events.on("issue.updated", eventHandler);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Send two events
      const res1 = await stdio.request(2, "onEvent", {
        event: {
          eventId: "evt-1",
          eventType: "issue.created",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });
      const res2 = await stdio.request(3, "onEvent", {
        event: {
          eventId: "evt-2",
          eventType: "issue.updated",
          companyId: "company-1",
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });

      expect((res1 as JsonRpcSuccessResponse).result).toBeNull();
      expect((res2 as JsonRpcSuccessResponse).result).toBeNull();
      expect(eventHandler).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Event handler error boundary
  // -----------------------------------------------------------------------

  describe("event handler error boundary", () => {
    let stdio: MockStdio;
    let host: WorkerRpcHost;

    beforeEach(() => {
      stdio = new MockStdio();
    });

    afterEach(() => {
      if (host?.running) {
        host.stop();
      }
      stdio.destroy();
    });

    it("catches errors thrown by event handlers and still returns success", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async () => {
            throw new Error("Handler boom");
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      // Send the event that triggers the failing handler
      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 100,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-fail",
            eventType: "issue.created",
            companyId: "company-1",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // The worker should send a log notification about the error
      const logNotification = await stdio.readNextMessage<any>();
      expect(logNotification.method).toBe("log");
      expect(logNotification.params.level).toBe("error");
      expect(logNotification.params.message).toContain("Event handler");
      expect(logNotification.params.message).toContain("Handler boom");
      // Notification should not have an id
      expect(logNotification.id).toBeUndefined();

      // The onEvent response should still be a success (no error propagation)
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).result).toBeNull();
      expect((eventResponse as JsonRpcSuccessResponse).id).toBe(100);
    });

    it("continues processing other handlers when one throws", async () => {
      const handler2 = vi.fn(async () => {});

      const plugin = definePlugin({
        async setup(ctx) {
          // First handler throws
          ctx.events.on("issue.created", async () => {
            throw new Error("First handler fails");
          });
          // Second handler should still run
          ctx.events.on("issue.created", handler2);
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 101,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-multi",
            eventType: "issue.created",
            companyId: "company-1",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Read the error log notification from the first handler
      const logNotification = await stdio.readNextMessage<any>();
      expect(logNotification.method).toBe("log");
      expect(logNotification.params.level).toBe("error");

      // Read the onEvent response
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).id).toBe(101);
      expect((eventResponse as JsonRpcSuccessResponse).result).toBeNull();

      // Second handler should have been called despite first handler throwing
      expect(handler2).toHaveBeenCalledOnce();
    });

    it("handles non-Error thrown values in event handlers", async () => {
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on("issue.created", async () => {
            throw "string error"; // non-Error throw
          });
        },
      });

      host = startWorkerRpcHost({
        plugin,
        stdin: stdio.workerStdin,
        stdout: stdio.workerStdout,
      });

      await stdio.initialize();

      stdio.sendToWorker({
        jsonrpc: JSONRPC_VERSION,
        id: 102,
        method: "onEvent",
        params: {
          event: {
            eventId: "evt-str",
            eventType: "issue.created",
            companyId: "company-1",
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      });

      // Log notification should contain the string error
      const logNotification = await stdio.readNextMessage<any>();
      expect(logNotification.method).toBe("log");
      expect(logNotification.params.level).toBe("error");
      expect(logNotification.params.message).toContain("string error");

      // Response should still succeed
      const eventResponse = await stdio.readNextMessage<JsonRpcResponse>();
      expect((eventResponse as JsonRpcSuccessResponse).result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// runWorker
// ---------------------------------------------------------------------------

describe("runWorker", () => {
  let stdio: MockStdio;
  let host: WorkerRpcHost | void;

  beforeEach(() => {
    stdio = new MockStdio();
  });

  afterEach(() => {
    if (host && typeof host === "object" && "running" in host && host.running) {
      host.stop();
    }
    stdio.destroy();
  });

  it("does nothing when moduleUrl does not match process.argv[1]", () => {
    const plugin = definePlugin({ async setup() {} });
    const listenerCountBefore = process.stdin.listenerCount("readable");
    runWorker(plugin, "file:///nonexistent/worker.js");
    expect(process.stdin.listenerCount("readable")).toBe(listenerCountBefore);
  });

  it("starts the RPC host when options.stdin and options.stdout are provided", async () => {
    const setupFn = vi.fn(async () => {});
    const plugin = definePlugin({ setup: setupFn });

    host = runWorker(plugin, "file:///any/worker.js", {
      stdin: stdio.workerStdin,
      stdout: stdio.workerStdout,
    });

    expect(host).toBeDefined();
    expect(host!.running).toBe(true);

    const response = await stdio.initialize();
    expect(response.result).toEqual({ ok: true });
    expect(setupFn).toHaveBeenCalledOnce();
  });

  it("returns host that accepts initialize with custom manifest", async () => {
    const plugin = definePlugin({ async setup() {} });

    host = runWorker(plugin, "file:///test/worker.js", {
      stdin: stdio.workerStdin,
      stdout: stdio.workerStdout,
    });

    const response = await stdio.initialize({
      manifest: makeManifest({ id: "runWorker.test" }),
    });
    expect(response.result).toEqual({ ok: true });
  });
});
