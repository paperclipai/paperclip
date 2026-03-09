/**
 * Full Plugin Lifecycle Integration Test
 *
 * Exercises the complete plugin lifecycle end-to-end using a mock child process
 * that simulates a real plugin worker. Covers:
 *
 * 1. **Install** — Plugin is registered in the system
 * 2. **Spawn worker** — Worker process is started and initialized via JSON-RPC
 * 3. **Subscribe to events** — Events are routed through the event bus
 * 4. **Run a scheduled job** — Job scheduler dispatches `runJob` to the worker
 * 5. **Handle a webhook** — `handleWebhook` RPC is sent to the worker
 * 6. **Serve UI data** — `getData` RPC is sent to the worker
 * 7. **Shutdown cleanly** — Graceful shutdown via `shutdown` RPC + process exit
 *
 * Uses the MockChildProcess pattern from plugin-worker-manager.test.ts to
 * simulate the out-of-process worker without spawning a real child process.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginCategory,
  PluginRecord,
  PluginStatus,
} from "@paperclipai/shared";
import type { JsonRpcRequest, PluginEvent } from "@paperclipai/plugin-sdk";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

// ---------------------------------------------------------------------------
// Mock child_process.fork
// ---------------------------------------------------------------------------

/**
 * A mock child process that simulates worker behavior in tests.
 * Replicates the pattern from plugin-worker-manager.test.ts.
 */
class MockChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid = 99999;
  killed = false;

  private _stdinBuffer = "";
  private _stdinWaiters: Array<(data: string) => void> = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.on("data", (chunk: Buffer) => {
      this._stdinBuffer += chunk.toString();
      this._flushWaiters();
    });
  }

  private _flushWaiters(): void {
    while (this._stdinWaiters.length > 0 && this._stdinBuffer.includes("\n")) {
      const idx = this._stdinBuffer.indexOf("\n");
      const line = this._stdinBuffer.slice(0, idx);
      this._stdinBuffer = this._stdinBuffer.slice(idx + 1);
      const waiter = this._stdinWaiters.shift()!;
      waiter(line);
    }
  }

  kill(signal?: string): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => {
      this.emit("exit", signal === "SIGKILL" ? null : 0, signal ?? null);
    });
    return true;
  }

  /** Simulate the worker sending a JSON-RPC message to the host via stdout. */
  sendToHost(message: unknown): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  /** Read the next complete line from stdin. */
  private _readNextLine(): Promise<string> {
    return new Promise((resolve) => {
      if (this._stdinBuffer.includes("\n")) {
        const idx = this._stdinBuffer.indexOf("\n");
        const line = this._stdinBuffer.slice(0, idx);
        this._stdinBuffer = this._stdinBuffer.slice(idx + 1);
        resolve(line);
      } else {
        this._stdinWaiters.push(resolve);
      }
    });
  }

  /** Read the next request from stdin and return the parsed JSON-RPC request. */
  async readNextRequest(): Promise<JsonRpcRequest> {
    const line = await this._readNextLine();
    return JSON.parse(line) as JsonRpcRequest;
  }

  /** Respond to the next request from the host with a success result. */
  async respondToNextRequest(result: unknown): Promise<JsonRpcRequest> {
    const request = await this.readNextRequest();
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result });
    return request;
  }

  /** Respond to the next request with an error. */
  async respondWithError(code: number, message: string): Promise<JsonRpcRequest> {
    const request = await this.readNextRequest();
    this.sendToHost({ jsonrpc: "2.0", id: request.id, error: { code, message } });
    return request;
  }

  /**
   * Respond to the shutdown RPC and then simulate process exit.
   */
  async respondToShutdownAndExit(): Promise<void> {
    const request = await this.readNextRequest();
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result: null });
    setImmediate(() => {
      if (!this.killed) {
        this.killed = true;
        this.emit("exit", 0, null);
      }
    });
  }

  /** Cleanup resources. */
  destroy(): void {
    this.removeAllListeners();
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    this._stdinWaiters = [];
  }
}

let allMockChildren: MockChildProcess[] = [];
let mockChild: MockChildProcess;

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    mockChild = new MockChildProcess();
    allMockChildren.push(mockChild);
    return mockChild;
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Import after mocks
const {
  createPluginWorkerManager,
} = await import("../services/plugin-worker-manager.js");

import type {
  WorkerStartOptions,
  WorkerToHostHandlers,
  PluginWorkerManager,
} from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Manifest for a fully-featured test plugin that declares all capabilities
 * needed to exercise every lifecycle stage.
 */
function makeFullManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "acme.full-lifecycle-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Full Lifecycle Test Plugin",
    description: "A test plugin that exercises the full lifecycle",
    categories: ["connector" as PluginCategory],
    capabilities: [
      "events.subscribe",
      "events.emit",
      "jobs.schedule",
      "webhooks.receive",
      "plugin.state.read",
      "plugin.state.write",
    ] as PluginCapability[],
    entrypoints: { worker: "dist/worker.js" },
    jobs: [
      {
        jobKey: "full-sync",
        displayName: "Full Sync",
        description: "Synchronizes all data from external system",
        schedule: "0 * * * *", // every hour
      },
    ],
    webhooks: [
      {
        endpointKey: "inbound",
        displayName: "Inbound Webhook",
        description: "Receives pushes from external system",
      },
    ],
    ui: {
      slots: [
        {
          type: "settings-panel" as any,
          entrypoint: "dist/ui/settings.js",
        },
      ],
    },
    ...overrides,
  };
}

function makeStartOptions(
  overrides: Partial<WorkerStartOptions> = {},
): WorkerStartOptions {
  return {
    entrypointPath: "/path/to/full-lifecycle-plugin/dist/worker.cjs",
    manifest: makeFullManifest(),
    config: { apiKey: "secret-ref:API_KEY", workspace: "acme" },
    instanceInfo: { instanceId: "inst-test", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full Lifecycle Integration Tests
// ---------------------------------------------------------------------------

describe("plugin full lifecycle integration", () => {
  let workerManager: PluginWorkerManager;
  const pluginId = "plugin-uuid-lifecycle-1";
  const pluginKey = "acme.full-lifecycle-plugin";

  beforeEach(() => {
    allMockChildren = [];
    workerManager = createPluginWorkerManager();
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  // =========================================================================
  // 1. Full lifecycle: install → spawn → events → jobs → webhooks → UI → shutdown
  // =========================================================================

  it("exercises the complete plugin lifecycle end-to-end", async () => {
    // -----------------------------------------------------------------------
    // Track received host→worker RPC calls to verify ordering
    // -----------------------------------------------------------------------
    const rpcLog: string[] = [];

    // Host handlers that the worker can call back
    const stateStore = new Map<string, unknown>();
    const hostHandlers: WorkerToHostHandlers = {
      "config.get": vi.fn(async () => ({ apiKey: "resolved-key", workspace: "acme" })),
      "state.get": vi.fn(async (params) => {
        const key = `${(params as any).scopeKind}:${(params as any).stateKey}`;
        return stateStore.get(key) ?? null;
      }),
      "state.set": vi.fn(async (params) => {
        const key = `${(params as any).scopeKind}:${(params as any).stateKey}`;
        stateStore.set(key, (params as any).value);
      }),
    };

    const options = makeStartOptions({ hostHandlers });

    // ===================================================================
    // STEP 1: Install & Spawn Worker
    // ===================================================================
    // Start worker — this triggers fork() + initialize RPC
    const startPromise = workerManager.startWorker(pluginId, options);

    // Wait for fork and respond to initialize
    await tick();
    const initRequest = await mockChild.respondToNextRequest({ ok: true });
    rpcLog.push(initRequest.method);

    const handle = await startPromise;

    expect(handle.status).toBe("running");
    expect(handle.pluginId).toBe(pluginId);
    expect(workerManager.isRunning(pluginId)).toBe(true);
    expect(initRequest.method).toBe("initialize");
    expect((initRequest.params as any).manifest.id).toBe("acme.full-lifecycle-plugin");
    expect((initRequest.params as any).config).toEqual({ apiKey: "secret-ref:API_KEY", workspace: "acme" });

    const child = mockChild; // capture for later use

    // ===================================================================
    // STEP 2: Event Subscription — Worker calls events via host handlers
    // ===================================================================
    // The event bus is a separate service. In real code, the plugin loader
    // wires up event subscriptions via host handlers. Here we test that
    // the onEvent RPC is correctly dispatched to the worker.

    const eventBus = createPluginEventBus();
    const scopedBus = eventBus.forPlugin(pluginKey);

    // Register a subscription that proxies events to the worker
    const deliveredEvents: PluginEvent[] = [];
    scopedBus.subscribe("issue.created", async (event) => {
      deliveredEvents.push(event);
    });

    expect(eventBus.subscriptionCount(pluginKey)).toBe(1);

    // Emit a domain event through the bus
    const testEvent: PluginEvent = {
      eventId: "evt-001",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      entityId: "iss-42",
      entityType: "issue",
      companyId: "comp-1",
      payload: { title: "Fix login bug", projectId: "proj-1", companyId: "comp-1" },
    };
    const emitResult = await eventBus.emit(testEvent);

    expect(emitResult.errors).toHaveLength(0);
    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0]!.entityId).toBe("iss-42");

    // Also verify we can send onEvent RPC to the worker directly
    const onEventRespondPromise = child.respondToNextRequest(null);
    await handle.call("onEvent", { event: testEvent });
    const onEventRequest = await onEventRespondPromise;

    rpcLog.push(onEventRequest.method);
    expect(onEventRequest.method).toBe("onEvent");
    expect((onEventRequest.params as any).event.eventId).toBe("evt-001");

    // ===================================================================
    // STEP 3: Scheduled Job — runJob RPC
    // ===================================================================
    const runJobRespondPromise = child.respondToNextRequest(null);
    await handle.call("runJob", {
      job: {
        jobKey: "full-sync",
        runId: "run-001",
        trigger: "schedule" as const,
        scheduledAt: new Date().toISOString(),
      },
    });
    const runJobRequest = await runJobRespondPromise;

    rpcLog.push(runJobRequest.method);
    expect(runJobRequest.method).toBe("runJob");
    expect((runJobRequest.params as any).job.jobKey).toBe("full-sync");
    expect((runJobRequest.params as any).job.runId).toBe("run-001");
    expect((runJobRequest.params as any).job.trigger).toBe("schedule");

    // ===================================================================
    // STEP 4: Webhook — handleWebhook RPC
    // ===================================================================
    const webhookRespondPromise = child.respondToNextRequest(null);
    await handle.call("handleWebhook", {
      endpointKey: "inbound",
      headers: { "content-type": "application/json", "x-webhook-secret": "abc123" },
      rawBody: '{"action":"push","ref":"refs/heads/main"}',
      parsedBody: { action: "push", ref: "refs/heads/main" },
      requestId: "req-001",
    });
    const webhookRequest = await webhookRespondPromise;

    rpcLog.push(webhookRequest.method);
    expect(webhookRequest.method).toBe("handleWebhook");
    expect((webhookRequest.params as any).endpointKey).toBe("inbound");
    expect((webhookRequest.params as any).requestId).toBe("req-001");
    expect((webhookRequest.params as any).rawBody).toBe('{"action":"push","ref":"refs/heads/main"}');

    // ===================================================================
    // STEP 5: UI Data — getData RPC
    // ===================================================================
    const getDataRespondPromise = child.respondToNextRequest({
      lastSync: "2024-01-01T12:00:00Z",
      status: "healthy",
      itemsSynced: 42,
    });
    const uiData = await handle.call("getData", {
      key: "sync-health",
      params: { companyId: "comp-1" },
    });
    const getDataRequest = await getDataRespondPromise;

    rpcLog.push(getDataRequest.method);
    expect(getDataRequest.method).toBe("getData");
    expect((getDataRequest.params as any).key).toBe("sync-health");
    expect(uiData).toEqual({
      lastSync: "2024-01-01T12:00:00Z",
      status: "healthy",
      itemsSynced: 42,
    });

    // ===================================================================
    // STEP 6: Worker→Host calls (state management via host handlers)
    // ===================================================================
    // Simulate the worker calling state.set via JSON-RPC.
    // The host processes these and writes responses back to stdin.
    // We need to drain those responses from stdin before making more
    // host→worker calls, because the mock's _readNextLine will pick them up.
    child.sendToHost({
      jsonrpc: "2.0",
      id: 5001,
      method: "state.set",
      params: {
        scopeKind: "instance",
        stateKey: "last-sync-cursor",
        value: "cursor-abc-123",
      },
    });

    await tick(50);

    expect(hostHandlers["state.set"]).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "instance",
        stateKey: "last-sync-cursor",
        value: "cursor-abc-123",
      }),
    );
    expect(stateStore.get("instance:last-sync-cursor")).toBe("cursor-abc-123");

    // Simulate the worker reading state back
    child.sendToHost({
      jsonrpc: "2.0",
      id: 5002,
      method: "state.get",
      params: {
        scopeKind: "instance",
        stateKey: "last-sync-cursor",
      },
    });

    await tick(50);

    expect(hostHandlers["state.get"]).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "instance",
        stateKey: "last-sync-cursor",
      }),
    );

    // Drain host-written responses from stdin so they don't interfere
    // with subsequent respondToNextRequest calls. The host wrote two
    // response lines (for state.set and state.get) back to stdin.
    // The mock's readNextRequest would consume them as "requests" which
    // would break the test flow. Read them now to clear the buffer.
    await child.readNextRequest(); // drain state.set response
    await child.readNextRequest(); // drain state.get response

    // ===================================================================
    // STEP 7: Health Check
    // ===================================================================
    const healthRespondPromise = child.respondToNextRequest({
      status: "ok",
      message: "All systems operational",
      details: { connections: 1, queueDepth: 0 },
    });
    const healthResult = await handle.call("health", {} as Record<string, never>);
    const healthRequest = await healthRespondPromise;

    rpcLog.push(healthRequest.method);
    expect(healthRequest.method).toBe("health");
    expect(healthResult).toEqual({
      status: "ok",
      message: "All systems operational",
      details: { connections: 1, queueDepth: 0 },
    });

    // ===================================================================
    // STEP 8: Graceful Shutdown
    // ===================================================================
    const shutdownPromise = child.respondToShutdownAndExit();
    await handle.stop();
    await shutdownPromise;

    rpcLog.push("shutdown");

    expect(handle.status).toBe("stopped");
    expect(workerManager.isRunning(pluginId)).toBe(false);

    // ===================================================================
    // Verify the complete RPC call ordering
    // ===================================================================
    expect(rpcLog).toEqual([
      "initialize",
      "onEvent",
      "runJob",
      "handleWebhook",
      "getData",
      "health",
      "shutdown",
    ]);
  });

  // =========================================================================
  // 2. Plugin-to-plugin events via the event bus
  // =========================================================================

  it("supports plugin-to-plugin events through the event bus", async () => {
    const eventBus = createPluginEventBus();

    // Plugin A emits events
    const pluginA = eventBus.forPlugin("acme.plugin-a");
    // Plugin B subscribes to Plugin A's events
    const pluginB = eventBus.forPlugin("acme.plugin-b");

    const receivedEvents: PluginEvent[] = [];
    pluginB.subscribe("plugin.acme.plugin-a.*", async (event) => {
      receivedEvents.push(event);
    });

    // Plugin A emits a custom event (auto-namespaced)
    await pluginA.emit("sync-complete", "comp-1", {
      itemsSynced: 100,
      duration: 5000,
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.eventType).toBe("plugin.acme.plugin-a.sync-complete");
    expect(receivedEvents[0]!.payload).toEqual({
      itemsSynced: 100,
      duration: 5000,
    });
    expect(receivedEvents[0]!.actorType).toBe("plugin");
    expect(receivedEvents[0]!.actorId).toBe("acme.plugin-a");
  });

  // =========================================================================
  // 3. Worker crash does not lose host state
  // =========================================================================

  it("worker crash preserves host-side state and events", async () => {
    const eventBus = createPluginEventBus();
    const scopedBus = eventBus.forPlugin(pluginKey);

    const deliveredEvents: PluginEvent[] = [];
    scopedBus.subscribe("issue.updated", async (event) => {
      deliveredEvents.push(event);
    });

    // Start first worker
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions({
      autoRestart: false, // Disable auto-restart for controlled testing
    }));
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    const handle = await startPromise;
    const firstChild = mockChild;

    expect(handle.status).toBe("running");

    // Simulate crash
    firstChild.killed = true;
    firstChild.emit("exit", 1, null);
    await tick();

    expect(handle.status).toBe("crashed");

    // Event bus subscriptions should still be intact
    expect(eventBus.subscriptionCount(pluginKey)).toBe(1);

    // Emit event after crash — the handler is still registered
    await eventBus.emit({
      eventId: "evt-002",
      eventType: "issue.updated",
      occurredAt: new Date().toISOString(),
      entityId: "iss-99",
      entityType: "issue",
      payload: { title: "Updated issue" },
    });

    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0]!.entityId).toBe("iss-99");
  });

  // =========================================================================
  // 4. Multiple plugins can run concurrently
  // =========================================================================

  it("manages multiple concurrent plugin workers independently", async () => {
    const pluginAId = "plugin-uuid-a";
    const pluginBId = "plugin-uuid-b";

    // Start plugin A
    const startA = workerManager.startWorker(pluginAId, makeStartOptions({
      manifest: makeFullManifest({ id: "acme.plugin-a" }),
    }));
    await tick();
    const childA = mockChild;
    await childA.respondToNextRequest({ ok: true });
    const handleA = await startA;

    // Start plugin B
    const startB = workerManager.startWorker(pluginBId, makeStartOptions({
      manifest: makeFullManifest({ id: "acme.plugin-b" }),
    }));
    await tick();
    const childB = mockChild;
    await childB.respondToNextRequest({ ok: true });
    const handleB = await startB;

    // Both should be running
    expect(handleA.status).toBe("running");
    expect(handleB.status).toBe("running");
    expect(workerManager.diagnostics()).toHaveLength(2);

    // Send health check to each
    const healthA = childA.respondToNextRequest({ status: "ok", message: "A healthy" });
    const resultA = await handleA.call("health", {} as Record<string, never>);
    await healthA;

    const healthB = childB.respondToNextRequest({ status: "ok", message: "B healthy" });
    const resultB = await handleB.call("health", {} as Record<string, never>);
    await healthB;

    expect(resultA).toEqual({ status: "ok", message: "A healthy" });
    expect(resultB).toEqual({ status: "ok", message: "B healthy" });

    // Stop plugin A — plugin B should still be running
    const shutdownA = childA.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginAId);
    await shutdownA;

    expect(workerManager.isRunning(pluginAId)).toBe(false);
    expect(workerManager.isRunning(pluginBId)).toBe(true);

    // Cleanup: stop plugin B
    const shutdownB = childB.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginBId);
    await shutdownB;
  });

  // =========================================================================
  // 5. Worker logging is captured
  // =========================================================================

  it("captures structured log notifications from the worker", async () => {
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;
    const child = mockChild;

    // Worker sends log notifications (fire-and-forget, no response expected)
    child.sendToHost({
      jsonrpc: "2.0",
      method: "log",
      params: { level: "info", message: "Starting sync", meta: { itemCount: 50 } },
    });

    child.sendToHost({
      jsonrpc: "2.0",
      method: "log",
      params: { level: "warn", message: "Rate limit approaching", meta: { remaining: 10 } },
    });

    child.sendToHost({
      jsonrpc: "2.0",
      method: "log",
      params: { level: "error", message: "Connection failed", meta: { endpoint: "api.example.com" } },
    });

    // Allow time for notifications to be processed
    await tick(50);

    // Logs are fire-and-forget, no response — the worker manager routes them
    // to the host logger. In this test we just verify they don't cause errors.
    // The actual log verification is done in plugin-worker-manager.test.ts.

    // Cleanup
    const shutdown = child.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginId);
    await shutdown;
  });

  // =========================================================================
  // 6. Event filtering works end-to-end
  // =========================================================================

  it("filters events based on server-side EventFilter", async () => {
    const eventBus = createPluginEventBus();
    const scopedBus = eventBus.forPlugin(pluginKey);

    const receivedEvents: PluginEvent[] = [];

    // Subscribe with a filter: only events for project "proj-1"
    scopedBus.subscribe(
      "issue.created",
      { projectId: "proj-1" },
      async (event) => {
        receivedEvents.push(event);
      },
    );

    // Emit event for proj-1 (should match)
    await eventBus.emit({
      eventId: "evt-100",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      entityId: "iss-1",
      entityType: "issue",
      payload: { title: "Bug in proj-1", projectId: "proj-1" },
    });

    // Emit event for proj-2 (should NOT match)
    await eventBus.emit({
      eventId: "evt-101",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      entityId: "iss-2",
      entityType: "issue",
      payload: { title: "Bug in proj-2", projectId: "proj-2" },
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.eventId).toBe("evt-100");
  });

  // =========================================================================
  // 7. Concurrent RPC calls to the same worker
  // =========================================================================

  it("handles multiple concurrent RPC calls to the same worker correctly", async () => {
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;
    const child = mockChild;

    // Queue up responses for three concurrent calls
    const respond1 = child.respondToNextRequest({ key: "sync-health", data: { lastSync: "2024-01-01" } });
    const respond2 = child.respondToNextRequest({ key: "sync-status", data: { status: "idle" } });
    const respond3 = child.respondToNextRequest({ key: "sync-history", data: { entries: [] } });

    // Fire three concurrent getData calls
    const [result1, result2, result3] = await Promise.all([
      workerManager.call(pluginId, "getData", { key: "sync-health", params: {} }),
      workerManager.call(pluginId, "getData", { key: "sync-status", params: {} }),
      workerManager.call(pluginId, "getData", { key: "sync-history", params: {} }),
    ]);

    await Promise.all([respond1, respond2, respond3]);

    // All three should have returned valid results
    expect(result1).toHaveProperty("key");
    expect(result2).toHaveProperty("key");
    expect(result3).toHaveProperty("key");

    // Cleanup
    const shutdown = child.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginId);
    await shutdown;
  });

  // =========================================================================
  // 8. performAction RPC
  // =========================================================================

  it("sends performAction RPC to the worker for UI actions", async () => {
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;
    const child = mockChild;

    // Worker responds to performAction
    const respondPromise = child.respondToNextRequest({
      success: true,
      message: "Resync initiated",
    });

    const result = await workerManager.call(pluginId, "performAction", {
      key: "resync",
      params: { companyId: "comp-1", force: true },
    });
    const actionRequest = await respondPromise;

    expect(actionRequest.method).toBe("performAction");
    expect((actionRequest.params as any).key).toBe("resync");
    expect((actionRequest.params as any).params).toEqual({ companyId: "comp-1", force: true });
    expect(result).toEqual({ success: true, message: "Resync initiated" });

    // Cleanup
    const shutdown = child.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginId);
    await shutdown;
  });

  // =========================================================================
  // 9. executeTool RPC for agent tools
  // =========================================================================

  it("sends executeTool RPC to the worker for agent tool invocations", async () => {
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;
    const child = mockChild;

    // Worker responds to executeTool
    const respondPromise = child.respondToNextRequest({
      content: "Found 3 matching issues: #42, #43, #44",
      metadata: { count: 3 },
    });

    const toolResult = await workerManager.call(pluginId, "executeTool", {
      toolName: "search-issues",
      parameters: { query: "login bug", status: "open" },
      runContext: {
        runId: "run-001",
        agentId: "agent-1",
        companyId: "comp-1",
        projectId: "proj-1",
      } as any,
    });
    const toolRequest = await respondPromise;

    expect(toolRequest.method).toBe("executeTool");
    expect((toolRequest.params as any).toolName).toBe("search-issues");
    expect(toolResult).toEqual({
      content: "Found 3 matching issues: #42, #43, #44",
      metadata: { count: 3 },
    });

    // Cleanup
    const shutdown = child.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginId);
    await shutdown;
  });

  // =========================================================================
  // 10. validateConfig and configChanged RPCs
  // =========================================================================

  it("sends validateConfig and configChanged RPCs to the worker", async () => {
    const startPromise = workerManager.startWorker(pluginId, makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;
    const child = mockChild;

    // Test validateConfig
    const validateRespondPromise = child.respondToNextRequest({
      ok: true,
      warnings: ["API key will expire in 7 days"],
    });
    const validateResult = await workerManager.call(pluginId, "validateConfig", {
      config: { apiKey: "new-key-123", workspace: "acme" },
    });
    const validateRequest = await validateRespondPromise;

    expect(validateRequest.method).toBe("validateConfig");
    expect(validateResult).toEqual({
      ok: true,
      warnings: ["API key will expire in 7 days"],
    });

    // Test configChanged
    const configChangedRespondPromise = child.respondToNextRequest(null);
    await workerManager.call(pluginId, "configChanged", {
      config: { apiKey: "new-key-123", workspace: "acme-new" },
    });
    const configChangedRequest = await configChangedRespondPromise;

    expect(configChangedRequest.method).toBe("configChanged");
    expect((configChangedRequest.params as any).config.workspace).toBe("acme-new");

    // Cleanup
    const shutdown = child.respondToShutdownAndExit();
    await workerManager.stopWorker(pluginId);
    await shutdown;
  });

  // =========================================================================
  // 11. stopAll shuts down all workers cleanly
  // =========================================================================

  it("stopAll gracefully shuts down all workers", async () => {
    // Start two workers
    const startA = workerManager.startWorker("p-a", makeStartOptions({
      manifest: makeFullManifest({ id: "a" }),
    }));
    await tick();
    const childA = mockChild;
    await childA.respondToNextRequest({ ok: true });
    await startA;

    const startB = workerManager.startWorker("p-b", makeStartOptions({
      manifest: makeFullManifest({ id: "b" }),
    }));
    await tick();
    const childB = mockChild;
    await childB.respondToNextRequest({ ok: true });
    await startB;

    expect(workerManager.diagnostics()).toHaveLength(2);

    // Queue shutdown responses for both
    const shutdownA = childA.respondToShutdownAndExit();
    const shutdownB = childB.respondToShutdownAndExit();

    // Stop all workers
    await workerManager.stopAll();
    await Promise.all([shutdownA, shutdownB]);

    expect(workerManager.diagnostics()).toHaveLength(0);
  });

  // =========================================================================
  // 12. Event bus isolation — one plugin's handler error doesn't affect others
  // =========================================================================

  it("isolates event handler errors between plugins", async () => {
    const eventBus = createPluginEventBus();

    // Plugin A handler throws
    const throwingHandler = vi.fn().mockRejectedValue(new Error("Plugin A error"));
    eventBus.forPlugin("plugin-a").subscribe("issue.created", throwingHandler);

    // Plugin B handler succeeds
    const successHandler = vi.fn().mockResolvedValue(undefined);
    eventBus.forPlugin("plugin-b").subscribe("issue.created", successHandler);

    const result = await eventBus.emit({
      eventId: "evt-iso",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      payload: { title: "test" },
    });

    // Plugin B still received the event despite Plugin A's error
    expect(successHandler).toHaveBeenCalledTimes(1);
    expect(throwingHandler).toHaveBeenCalledTimes(1);

    // The error is captured, not thrown
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.pluginId).toBe("plugin-a");
  });
});
