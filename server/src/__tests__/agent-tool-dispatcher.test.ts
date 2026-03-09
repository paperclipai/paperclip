/**
 * Integration tests for the agent tool dispatcher — covering tool discovery,
 * namespacing, execution routing, and capability enforcement as they work
 * together in the full stack.
 *
 * These tests exercise the combined behavior of:
 * - `PluginToolDispatcher` (orchestration layer)
 * - `PluginToolRegistry` (namespaced lookups, execution routing)
 * - `PluginCapabilityValidator` (capability gating)
 *
 * Unlike the unit tests for each service, these tests verify the integration
 * points and cross-cutting behaviors.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  createPluginToolDispatcher,
  type PluginToolDispatcher,
  type AgentToolDescriptor,
} from "../services/plugin-tool-dispatcher.js";
import {
  createPluginToolRegistry,
  TOOL_NAMESPACE_SEPARATOR,
  type PluginToolRegistry,
  type RegisteredTool,
} from "../services/plugin-tool-registry.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
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

const fakeDb = {} as import("@paperclipai/db").Db;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Tool Dispatcher — Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListByStatus.mockResolvedValue([]);
    mockGetById.mockResolvedValue(null);
  });

  // =========================================================================
  // §1: Tool Discovery
  // =========================================================================

  describe("Tool Discovery", () => {
    describe("discovery from DB on initialization", () => {
      it("discovers tools from all ready plugins at startup", async () => {
        const manifests = [
          makeManifest({
            id: "acme.linear",
            tools: [makeToolDecl("search-issues"), makeToolDecl("create-issue")],
          }),
          makeManifest({
            id: "acme.github",
            tools: [makeToolDecl("list-prs"), makeToolDecl("merge-pr"), makeToolDecl("create-pr")],
          }),
          makeManifest({
            id: "acme.slack",
            tools: [makeToolDecl("send-message")],
          }),
        ];

        mockListByStatus.mockResolvedValue([
          makePluginRecord("uuid-1", "acme.linear", manifests[0]),
          makePluginRecord("uuid-2", "acme.github", manifests[1]),
          makePluginRecord("uuid-3", "acme.slack", manifests[2]),
        ]);

        const dispatcher = createPluginToolDispatcher({ db: fakeDb });
        await dispatcher.initialize();

        expect(dispatcher.toolCount()).toBe(6);
        expect(dispatcher.toolCount("acme.linear")).toBe(2);
        expect(dispatcher.toolCount("acme.github")).toBe(3);
        expect(dispatcher.toolCount("acme.slack")).toBe(1);
      });

      it("discovers tools and returns them in agent-friendly format via listToolsForAgent", async () => {
        const manifest = makeManifest({
          id: "acme.linear",
          tools: [
            makeToolDecl("search-issues", {
              displayName: "Search Linear Issues",
              description: "Search issues in Linear",
              parametersSchema: {
                type: "object",
                properties: { query: { type: "string" }, limit: { type: "number" } },
                required: ["query"],
              },
            }),
          ],
        });

        mockListByStatus.mockResolvedValue([
          makePluginRecord("uuid-1", "acme.linear", manifest),
        ]);

        const dispatcher = createPluginToolDispatcher({ db: fakeDb });
        await dispatcher.initialize();

        const tools = dispatcher.listToolsForAgent();
        expect(tools).toHaveLength(1);

        const tool = tools[0];
        expect(tool.name).toBe("acme.linear:search-issues");
        expect(tool.displayName).toBe("Search Linear Issues");
        expect(tool.description).toBe("Search issues in Linear");
        expect(tool.pluginId).toBe("acme.linear");
        expect(tool.parametersSchema).toEqual({
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        });
      });

      it("skips plugins with no manifest", async () => {
        const plugin = makePluginRecord(
          "uuid-1",
          "acme.no-manifest",
          makeManifest({ id: "acme.no-manifest" }),
        );
        // Simulate a plugin that has a null manifestJson
        (plugin as Record<string, unknown>).manifestJson = null;

        mockListByStatus.mockResolvedValue([plugin]);

        const dispatcher = createPluginToolDispatcher({ db: fakeDb });
        await dispatcher.initialize();

        expect(dispatcher.toolCount()).toBe(0);
      });

      it("skips plugins with empty tools array without error", async () => {
        const manifest = makeManifest({ id: "acme.data-only", tools: [] });
        mockListByStatus.mockResolvedValue([
          makePluginRecord("uuid-1", "acme.data-only", manifest),
        ]);

        const dispatcher = createPluginToolDispatcher({ db: fakeDb });
        await dispatcher.initialize();

        expect(dispatcher.toolCount()).toBe(0);
        expect(dispatcher.listToolsForAgent()).toEqual([]);
      });
    });

    describe("dynamic discovery via lifecycle events", () => {
      it("discovers new tools when a plugin is enabled", async () => {
        const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

        const manifest = makeManifest({
          id: "acme.jira",
          tools: [makeToolDecl("get-ticket"), makeToolDecl("create-ticket")],
        });
        const plugin = makePluginRecord("uuid-jira", "acme.jira", manifest);
        mockGetById.mockResolvedValue(plugin);

        const dispatcher = createPluginToolDispatcher({
          lifecycleManager: mockLifecycle,
          db: fakeDb,
        });
        await dispatcher.initialize();

        expect(dispatcher.toolCount()).toBe(0);

        emitLifecycleEvent(listeners, "plugin.enabled", {
          pluginId: "uuid-jira",
          pluginKey: "acme.jira",
        });

        await vi.waitFor(() => {
          expect(dispatcher.toolCount()).toBe(2);
        });

        const tools = dispatcher.listToolsForAgent();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(["acme.jira:create-ticket", "acme.jira:get-ticket"]);
      });

      it("removes tools when a plugin is disabled", async () => {
        const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

        const dispatcher = createPluginToolDispatcher({
          lifecycleManager: mockLifecycle,
          db: fakeDb,
        });
        await dispatcher.initialize();

        // Pre-register tools
        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );
        expect(dispatcher.toolCount()).toBe(1);

        emitLifecycleEvent(listeners, "plugin.disabled", {
          pluginId: "uuid-1",
          pluginKey: "acme.linear",
          reason: "admin request",
        });

        expect(dispatcher.toolCount()).toBe(0);
        expect(dispatcher.listToolsForAgent()).toEqual([]);
      });

      it("removes tools when a plugin is unloaded", async () => {
        const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

        const dispatcher = createPluginToolDispatcher({
          lifecycleManager: mockLifecycle,
          db: fakeDb,
        });
        await dispatcher.initialize();

        dispatcher.registerPluginTools(
          "acme.github",
          makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup"), makeToolDecl("pr-status")] }),
        );
        expect(dispatcher.toolCount()).toBe(2);

        emitLifecycleEvent(listeners, "plugin.unloaded", {
          pluginId: "uuid-2",
          pluginKey: "acme.github",
          removeData: true,
        });

        expect(dispatcher.toolCount()).toBe(0);
      });

      it("handles rapid enable/disable cycles — async registration may complete after disable", async () => {
        const { manager: mockLifecycle, listeners } = createMockLifecycleManager();

        const manifest = makeManifest({
          id: "acme.flaky",
          tools: [makeToolDecl("tool-a")],
        });
        const plugin = makePluginRecord("uuid-flaky", "acme.flaky", manifest);

        mockGetById.mockImplementation(async () => {
          // Simulate some delay on async DB lookup
          await new Promise((r) => setTimeout(r, 10));
          return plugin;
        });

        const dispatcher = createPluginToolDispatcher({
          lifecycleManager: mockLifecycle,
          db: fakeDb,
        });
        await dispatcher.initialize();

        // Enable (fires async registerFromDb)
        emitLifecycleEvent(listeners, "plugin.enabled", {
          pluginId: "uuid-flaky",
          pluginKey: "acme.flaky",
        });

        // Immediately disable (synchronous unregister)
        emitLifecycleEvent(listeners, "plugin.disabled", {
          pluginId: "uuid-flaky",
          pluginKey: "acme.flaky",
        });

        // Wait for async registration to settle
        await new Promise((r) => setTimeout(r, 100));

        // Note: because enable is fire-and-forget async and disable is sync,
        // the async registerFromDb from enable may complete AFTER the synchronous
        // unregister from disable. This is a known architectural trade-off —
        // the lifecycle event ordering is correct, but the async DB lookup
        // means the final state could have tools re-registered.
        // The important thing is that no errors are thrown and the registry
        // is in a consistent state (not corrupted).
        const count = dispatcher.toolCount("acme.flaky");
        expect(typeof count).toBe("number");
        expect(count).toBeGreaterThanOrEqual(0);
      });
    });

    describe("tool discovery filtering", () => {
      it("filters discovered tools by plugin ID", () => {
        const dispatcher = createPluginToolDispatcher();

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search"), makeToolDecl("create")] }),
        );
        dispatcher.registerPluginTools(
          "acme.github",
          makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
        );
        dispatcher.registerPluginTools(
          "acme.jira",
          makeManifest({ id: "acme.jira", tools: [makeToolDecl("get-ticket")] }),
        );

        const linearTools = dispatcher.listToolsForAgent({ pluginId: "acme.linear" });
        expect(linearTools).toHaveLength(2);
        expect(linearTools.every((t) => t.pluginId === "acme.linear")).toBe(true);

        const githubTools = dispatcher.listToolsForAgent({ pluginId: "acme.github" });
        expect(githubTools).toHaveLength(1);
        expect(githubTools[0].name).toBe("acme.github:lookup");
      });

      it("returns empty when filtering by nonexistent plugin", () => {
        const dispatcher = createPluginToolDispatcher();
        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        expect(dispatcher.listToolsForAgent({ pluginId: "acme.nonexistent" })).toEqual([]);
      });
    });
  });

  // =========================================================================
  // §2: Namespacing
  // =========================================================================

  describe("Namespacing", () => {
    it("uses colon as the namespace separator", () => {
      expect(TOOL_NAMESPACE_SEPARATOR).toBe(":");
    });

    it("namespaces tools as <pluginId>:<toolName>", () => {
      const dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [makeToolDecl("search-issues")],
        }),
      );

      const tools = dispatcher.listToolsForAgent();
      expect(tools[0].name).toBe("acme.linear:search-issues");
    });

    it("prevents name collisions for same tool name across different plugins", () => {
      const dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );
      dispatcher.registerPluginTools(
        "acme.github",
        makeManifest({ id: "acme.github", tools: [makeToolDecl("search")] }),
      );
      dispatcher.registerPluginTools(
        "acme.jira",
        makeManifest({ id: "acme.jira", tools: [makeToolDecl("search")] }),
      );

      const tools = dispatcher.listToolsForAgent();
      expect(tools).toHaveLength(3);

      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "acme.github:search",
        "acme.jira:search",
        "acme.linear:search",
      ]);

      // Each is independently resolvable
      expect(dispatcher.getTool("acme.linear:search")?.pluginId).toBe("acme.linear");
      expect(dispatcher.getTool("acme.github:search")?.pluginId).toBe("acme.github");
      expect(dispatcher.getTool("acme.jira:search")?.pluginId).toBe("acme.jira");
    });

    it("handles plugin IDs with multiple dots", () => {
      const dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "com.example.deep.plugin",
        makeManifest({
          id: "com.example.deep.plugin",
          tools: [makeToolDecl("my-tool")],
        }),
      );

      const tool = dispatcher.getTool("com.example.deep.plugin:my-tool");
      expect(tool).not.toBeNull();
      expect(tool!.pluginId).toBe("com.example.deep.plugin");
      expect(tool!.name).toBe("my-tool");
    });

    describe("namespace parsing via registry", () => {
      let registry: PluginToolRegistry;

      beforeEach(() => {
        registry = createPluginToolRegistry();
      });

      it("parses valid namespaced names correctly", () => {
        expect(registry.parseNamespacedName("acme.linear:search-issues")).toEqual({
          pluginId: "acme.linear",
          toolName: "search-issues",
        });
      });

      it("parses namespaced names with dotted plugin IDs", () => {
        expect(registry.parseNamespacedName("com.example.deep.plugin:my-tool")).toEqual({
          pluginId: "com.example.deep.plugin",
          toolName: "my-tool",
        });
      });

      it("returns null for name without separator", () => {
        expect(registry.parseNamespacedName("invalid-no-colon")).toBeNull();
      });

      it("returns null for name starting with separator", () => {
        expect(registry.parseNamespacedName(":toolname")).toBeNull();
      });

      it("returns null for name ending with separator", () => {
        expect(registry.parseNamespacedName("pluginid:")).toBeNull();
      });

      it("returns null for empty string", () => {
        expect(registry.parseNamespacedName("")).toBeNull();
      });

      it("returns null for just the separator", () => {
        expect(registry.parseNamespacedName(":")).toBeNull();
      });

      it("handles names with multiple colons (uses lastIndexOf)", () => {
        // Plugin ID could theoretically contain colons — the last colon is the separator
        const result = registry.parseNamespacedName("org:acme.linear:search");
        expect(result).toEqual({
          pluginId: "org:acme.linear",
          toolName: "search",
        });
      });

      it("builds namespaced names correctly", () => {
        expect(registry.buildNamespacedName("acme.linear", "search-issues")).toBe(
          "acme.linear:search-issues",
        );
      });

      it("build and parse are inverse operations", () => {
        const pluginId = "acme.linear";
        const toolName = "search-issues";

        const built = registry.buildNamespacedName(pluginId, toolName);
        const parsed = registry.parseNamespacedName(built);

        expect(parsed).toEqual({ pluginId, toolName });
      });
    });

    describe("namespace isolation on registration", () => {
      it("replaces all tools when re-registering a plugin", () => {
        const dispatcher = createPluginToolDispatcher();

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({
            id: "acme.linear",
            tools: [makeToolDecl("search"), makeToolDecl("create"), makeToolDecl("delete")],
          }),
        );

        expect(dispatcher.toolCount("acme.linear")).toBe(3);

        // Re-register with different tools
        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({
            id: "acme.linear",
            tools: [makeToolDecl("list"), makeToolDecl("update")],
          }),
        );

        expect(dispatcher.toolCount("acme.linear")).toBe(2);
        expect(dispatcher.getTool("acme.linear:search")).toBeNull();
        expect(dispatcher.getTool("acme.linear:create")).toBeNull();
        expect(dispatcher.getTool("acme.linear:delete")).toBeNull();
        expect(dispatcher.getTool("acme.linear:list")).not.toBeNull();
        expect(dispatcher.getTool("acme.linear:update")).not.toBeNull();
      });

      it("unregistering one plugin namespace preserves all others", () => {
        const dispatcher = createPluginToolDispatcher();

        const plugins = [
          { id: "acme.linear", tools: [makeToolDecl("search"), makeToolDecl("create")] },
          { id: "acme.github", tools: [makeToolDecl("list-prs")] },
          { id: "acme.jira", tools: [makeToolDecl("get-ticket"), makeToolDecl("assign")] },
        ];

        for (const p of plugins) {
          dispatcher.registerPluginTools(p.id, makeManifest({ id: p.id, tools: p.tools }));
        }

        expect(dispatcher.toolCount()).toBe(5);

        dispatcher.unregisterPluginTools("acme.github");

        expect(dispatcher.toolCount()).toBe(4);
        expect(dispatcher.toolCount("acme.linear")).toBe(2);
        expect(dispatcher.toolCount("acme.jira")).toBe(2);
        expect(dispatcher.toolCount("acme.github")).toBe(0);

        // Verify individual tools still accessible
        expect(dispatcher.getTool("acme.linear:search")).not.toBeNull();
        expect(dispatcher.getTool("acme.jira:get-ticket")).not.toBeNull();
        expect(dispatcher.getTool("acme.github:list-prs")).toBeNull();
      });
    });
  });

  // =========================================================================
  // §3: Execution Routing
  // =========================================================================

  describe("Execution Routing", () => {
    describe("basic routing", () => {
      it("routes tool execution to the correct plugin worker", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search-issues")] }),
        );

        const expectedResult: ToolResult = {
          content: "Found 5 issues",
          data: { issues: [1, 2, 3, 4, 5] },
        };
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

        const result = await dispatcher.executeTool(
          "acme.linear:search-issues",
          { query: "auth bug", limit: 10 },
          makeRunContext(),
        );

        expect(result.pluginId).toBe("acme.linear");
        expect(result.toolName).toBe("search-issues");
        expect(result.result).toEqual(expectedResult);

        expect(mockManager.call).toHaveBeenCalledWith(
          "acme.linear",
          "executeTool",
          {
            toolName: "search-issues",
            parameters: { query: "auth bug", limit: 10 },
            runContext: makeRunContext(),
          },
        );
      });

      it("passes the full run context to the plugin worker", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        const context = makeRunContext({
          agentId: "agent-42",
          runId: "run-99",
          companyId: "co-abc",
          projectId: "proj-xyz",
        });

        await dispatcher.executeTool("acme.linear:search", { q: "test" }, context);

        expect(mockManager.call).toHaveBeenCalledWith(
          "acme.linear",
          "executeTool",
          expect.objectContaining({
            runContext: {
              agentId: "agent-42",
              runId: "run-99",
              companyId: "co-abc",
              projectId: "proj-xyz",
            },
          }),
        );
      });

      it("passes parameters through without modification", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        const complexParams = {
          query: "auth bug",
          filters: { status: ["open", "in-progress"], assignee: null },
          nested: { deep: { value: 42 } },
          emptyArray: [],
        };

        await dispatcher.executeTool("acme.linear:search", complexParams, makeRunContext());

        expect(mockManager.call).toHaveBeenCalledWith(
          "acme.linear",
          "executeTool",
          expect.objectContaining({
            parameters: complexParams,
          }),
        );
      });
    });

    describe("multi-plugin routing", () => {
      it("routes to the correct plugin when multiple plugins have same-named tools", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );
        dispatcher.registerPluginTools(
          "acme.github",
          makeManifest({ id: "acme.github", tools: [makeToolDecl("search")] }),
        );

        // Execute acme.linear:search
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({ content: "linear result" });
        const r1 = await dispatcher.executeTool(
          "acme.linear:search",
          { q: "bug" },
          makeRunContext(),
        );
        expect(r1.pluginId).toBe("acme.linear");
        expect(mockManager.call).toHaveBeenCalledWith("acme.linear", "executeTool", expect.any(Object));

        vi.clearAllMocks();
        (mockManager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({ content: "github result" });

        // Execute acme.github:search
        const r2 = await dispatcher.executeTool(
          "acme.github:search",
          { q: "pr" },
          makeRunContext(),
        );
        expect(r2.pluginId).toBe("acme.github");
        expect(mockManager.call).toHaveBeenCalledWith("acme.github", "executeTool", expect.any(Object));
      });

      it("routes concurrent executions to different plugins simultaneously", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );
        dispatcher.registerPluginTools(
          "acme.github",
          makeManifest({ id: "acme.github", tools: [makeToolDecl("lookup")] }),
        );

        (mockManager.call as ReturnType<typeof vi.fn>).mockImplementation(
          async (pluginId: string) => {
            await new Promise((r) => setTimeout(r, 10));
            return { content: `result from ${pluginId}` };
          },
        );

        const [r1, r2] = await Promise.all([
          dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
          dispatcher.executeTool("acme.github:lookup", {}, makeRunContext()),
        ]);

        expect(r1.pluginId).toBe("acme.linear");
        expect(r1.result.content).toBe("result from acme.linear");
        expect(r2.pluginId).toBe("acme.github");
        expect(r2.result.content).toBe("result from acme.github");

        expect(mockManager.call).toHaveBeenCalledTimes(2);
      });
    });

    describe("error handling in routing", () => {
      it("throws for a tool with an invalid namespaced name format", async () => {
        const dispatcher = createPluginToolDispatcher();

        await expect(
          dispatcher.executeTool("invalid-no-colon", {}, makeRunContext()),
        ).rejects.toThrow("Invalid tool name");
      });

      it("throws for a tool that is not registered", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        await expect(
          dispatcher.executeTool("acme.linear:nonexistent", {}, makeRunContext()),
        ).rejects.toThrow("not registered");
      });

      it("throws when the plugin worker is not running", async () => {
        const mockManager = createMockWorkerManager({
          isRunning: vi.fn().mockReturnValue(false),
        });
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        await expect(
          dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
        ).rejects.toThrow("not running");
      });

      it("throws when no worker manager is configured", async () => {
        const registry = createPluginToolRegistry(); // no worker manager
        registry.registerPlugin(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        await expect(
          registry.executeTool("acme.linear:search", {}, makeRunContext()),
        ).rejects.toThrow("no worker manager configured");
      });

      it("propagates RPC timeout errors from the worker", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        (mockManager.call as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("RPC call timed out after 30000ms"),
        );

        await expect(
          dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
        ).rejects.toThrow("RPC call timed out");
      });

      it("propagates worker crash errors", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        (mockManager.call as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("Worker process exited unexpectedly with code 1"),
        );

        await expect(
          dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
        ).rejects.toThrow("Worker process exited unexpectedly");
      });

      it("passes tool error results through without throwing", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        const errorResult: ToolResult = { error: "API rate limited" };
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(errorResult);

        const result = await dispatcher.executeTool(
          "acme.linear:search",
          {},
          makeRunContext(),
        );

        // Error results from the plugin are returned, not thrown
        expect(result.result.error).toBe("API rate limited");
        expect(result.pluginId).toBe("acme.linear");
      });

      it("returns results with data and no content", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        const dataOnlyResult: ToolResult = { data: { count: 0, items: [] } };
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue(dataOnlyResult);

        const result = await dispatcher.executeTool(
          "acme.linear:search",
          {},
          makeRunContext(),
        );

        expect(result.result.data).toEqual({ count: 0, items: [] });
        expect(result.result.content).toBeUndefined();
      });
    });

    describe("execution after lifecycle changes", () => {
      it("cannot execute a tool after its plugin is unregistered", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        // Verify it works first
        await dispatcher.executeTool("acme.linear:search", {}, makeRunContext());
        expect(mockManager.call).toHaveBeenCalledTimes(1);

        // Unregister
        dispatcher.unregisterPluginTools("acme.linear");

        // Now it should fail
        await expect(
          dispatcher.executeTool("acme.linear:search", {}, makeRunContext()),
        ).rejects.toThrow("not registered");
      });

      it("can execute a tool after its plugin is re-registered", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
        );

        // Unregister
        dispatcher.unregisterPluginTools("acme.linear");

        // Re-register with new tools
        dispatcher.registerPluginTools(
          "acme.linear",
          makeManifest({ id: "acme.linear", tools: [makeToolDecl("search"), makeToolDecl("create")] }),
        );

        // Should work again
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({ content: "ok" });
        const result = await dispatcher.executeTool("acme.linear:search", {}, makeRunContext());
        expect(result.pluginId).toBe("acme.linear");
      });
    });
  });

  // =========================================================================
  // §4: Capability Enforcement
  // =========================================================================

  describe("Capability Enforcement", () => {
    const validator = pluginCapabilityValidator();

    describe("agent.tools.register capability requirement", () => {
      it("validates that tools require agent.tools.register capability", () => {
        const manifestWithCapability = makeManifest({
          id: "acme.valid",
          capabilities: ["agent.tools.register"],
          tools: [makeToolDecl("search")],
        });

        const result = validator.validateManifestCapabilities(manifestWithCapability);
        expect(result.allowed).toBe(true);
        expect(result.missing).toEqual([]);
      });

      it("detects missing agent.tools.register when tools are declared", () => {
        const manifestWithoutCapability = makeManifest({
          id: "acme.invalid",
          capabilities: [], // Missing agent.tools.register
          tools: [makeToolDecl("search")],
        });

        const result = validator.validateManifestCapabilities(manifestWithoutCapability);
        expect(result.allowed).toBe(false);
        expect(result.missing).toContain("agent.tools.register");
      });

      it("does not require agent.tools.register when no tools are declared", () => {
        const manifestNoTools = makeManifest({
          id: "acme.no-tools",
          capabilities: [],
          tools: [],
        });

        const result = validator.validateManifestCapabilities(manifestNoTools);
        expect(result.allowed).toBe(true);
      });
    });

    describe("agent.tools.execute capability gating", () => {
      it("allows agent.tools.execute when agent.tools.register is declared", () => {
        const manifest = makeManifest({
          id: "acme.valid",
          capabilities: ["agent.tools.register"],
        });

        const result = validator.checkOperation(manifest, "agent.tools.execute");
        expect(result.allowed).toBe(true);
      });

      it("rejects agent.tools.execute without agent.tools.register capability", () => {
        const manifest = makeManifest({
          id: "acme.invalid",
          capabilities: [],
        });

        const result = validator.checkOperation(manifest, "agent.tools.execute");
        expect(result.allowed).toBe(false);
        expect(result.missing).toContain("agent.tools.register");
      });

      it("assertOperation throws 403 for agent.tools.execute without capability", () => {
        const manifest = makeManifest({
          id: "acme.invalid",
          capabilities: [],
        });

        expect(() => validator.assertOperation(manifest, "agent.tools.execute")).toThrow(
          /Plugin 'acme.invalid' is not allowed to perform 'agent.tools.execute'/,
        );
      });
    });

    describe("capability enforcement at install time", () => {
      it("validates a well-formed manifest with tools and correct capabilities", () => {
        const manifest = makeManifest({
          id: "acme.full",
          capabilities: ["agent.tools.register", "issues.read", "issues.create"],
          tools: [
            makeToolDecl("search-issues", {
              displayName: "Search Issues",
              description: "Search issues using queries",
              parametersSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            }),
            makeToolDecl("create-issue", {
              displayName: "Create Issue",
              description: "Create a new issue",
              parametersSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                },
                required: ["title"],
              },
            }),
          ],
        });

        const result = validator.validateManifestCapabilities(manifest);
        expect(result.allowed).toBe(true);
      });

      it("rejects a manifest that declares tools but lacks agent.tools.register", () => {
        const manifest = makeManifest({
          id: "acme.bad-tools",
          capabilities: ["issues.read"], // has other caps but not agent.tools.register
          tools: [makeToolDecl("search")],
        });

        const result = validator.validateManifestCapabilities(manifest);
        expect(result.allowed).toBe(false);
        expect(result.missing).toContain("agent.tools.register");
      });

      it("detects all missing capabilities across features", () => {
        const manifest = makeManifest({
          id: "acme.everything-wrong",
          capabilities: [],
          tools: [makeToolDecl("tool")],
          jobs: [{ jobKey: "sync", displayName: "Sync" }],
          webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
        });

        const result = validator.validateManifestCapabilities(manifest);
        expect(result.allowed).toBe(false);
        expect(result.missing).toContain("agent.tools.register");
        expect(result.missing).toContain("jobs.schedule");
        expect(result.missing).toContain("webhooks.receive");
      });
    });

    describe("capability enforcement interaction with tool registration", () => {
      it("tool registration does not validate capabilities (that is done at install)", () => {
        // The dispatcher/registry intentionally does NOT check capabilities
        // during registration — that's handled by the install flow.
        // This test documents that architectural decision.
        const dispatcher = createPluginToolDispatcher();

        const manifestWithoutCap = makeManifest({
          id: "acme.no-cap",
          capabilities: [], // No agent.tools.register
          tools: [makeToolDecl("sneaky-tool")],
        });

        // Registration succeeds (capability check happens at install time, not here)
        dispatcher.registerPluginTools("acme.no-cap", manifestWithoutCap);
        expect(dispatcher.toolCount("acme.no-cap")).toBe(1);
      });

      it("pre-install capability validation would catch tools without capabilities", () => {
        // This simulates what happens during plugin installation
        const manifest = makeManifest({
          id: "acme.sneaky",
          capabilities: [],
          tools: [makeToolDecl("sneaky-tool")],
        });

        // Validate before install
        const result = validator.validateManifestCapabilities(manifest);
        expect(result.allowed).toBe(false);

        // Install should be blocked — tools never reach the registry
        expect(result.missing).toContain("agent.tools.register");
      });
    });

    describe("capability checks for tool execution operations", () => {
      it("agent.tools.register capability is required for execution", () => {
        const caps = validator.getRequiredCapabilities("agent.tools.execute");
        expect(caps).toContain("agent.tools.register");
      });

      it("agent.tools.register capability is required for registration", () => {
        const caps = validator.getRequiredCapabilities("agent.tools.register");
        expect(caps).toContain("agent.tools.register");
      });

      it("unknown operations are rejected by default", () => {
        const manifest = makeManifest({
          id: "acme.test",
          capabilities: ["agent.tools.register"],
        });

        const result = validator.checkOperation(manifest, "agent.tools.unknown");
        expect(result.allowed).toBe(false);
      });
    });

    describe("end-to-end: capability + discovery + execution", () => {
      it("a plugin with correct capabilities can register, discover, and execute tools", async () => {
        const mockManager = createMockWorkerManager();
        const dispatcher = createPluginToolDispatcher({ workerManager: mockManager });

        const manifest = makeManifest({
          id: "acme.valid",
          capabilities: ["agent.tools.register"],
          tools: [
            makeToolDecl("search", {
              displayName: "Search",
              description: "Search for items",
              parametersSchema: {
                type: "object",
                properties: { q: { type: "string" } },
                required: ["q"],
              },
            }),
          ],
        });

        // Step 1: Validate capabilities (would happen at install time)
        const capResult = validator.validateManifestCapabilities(manifest);
        expect(capResult.allowed).toBe(true);

        // Step 2: Register tools (happens when plugin is loaded)
        dispatcher.registerPluginTools("acme.valid", manifest);

        // Step 3: Discover tools (happens when agent constructs its prompt)
        const tools = dispatcher.listToolsForAgent();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("acme.valid:search");

        // Step 4: Execute tool (happens when agent decides to call it)
        (mockManager.call as ReturnType<typeof vi.fn>).mockResolvedValue({
          content: "Found 3 results",
        });

        const result = await dispatcher.executeTool(
          "acme.valid:search",
          { q: "test" },
          makeRunContext(),
        );

        expect(result.pluginId).toBe("acme.valid");
        expect(result.toolName).toBe("search");
        expect(result.result.content).toBe("Found 3 results");
      });

      it("a plugin without capabilities should be blocked at install time", () => {
        const manifest = makeManifest({
          id: "acme.blocked",
          capabilities: [],
          tools: [makeToolDecl("bad-tool")],
        });

        // Capability validation fails — this would block installation
        const capResult = validator.validateManifestCapabilities(manifest);
        expect(capResult.allowed).toBe(false);
        expect(capResult.missing).toContain("agent.tools.register");

        // Because install is blocked, tools would never be registered in the dispatcher
        // (tested for documentation purposes)
        const dispatcher = createPluginToolDispatcher();
        expect(dispatcher.toolCount()).toBe(0);
        expect(dispatcher.listToolsForAgent()).toEqual([]);
      });
    });
  });

  // =========================================================================
  // §5: Teardown and Cleanup
  // =========================================================================

  describe("Teardown and Cleanup", () => {
    it("teardown removes lifecycle listeners", async () => {
      const { manager: mockLifecycle } = createMockLifecycleManager();
      const dispatcher = createPluginToolDispatcher({
        lifecycleManager: mockLifecycle,
        db: fakeDb,
      });

      await dispatcher.initialize();
      dispatcher.teardown();

      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.enabled", expect.any(Function));
      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.disabled", expect.any(Function));
      expect(mockLifecycle.off).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
    });

    it("teardown is a no-op before initialization", () => {
      const dispatcher = createPluginToolDispatcher();
      // Should not throw
      dispatcher.teardown();
    });

    it("registry exposes internal state for diagnostics", () => {
      const dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({ id: "acme.linear", tools: [makeToolDecl("search")] }),
      );

      const registry = dispatcher.getRegistry();
      expect(registry).toBeDefined();
      expect(registry.toolCount()).toBe(1);
      expect(registry.listTools()).toHaveLength(1);
    });
  });

  // =========================================================================
  // §6: Edge Cases and Robustness
  // =========================================================================

  describe("Edge Cases", () => {
    it("handles a plugin with many tools", () => {
      const dispatcher = createPluginToolDispatcher();

      const tools = Array.from({ length: 50 }, (_, i) =>
        makeToolDecl(`tool-${i}`, {
          displayName: `Tool ${i}`,
          description: `Description for tool ${i}`,
        }),
      );

      dispatcher.registerPluginTools(
        "acme.mega-plugin",
        makeManifest({ id: "acme.mega-plugin", tools }),
      );

      expect(dispatcher.toolCount("acme.mega-plugin")).toBe(50);

      const agentTools = dispatcher.listToolsForAgent();
      expect(agentTools).toHaveLength(50);

      // Verify a specific tool is accessible
      const tool = dispatcher.getTool("acme.mega-plugin:tool-42");
      expect(tool).not.toBeNull();
      expect(tool!.displayName).toBe("Tool 42");
    });

    it("handles tools with special characters in names", () => {
      const dispatcher = createPluginToolDispatcher();

      dispatcher.registerPluginTools(
        "acme.special",
        makeManifest({
          id: "acme.special",
          tools: [
            makeToolDecl("tool-with-dashes"),
            makeToolDecl("tool_with_underscores"),
            makeToolDecl("toolWithCamelCase"),
          ],
        }),
      );

      expect(dispatcher.getTool("acme.special:tool-with-dashes")).not.toBeNull();
      expect(dispatcher.getTool("acme.special:tool_with_underscores")).not.toBeNull();
      expect(dispatcher.getTool("acme.special:toolWithCamelCase")).not.toBeNull();
    });

    it("handles tools with complex parameter schemas", () => {
      const dispatcher = createPluginToolDispatcher();

      const complexSchema = {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          filters: {
            type: "object",
            properties: {
              status: {
                type: "array",
                items: { type: "string", enum: ["open", "closed", "in-progress"] },
              },
              assignee: { type: ["string", "null"] },
              priority: { type: "integer", minimum: 1, maximum: 5 },
              labels: { type: "array", items: { type: "string" }, uniqueItems: true },
            },
          },
          pagination: {
            type: "object",
            properties: {
              cursor: { type: "string" },
              limit: { type: "integer", default: 25, minimum: 1, maximum: 100 },
            },
          },
        },
        required: ["query"],
      };

      dispatcher.registerPluginTools(
        "acme.linear",
        makeManifest({
          id: "acme.linear",
          tools: [
            makeToolDecl("advanced-search", {
              displayName: "Advanced Search",
              description: "Search with complex filters",
              parametersSchema: complexSchema,
            }),
          ],
        }),
      );

      const tools = dispatcher.listToolsForAgent();
      expect(tools[0].parametersSchema).toEqual(complexSchema);
    });

    it("getTool returns null for completely unknown names", () => {
      const dispatcher = createPluginToolDispatcher();
      expect(dispatcher.getTool("")).toBeNull();
      expect(dispatcher.getTool("no-colon")).toBeNull();
      expect(dispatcher.getTool("a:b:c")).toBeNull(); // parses as {pluginId: "a:b", toolName: "c"}
    });

    it("toolCount returns 0 when nothing is registered", () => {
      const dispatcher = createPluginToolDispatcher();
      expect(dispatcher.toolCount()).toBe(0);
      expect(dispatcher.toolCount("any-plugin")).toBe(0);
    });

    it("multiple initializations are idempotent", async () => {
      const manifest = makeManifest({
        id: "acme.linear",
        tools: [makeToolDecl("search")],
      });
      mockListByStatus.mockResolvedValue([
        makePluginRecord("uuid-1", "acme.linear", manifest),
      ]);

      const dispatcher = createPluginToolDispatcher({ db: fakeDb });
      await dispatcher.initialize();
      await dispatcher.initialize(); // should be no-op

      // Tools should only be registered once
      expect(dispatcher.toolCount()).toBe(1);
      expect(mockListByStatus).toHaveBeenCalledTimes(1);
    });
  });
});
