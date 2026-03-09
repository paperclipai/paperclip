import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginCapability } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  getRequiredCapability,
  CapabilityDeniedError,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import type {
  HostServices,
  HostClientHandlers,
  WorkerToHostMethodName,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * All capabilities — used when we want no capability restrictions.
 */
const ALL_CAPABILITIES: PluginCapability[] = [
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "issues.read",
  "issue.comments.read",
  "agents.read",
  "goals.read",
  "activity.read",
  "costs.read",
  "issues.create",
  "issues.update",
  "issue.comments.create",
  "assets.write",
  "assets.read",
  "activity.log.write",
  "metrics.write",
  "plugin.state.read",
  "plugin.state.write",
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "http.outbound",
  "secrets.read-ref",
  "agent.tools.register",
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.action.register",
];

/**
 * Create a mock HostServices object where every method is a vi.fn() that
 * resolves to a sensible default.
 */
function createMockServices(): HostServices {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ key: "value" }),
    },
    state: {
      get: vi.fn().mockResolvedValue("stored-value"),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    entities: {
      upsert: vi.fn().mockResolvedValue({
        id: "ent-1",
        entityType: "ticket",
        scopeKind: "instance",
        scopeId: null,
        externalId: null,
        title: null,
        status: null,
        data: {},
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      list: vi.fn().mockResolvedValue([]),
    },
    events: {
      emit: vi.fn().mockResolvedValue(undefined),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    },
    secrets: {
      resolve: vi.fn().mockResolvedValue("secret-value"),
    },
    assets: {
      upload: vi.fn().mockResolvedValue({ assetId: "asset-1", url: "https://cdn.example.com/asset-1" }),
      getUrl: vi.fn().mockResolvedValue("https://cdn.example.com/asset-1"),
    },
    activity: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    metrics: {
      write: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    projects: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listWorkspaces: vi.fn().mockResolvedValue([]),
      getPrimaryWorkspace: vi.fn().mockResolvedValue(null),
    },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "issue-1" }),
      update: vi.fn().mockResolvedValue({ id: "issue-1" }),
      listComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    goals: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHostClientHandlers", () => {
  let services: HostServices;

  beforeEach(() => {
    services = createMockServices();
  });

  describe("handler map completeness", () => {
    it("returns a handler for every WorkerToHostMethodName", () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      // All expected methods
      const expectedMethods: WorkerToHostMethodName[] = [
        "config.get",
        "state.get", "state.set", "state.delete",
        "entities.upsert", "entities.list",
        "events.emit",
        "http.fetch",
        "secrets.resolve",
        "assets.upload", "assets.getUrl",
        "activity.log",
        "metrics.write",
        "log",
        "companies.list", "companies.get",
        "projects.list", "projects.get", "projects.listWorkspaces", "projects.getPrimaryWorkspace",
        "issues.list", "issues.get", "issues.create", "issues.update", "issues.listComments", "issues.createComment",
        "agents.list", "agents.get",
        "goals.list", "goals.get",
      ];

      for (const method of expectedMethods) {
        expect(handlers[method], `missing handler for ${method}`).toBeDefined();
        expect(typeof handlers[method], `handler for ${method} is not a function`).toBe("function");
      }
    });
  });

  describe("capability gating", () => {
    it("allows calls when the plugin has the required capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["plugin.state.read"],
        services,
      });

      const result = await handlers["state.get"]({
        scopeKind: "instance",
        stateKey: "test",
      });

      expect(result).toBe("stored-value");
      expect(services.state.get).toHaveBeenCalledWith({
        scopeKind: "instance",
        stateKey: "test",
      });
    });

    it("throws CapabilityDeniedError when the plugin lacks the required capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [], // No capabilities
        services,
      });

      await expect(
        handlers["state.get"]({ scopeKind: "instance", stateKey: "test" }),
      ).rejects.toThrow(CapabilityDeniedError);

      // Service should NOT have been called
      expect(services.state.get).not.toHaveBeenCalled();
    });

    it("CapabilityDeniedError has the correct code and message", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "acme.linear",
        capabilities: [],
        services,
      });

      try {
        await handlers["state.set"]({
          scopeKind: "instance",
          stateKey: "k",
          value: "v",
        });
        expect.fail("Expected CapabilityDeniedError");
      } catch (err) {
        expect(err).toBeInstanceOf(CapabilityDeniedError);
        const capErr = err as CapabilityDeniedError;
        expect(capErr.code).toBe(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED);
        expect(capErr.message).toContain("acme.linear");
        expect(capErr.message).toContain("plugin.state.write");
        expect(capErr.message).toContain("state.set");
      }
    });

    it("allows methods that do not require a capability (config.get, log, entities)", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [], // No capabilities at all
        services,
      });

      // config.get — no capability required
      await expect(handlers["config.get"]({} as Record<string, never>)).resolves.toEqual({ key: "value" });
      expect(services.config.get).toHaveBeenCalled();

      // log — no capability required
      await expect(
        handlers["log"]({ level: "info", message: "hello" }),
      ).resolves.toBeUndefined();
      expect(services.logger.log).toHaveBeenCalled();

      // entities.upsert — no capability required
      await expect(
        handlers["entities.upsert"]({
          entityType: "ticket",
          scopeKind: "instance",
          data: {},
        }),
      ).resolves.toBeDefined();
      expect(services.entities.upsert).toHaveBeenCalled();

      // entities.list — no capability required
      await expect(
        handlers["entities.list"]({}),
      ).resolves.toEqual([]);
      expect(services.entities.list).toHaveBeenCalled();
    });

    it("blocks state.get without plugin.state.read", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["plugin.state.write"], // has write but not read
        services,
      });

      await expect(
        handlers["state.get"]({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks state.set without plugin.state.write", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["plugin.state.read"], // has read but not write
        services,
      });

      await expect(
        handlers["state.set"]({ scopeKind: "instance", stateKey: "k", value: 1 }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks state.delete without plugin.state.write", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["plugin.state.read"],
        services,
      });

      await expect(
        handlers["state.delete"]({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks events.emit without events.emit capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["events.subscribe"],
        services,
      });

      await expect(
        handlers["events.emit"]({ name: "test", payload: {} }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks http.fetch without http.outbound capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(
        handlers["http.fetch"]({ url: "https://example.com" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks secrets.resolve without secrets.read-ref capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(
        handlers["secrets.resolve"]({ secretRef: "MY_KEY" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks assets.upload without assets.write capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["assets.read"],
        services,
      });

      await expect(
        handlers["assets.upload"]({ filename: "x.png", contentType: "image/png", data: "" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks assets.getUrl without assets.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["assets.write"],
        services,
      });

      await expect(
        handlers["assets.getUrl"]({ assetId: "a1" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks activity.log without activity.log.write capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(
        handlers["activity.log"]({ message: "hi" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks metrics.write without metrics.write capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(
        handlers["metrics.write"]({ name: "m", value: 1 }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks companies.list without companies.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(handlers["companies.list"]({})).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks projects.listWorkspaces without project.workspaces.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["projects.read"], // has projects.read but not project.workspaces.read
        services,
      });

      await expect(
        handlers["projects.listWorkspaces"]({ projectId: "p1", companyId: "c1" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks issues.create without issues.create capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["issues.read"],
        services,
      });

      await expect(
        handlers["issues.create"]({
          companyId: "c1",
          title: "test",
        }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks issues.update without issues.update capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["issues.read", "issues.create"],
        services,
      });

      await expect(
        handlers["issues.update"]({ issueId: "i1", patch: { title: "updated" }, companyId: "c1" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks issues.listComments without issue.comments.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["issues.read"],
        services,
      });

      await expect(
        handlers["issues.listComments"]({ issueId: "i1", companyId: "c1" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks issues.createComment without issue.comments.create capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ["issues.read", "issue.comments.read"],
        services,
      });

      await expect(
        handlers["issues.createComment"]({ issueId: "i1", body: "hello", companyId: "c1" }),
      ).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks agents.list without agents.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(handlers["agents.list"]({})).rejects.toThrow(CapabilityDeniedError);
    });

    it("blocks goals.list without goals.read capability", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [],
        services,
      });

      await expect(handlers["goals.list"]({})).rejects.toThrow(CapabilityDeniedError);
    });
  });

  describe("service delegation", () => {
    it("delegates config.get to services.config.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const result = await handlers["config.get"]({} as Record<string, never>);
      expect(result).toEqual({ key: "value" });
      expect(services.config.get).toHaveBeenCalledOnce();
    });

    it("delegates state.get with full params", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        scopeKind: "project" as const,
        scopeId: "proj-1",
        namespace: "sync",
        stateKey: "cursor",
      };

      await handlers["state.get"](params);
      expect(services.state.get).toHaveBeenCalledWith(params);
    });

    it("delegates state.set with value", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        scopeKind: "instance" as const,
        stateKey: "version",
        value: 42,
      };

      await handlers["state.set"](params);
      expect(services.state.set).toHaveBeenCalledWith(params);
    });

    it("delegates state.delete", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { scopeKind: "instance" as const, stateKey: "old-key" };
      await handlers["state.delete"](params);
      expect(services.state.delete).toHaveBeenCalledWith(params);
    });

    it("delegates entities.upsert", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        entityType: "linear-issue",
        scopeKind: "project" as const,
        scopeId: "proj-1",
        externalId: "LIN-123",
        title: "Fix bug",
        status: "open",
        data: { url: "https://linear.app/issue/LIN-123" },
      };

      const result = await handlers["entities.upsert"](params);
      expect(services.entities.upsert).toHaveBeenCalledWith(params);
      expect(result).toBeDefined();
      expect(result.id).toBe("ent-1");
    });

    it("delegates entities.list with query", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        entityType: "linear-issue",
        scopeKind: "project" as const,
        limit: 10,
        offset: 0,
      };

      await handlers["entities.list"](params);
      expect(services.entities.list).toHaveBeenCalledWith(params);
    });

    it("delegates events.emit", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { name: "sync-done", payload: { records: 42 } };
      await handlers["events.emit"](params);
      expect(services.events.emit).toHaveBeenCalledWith(params);
    });

    it("delegates http.fetch", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        url: "https://api.example.com/data",
        init: { method: "POST", body: '{"key":"val"}' },
      };

      const result = await handlers["http.fetch"](params);
      expect(services.http.fetch).toHaveBeenCalledWith(params);
      expect(result.status).toBe(200);
    });

    it("delegates secrets.resolve", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const result = await handlers["secrets.resolve"]({ secretRef: "API_KEY" });
      expect(services.secrets.resolve).toHaveBeenCalledWith({ secretRef: "API_KEY" });
      expect(result).toBe("secret-value");
    });

    it("delegates assets.upload", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { filename: "img.png", contentType: "image/png", data: "base64data" };
      const result = await handlers["assets.upload"](params);
      expect(services.assets.upload).toHaveBeenCalledWith(params);
      expect(result.assetId).toBe("asset-1");
    });

    it("delegates assets.getUrl", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const result = await handlers["assets.getUrl"]({ assetId: "asset-1" });
      expect(services.assets.getUrl).toHaveBeenCalledWith({ assetId: "asset-1" });
      expect(result).toBe("https://cdn.example.com/asset-1");
    });

    it("delegates activity.log", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        message: "Synced 10 issues",
        entityType: "issue",
        entityId: "issue-1",
        metadata: { count: 10 },
      };

      await handlers["activity.log"](params);
      expect(services.activity.log).toHaveBeenCalledWith(params);
    });

    it("delegates metrics.write", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { name: "sync.duration", value: 1234, tags: { plugin: "test" } };
      await handlers["metrics.write"](params);
      expect(services.metrics.write).toHaveBeenCalledWith(params);
    });

    it("delegates log to services.logger.log", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { level: "error" as const, message: "Something failed", meta: { stack: "..." } };
      await handlers["log"](params);
      expect(services.logger.log).toHaveBeenCalledWith(params);
    });

    it("delegates companies.list", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["companies.list"]({ limit: 5 });
      expect(services.companies.list).toHaveBeenCalledWith({ limit: 5 });
    });

    it("delegates companies.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["companies.get"]({ companyId: "c1" });
      expect(services.companies.get).toHaveBeenCalledWith({ companyId: "c1" });
    });

    it("delegates projects.list", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["projects.list"]({ companyId: "c1", limit: 10 });
      expect(services.projects.list).toHaveBeenCalledWith({ companyId: "c1", limit: 10 });
    });

    it("delegates projects.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["projects.get"]({ projectId: "p1", companyId: "c1" });
      expect(services.projects.get).toHaveBeenCalledWith({ projectId: "p1", companyId: "c1" });
    });

    it("delegates projects.listWorkspaces", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["projects.listWorkspaces"]({ projectId: "p1", companyId: "c1" });
      expect(services.projects.listWorkspaces).toHaveBeenCalledWith({ projectId: "p1", companyId: "c1" });
    });

    it("delegates projects.getPrimaryWorkspace", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["projects.getPrimaryWorkspace"]({ projectId: "p1", companyId: "c1" });
      expect(services.projects.getPrimaryWorkspace).toHaveBeenCalledWith({ projectId: "p1", companyId: "c1" });
    });

    it("delegates issues.list", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["issues.list"]({ companyId: "c1", status: "todo", limit: 10 });
      expect(services.issues.list).toHaveBeenCalledWith({ companyId: "c1", status: "todo", limit: 10 });
    });

    it("delegates issues.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["issues.get"]({ issueId: "i1", companyId: "c1" });
      expect(services.issues.get).toHaveBeenCalledWith({ issueId: "i1", companyId: "c1" });
    });

    it("delegates issues.create", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = {
        companyId: "c1",
        projectId: "p1",
        title: "New issue",
        description: "A test issue",
        priority: "high",
      };

      await handlers["issues.create"](params);
      expect(services.issues.create).toHaveBeenCalledWith(params);
    });

    it("delegates issues.update", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      const params = { issueId: "i1", patch: { title: "Updated", status: "done" }, companyId: "c1" };
      await handlers["issues.update"](params);
      expect(services.issues.update).toHaveBeenCalledWith(params);
    });

    it("delegates issues.listComments", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["issues.listComments"]({ issueId: "i1", companyId: "c1" });
      expect(services.issues.listComments).toHaveBeenCalledWith({ issueId: "i1", companyId: "c1" });
    });

    it("delegates issues.createComment", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["issues.createComment"]({ issueId: "i1", body: "A comment", companyId: "c1" });
      expect(services.issues.createComment).toHaveBeenCalledWith({ issueId: "i1", body: "A comment", companyId: "c1" });
    });

    it("delegates agents.list", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["agents.list"]({ companyId: "c1", status: "active" });
      expect(services.agents.list).toHaveBeenCalledWith({ companyId: "c1", status: "active" });
    });

    it("delegates agents.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["agents.get"]({ agentId: "a1", companyId: "c1" });
      expect(services.agents.get).toHaveBeenCalledWith({ agentId: "a1", companyId: "c1" });
    });

    it("delegates goals.list", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["goals.list"]({ companyId: "c1", level: "company" });
      expect(services.goals.list).toHaveBeenCalledWith({ companyId: "c1", level: "company" });
    });

    it("delegates goals.get", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await handlers["goals.get"]({ goalId: "g1", companyId: "c1" });
      expect(services.goals.get).toHaveBeenCalledWith({ goalId: "g1", companyId: "c1" });
    });
  });

  describe("error propagation from services", () => {
    it("propagates service errors through the handler", async () => {
      const error = new Error("Database connection failed");
      (services.state.get as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: ALL_CAPABILITIES,
        services,
      });

      await expect(
        handlers["state.get"]({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow("Database connection failed");
    });

    it("capability check runs before service call (service is never reached on denied)", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [], // No capabilities
        services,
      });

      await expect(
        handlers["state.get"]({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow(CapabilityDeniedError);

      // Service was never called
      expect(services.state.get).not.toHaveBeenCalled();
    });
  });

  describe("mixed capability scenarios", () => {
    it("allows some methods while blocking others based on capabilities", async () => {
      const handlers = createHostClientHandlers({
        pluginId: "test.plugin",
        capabilities: [
          "plugin.state.read",
          "issues.read",
          "events.subscribe", // note: subscribe, not emit
        ],
        services,
      });

      // Allowed
      await expect(handlers["state.get"]({ scopeKind: "instance", stateKey: "k" })).resolves.toBeDefined();
      await expect(handlers["issues.list"]({})).resolves.toBeDefined();
      await expect(handlers["config.get"]({} as Record<string, never>)).resolves.toBeDefined(); // no cap needed

      // Blocked
      await expect(handlers["state.set"]({ scopeKind: "instance", stateKey: "k", value: 1 })).rejects.toThrow(CapabilityDeniedError);
      await expect(handlers["events.emit"]({ name: "x", payload: {} })).rejects.toThrow(CapabilityDeniedError);
      await expect(handlers["issues.create"]({ companyId: "c", title: "t" })).rejects.toThrow(CapabilityDeniedError);
    });
  });
});

describe("getRequiredCapability", () => {
  it("returns null for methods with no capability requirement", () => {
    expect(getRequiredCapability("config.get")).toBeNull();
    expect(getRequiredCapability("log")).toBeNull();
    expect(getRequiredCapability("entities.upsert")).toBeNull();
    expect(getRequiredCapability("entities.list")).toBeNull();
  });

  it("returns the correct capability for state methods", () => {
    expect(getRequiredCapability("state.get")).toBe("plugin.state.read");
    expect(getRequiredCapability("state.set")).toBe("plugin.state.write");
    expect(getRequiredCapability("state.delete")).toBe("plugin.state.write");
  });

  it("returns the correct capability for events methods", () => {
    expect(getRequiredCapability("events.emit")).toBe("events.emit");
  });

  it("returns the correct capability for integration methods", () => {
    expect(getRequiredCapability("http.fetch")).toBe("http.outbound");
    expect(getRequiredCapability("secrets.resolve")).toBe("secrets.read-ref");
  });

  it("returns the correct capability for asset methods", () => {
    expect(getRequiredCapability("assets.upload")).toBe("assets.write");
    expect(getRequiredCapability("assets.getUrl")).toBe("assets.read");
  });

  it("returns the correct capability for data write methods", () => {
    expect(getRequiredCapability("activity.log")).toBe("activity.log.write");
    expect(getRequiredCapability("metrics.write")).toBe("metrics.write");
  });

  it("returns the correct capability for read methods", () => {
    expect(getRequiredCapability("companies.list")).toBe("companies.read");
    expect(getRequiredCapability("companies.get")).toBe("companies.read");
    expect(getRequiredCapability("projects.list")).toBe("projects.read");
    expect(getRequiredCapability("projects.get")).toBe("projects.read");
    expect(getRequiredCapability("projects.listWorkspaces")).toBe("project.workspaces.read");
    expect(getRequiredCapability("projects.getPrimaryWorkspace")).toBe("project.workspaces.read");
    expect(getRequiredCapability("issues.list")).toBe("issues.read");
    expect(getRequiredCapability("issues.get")).toBe("issues.read");
    expect(getRequiredCapability("issues.create")).toBe("issues.create");
    expect(getRequiredCapability("issues.update")).toBe("issues.update");
    expect(getRequiredCapability("issues.listComments")).toBe("issue.comments.read");
    expect(getRequiredCapability("issues.createComment")).toBe("issue.comments.create");
    expect(getRequiredCapability("agents.list")).toBe("agents.read");
    expect(getRequiredCapability("agents.get")).toBe("agents.read");
    expect(getRequiredCapability("goals.list")).toBe("goals.read");
    expect(getRequiredCapability("goals.get")).toBe("goals.read");
  });
});

describe("CapabilityDeniedError", () => {
  it("has name CapabilityDeniedError", () => {
    const err = new CapabilityDeniedError("test", "state.get", "plugin.state.read");
    expect(err.name).toBe("CapabilityDeniedError");
  });

  it("is an instance of Error", () => {
    const err = new CapabilityDeniedError("test", "state.get", "plugin.state.read");
    expect(err).toBeInstanceOf(Error);
  });

  it("has code CAPABILITY_DENIED", () => {
    const err = new CapabilityDeniedError("test", "state.get", "plugin.state.read");
    expect(err.code).toBe(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED);
  });

  it("includes plugin ID, method, and capability in message", () => {
    const err = new CapabilityDeniedError("acme.linear", "state.get", "plugin.state.read");
    expect(err.message).toContain("acme.linear");
    expect(err.message).toContain("state.get");
    expect(err.message).toContain("plugin.state.read");
  });
});
