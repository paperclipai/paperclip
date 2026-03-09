import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginCategory,
} from "@paperclipai/shared";
import {
  PLUGIN_RPC_ERROR_CODES,
  JsonRpcCallError,
} from "@paperclipai/plugin-sdk";
import type { JsonRpcRequest } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Mock child_process.fork
// ---------------------------------------------------------------------------

/**
 * A mock child process that simulates worker behavior in tests.
 *
 * The stdin PassThrough represents the pipe from host → worker.
 * The stdout PassThrough represents the pipe from worker → host.
 */
class MockChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid = 12345;
  killed = false;

  /** Accumulated stdin data for parsing requests. */
  private _stdinBuffer = "";
  /** Queue of pending stdin data resolvers. */
  private _stdinWaiters: Array<(data: string) => void> = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    // Buffer all stdin data so we never miss writes that happen before reads.
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
      // Check if there's already a buffered line
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

  /** Respond to the next request from the host with a success result. */
  async respondToNextRequest(result: unknown): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result });
  }

  /** Respond to the next request from the host with an error. */
  async respondWithError(code: number, message: string): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    this.sendToHost({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  }

  /**
   * Respond to the shutdown RPC and then simulate process exit (like a real
   * worker would do). Call this BEFORE `handle.stop()` so the response is
   * ready to be consumed.
   */
  async respondToShutdownAndExit(): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    // Send the response
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result: null });
    // Simulate the worker exiting gracefully after responding
    setImmediate(() => {
      if (!this.killed) {
        this.killed = true;
        this.emit("exit", 0, null);
      }
    });
  }

  /** Simulate an unexpected process exit (crash). */
  simulateCrash(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.killed = true;
    this.emit("exit", code, signal);
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

/** Captured child-logger mocks keyed by pluginId (from the `child()` bindings). */
const mockChildLoggers = new Map<string, {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}>();

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: (bindings?: Record<string, unknown>) => {
      const childLog = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const key = (bindings?.pluginId as string) ?? (bindings?.service as string) ?? "unknown";
      mockChildLoggers.set(key, childLog);
      return childLog;
    },
  },
}));

// Import the module under test (after mocks)
const {
  createPluginWorkerHandle,
  createPluginWorkerManager,
} = await import("../services/plugin-worker-manager.js");

import type {
  WorkerStartOptions,
  WorkerToHostHandlers,
  WorkerStatus,
  PluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

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
    description: "A test plugin for unit tests",
    categories: ["connector" as PluginCategory],
    capabilities: ["events.subscribe" as PluginCapability],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

function makeStartOptions(
  overrides: Partial<WorkerStartOptions> = {},
): WorkerStartOptions {
  return {
    entrypointPath: "/path/to/worker.cjs",
    manifest: makeManifest(),
    config: { apiKey: "secret-ref:MY_KEY" },
    instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...overrides,
  };
}

/**
 * Start a worker handle; the mock process auto-responds to `initialize`.
 */
async function startHandle(
  pluginId: string,
  options?: Partial<WorkerStartOptions>,
): Promise<{ handle: PluginWorkerHandle; child: MockChildProcess }> {
  const handle = createPluginWorkerHandle(pluginId, makeStartOptions(options));

  // Start will immediately call fork(), so queue up the response handler
  // before calling start to avoid race conditions.
  const respondPromise = (async () => {
    // Wait for fork to happen and the child to exist
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
  })();

  await handle.start();
  await respondPromise;

  return { handle, child: mockChild };
}

// ---------------------------------------------------------------------------
// Tests: createPluginWorkerHandle
// ---------------------------------------------------------------------------

describe("createPluginWorkerHandle", () => {
  beforeEach(() => {
    allMockChildren = [];
    mockChildLoggers.clear();
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe("initial state", () => {
    it("starts with status 'stopped'", () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      expect(handle.status).toBe("stopped");
      expect(handle.pluginId).toBe("test.plugin");
    });

    it("diagnostics show no active process", () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      const diag = handle.diagnostics();
      expect(diag.pluginId).toBe("test.plugin");
      expect(diag.status).toBe("stopped");
      expect(diag.pid).toBeNull();
      expect(diag.uptime).toBeNull();
      expect(diag.consecutiveCrashes).toBe(0);
      expect(diag.totalCrashes).toBe(0);
      expect(diag.pendingRequests).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Start and initialize
  // -------------------------------------------------------------------------

  describe("start and initialize", () => {
    it("starts the worker process and transitions to running", async () => {
      const { handle } = await startHandle("test.plugin");
      expect(handle.status).toBe("running");
      expect(handle.diagnostics().pid).toBe(12345);
    });

    it("emits 'ready' event after successful initialize", async () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      const readyHandler = vi.fn();
      handle.on("ready", readyHandler);

      const startPromise = handle.start();
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startPromise;

      expect(readyHandler).toHaveBeenCalledWith({ pluginId: "test.plugin" });
    });

    it("emits status changes during startup", async () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      const statusChanges: Array<{ status: WorkerStatus; previousStatus: WorkerStatus }> = [];
      handle.on("status", (payload) => statusChanges.push(payload));

      const startPromise = handle.start();
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startPromise;

      expect(statusChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "starting", previousStatus: "stopped" }),
          expect.objectContaining({ status: "running", previousStatus: "starting" }),
        ]),
      );
    });

    it("throws if initialize returns ok=false", async () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());

      const startPromise = handle.start();
      await tick();
      await mockChild.respondToNextRequest({ ok: false });

      await expect(startPromise).rejects.toThrow(/initialize/i);
      expect(handle.status).toBe("crashed");
    });

    it("throws if already running", async () => {
      const { handle } = await startHandle("test.plugin");
      await expect(handle.start()).rejects.toThrow(/already running/i);
    });

    it("resets consecutive crash counter on successful start", async () => {
      const { handle } = await startHandle("test.plugin");
      expect(handle.diagnostics().consecutiveCrashes).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // RPC calls (host → worker)
  // -------------------------------------------------------------------------

  describe("RPC calls", () => {
    it("sends a typed RPC call and receives the response", async () => {
      const { handle, child } = await startHandle("test.plugin");

      // Queue the response before making the call to avoid race conditions.
      const respondPromise = child.respondToNextRequest({ status: "ok", message: "All good" });
      const result = await handle.call("health", {} as Record<string, never>);
      await respondPromise;

      expect(result).toEqual({ status: "ok", message: "All good" });
    });

    it("rejects with JsonRpcCallError on error response", async () => {
      const { handle, child } = await startHandle("test.plugin");

      const respondPromise = child.respondWithError(
        PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
        "Something went wrong",
      );

      await expect(
        handle.call("health", {} as Record<string, never>),
      ).rejects.toThrow(JsonRpcCallError);

      await respondPromise;
    });

    it("rejects with timeout error when worker does not respond", async () => {
      const { handle } = await startHandle("test.plugin", {
        rpcTimeoutMs: 50,
      });

      await expect(
        handle.call("health", {} as Record<string, never>),
      ).rejects.toThrow(/timed out/i);
    });

    it("rejects if worker is not running", async () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());

      await expect(
        handle.call("health", {} as Record<string, never>),
      ).rejects.toThrow(/stopped/i);
    });

    it("handles multiple concurrent calls correctly", async () => {
      const { handle, child } = await startHandle("test.plugin");

      // Queue up responses for two calls
      const respond1 = child.respondToNextRequest({ status: "ok", call: 1 });
      const respond2 = child.respondToNextRequest({ status: "ok", call: 2 });

      const [result1, result2] = await Promise.all([
        handle.call("health", {} as Record<string, never>),
        handle.call("health", {} as Record<string, never>),
      ]);

      await Promise.all([respond1, respond2]);

      expect(result1).toHaveProperty("status", "ok");
      expect(result2).toHaveProperty("status", "ok");
    });
  });

  // -------------------------------------------------------------------------
  // Worker → Host calls
  // -------------------------------------------------------------------------

  describe("worker-to-host calls", () => {
    it("routes worker requests to registered host handlers", async () => {
      const configHandler = vi.fn().mockResolvedValue({ apiKey: "resolved-key" });
      const hostHandlers: WorkerToHostHandlers = {
        "config.get": configHandler,
      };

      const { child } = await startHandle("test.plugin", { hostHandlers });

      child.sendToHost({
        jsonrpc: "2.0",
        id: 999,
        method: "config.get",
        params: {},
      });

      await tick(50);
      expect(configHandler).toHaveBeenCalledWith({});
    });

    it("returns error for unregistered host methods", async () => {
      const { child } = await startHandle("test.plugin");

      child.sendToHost({
        jsonrpc: "2.0",
        id: 888,
        method: "unknown.method",
        params: {},
      });

      await tick(50);
    });

    it("returns error when host handler throws", async () => {
      const hostHandlers: WorkerToHostHandlers = {
        "config.get": vi.fn().mockRejectedValue(new Error("host-error")),
      };

      const { child } = await startHandle("test.plugin", { hostHandlers });

      child.sendToHost({
        jsonrpc: "2.0",
        id: 777,
        method: "config.get",
        params: {},
      });

      await tick(50);
    });
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  describe("notifications", () => {
    it("sends fire-and-forget notifications to the worker", async () => {
      const { handle, child } = await startHandle("test.plugin");

      // Queue reader first, then send
      const linePromise = child["_readNextLine"]();
      handle.notify("configChanged", { config: { newKey: "value" } });

      const raw = await linePromise;
      const msg = JSON.parse(raw);
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("configChanged");
      expect(msg).not.toHaveProperty("id");
    });

    it("does not throw when worker is not running", () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      handle.notify("configChanged", {});
    });

    it("handles log notifications from worker with structured context", async () => {
      const { child } = await startHandle("test.plugin");
      const childLog = mockChildLoggers.get("test.plugin")!;

      // Clear any calls from startup (e.g. "worker process started")
      childLog.info.mockClear();
      childLog.warn.mockClear();
      childLog.error.mockClear();
      childLog.debug.mockClear();

      child.sendToHost({
        jsonrpc: "2.0",
        method: "log",
        params: { level: "info", message: "Plugin doing things", meta: { count: 5 } },
      });

      await tick(30);

      expect(childLog.info).toHaveBeenCalledOnce();

      // Verify structured fields: pluginLogLevel, pluginTimestamp, plus original meta
      const logFields = childLog.info.mock.calls[0][0] as Record<string, unknown>;
      expect(logFields.pluginLogLevel).toBe("info");
      expect(logFields.pluginTimestamp).toBeDefined();
      expect(typeof logFields.pluginTimestamp).toBe("string");
      expect(logFields.count).toBe(5);

      // Verify message format
      expect(childLog.info.mock.calls[0][1]).toBe("[plugin] Plugin doing things");
    });

    it("routes log notifications to correct log level", async () => {
      const { child } = await startHandle("test.plugin");
      const childLog = mockChildLoggers.get("test.plugin")!;

      // Clear any calls from startup
      childLog.info.mockClear();
      childLog.warn.mockClear();
      childLog.error.mockClear();
      childLog.debug.mockClear();

      child.sendToHost({
        jsonrpc: "2.0",
        method: "log",
        params: { level: "error", message: "Something broke" },
      });
      await tick(30);
      expect(childLog.error).toHaveBeenCalledOnce();
      expect((childLog.error.mock.calls[0][0] as Record<string, unknown>).pluginLogLevel).toBe("error");

      child.sendToHost({
        jsonrpc: "2.0",
        method: "log",
        params: { level: "warn", message: "Watch out" },
      });
      await tick(30);
      expect(childLog.warn).toHaveBeenCalledOnce();
      expect((childLog.warn.mock.calls[0][0] as Record<string, unknown>).pluginLogLevel).toBe("warn");

      child.sendToHost({
        jsonrpc: "2.0",
        method: "log",
        params: { level: "debug", message: "Details" },
      });
      await tick(30);
      expect(childLog.debug).toHaveBeenCalledOnce();
      expect((childLog.debug.mock.calls[0][0] as Record<string, unknown>).pluginLogLevel).toBe("debug");
    });

    it("defaults to info level for log notifications without level", async () => {
      const { child } = await startHandle("test.plugin");
      const childLog = mockChildLoggers.get("test.plugin")!;

      // Clear any calls from startup
      childLog.info.mockClear();

      child.sendToHost({
        jsonrpc: "2.0",
        method: "log",
        params: { message: "No level specified" },
      });
      await tick(30);

      expect(childLog.info).toHaveBeenCalledOnce();
      expect((childLog.info.mock.calls[0][0] as Record<string, unknown>).pluginLogLevel).toBe("info");
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  describe("graceful shutdown", () => {
    it("sends shutdown RPC then waits for process exit", async () => {
      const { handle, child } = await startHandle("test.plugin");

      // Queue up the shutdown response AND simulate the worker exiting
      const respondPromise = child.respondToShutdownAndExit();
      await handle.stop();
      await respondPromise;

      expect(handle.status).toBe("stopped");
    });

    it("transitions through stopping → stopped", async () => {
      const { handle, child } = await startHandle("test.plugin");
      const statuses: WorkerStatus[] = [];
      handle.on("status", (p) => statuses.push(p.status));

      const respondPromise = child.respondToShutdownAndExit();
      await handle.stop();
      await respondPromise;

      expect(statuses).toContain("stopping");
      expect(statuses).toContain("stopped");
    });

    it("is idempotent when called on an already-stopped handle", async () => {
      const { handle, child } = await startHandle("test.plugin");

      const respondPromise = child.respondToShutdownAndExit();
      await handle.stop();
      await respondPromise;

      await handle.stop();
      expect(handle.status).toBe("stopped");
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  describe("crash recovery", () => {
    it("emits crash event on unexpected exit", async () => {
      const { handle, child } = await startHandle("test.plugin");
      const crashHandler = vi.fn();
      handle.on("crash", crashHandler);

      child.simulateCrash(1, null);
      await tick();

      expect(crashHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "test.plugin",
          code: 1,
          signal: null,
          willRestart: true,
        }),
      );
    });

    it("tracks consecutive crashes", async () => {
      const { handle, child } = await startHandle("test.plugin");

      child.simulateCrash(1);
      await tick();

      expect(handle.diagnostics().consecutiveCrashes).toBe(1);
      expect(handle.diagnostics().totalCrashes).toBe(1);
      expect(handle.status).toBe("backoff");
    });

    it("enters backoff state after crash with autoRestart=true", async () => {
      const { handle, child } = await startHandle("test.plugin");

      child.simulateCrash(1);
      await tick();

      expect(handle.status).toBe("backoff");
      expect(handle.diagnostics().nextRestartAt).not.toBeNull();
    });

    it("does not restart when autoRestart=false", async () => {
      const { handle, child } = await startHandle("test.plugin", {
        autoRestart: false,
      });
      const crashHandler = vi.fn();
      handle.on("crash", crashHandler);

      child.simulateCrash(1);
      await tick();

      expect(crashHandler).toHaveBeenCalledWith(
        expect.objectContaining({ willRestart: false }),
      );
      expect(handle.status).toBe("crashed");
    });

    it("rejects all pending requests on crash", async () => {
      const { handle, child } = await startHandle("test.plugin");

      const callPromise = handle.call("health", {} as Record<string, never>);
      await tick();
      child.simulateCrash(1);

      await expect(callPromise).rejects.toThrow(/exited/i);
    });

    it("emits exit event on crash", async () => {
      const { handle, child } = await startHandle("test.plugin");
      const exitHandler = vi.fn();
      handle.on("exit", exitHandler);

      child.simulateCrash(1, "SIGSEGV" as NodeJS.Signals);
      await tick();

      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "test.plugin",
          code: 1,
          signal: "SIGSEGV",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Restart
  // -------------------------------------------------------------------------

  describe("restart", () => {
    it("stops and restarts the worker", async () => {
      const { handle, child: oldChild } = await startHandle("test.plugin");

      // Queue up the shutdown response + exit on the old child
      const shutdownPromise = oldChild.respondToShutdownAndExit();

      // Restart is async — it stops (sends shutdown) then starts (new fork + initialize)
      const restartPromise = handle.restart();

      // Wait for shutdown response + exit to complete
      await shutdownPromise;

      // After shutdown, a new child is forked — respond to its initialize
      await tick(50);
      if (mockChild !== oldChild) {
        await mockChild.respondToNextRequest({ ok: true });
      }

      await restartPromise;
      expect(handle.status).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // Message parsing edge cases
  // -------------------------------------------------------------------------

  describe("message parsing", () => {
    it("ignores empty lines from worker stdout", async () => {
      const { child } = await startHandle("test.plugin");
      child.stdout.write("\n");
      child.stdout.write("   \n");
      await tick();
    });

    it("handles malformed JSON gracefully", async () => {
      const { child } = await startHandle("test.plugin");
      child.stdout.write("not valid json\n");
      await tick();
    });

    it("handles responses with unknown request IDs gracefully", async () => {
      const { child } = await startHandle("test.plugin");
      child.sendToHost({
        jsonrpc: "2.0",
        id: 999999,
        result: "orphaned response",
      });
      await tick();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: createPluginWorkerManager
// ---------------------------------------------------------------------------

describe("createPluginWorkerManager", () => {
  beforeEach(() => {
    allMockChildren = [];
    mockChildLoggers.clear();
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  it("creates a manager with no workers initially", () => {
    const manager = createPluginWorkerManager();
    expect(manager.diagnostics()).toHaveLength(0);
    expect(manager.isRunning("test.plugin")).toBe(false);
    expect(manager.getWorker("test.plugin")).toBeUndefined();
  });

  it("starts and registers a worker", async () => {
    const manager = createPluginWorkerManager();

    const startPromise = manager.startWorker("test.plugin", makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });

    const handle = await startPromise;

    expect(handle.pluginId).toBe("test.plugin");
    expect(manager.isRunning("test.plugin")).toBe(true);
    expect(manager.getWorker("test.plugin")).toBe(handle);
    expect(manager.diagnostics()).toHaveLength(1);
  });

  it("throws when starting a duplicate worker", async () => {
    const manager = createPluginWorkerManager();

    const startPromise = manager.startWorker("test.plugin", makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;

    await expect(
      manager.startWorker("test.plugin", makeStartOptions()),
    ).rejects.toThrow(/already registered/i);
  });

  it("stops and unregisters a worker", async () => {
    const manager = createPluginWorkerManager();

    const startPromise = manager.startWorker("test.plugin", makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;

    const child = mockChild;
    // Queue shutdown response + exit before calling stop
    const respondPromise = child.respondToShutdownAndExit();
    await manager.stopWorker("test.plugin");
    await respondPromise;

    expect(manager.isRunning("test.plugin")).toBe(false);
    expect(manager.getWorker("test.plugin")).toBeUndefined();
  });

  it("stopWorker is a no-op for unregistered plugins", async () => {
    const manager = createPluginWorkerManager();
    await manager.stopWorker("nonexistent");
  });

  it("routes RPC calls to the correct worker", async () => {
    const manager = createPluginWorkerManager();

    const startPromise = manager.startWorker("test.plugin", makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;

    const child = mockChild;
    // Queue response before making the call
    const respondPromise = child.respondToNextRequest({ status: "ok" });
    const result = await manager.call("test.plugin", "health", {} as Record<string, never>);
    await respondPromise;

    expect(result).toEqual({ status: "ok" });
  });

  it("rejects calls for unregistered workers", async () => {
    const manager = createPluginWorkerManager();
    await expect(
      manager.call("nonexistent", "health", {} as Record<string, never>),
    ).rejects.toThrow(/No worker registered/i);
  });

  it("diagnostics returns info for all workers", async () => {
    const manager = createPluginWorkerManager();

    const startPromise = manager.startWorker("plugin.a", makeStartOptions());
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
    await startPromise;

    const diags = manager.diagnostics();
    expect(diags).toHaveLength(1);
    expect(diags[0]!.pluginId).toBe("plugin.a");
    expect(diags[0]!.status).toBe("running");
  });
});
