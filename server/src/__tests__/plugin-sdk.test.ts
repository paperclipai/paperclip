/**
 * Tests for @paperclipai/plugin-sdk
 *
 * Covers:
 * - definePlugin() factory: return shape, Object.freeze, lifecycle hooks
 * - PluginHealthDiagnostics shape and status variants
 * - PluginConfigValidationResult shape
 * - PluginWebhookInput shape
 * - Constants re-exports (PLUGIN_CAPABILITIES, PLUGIN_EVENT_TYPES, etc.)
 * - Zod re-export
 * - PluginContext mock integration (event registration, job registration,
 *   data handlers, action handlers, tool handlers)
 * - ScopeKey shape
 * - PluginEvent envelope shape
 * - PluginJobContext shape
 * - ToolRunContext / ToolResult shapes
 * - PluginEntityUpsert / PluginEntityRecord shapes
 *
 * @see doc/plugins/PLUGIN_SPEC.md §14 — SDK Surface
 */

import { describe, expect, it, vi } from "vitest";
import {
  definePlugin,
  createTestHarness,
  PLUGIN_CAPABILITIES,
  PLUGIN_CATEGORIES,
  PLUGIN_EVENT_TYPES,
  PLUGIN_STATUSES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_STATE_SCOPE_KINDS,
  PLUGIN_JOB_STATUSES,
  PLUGIN_JOB_RUN_STATUSES,
  PLUGIN_JOB_RUN_TRIGGERS,
  PLUGIN_WEBHOOK_DELIVERY_STATUSES,
  PLUGIN_BRIDGE_ERROR_CODES,
  PLUGIN_API_VERSION,
  z,
} from "@paperclipai/plugin-sdk";

import type {
  PluginDefinition,
  PaperclipPlugin,
  PluginContext,
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
  PluginEvent,
  PluginJobContext,
  ToolRunContext,
  ToolResult,
  ScopeKey,
  PluginEntityUpsert,
  PluginEntityRecord,
  PluginEntityQuery,
  PluginWorkspace,
  EventFilter,
} from "@paperclipai/plugin-sdk";

// ===========================================================================
// Helpers — mock PluginContext
// ===========================================================================

/**
 * Build a minimal mock PluginContext suitable for exercising definePlugin()
 * setup() handlers in unit tests.
 *
 * Each client is a plain object with vi.fn() stubs for all methods.
 */
function buildMockContext(): PluginContext {
  return {
    manifest: {
      id: "test.plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A plugin used in unit tests",
      categories: ["connector"],
      capabilities: ["issues.read", "events.subscribe", "events.emit"],
      entrypoints: { worker: "worker.js" },
    },
    config: {
      get: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
    },
    events: {
      on: vi.fn(),
      emit: vi.fn().mockResolvedValue(undefined),
    },
    jobs: {
      register: vi.fn(),
    },
    launchers: {
      register: vi.fn(),
    },
    http: {
      fetch: vi.fn().mockResolvedValue(new Response("ok")),
    },
    secrets: {
      resolve: vi.fn().mockResolvedValue("super-secret-value"),
    },
    assets: {
      upload: vi.fn().mockResolvedValue({ assetId: "asset-1", url: "https://cdn.example.com/asset-1" }),
      getUrl: vi.fn().mockResolvedValue("https://cdn.example.com/asset-1"),
    },
    activity: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    entities: {
      upsert: vi.fn().mockResolvedValue({ id: "ent-1", entityType: "linear-issue", scopeKind: "company", scopeId: "co-1", externalId: "LIN-123", title: null, status: null, data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      list: vi.fn().mockResolvedValue([]),
    },
    projects: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listWorkspaces: vi.fn().mockResolvedValue([]),
      getPrimaryWorkspace: vi.fn().mockResolvedValue(null),
    },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    goals: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    data: {
      register: vi.fn(),
    },
    actions: {
      register: vi.fn(),
    },
    tools: {
      register: vi.fn(),
    },
    metrics: {
      write: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// ===========================================================================
// definePlugin — factory function
// ===========================================================================

describe("definePlugin", () => {
  describe("return value shape", () => {
    it("returns a PaperclipPlugin with a definition property", () => {
      const plugin = definePlugin({ async setup(_ctx) {} });
      expect(plugin).toBeDefined();
      expect(typeof plugin).toBe("object");
      expect(plugin).toHaveProperty("definition");
    });

    it("the returned object is frozen (immutable)", () => {
      const plugin = definePlugin({ async setup(_ctx) {} });
      expect(Object.isFrozen(plugin)).toBe(true);
    });

    it("preserves the setup function reference exactly", () => {
      const setup = vi.fn().mockResolvedValue(undefined);
      const plugin = definePlugin({ setup });
      expect(plugin.definition.setup).toBe(setup);
    });

    it("returns a new object each call (no caching)", () => {
      const def = { async setup(_ctx: PluginContext) {} };
      const a = definePlugin(def);
      const b = definePlugin(def);
      expect(a).not.toBe(b);
    });
  });

  describe("optional lifecycle hooks presence", () => {
    it("optional hooks are undefined when not provided", () => {
      const plugin = definePlugin({ async setup(_ctx) {} });
      expect(plugin.definition.onHealth).toBeUndefined();
      expect(plugin.definition.onConfigChanged).toBeUndefined();
      expect(plugin.definition.onShutdown).toBeUndefined();
      expect(plugin.definition.onValidateConfig).toBeUndefined();
      expect(plugin.definition.onWebhook).toBeUndefined();
    });

    it("all lifecycle hooks are preserved when all provided", () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onHealth() { return { status: "ok" }; },
        async onConfigChanged(_cfg) {},
        async onShutdown() {},
        async onValidateConfig(_cfg) { return { ok: true }; },
        async onWebhook(_input) {},
      });

      expect(typeof plugin.definition.onHealth).toBe("function");
      expect(typeof plugin.definition.onConfigChanged).toBe("function");
      expect(typeof plugin.definition.onShutdown).toBe("function");
      expect(typeof plugin.definition.onValidateConfig).toBe("function");
      expect(typeof plugin.definition.onWebhook).toBe("function");
    });
  });

  describe("setup() invocation", () => {
    it("setup() is callable with a mock context", async () => {
      const ctx = buildMockContext();
      let receivedCtx: PluginContext | null = null;

      const plugin = definePlugin({
        async setup(c) { receivedCtx = c; },
      });

      await plugin.definition.setup(ctx);
      expect(receivedCtx).toBe(ctx);
    });

    it("setup() can register event handlers via ctx.events.on", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.events.on("issue.created", async (_event) => {});
          c.events.on("agent.run.started", async (_event) => {});
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.events.on).toHaveBeenCalledTimes(2);
      expect((ctx.events.on as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("issue.created");
      expect((ctx.events.on as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("agent.run.started");
    });

    it("setup() can register job handlers via ctx.jobs.register", async () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockResolvedValue(undefined);

      const plugin = definePlugin({
        async setup(c) {
          c.jobs.register("full-sync", handler);
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.jobs.register).toHaveBeenCalledWith("full-sync", handler);
    });

    it("setup() can register launcher metadata via ctx.launchers.register", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.launchers.register({
            id: "project-files",
            displayName: "Files",
            placementZone: "projectSidebarItem",
            entityTypes: ["project"],
            action: {
              type: "deepLink",
              target: "plugin:test.plugin:files",
            },
          });
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.launchers.register).toHaveBeenCalledWith({
        id: "project-files",
        displayName: "Files",
        placementZone: "projectSidebarItem",
        entityTypes: ["project"],
        action: {
          type: "deepLink",
          target: "plugin:test.plugin:files",
        },
      });
    });

    it("setup() can register data handlers via ctx.data.register", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.data.register("sync-health", async ({ companyId }) => {
            return { companyId, lastSync: null };
          });
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.data.register).toHaveBeenCalledTimes(1);
      expect((ctx.data.register as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("sync-health");
    });

    it("setup() can register action handlers via ctx.actions.register", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.actions.register("resync", async (_params) => ({ triggered: true }));
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.actions.register).toHaveBeenCalledTimes(1);
      expect((ctx.actions.register as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("resync");
    });

    it("setup() can register tool handlers via ctx.tools.register", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.tools.register(
            "search-issues",
            {
              displayName: "Search Issues",
              description: "Search for issues in the external tracker",
              parametersSchema: { type: "object", properties: { query: { type: "string" } } },
            },
            async (params, _runCtx) => ({
              content: `Found results for: ${(params as { query: string }).query}`,
            }),
          );
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.tools.register).toHaveBeenCalledTimes(1);
      const [name, decl, fn] = (ctx.tools.register as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(name).toBe("search-issues");
      expect(decl.displayName).toBe("Search Issues");
      expect(typeof fn).toBe("function");
    });

    it("setup() can read config via ctx.config.get()", async () => {
      const ctx = buildMockContext();
      let configRead: Record<string, unknown> | null = null;

      const plugin = definePlugin({
        async setup(c) {
          configRead = await c.config.get();
        },
      });

      await plugin.definition.setup(ctx);
      expect(configRead).toEqual({ apiKey: "test-key" });
    });

    it("setup() can log via ctx.logger", async () => {
      const ctx = buildMockContext();

      const plugin = definePlugin({
        async setup(c) {
          c.logger.info("Plugin started", { version: "1.0.0" });
          c.logger.debug("Debug message");
          c.logger.warn("Warning message");
        },
      });

      await plugin.definition.setup(ctx);
      expect(ctx.logger.info).toHaveBeenCalledWith("Plugin started", { version: "1.0.0" });
      expect(ctx.logger.debug).toHaveBeenCalledWith("Debug message");
      expect(ctx.logger.warn).toHaveBeenCalledWith("Warning message");
    });
  });

  describe("onHealth() lifecycle hook", () => {
    it("returns status: ok", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onHealth() { return { status: "ok" }; },
      });

      const result = await plugin.definition.onHealth!();
      expect(result.status).toBe("ok");
    });

    it("returns status: degraded with message", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onHealth() {
          return { status: "degraded", message: "Sync queue is backed up", details: { queueDepth: 150 } };
        },
      });

      const result = await plugin.definition.onHealth!();
      expect(result.status).toBe("degraded");
      expect(result.message).toBe("Sync queue is backed up");
      expect((result.details as Record<string, unknown>).queueDepth).toBe(150);
    });

    it("returns status: error", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onHealth() { return { status: "error", message: "Cannot reach external API" }; },
      });

      const result = await plugin.definition.onHealth!();
      expect(result.status).toBe("error");
    });
  });

  describe("onValidateConfig() lifecycle hook", () => {
    it("returns ok: true for valid config", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onValidateConfig(config) {
          if (typeof config.apiKey !== "string" || config.apiKey.length === 0) {
            return { ok: false, errors: ["apiKey is required"] };
          }
          return { ok: true };
        },
      });

      const result = await plugin.definition.onValidateConfig!({ apiKey: "sk-valid" });
      expect(result.ok).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("returns ok: false with errors for invalid config", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onValidateConfig(config) {
          const errors: string[] = [];
          if (!config.apiKey) errors.push("apiKey is required");
          if (!config.workspace) errors.push("workspace is required");
          return { ok: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
        },
      });

      const result = await plugin.definition.onValidateConfig!({});
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("apiKey is required");
      expect(result.errors).toContain("workspace is required");
    });

    it("can return warnings alongside ok: true", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onValidateConfig(_config) {
          return {
            ok: true,
            warnings: ["apiKey will expire in 7 days"],
          };
        },
      });

      const result = await plugin.definition.onValidateConfig!({ apiKey: "sk-expiring" });
      expect(result.ok).toBe(true);
      expect(result.warnings).toContain("apiKey will expire in 7 days");
    });
  });

  describe("onConfigChanged() lifecycle hook", () => {
    it("receives new config object", async () => {
      let receivedConfig: Record<string, unknown> | null = null;

      const plugin = definePlugin({
        async setup(_ctx) {},
        async onConfigChanged(newConfig) { receivedConfig = newConfig; },
      });

      await plugin.definition.onConfigChanged!({ apiKey: "new-key", workspace: "new-ws" });
      expect(receivedConfig).toEqual({ apiKey: "new-key", workspace: "new-ws" });
    });
  });

  describe("onShutdown() lifecycle hook", () => {
    it("resolves without error", async () => {
      const plugin = definePlugin({
        async setup(_ctx) {},
        async onShutdown() {
          // flush in-flight requests
        },
      });

      await expect(plugin.definition.onShutdown!()).resolves.toBeUndefined();
    });
  });

  describe("onWebhook() lifecycle hook", () => {
    it("receives webhook input with all fields", async () => {
      let received: PluginWebhookInput | null = null;

      const plugin = definePlugin({
        async setup(_ctx) {},
        async onWebhook(input) { received = input; },
      });

      const webhookInput: PluginWebhookInput = {
        endpointKey: "github-push",
        headers: { "x-github-event": "push", "content-type": "application/json" },
        rawBody: '{"ref":"refs/heads/main"}',
        parsedBody: { ref: "refs/heads/main" },
        requestId: "req-uuid-1",
      };

      await plugin.definition.onWebhook!(webhookInput);
      expect(received).toBe(webhookInput);
      expect(received!.endpointKey).toBe("github-push");
      expect(received!.requestId).toBe("req-uuid-1");
    });

    it("handles webhook without parsedBody", async () => {
      let received: PluginWebhookInput | null = null;

      const plugin = definePlugin({
        async setup(_ctx) {},
        async onWebhook(input) { received = input; },
      });

      await plugin.definition.onWebhook!({
        endpointKey: "binary-hook",
        headers: {},
        rawBody: "binary-data",
        requestId: "req-2",
      });

      expect(received!.parsedBody).toBeUndefined();
    });
  });
});

// ===========================================================================
// PluginContext — individual client APIs via mock context
// ===========================================================================

describe("PluginContext client APIs", () => {
  describe("ctx.config", () => {
    it("get() returns the resolved config", async () => {
      const ctx = buildMockContext();
      const config = await ctx.config.get();
      expect(config).toEqual({ apiKey: "test-key" });
    });
  });

  describe("ctx.events", () => {
    it("on() can subscribe to a domain event", () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockResolvedValue(undefined);
      ctx.events.on("issue.created", handler);
      expect(ctx.events.on).toHaveBeenCalledWith("issue.created", handler);
    });

    it("on() can subscribe with an event filter", () => {
      const ctx = buildMockContext();
      const filter: EventFilter = { projectId: "proj-uuid-1" };
      const handler = vi.fn().mockResolvedValue(undefined);
      ctx.events.on("issue.created", filter, handler);
      expect(ctx.events.on).toHaveBeenCalledWith("issue.created", filter, handler);
    });

    it("emit() sends a plugin-namespaced event", async () => {
      const ctx = buildMockContext();
      await ctx.events.emit("sync-done", { syncedCount: 42 });
      expect(ctx.events.emit).toHaveBeenCalledWith("sync-done", { syncedCount: 42 });
    });
  });

  describe("ctx.jobs", () => {
    it("register() stores a job handler", () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockResolvedValue(undefined);
      ctx.jobs.register("daily-sync", handler);
      expect(ctx.jobs.register).toHaveBeenCalledWith("daily-sync", handler);
    });

    it("job handler receives a PluginJobContext", async () => {
      const ctx = buildMockContext();
      let jobCtx: PluginJobContext | null = null;

      ctx.jobs.register("report-gen", async (job) => { jobCtx = job; });

      const [, registeredFn] = (ctx.jobs.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const testJobCtx: PluginJobContext = {
        jobKey: "report-gen",
        runId: "run-uuid-1",
        trigger: "schedule",
        scheduledAt: new Date().toISOString(),
      };
      await registeredFn(testJobCtx);
      expect(jobCtx).toEqual(testJobCtx);
    });
  });

  describe("ctx.secrets", () => {
    it("resolve() returns the secret value", async () => {
      const ctx = buildMockContext();
      const value = await ctx.secrets.resolve("MY_API_KEY");
      expect(value).toBe("super-secret-value");
    });
  });

  describe("ctx.assets", () => {
    it("upload() returns assetId and url", async () => {
      const ctx = buildMockContext();
      const result = await ctx.assets.upload("screenshot.png", "image/png", new Uint8Array([0, 1, 2]));
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("url");
    });

    it("getUrl() returns a URL string", async () => {
      const ctx = buildMockContext();
      const url = await ctx.assets.getUrl("asset-123");
      expect(typeof url).toBe("string");
    });
  });

  describe("ctx.activity", () => {
    it("log() writes an activity entry", async () => {
      const ctx = buildMockContext();
      await ctx.activity.log({ message: "Synced 5 issues", entityType: "issue" });
      expect(ctx.activity.log).toHaveBeenCalledWith({ message: "Synced 5 issues", entityType: "issue" });
    });
  });

  describe("ctx.state", () => {
    it("get() returns stored value", async () => {
      const ctx = buildMockContext();
      (ctx.state.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce("2024-01-01T00:00:00Z");

      const scope: ScopeKey = { scopeKind: "company", scopeId: "co-1", stateKey: "last-sync" };
      const result = await ctx.state.get(scope);
      expect(result).toBe("2024-01-01T00:00:00Z");
      expect(ctx.state.get).toHaveBeenCalledWith(scope);
    });

    it("get() returns null when not set", async () => {
      const ctx = buildMockContext();
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "counter" };
      const result = await ctx.state.get(scope);
      expect(result).toBeNull();
    });

    it("set() writes a value", async () => {
      const ctx = buildMockContext();
      const scope: ScopeKey = { scopeKind: "project", scopeId: "proj-1", stateKey: "config" };
      await ctx.state.set(scope, { theme: "dark" });
      expect(ctx.state.set).toHaveBeenCalledWith(scope, { theme: "dark" });
    });

    it("delete() removes a value", async () => {
      const ctx = buildMockContext();
      const scope: ScopeKey = { scopeKind: "company", scopeId: "co-1", stateKey: "cache" };
      await ctx.state.delete(scope);
      expect(ctx.state.delete).toHaveBeenCalledWith(scope);
    });

    it("ScopeKey supports all scope kinds", () => {
      // TypeScript compile-time check that all scope kinds are accepted
      const scopes: ScopeKey[] = [
        { scopeKind: "instance", stateKey: "k" },
        { scopeKind: "company", scopeId: "c1", stateKey: "k" },
        { scopeKind: "project", scopeId: "p1", stateKey: "k" },
        { scopeKind: "project_workspace", scopeId: "pw1", stateKey: "k" },
        { scopeKind: "agent", scopeId: "a1", stateKey: "k" },
        { scopeKind: "issue", scopeId: "i1", stateKey: "k" },
        { scopeKind: "goal", scopeId: "g1", stateKey: "k" },
        { scopeKind: "run", scopeId: "r1", stateKey: "k" },
      ];
      expect(scopes).toHaveLength(8);
    });
  });

  describe("ctx.entities", () => {
    it("upsert() creates an entity and returns a record", async () => {
      const ctx = buildMockContext();
      const input: PluginEntityUpsert = {
        entityType: "linear-issue",
        scopeKind: "company",
        scopeId: "co-1",
        externalId: "LIN-42",
        title: "Fix the bug",
        data: { url: "https://linear.app/issue/LIN-42" },
      };

      const result = await ctx.entities.upsert(input);
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("entityType");
      expect(result).toHaveProperty("createdAt");
      expect(ctx.entities.upsert).toHaveBeenCalledWith(input);
    });

    it("list() returns an array of entity records", async () => {
      const ctx = buildMockContext();
      const mockEntities: PluginEntityRecord[] = [
        {
          id: "ent-1",
          entityType: "linear-issue",
          scopeKind: "company",
          scopeId: "co-1",
          externalId: "LIN-1",
          title: "First issue",
          status: "open",
          data: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      (ctx.entities.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockEntities);

      const query: PluginEntityQuery = { entityType: "linear-issue", scopeKind: "company", scopeId: "co-1" };
      const results = await ctx.entities.list(query);
      expect(results).toHaveLength(1);
      expect(results[0].externalId).toBe("LIN-1");
    });
  });

  describe("ctx.projects", () => {
    it("listWorkspaces() returns an empty array by default", async () => {
      const ctx = buildMockContext();
      const workspaces = await ctx.projects.listWorkspaces("proj-1", "co-1");
      expect(workspaces).toEqual([]);
    });

    it("getPrimaryWorkspace() returns workspace when found", async () => {
      const ctx = buildMockContext();
      const mockWorkspace: PluginWorkspace = {
        id: "ws-1",
        projectId: "proj-1",
        name: "Main Workspace",
        path: "/home/user/projects/myapp",
        isPrimary: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      (ctx.projects.getPrimaryWorkspace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockWorkspace);

      const ws = await ctx.projects.getPrimaryWorkspace("proj-1", "co-1");
      expect(ws).not.toBeNull();
      expect(ws!.isPrimary).toBe(true);
      expect(ws!.path).toBe("/home/user/projects/myapp");
    });

    it("getPrimaryWorkspace() returns null when not configured", async () => {
      const ctx = buildMockContext();
      const ws = await ctx.projects.getPrimaryWorkspace("proj-with-no-workspace", "co-1");
      expect(ws).toBeNull();
    });
  });

  describe("ctx.data", () => {
    it("register() stores a data handler", () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockResolvedValue({ count: 0 });
      ctx.data.register("stats", handler);
      expect(ctx.data.register).toHaveBeenCalledWith("stats", handler);
    });

    it("data handler can be invoked with params", async () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockImplementation(async ({ companyId }) => ({
        companyId,
        syncedCount: 10,
      }));

      ctx.data.register("sync-stats", handler);
      const [, registeredFn] = (ctx.data.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const result = await registeredFn({ companyId: "co-123" });
      expect(result).toEqual({ companyId: "co-123", syncedCount: 10 });
    });
  });

  describe("ctx.actions", () => {
    it("register() stores an action handler", () => {
      const ctx = buildMockContext();
      const handler = vi.fn().mockResolvedValue({ triggered: true });
      ctx.actions.register("resync", handler);
      expect(ctx.actions.register).toHaveBeenCalledWith("resync", handler);
    });

    it("action handler can be invoked with params", async () => {
      const ctx = buildMockContext();
      const results: unknown[] = [];

      ctx.actions.register("mark-synced", async (params) => {
        results.push(params);
        return { success: true };
      });

      const [, registeredFn] = (ctx.actions.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const result = await registeredFn({ issueId: "iss-42" });
      expect(result).toEqual({ success: true });
      expect(results[0]).toEqual({ issueId: "iss-42" });
    });
  });

  describe("ctx.tools", () => {
    it("register() stores a tool handler with declaration", () => {
      const ctx = buildMockContext();
      const declaration = {
        displayName: "Get Issue",
        description: "Retrieve details of an issue by ID",
        parametersSchema: { type: "object", properties: { issueId: { type: "string" } } },
      };
      const handler = vi.fn().mockResolvedValue({ content: "Issue details" });

      ctx.tools.register("get-issue", declaration, handler);
      expect(ctx.tools.register).toHaveBeenCalledWith("get-issue", declaration, handler);
    });

    it("tool handler receives params and ToolRunContext", async () => {
      const ctx = buildMockContext();
      let capturedParams: unknown = null;
      let capturedRunCtx: ToolRunContext | null = null;

      ctx.tools.register(
        "search",
        { displayName: "Search", description: "Search", parametersSchema: {} },
        async (params, runCtx) => {
          capturedParams = params;
          capturedRunCtx = runCtx;
          return { content: "results" };
        },
      );

      const [, , registeredFn] = (ctx.tools.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const runCtx: ToolRunContext = {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "co-1",
        projectId: "proj-1",
      };
      const result: ToolResult = await registeredFn({ query: "test" }, runCtx);

      expect(capturedParams).toEqual({ query: "test" });
      expect(capturedRunCtx).toEqual(runCtx);
      expect(result.content).toBe("results");
    });

    it("tool handler can return an error ToolResult", async () => {
      const ctx = buildMockContext();
      ctx.tools.register(
        "fail-tool",
        { displayName: "Fail", description: "Always fails", parametersSchema: {} },
        async (_params, _runCtx) => ({ error: "Something went wrong" }),
      );

      const [, , registeredFn] = (ctx.tools.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const result: ToolResult = await registeredFn({}, { agentId: "a", runId: "r", companyId: "c", projectId: "p" });
      expect(result.error).toBe("Something went wrong");
      expect(result.content).toBeUndefined();
    });
  });

  describe("ctx.metrics", () => {
    it("write() sends a metric", async () => {
      const ctx = buildMockContext();
      await ctx.metrics.write("synced_issues", 42, { region: "us-east-1" });
      expect(ctx.metrics.write).toHaveBeenCalledWith("synced_issues", 42, { region: "us-east-1" });
    });

    it("write() works without tags", async () => {
      const ctx = buildMockContext();
      await ctx.metrics.write("api_calls", 10);
      expect(ctx.metrics.write).toHaveBeenCalledWith("api_calls", 10);
    });
  });

  describe("ctx.logger", () => {
    it("all log levels are callable", () => {
      const ctx = buildMockContext();
      ctx.logger.info("Info message", { key: "val" });
      ctx.logger.warn("Warn message");
      ctx.logger.error("Error message", { code: 500 });
      ctx.logger.debug("Debug message");

      expect(ctx.logger.info).toHaveBeenCalledWith("Info message", { key: "val" });
      expect(ctx.logger.warn).toHaveBeenCalledWith("Warn message");
      expect(ctx.logger.error).toHaveBeenCalledWith("Error message", { code: 500 });
      expect(ctx.logger.debug).toHaveBeenCalledWith("Debug message");
    });
  });
});

// ===========================================================================
// PluginEvent envelope
// ===========================================================================

describe("PluginEvent envelope", () => {
  it("conforms to the envelope shape", () => {
    const event: PluginEvent<{ title: string }> = {
      eventId: "evt-uuid-1",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      actorId: "user-1",
      actorType: "user",
      entityId: "iss-1",
      entityType: "issue",
      payload: { title: "Fix the bug" },
    };

    expect(event.eventId).toBe("evt-uuid-1");
    expect(event.eventType).toBe("issue.created");
    expect(event.payload.title).toBe("Fix the bug");
  });

  it("supports plugin-namespaced event types", () => {
    const event: PluginEvent = {
      eventId: "evt-2",
      eventType: "plugin.acme.linear.sync-done",
      occurredAt: new Date().toISOString(),
      payload: { syncedCount: 42 },
    };

    expect(event.eventType).toBe("plugin.acme.linear.sync-done");
  });

  it("optional fields can be absent", () => {
    const event: PluginEvent = {
      eventId: "evt-3",
      eventType: "company.created",
      occurredAt: "2024-01-01T00:00:00.000Z",
      payload: {},
    };

    expect(event.actorId).toBeUndefined();
    expect(event.entityId).toBeUndefined();
  });
});

// ===========================================================================
// Constants re-exports
// ===========================================================================

describe("constants re-exports", () => {
  describe("PLUGIN_API_VERSION", () => {
    it("equals 1", () => {
      expect(PLUGIN_API_VERSION).toBe(1);
    });
  });

  describe("PLUGIN_CAPABILITIES", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(PLUGIN_CAPABILITIES)).toBe(true);
      expect(PLUGIN_CAPABILITIES.length).toBeGreaterThan(0);
    });

    it("contains all expected capability groups", () => {
      // Data Read
      expect(PLUGIN_CAPABILITIES).toContain("companies.read");
      expect(PLUGIN_CAPABILITIES).toContain("projects.read");
      expect(PLUGIN_CAPABILITIES).toContain("project.workspaces.read");
      expect(PLUGIN_CAPABILITIES).toContain("issues.read");
      expect(PLUGIN_CAPABILITIES).toContain("issue.comments.read");
      expect(PLUGIN_CAPABILITIES).toContain("agents.read");
      expect(PLUGIN_CAPABILITIES).toContain("goals.read");
      expect(PLUGIN_CAPABILITIES).toContain("activity.read");
      expect(PLUGIN_CAPABILITIES).toContain("costs.read");
      // Data Write
      expect(PLUGIN_CAPABILITIES).toContain("issues.create");
      expect(PLUGIN_CAPABILITIES).toContain("issues.update");
      expect(PLUGIN_CAPABILITIES).toContain("issue.comments.create");
      expect(PLUGIN_CAPABILITIES).toContain("assets.write");
      expect(PLUGIN_CAPABILITIES).toContain("assets.read");
      expect(PLUGIN_CAPABILITIES).toContain("activity.log.write");
      expect(PLUGIN_CAPABILITIES).toContain("metrics.write");
      // Plugin State
      expect(PLUGIN_CAPABILITIES).toContain("plugin.state.read");
      expect(PLUGIN_CAPABILITIES).toContain("plugin.state.write");
      // Runtime / Integration
      expect(PLUGIN_CAPABILITIES).toContain("events.subscribe");
      expect(PLUGIN_CAPABILITIES).toContain("events.emit");
      expect(PLUGIN_CAPABILITIES).toContain("jobs.schedule");
      expect(PLUGIN_CAPABILITIES).toContain("webhooks.receive");
      expect(PLUGIN_CAPABILITIES).toContain("http.outbound");
      expect(PLUGIN_CAPABILITIES).toContain("secrets.read-ref");
      // Agent Tools
      expect(PLUGIN_CAPABILITIES).toContain("agent.tools.register");
      // UI
      expect(PLUGIN_CAPABILITIES).toContain("instance.settings.register");
      expect(PLUGIN_CAPABILITIES).toContain("ui.sidebar.register");
      expect(PLUGIN_CAPABILITIES).toContain("ui.page.register");
      expect(PLUGIN_CAPABILITIES).toContain("ui.detailTab.register");
      expect(PLUGIN_CAPABILITIES).toContain("ui.dashboardWidget.register");
      expect(PLUGIN_CAPABILITIES).toContain("ui.action.register");
    });

    it("has no duplicate entries", () => {
      const unique = new Set(PLUGIN_CAPABILITIES);
      expect(unique.size).toBe(PLUGIN_CAPABILITIES.length);
    });
  });

  describe("PLUGIN_EVENT_TYPES", () => {
    it("is a non-empty readonly array", () => {
      expect(PLUGIN_EVENT_TYPES.length).toBeGreaterThan(0);
    });

    it("contains all expected domain event types", () => {
      expect(PLUGIN_EVENT_TYPES).toContain("company.created");
      expect(PLUGIN_EVENT_TYPES).toContain("company.updated");
      expect(PLUGIN_EVENT_TYPES).toContain("project.created");
      expect(PLUGIN_EVENT_TYPES).toContain("project.updated");
      expect(PLUGIN_EVENT_TYPES).toContain("project.workspace_created");
      expect(PLUGIN_EVENT_TYPES).toContain("project.workspace_updated");
      expect(PLUGIN_EVENT_TYPES).toContain("project.workspace_deleted");
      expect(PLUGIN_EVENT_TYPES).toContain("issue.created");
      expect(PLUGIN_EVENT_TYPES).toContain("issue.updated");
      expect(PLUGIN_EVENT_TYPES).toContain("issue.comment.created");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.created");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.updated");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.status_changed");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.run.started");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.run.finished");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.run.failed");
      expect(PLUGIN_EVENT_TYPES).toContain("agent.run.cancelled");
      expect(PLUGIN_EVENT_TYPES).toContain("approval.created");
      expect(PLUGIN_EVENT_TYPES).toContain("approval.decided");
      expect(PLUGIN_EVENT_TYPES).toContain("cost_event.created");
      expect(PLUGIN_EVENT_TYPES).toContain("activity.logged");
    });

    it("has no duplicate entries", () => {
      const unique = new Set(PLUGIN_EVENT_TYPES);
      expect(unique.size).toBe(PLUGIN_EVENT_TYPES.length);
    });
  });

  describe("PLUGIN_STATUSES", () => {
    it("contains all lifecycle statuses", () => {
      expect(PLUGIN_STATUSES).toContain("installed");
      expect(PLUGIN_STATUSES).toContain("ready");
      expect(PLUGIN_STATUSES).toContain("error");
      expect(PLUGIN_STATUSES).toContain("upgrade_pending");
      expect(PLUGIN_STATUSES).toContain("uninstalled");
    });

    it("has exactly 5 statuses", () => {
      expect(PLUGIN_STATUSES).toHaveLength(5);
    });
  });

  describe("PLUGIN_CATEGORIES", () => {
    it("contains all category values", () => {
      expect(PLUGIN_CATEGORIES).toContain("connector");
      expect(PLUGIN_CATEGORIES).toContain("workspace");
      expect(PLUGIN_CATEGORIES).toContain("automation");
      expect(PLUGIN_CATEGORIES).toContain("ui");
    });

    it("has exactly 4 categories", () => {
      expect(PLUGIN_CATEGORIES).toHaveLength(4);
    });
  });

  describe("PLUGIN_UI_SLOT_TYPES", () => {
    it("contains all slot types", () => {
      expect(PLUGIN_UI_SLOT_TYPES).toContain("page");
      expect(PLUGIN_UI_SLOT_TYPES).toContain("detailTab");
      expect(PLUGIN_UI_SLOT_TYPES).toContain("dashboardWidget");
      expect(PLUGIN_UI_SLOT_TYPES).toContain("sidebar");
      expect(PLUGIN_UI_SLOT_TYPES).toContain("settingsPage");
    });
  });

  describe("PLUGIN_UI_SLOT_ENTITY_TYPES", () => {
    it("contains all entity types", () => {
      expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toContain("project");
      expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toContain("issue");
      expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toContain("agent");
      expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toContain("goal");
      expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toContain("run");
    });
  });

  describe("PLUGIN_STATE_SCOPE_KINDS", () => {
    it("contains all scope kinds", () => {
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("instance");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("company");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("project");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("project_workspace");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("agent");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("issue");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("goal");
      expect(PLUGIN_STATE_SCOPE_KINDS).toContain("run");
    });

    it("has exactly 8 scope kinds", () => {
      expect(PLUGIN_STATE_SCOPE_KINDS).toHaveLength(8);
    });
  });

  describe("PLUGIN_JOB_STATUSES", () => {
    it("contains all job statuses", () => {
      expect(PLUGIN_JOB_STATUSES).toContain("active");
      expect(PLUGIN_JOB_STATUSES).toContain("paused");
      expect(PLUGIN_JOB_STATUSES).toContain("failed");
    });
  });

  describe("PLUGIN_JOB_RUN_STATUSES", () => {
    it("contains all job run statuses", () => {
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("pending");
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("queued");
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("running");
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("succeeded");
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("failed");
      expect(PLUGIN_JOB_RUN_STATUSES).toContain("cancelled");
    });
  });

  describe("PLUGIN_JOB_RUN_TRIGGERS", () => {
    it("contains all trigger types", () => {
      expect(PLUGIN_JOB_RUN_TRIGGERS).toContain("schedule");
      expect(PLUGIN_JOB_RUN_TRIGGERS).toContain("manual");
      expect(PLUGIN_JOB_RUN_TRIGGERS).toContain("retry");
    });
  });

  describe("PLUGIN_WEBHOOK_DELIVERY_STATUSES", () => {
    it("contains all delivery statuses", () => {
      expect(PLUGIN_WEBHOOK_DELIVERY_STATUSES).toContain("pending");
      expect(PLUGIN_WEBHOOK_DELIVERY_STATUSES).toContain("success");
      expect(PLUGIN_WEBHOOK_DELIVERY_STATUSES).toContain("failed");
    });
  });

  describe("PLUGIN_BRIDGE_ERROR_CODES", () => {
    it("contains all error codes", () => {
      expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("WORKER_UNAVAILABLE");
      expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("CAPABILITY_DENIED");
      expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("WORKER_ERROR");
      expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("TIMEOUT");
      expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("UNKNOWN");
    });
  });
});

// ===========================================================================
// Zod re-export
// ===========================================================================

describe("z (Zod re-export)", () => {
  it("is the Zod library", () => {
    expect(z).toBeDefined();
    expect(typeof z.object).toBe("function");
    expect(typeof z.string).toBe("function");
    expect(typeof z.number).toBe("function");
    expect(typeof z.boolean).toBe("function");
    expect(typeof z.array).toBe("function");
    expect(typeof z.enum).toBe("function");
  });

  it("can define an instanceConfigSchema", () => {
    const configSchema = z.object({
      apiKey: z.string().min(1).describe("Your API key"),
      workspace: z.string().optional(),
      maxRetries: z.number().int().min(0).max(10).default(3),
    });

    const valid = configSchema.safeParse({ apiKey: "sk-123" });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.maxRetries).toBe(3); // default applied
    }

    const invalid = configSchema.safeParse({ apiKey: "" });
    expect(invalid.success).toBe(false);
  });

  it("can define a tool parametersSchema", () => {
    const paramsSchema = z.object({
      query: z.string().min(1).describe("Search query"),
      maxResults: z.number().int().positive().optional(),
    });

    const valid = paramsSchema.safeParse({ query: "bug fix" });
    expect(valid.success).toBe(true);

    const invalid = paramsSchema.safeParse({ query: "" });
    expect(invalid.success).toBe(false);
  });
});

// ===========================================================================
// Integration: complete plugin example
// ===========================================================================

describe("end-to-end plugin wiring", () => {
  it("simulates a full plugin setup lifecycle", async () => {
    const ctx = buildMockContext();

    // Track what the plugin registered
    const registeredHandlers: Record<string, unknown> = {};

    // Override mocks to capture registrations
    (ctx.events.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, ...rest: unknown[]) => {
      const fn = rest.length === 2 ? rest[1] : rest[0];
      registeredHandlers[`event:${event}`] = fn;
    });
    (ctx.jobs.register as ReturnType<typeof vi.fn>).mockImplementation((key: string, fn: unknown) => {
      registeredHandlers[`job:${key}`] = fn;
    });
    (ctx.data.register as ReturnType<typeof vi.fn>).mockImplementation((key: string, fn: unknown) => {
      registeredHandlers[`data:${key}`] = fn;
    });
    (ctx.actions.register as ReturnType<typeof vi.fn>).mockImplementation((key: string, fn: unknown) => {
      registeredHandlers[`action:${key}`] = fn;
    });

    // Define a realistic plugin
    const plugin = definePlugin({
      async setup(c) {
        c.logger.info("Linear sync plugin starting");

        // Event subscriptions
        c.events.on("issue.created", async (event) => {
          await c.activity.log({ message: `Issue created: ${event.entityId}` });
        });

        c.events.on("project.created", async (event) => {
          await c.state.set({ scopeKind: "project", scopeId: event.entityId!, stateKey: "synced" }, false);
        });

        // Job handler
        c.jobs.register("full-sync", async (job) => {
          c.logger.info("Running full sync", { runId: job.runId });
          await c.metrics.write("sync_runs", 1);
        });

        // Data handler for UI
        c.data.register("sync-health", async ({ companyId }) => {
          const lastSync = await c.state.get({ scopeKind: "company", scopeId: String(companyId), stateKey: "last-sync" });
          return { lastSync, status: lastSync ? "synced" : "never-synced" };
        });

        // Action handler
        c.actions.register("resync", async ({ companyId }) => {
          await c.events.emit("resync-triggered", { companyId });
          return { triggered: true };
        });
      },

      async onHealth() {
        return { status: "ok", message: "All systems operational" };
      },

      async onValidateConfig(config) {
        if (!config.apiKey) return { ok: false, errors: ["apiKey is required"] };
        return { ok: true };
      },
    });

    // Run setup
    await plugin.definition.setup(ctx);

    // Verify all registrations happened
    expect(ctx.logger.info).toHaveBeenCalledWith("Linear sync plugin starting");
    expect(registeredHandlers["event:issue.created"]).toBeDefined();
    expect(registeredHandlers["event:project.created"]).toBeDefined();
    expect(registeredHandlers["job:full-sync"]).toBeDefined();
    expect(registeredHandlers["data:sync-health"]).toBeDefined();
    expect(registeredHandlers["action:resync"]).toBeDefined();

    // Simulate host calling health check
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");

    // Simulate host validating config
    const badConfig = await plugin.definition.onValidateConfig!({});
    expect(badConfig.ok).toBe(false);

    const goodConfig = await plugin.definition.onValidateConfig!({ apiKey: "sk-live-123" });
    expect(goodConfig.ok).toBe(true);

    // Simulate invoking the event handler
    const issueHandler = registeredHandlers["event:issue.created"] as (e: PluginEvent) => Promise<void>;
    await issueHandler({ eventId: "evt-1", eventType: "issue.created", occurredAt: "2024-01-01T00:00:00Z", entityId: "iss-42", payload: {} });
    expect(ctx.activity.log).toHaveBeenCalledWith({ message: "Issue created: iss-42" });

    // Simulate invoking the data handler
    (ctx.state.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce("2024-01-01T00:00:00Z");
    const dataHandler = registeredHandlers["data:sync-health"] as (p: Record<string, unknown>) => Promise<unknown>;
    const syncHealth = await dataHandler({ companyId: "co-1" }) as Record<string, unknown>;
    expect(syncHealth.status).toBe("synced");

    // Simulate invoking the action handler
    const actionHandler = registeredHandlers["action:resync"] as (p: Record<string, unknown>) => Promise<unknown>;
    const actionResult = await actionHandler({ companyId: "co-1" }) as Record<string, unknown>;
    expect(actionResult.triggered).toBe(true);
    expect(ctx.events.emit).toHaveBeenCalledWith("resync-triggered", { companyId: "co-1" });
  });
});

describe("createTestHarness", () => {
  const harnessManifest = {
    id: "test.harness",
    apiVersion: 1 as const,
    version: "1.0.0",
    displayName: "Harness Test",
    categories: ["connector" as const],
    capabilities: ["issue.comments.create", "issues.create"],
    entrypoints: { worker: "worker.js" },
  };

  it("upserts entity records by external key", async () => {
    const harness = createTestHarness({ manifest: harnessManifest });
    const first = await harness.ctx.entities.upsert({
      entityType: "remote-issue",
      scopeKind: "project",
      scopeId: "proj_1",
      externalId: "ABC-1",
      data: { title: "Before" },
    });
    const second = await harness.ctx.entities.upsert({
      entityType: "remote-issue",
      scopeKind: "project",
      scopeId: "proj_1",
      externalId: "ABC-1",
      title: "After",
      data: { title: "After" },
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("After");
    expect((await harness.ctx.entities.list({ entityType: "remote-issue" })).length).toBe(1);
  });

  it("throws when creating comments for unknown issues", async () => {
    const harness = createTestHarness({ manifest: harnessManifest });
    await expect(harness.ctx.issues.createComment("missing", "hello", "co-1")).rejects.toThrow("Issue not found");
  });
});
