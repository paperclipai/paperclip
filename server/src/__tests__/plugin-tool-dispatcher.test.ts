import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  createPluginToolDispatcher,
  type PluginToolDispatcher,
  type AgentToolDescriptor,
} from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";

// ---------------------------------------------------------------------------
// Mock the plugin-registry module (DB dependency)
// ---------------------------------------------------------------------------

const mockListByStatus = vi.fn();
const mockGetById = vi.fn();

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    listByStatus: mockListByStatus,
    getById: mockGetById,
    getByKey: vi.fn(),
    list: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    updateStatus: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "acme.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin",
    author: "Test Author",
    categories: ["integration"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
    tools: [],
    ...overrides,
  } as PaperclipPluginManifestV1;
}

function makeToolDecl(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: `${name} tool`,
    description: `Description for ${name}`,
    parametersSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeRunContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    agentId: "agent-1",
    runId: "run-1",
    companyId: "company-1",
    projectId: "project-1",
    ...overrides,
  };
}

function makePluginRecord(
  id: string,
  pluginKey: string,
  manifest: PaperclipPluginManifestV1,
): PluginRecord {
  return {
    id,
    pluginKey,
    packageName: `paperclip-plugin-${pluginKey}`,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    categories: manifest.categories,
    manifestJson: manifest,
    status: "ready",
    installOrder: 1,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
  } as PluginRecord;
}

function createMockWorkerManager(
  overrides: Partial<PluginWorkerManager> = {},
): PluginWorkerManager {
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    stopAll: vi.fn(),
    diagnostics: vi.fn().mockReturnValue([]),
    call: vi.fn().mockResolvedValue({ content: "ok" } as ToolResult),
    ...overrides,
  } as unknown as PluginWorkerManager;
}

function createMockLifecycleManager(): {
  manager: PluginLifecycleManager;
  listeners: Map<string, Array<(payload: unknown) => void>>;
} {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  const manager: PluginLifecycleManager = {
    load: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    unload: vi.fn(),
    markError: vi.fn(),
    markUpgradePending: vi.fn(),
    upgrade: vi.fn(),
    getStatus: vi.fn(),
    canTransition: vi.fn(),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const eventListeners = listeners.get(event);
      if (eventListeners) {
        const idx = eventListeners.indexOf(listener);
        if (idx >= 0) eventListeners.splice(idx, 1);
      }
    }),
    once: vi.fn(),
  } as unknown as PluginLifecycleManager;

  return { manager, listeners };
}

/** Simulate emitting a lifecycle event to test listeners. */
function emitLifecycleEvent(
  listeners: Map<string, Array<(payload: unknown) => void>>,
  event: string,
  payload: unknown,
): void {
  const eventListeners = listeners.get(event);
  if (eventListeners) {
    for (const listener of eventListeners) {
      listener(payload);
    }
  }
}

// Fake Db object — the actual DB calls are mocked at the module level
const fakeDb = {} as import("@paperclipai/db").Db;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPluginToolDispatcher", () => {
  let dispatcher: PluginToolDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListByStatus.mockResolvedValue([]);
    mockGetById.mockResolvedValue(null);
  });

  // -----------------------------------------------------------------------
  // Basic creation
  // -----------------------------------------------------------------------

  describe("creation", () => {
    it("creates a dispatcher with no options", () => {
      dispatcher = createPluginToolDispatcher();
      expect(dispatcher).toBeDefined();
      expect(dispatcher.toolCount()).toBe(0);
    });

    it("creates a dispatcher with all options", () => {
      const mockManager = createMockWorkerManager();
      const { manager: mockLifecycle } = createMockLifecycleManager();

      dispatcher = createPluginToolDispatcher({
        workerManager: mockManager,
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });

      expect(dispatcher).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // initialize
  // -----------------------------------------------------------------------

  describe("initialize", () => {
    it("loads tools from ready plugins on initialize", async () => {
      const manifest = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("search-issues"), makeToolDecl("create-issue")],
      });
      const plugin = makePluginRecord("uuid-1", "acme.linear", manifest);

      mockListByStatus.mockResolvedValue([plugin]);

      dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();

      expect(mockListByStatus).toHaveBeenCalledWith("ready");
      expect(dispatcher.toolCount()).toBe(2);
      expect(dispatcher.toolCount("acme.linear")).toBe(2);
    });

    it("loads tools from multiple ready plugins", async () => {
      const linearManifest = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("search-issues")],
      });
      const githubManifest = makeManifest({
        id: "acme.github",
        tools: [makeToolDecl("lookup-pr"), makeToolDecl("create-pr")],
      });

      mockListByStatus.mockResolvedValue([
        makePluginRecord("uuid-1", "acme.linear", linearManifest),
        makePluginRecord("uuid-2", "acme.github", githubManifest),
      ]);

      dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();

      expect(dispatcher.toolCount()).toBe(3);
      expect(dispatcher.toolCount("acme.linear")).toBe(1);
      expect(dispatcher.toolCount("acme.github")).toBe(2);
    });

    it("skips plugins with no tools", async () => {
      const manifest = makeManifest({ id: "acme.empty", tools: [] });
      const plugin = makePluginRecord("uuid-1", "acme.empty", manifest);

      mockListByStatus.mockResolvedValue([plugin]);

      dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();

      expect(dispatcher.toolCount()).toBe(0);
    });

    it("skips plugins with undefined tools", async () => {
      const manifest = makeManifest({ id: "acme.empty", tools: undefined });
      const plugin = makePluginRecord("uuid-1", "acme.empty", manifest);

      mockListByStatus.mockResolvedValue([plugin]);

      dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();

      expect(dispatcher.toolCount()).toBe(0);
    });

    it("subscribes to lifecycle events on initialize", async () => {
      const { manager: mockLifecycle } = createMockLifecycleManager();

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      expect(mockLifecycle.on).toHaveBeenCalledWith("plugin.enabled", expect.any(Function));
      expect(mockLifecycle.on).toHaveBeenCalledWith("plugin.disabled", expect.any(Function));
      expect(mockLifecycle.on).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
    });

    it("is idempotent — second initialize is a no-op", async () => {
      dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();
      await dispatcher.initialize();

      // listByStatus should only be called once
      expect(mockListByStatus).toHaveBeenCalledTimes(1);
    });

    it("works without a db connection", async () => {
      dispatcher = createPluginToolDispatcher();
      await dispatcher.initialize();

      expect(dispatcher.toolCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // teardown
  // -----------------------------------------------------------------------

  describe("teardown", () => {
    it("unsubscribes from lifecycle events on teardown", async () => {
      const { manager: mockLifecycle } = createMockLifecycleManager();

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      dispatcher.teardown();

      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.enabled", expect.any(Function));
      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.disabled", expect.any(Function));
      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
    });

    it("is a no-op when not initialized", () => {
      dispatcher = createPluginToolDispatcher();
      // Should not throw
      dispatcher.teardown();
    });
  });

  // -----------------------------------------------------------------------
  // listToolsForAgent
  // -----------------------------------------------------------------------

  describe("listToolsForAgent", () => {
    it("returns all tools in agent-friendly format", () => {
      dispatcher = createPluginToolDispatcher();

      const manifest = makeManifest({
        id: "acme.linear",
        tools: [
          makeToolDecl("search-issues", {
            displayName: "Search Linear Issues",
            description: "Search issues in Linear",
            parametersSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          }),
        ],
      });

      dispatcher.registerPluginTools("acme.linear", manifest);

      const tools = dispatcher.listToolsForAgent();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: "acme.linear:search-issues",
        displayName: "Search Linear Issues",
        description: "Search issues in Linear",
        parametersSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        pluginId: "acme.linear",
      } satisfies AgentToolDescriptor);
    });

    it("filters by plugin ID", () => {
      dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      const tools = dispatcher.listToolsForAgent({ pluginId: "acme.linear" });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("acme.linear:search");
    });

    it("returns empty array when no tools are registered", () => {
      dispatcher = createPluginToolDispatcher();
      expect(dispatcher.listToolsForAgent()).toEqual([]);
    });

    it("returns empty array for unknown plugin filter", () => {
      dispatcher = createPluginToolDispatcher();
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      expect(dispatcher.listToolsForAgent({ pluginId: "unknown" })).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getTool
  // -----------------------------------------------------------------------

  describe("getTool", () => {
    it("returns the tool by namespaced name", () => {
      dispatcher = createPluginToolDispatcher();
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      const tool = dispatcher.getTool("acme.linear:search");
      expect(tool).not.toBeNull();
      expect(tool!.pluginId).toBe("acme.linear");
      expect(tool!.name).toBe("search");
    });

    it("returns null for unknown tool", () => {
      dispatcher = createPluginToolDispatcher();
      expect(dispatcher.getTool("acme.linear:unknown")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // executeTool
  // -----------------------------------------------------------------------

  describe("executeTool", () => {
    let mockManager: PluginWorkerManager;

    beforeEach(() => {
      mockManager = createMockWorkerManager();
      dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
    });

    it("routes tool execution to the correct plugin worker", async () => {
      const expectedResult: ToolResult = {
        content: "Found 3 issues",
        data: { count: 3 },
      };
      (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

      const result = await dispatcher.executeTool(
        "acme.linear:search",
        { query: "auth bug" },
        makeRunContext(),
      );

      expect(result.pluginId).toBe("acme.linear");
      expect(result.toolName).toBe("search");
      expect(result.result).toEqual(expectedResult);

      expect(mockManager.call).toHaveBeenCalledWith(
        "acme.linear",
        "executeTool",
        {
          toolName: "search",
          parameters: { query: "auth bug" },
          runContext: makeRunContext(),
        },
      );
    });

    it("throws for unregistered tool", async () => {
      await expect(
        dispatcher.executeTool("acme.linear:unknown", {}, makeRunContext()),
      ).rejects.toThrow("not registered");
    });

    it("throws for invalid namespaced name", async () => {
      await expect(
        dispatcher.executeTool("invalid", {}, makeRunContext()),
      ).rejects.toThrow("Invalid tool name");
    });

    it("propagates worker errors", async () => {
      (mockManager.call as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("RPC timeout"),
      );

      await expect(
        dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
      ).rejects.toThrow("RPC timeout");
    });

    it("passes error results through without throwing", async () => {
      const errorResult: ToolResult = { error: "API rate limited" };
      (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(errorResult);

      const result = await dispatcher.executeTool(
        "acme.linear:search",
        {},
        makeRunContext(),
      );

      expect(result.result.error).toBe("API rate limited");
    });
  });

  // -----------------------------------------------------------------------
  // registerPluginTools / unregisterPluginTools
  // -----------------------------------------------------------------------

  describe("registerPluginTools / unregisterPluginTools", () => {
    beforeEach(() => {
      dispatcher = createPluginToolDispatcher();
    });

    it("registers tools from a manifest", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      expect(dispatcher.toolCount("acme.linear")).toBe(1);
      expect(dispatcher.getTool("acme.linear:search")).not.toBeNull();
    });

    it("replaces tools on re-registration", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search"), makeToolDecl("create")],
        }),
      );

      expect(dispatcher.toolCount("acme.linear")).toBe(2);

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("list")] }),
      );

      expect(dispatcher.toolCount("acme.linear")).toBe(1);
      expect(dispatcher.getTool("acme.linear:search")).toBeNull();
      expect(dispatcher.getTool("acme.linear:list")).not.toBeNull();
    });

    it("unregisters all tools for a plugin", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search"), makeToolDecl("create")],
        }),
      );

      dispatcher.unregisterPluginTools("acme.linear");

      expect(dispatcher.toolCount("acme.linear")).toBe(0);
      expect(dispatcher.toolCount()).toBe(0);
    });

    it("unregister is a no-op for unknown plugins", () => {
      dispatcher.unregisterPluginTools("nonexistent");
      expect(dispatcher.toolCount()).toBe(0);
    });

    it("does not affect other plugins when unregistering", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      dispatcher.unregisterPluginTools("acme.linear");

      expect(dispatcher.toolCount()).toBe(1);
      expect(dispatcher.getTool("acme.github:lookup")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle integration
  // -----------------------------------------------------------------------

  describe("lifecycle integration", () => {
    it("registers tools when plugin.enabled is emitted", async () => {
      const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

      const manifest = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("search")],
      });
      const plugin = makePluginRecord("uuid-1", "acme.linear", manifest);
      mockGetById.mockResolvedValue(plugin);

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      // Emit the enabled event
      emitLifecycleEvent(listeners, "plugin.enabled", {
        pluginId: "uuid-1",
        pluginKey: "acme.linear",
      });

      // The registration is async (fire-and-forget), so we need to wait
      await vi.waitFor(() => {
        expect(dispatcher.toolCount("acme.linear")).toBe(1);
      });
    });

    it("unregisters tools when plugin.disabled is emitted", async () => {
      const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      // Pre-register some tools
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      expect(dispatcher.toolCount("acme.linear")).toBe(1);

      // Emit the disabled event
      emitLifecycleEvent(listeners, "plugin.disabled", {
        pluginId: "uuid-1",
        pluginKey: "acme.linear",
        reason: "test",
      });

      expect(dispatcher.toolCount("acme.linear")).toBe(0);
    });

    it("unregisters tools when plugin.unloaded is emitted", async () => {
      const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      // Pre-register some tools
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      // Emit the unloaded event
      emitLifecycleEvent(listeners, "plugin.unloaded", {
        pluginId: "uuid-1",
        pluginKey: "acme.linear",
        removeData: false,
      });

      expect(dispatcher.toolCount("acme.linear")).toBe(0);
    });

    it("handles plugin.enabled when DB lookup fails gracefully", async () => {
      const { manager: mockLifecycle, listeners } = createMockLifecycleManager();
      mockGetById.mockResolvedValue(null);

      dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });
      await dispatcher.initialize();

      // Emit the enabled event — should not throw
      emitLifecycleEvent(listeners, "plugin.enabled", {
        pluginId: "uuid-nonexistent",
        pluginKey: "acme.nonexistent",
      });

      // Wait a bit for async handler to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still have zero tools
      expect(dispatcher.toolCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // toolCount
  // -----------------------------------------------------------------------

  describe("toolCount", () => {
    beforeEach(() => {
      dispatcher = createPluginToolDispatcher();
    });

    it("returns total count when no plugin specified", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("a"), makeToolDecl("b")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("c")] }),
      );

      expect(dispatcher.toolCount()).toBe(3);
    });

    it("returns per-plugin count", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("a"), makeToolDecl("b")] }),
      );

      expect(dispatcher.toolCount("acme.linear")).toBe(2);
    });

    it("returns 0 for unregistered plugin", () => {
      expect(dispatcher.toolCount("nonexistent")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getRegistry
  // -----------------------------------------------------------------------

  describe("getRegistry", () => {
    it("exposes the underlying registry", () => {
      dispatcher = createPluginToolDispatcher();
      const registry = dispatcher.getRegistry();

      expect(registry).toBeDefined();
      expect(registry.listTools).toBeDefined();
      expect(registry.executeTool).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Multi-plugin scenarios
  // -----------------------------------------------------------------------

  describe("multi-plugin scenarios", () => {
    beforeEach(() => {
      dispatcher = createPluginToolDispatcher();
    });

    it("supports tools with the same bare name from different plugins", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("search")] }),
      );

      const tools = dispatcher.listToolsForAgent();
      expect(tools).toHaveLength(2);

      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["acme.github:search", "acme.linear:search"]);
    });

    it("unregistering one plugin leaves others intact", () => {
      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search"), makeToolDecl("create")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
      );

      dispatcher.unregisterPluginTools("acme.linear");

      expect(dispatcher.toolCount()).toBe(1);
      expect(dispatcher.getTool("acme.github:lookup")).not.toBeNull();
      expect(dispatcher.getTool("acme.linear:search")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // AgentToolDescriptor shape
  // -----------------------------------------------------------------------

  describe("AgentToolDescriptor shape", () => {
    it("contains all expected fields", () => {
      dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [
            {
              name: "search-issues",
              displayName: "Search Issues",
              description: "Search for issues in Linear",
              parametersSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query" },
                  limit: { type: "number", default: 10 },
                },
                required: ["query"],
              },
            },
          ],
        }),
      );

      const tools = dispatcher.listToolsForAgent();
      expect(tools[0]).toMatchObject({
        name: "acme.linear:search-issues",
        displayName: "Search Issues",
        description: "Search for issues in Linear",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
        pluginId: "acme.linear",
      });
    });
  });
});
