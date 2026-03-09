/**
 * Tests for SDK host services via createTestHarness.
 *
 * Covers:
 * - Capability gating: all host services enforce declared capabilities
 * - State operations: get/set/delete with full scope key semantics (scoping,
 *   namespaces, composite keys, falsy values, null vs undefined)
 * - Data handler registration and invocation through harness.getData()
 * - Action handler registration and invocation through harness.performAction()
 * - Tool handler registration and invocation through harness.executeTool()
 * - Activity, metrics, and logger capture
 * - Entity operations (upsert, list, filtering, external key deduplication)
 * - Event dispatch and filtering through harness.emit()
 * - Job handler registration and invocation through harness.runJob()
 * - Config get/set through harness.setConfig()
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestHarness, definePlugin } from "@paperclipai/plugin-sdk";
import type {
  TestHarness,
  PaperclipPluginManifestV1,
  PluginContext,
  ScopeKey,
  PluginEvent,
  PluginCapability,
} from "@paperclipai/plugin-sdk";

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a minimal manifest with the given capabilities.
 */
function manifest(capabilities: PluginCapability[]): PaperclipPluginManifestV1 {
  return {
    id: "test.host-services",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Host Services Test Plugin",
    description: "Used in host services test suite",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  };
}

/**
 * All capabilities that the test harness can gate on.
 */
const ALL_CAPABILITIES: PluginCapability[] = [
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "issues.read",
  "issue.comments.read",
  "issue.comments.create",
  "agents.read",
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "goals.read",
  "goals.create",
  "goals.update",
  "activity.read",
  "costs.read",
  "issues.create",
  "issues.update",
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

// ===========================================================================
// Capability gating — test harness enforces declared capabilities
// ===========================================================================

describe("test harness capability gating", () => {
  describe("state capability gating", () => {
    it("blocks state.get without plugin.state.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.write"]),
      });

      await expect(
        h.ctx.state.get({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow(/missing required capability.*plugin\.state\.read/i);
    });

    it("blocks state.set without plugin.state.write", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.read"]),
      });

      await expect(
        h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "v"),
      ).rejects.toThrow(/missing required capability.*plugin\.state\.write/i);
    });

    it("blocks state.delete without plugin.state.write", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.read"]),
      });

      await expect(
        h.ctx.state.delete({ scopeKind: "instance", stateKey: "k" }),
      ).rejects.toThrow(/missing required capability.*plugin\.state\.write/i);
    });

    it("allows state.get with plugin.state.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.read"]),
      });

      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "k" });
      expect(result).toBeNull();
    });

    it("allows state.set and state.delete with plugin.state.write", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.write"]),
      });

      // set should not throw
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "v");
      // delete should not throw
      await h.ctx.state.delete({ scopeKind: "instance", stateKey: "k" });
    });
  });

  describe("events capability gating", () => {
    it("blocks events.on without events.subscribe", () => {
      const h = createTestHarness({
        manifest: manifest(["events.emit"]),
      });

      expect(() =>
        h.ctx.events.on("issue.created", async () => {}),
      ).toThrow(/missing required capability.*events\.subscribe/i);
    });

    it("blocks events.emit without events.emit", async () => {
      const h = createTestHarness({
        manifest: manifest(["events.subscribe"]),
      });

      await expect(
        h.ctx.events.emit("test-event", { data: 1 }),
      ).rejects.toThrow(/missing required capability.*events\.emit/i);
    });

    it("allows events.on with events.subscribe", () => {
      const h = createTestHarness({
        manifest: manifest(["events.subscribe"]),
      });

      // Should not throw
      h.ctx.events.on("issue.created", async () => {});
    });
  });

  describe("jobs capability gating", () => {
    it("blocks jobs.register without jobs.schedule", () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      expect(() =>
        h.ctx.jobs.register("sync", async () => {}),
      ).toThrow(/missing required capability.*jobs\.schedule/i);
    });

    it("allows jobs.register with jobs.schedule", () => {
      const h = createTestHarness({
        manifest: manifest(["jobs.schedule"]),
      });

      h.ctx.jobs.register("sync", async () => {});
      // Should not throw
    });
  });

  describe("secrets capability gating", () => {
    it("blocks secrets.resolve without secrets.read-ref", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(
        h.ctx.secrets.resolve("MY_KEY"),
      ).rejects.toThrow(/missing required capability.*secrets\.read-ref/i);
    });
  });

  describe("assets capability gating", () => {
    it("blocks assets.upload without assets.write", async () => {
      const h = createTestHarness({
        manifest: manifest(["assets.read"]),
      });

      await expect(
        h.ctx.assets.upload("file.png", "image/png", new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/missing required capability.*assets\.write/i);
    });

    it("blocks assets.getUrl without assets.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["assets.write"]),
      });

      await expect(
        h.ctx.assets.getUrl("asset-1"),
      ).rejects.toThrow(/missing required capability.*assets\.read/i);
    });
  });

  describe("activity capability gating", () => {
    it("blocks activity.log without activity.log.write", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(
        h.ctx.activity.log({ message: "test" }),
      ).rejects.toThrow(/missing required capability.*activity\.log\.write/i);
    });
  });

  describe("metrics capability gating", () => {
    it("blocks metrics.write without metrics.write", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(
        h.ctx.metrics.write("m", 1),
      ).rejects.toThrow(/missing required capability.*metrics\.write/i);
    });
  });

  describe("tools capability gating", () => {
    it("blocks tools.register without agent.tools.register", () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      expect(() =>
        h.ctx.tools.register(
          "search",
          { displayName: "Search", description: "Search", parametersSchema: {} },
          async () => ({ content: "ok" }),
        ),
      ).toThrow(/missing required capability.*agent\.tools\.register/i);
    });
  });

  describe("companies capability gating", () => {
    it("blocks companies.list without companies.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.companies.list()).rejects.toThrow(
        /missing required capability.*companies\.read/i,
      );
    });

    it("blocks companies.get without companies.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.companies.get("c1")).rejects.toThrow(
        /missing required capability.*companies\.read/i,
      );
    });
  });

  describe("projects capability gating", () => {
    it("blocks projects.list without projects.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.projects.list({ companyId: "c1" })).rejects.toThrow(
        /missing required capability.*projects\.read/i,
      );
    });

    it("blocks projects.listWorkspaces without project.workspaces.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["projects.read"]),
      });

      await expect(h.ctx.projects.listWorkspaces("p1", "c1")).rejects.toThrow(
        /missing required capability.*project\.workspaces\.read/i,
      );
    });

    it("blocks projects.getPrimaryWorkspace without project.workspaces.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["projects.read"]),
      });

      await expect(h.ctx.projects.getPrimaryWorkspace("p1", "c1")).rejects.toThrow(
        /missing required capability.*project\.workspaces\.read/i,
      );
    });
  });

  describe("issues capability gating", () => {
    it("blocks issues.list without issues.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.issues.list({ companyId: "c1" })).rejects.toThrow(
        /missing required capability.*issues\.read/i,
      );
    });

    it("blocks issues.create without issues.create", async () => {
      const h = createTestHarness({
        manifest: manifest(["issues.read"]),
      });

      await expect(
        h.ctx.issues.create({ companyId: "c1", title: "test" }),
      ).rejects.toThrow(/missing required capability.*issues\.create/i);
    });

    it("blocks issues.update without issues.update", async () => {
      const h = createTestHarness({
        manifest: manifest(["issues.read", "issues.create"]),
      });

      await expect(
        h.ctx.issues.update("i1", { title: "updated" }, "c1"),
      ).rejects.toThrow(/missing required capability.*issues\.update/i);
    });

    it("blocks issues.listComments without issue.comments.read", async () => {
      const h = createTestHarness({
        manifest: manifest(["issues.read"]),
      });

      await expect(h.ctx.issues.listComments("i1", "c1")).rejects.toThrow(
        /missing required capability.*issue\.comments\.read/i,
      );
    });

    it("blocks issues.createComment without issue.comments.create", async () => {
      const h = createTestHarness({
        manifest: manifest(["issues.read", "issue.comments.read"]),
      });

      await expect(
        h.ctx.issues.createComment("i1", "hello", "c1"),
      ).rejects.toThrow(/missing required capability.*issue\.comments\.create/i);
    });
  });

  describe("agents capability gating", () => {
    it("blocks agents.list without agents.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.agents.list({ companyId: "c1" })).rejects.toThrow(
        /missing required capability.*agents\.read/i,
      );
    });

    it("blocks agents.pause without agents.pause", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read"]),
      });

      await expect(h.ctx.agents.pause("a1", "c1")).rejects.toThrow(
        /missing required capability.*agents\.pause/i,
      );
    });

    it("blocks agents.resume without agents.resume", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read"]),
      });

      await expect(h.ctx.agents.resume("a1", "c1")).rejects.toThrow(
        /missing required capability.*agents\.resume/i,
      );
    });

    it("blocks agents.invoke without agents.invoke", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read"]),
      });

      await expect(
        h.ctx.agents.invoke("a1", "c1", { prompt: "test" }),
      ).rejects.toThrow(/missing required capability.*agents\.invoke/i);
    });
  });

  describe("goals capability gating", () => {
    it("blocks goals.list without goals.read", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      await expect(h.ctx.goals.list({ companyId: "c1" })).rejects.toThrow(
        /missing required capability.*goals\.read/i,
      );
    });

    it("blocks goals.create without goals.create", async () => {
      const h = createTestHarness({
        manifest: manifest(["goals.read"]),
      });

      await expect(
        h.ctx.goals.create({ companyId: "c1", title: "New goal" }),
      ).rejects.toThrow(/missing required capability.*goals\.create/i);
    });

    it("blocks goals.update without goals.update", async () => {
      const h = createTestHarness({
        manifest: manifest(["goals.read", "goals.create"]),
      });

      await expect(
        h.ctx.goals.update("g1", { title: "Updated" }, "c1"),
      ).rejects.toThrow(/missing required capability.*goals\.update/i);
    });
  });

  describe("capability override", () => {
    it("uses manifest capabilities when no override provided", async () => {
      const h = createTestHarness({
        manifest: manifest(["plugin.state.read"]),
      });

      // Read allowed
      await expect(
        h.ctx.state.get({ scopeKind: "instance", stateKey: "k" }),
      ).resolves.toBeNull();

      // Write blocked
      await expect(
        h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "v"),
      ).rejects.toThrow(/missing required capability/i);
    });

    it("uses capabilities override when provided", async () => {
      const h = createTestHarness({
        manifest: manifest([]), // no capabilities in manifest
        capabilities: ["plugin.state.read", "plugin.state.write"], // override
      });

      // Both read and write allowed despite empty manifest capabilities
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "v");
      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "k" });
      expect(result).toBe("v");
    });
  });

  describe("logger is always allowed (no capability needed)", () => {
    it("all log levels work without any capability", () => {
      const h = createTestHarness({
        manifest: manifest([]), // no capabilities
      });

      // None of these should throw
      h.ctx.logger.info("info message");
      h.ctx.logger.warn("warn message");
      h.ctx.logger.error("error message");
      h.ctx.logger.debug("debug message");

      expect(h.logs).toHaveLength(4);
    });
  });

  describe("config.get is always allowed (no capability needed)", () => {
    it("config.get works without any capability", async () => {
      const h = createTestHarness({
        manifest: manifest([]), // no capabilities
        config: { apiKey: "test" },
      });

      const config = await h.ctx.config.get();
      expect(config).toEqual({ apiKey: "test" });
    });
  });

  describe("entities are always allowed (no capability needed)", () => {
    it("entities.upsert works without any capability", async () => {
      const h = createTestHarness({
        manifest: manifest([]), // no capabilities
      });

      const record = await h.ctx.entities.upsert({
        entityType: "ticket",
        scopeKind: "instance",
        data: { name: "test" },
      });

      expect(record.id).toBeDefined();
      expect(record.entityType).toBe("ticket");
    });

    it("entities.list works without any capability", async () => {
      const h = createTestHarness({
        manifest: manifest([]),
      });

      const results = await h.ctx.entities.list({});
      expect(results).toEqual([]);
    });
  });
});

// ===========================================================================
// State operations — full scope key semantics
// ===========================================================================

describe("state operations through test harness", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(["plugin.state.read", "plugin.state.write"]),
    });
  });

  describe("basic get/set/delete", () => {
    it("get returns null for unset keys", async () => {
      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "missing" });
      expect(result).toBeNull();
    });

    it("set then get returns stored value", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "version" }, 42);
      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "version" });
      expect(result).toBe(42);
    });

    it("delete removes a previously set value", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "temp" }, "data");
      await h.ctx.state.delete({ scopeKind: "instance", stateKey: "temp" });
      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "temp" });
      expect(result).toBeNull();
    });

    it("delete is idempotent (no-op for unset keys)", async () => {
      // Should not throw
      await h.ctx.state.delete({ scopeKind: "instance", stateKey: "never-set" });
    });

    it("set overwrites existing values", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "old");
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "new");
      const result = await h.ctx.state.get({ scopeKind: "instance", stateKey: "k" });
      expect(result).toBe("new");
    });
  });

  describe("stores JSON-serializable values correctly", () => {
    it("stores objects", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "obj" };
      const obj = { nested: { value: [1, 2, 3] }, flag: true };
      await h.ctx.state.set(scope, obj);
      expect(await h.ctx.state.get(scope)).toEqual(obj);
    });

    it("stores arrays", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "arr" };
      await h.ctx.state.set(scope, [1, "two", { three: 3 }]);
      expect(await h.ctx.state.get(scope)).toEqual([1, "two", { three: 3 }]);
    });

    it("stores strings", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "str" };
      await h.ctx.state.set(scope, "hello");
      expect(await h.ctx.state.get(scope)).toBe("hello");
    });

    it("stores numbers", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "num" };
      await h.ctx.state.set(scope, 3.14);
      expect(await h.ctx.state.get(scope)).toBe(3.14);
    });

    it("stores booleans", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "bool" };
      await h.ctx.state.set(scope, true);
      expect(await h.ctx.state.get(scope)).toBe(true);
    });

    it("stores null", async () => {
      const scope: ScopeKey = { scopeKind: "instance", stateKey: "nul" };
      await h.ctx.state.set(scope, null);
      // null is a valid stored value — distinct from "not set"
      // The harness returns null for both unset and explicitly-set null,
      // so getState() should show it was stored
      expect(h.getState(scope)).toBeNull();
    });

    it("stores falsy values correctly (false, 0, empty string)", async () => {
      const boolScope: ScopeKey = { scopeKind: "instance", stateKey: "false-val" };
      await h.ctx.state.set(boolScope, false);
      expect(await h.ctx.state.get(boolScope)).toBe(false);

      const zeroScope: ScopeKey = { scopeKind: "instance", stateKey: "zero-val" };
      await h.ctx.state.set(zeroScope, 0);
      expect(await h.ctx.state.get(zeroScope)).toBe(0);

      const emptyScope: ScopeKey = { scopeKind: "instance", stateKey: "empty-str" };
      await h.ctx.state.set(emptyScope, "");
      expect(await h.ctx.state.get(emptyScope)).toBe("");
    });
  });

  describe("scope isolation", () => {
    it("instance scope keys are isolated from project scope", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "version" }, "A");
      await h.ctx.state.set({ scopeKind: "project", scopeId: "p1", stateKey: "version" }, "B");

      expect(await h.ctx.state.get({ scopeKind: "instance", stateKey: "version" })).toBe("A");
      expect(await h.ctx.state.get({ scopeKind: "project", scopeId: "p1", stateKey: "version" })).toBe("B");
    });

    it("different scope IDs within the same scope kind are isolated", async () => {
      await h.ctx.state.set({ scopeKind: "company", scopeId: "c1", stateKey: "cursor" }, "abc");
      await h.ctx.state.set({ scopeKind: "company", scopeId: "c2", stateKey: "cursor" }, "xyz");

      expect(await h.ctx.state.get({ scopeKind: "company", scopeId: "c1", stateKey: "cursor" })).toBe("abc");
      expect(await h.ctx.state.get({ scopeKind: "company", scopeId: "c2", stateKey: "cursor" })).toBe("xyz");
    });

    it("all scope kinds store independently", async () => {
      const scopeKinds: ScopeKey[] = [
        { scopeKind: "instance", stateKey: "k" },
        { scopeKind: "company", scopeId: "c1", stateKey: "k" },
        { scopeKind: "project", scopeId: "p1", stateKey: "k" },
        { scopeKind: "project_workspace", scopeId: "pw1", stateKey: "k" },
        { scopeKind: "agent", scopeId: "a1", stateKey: "k" },
        { scopeKind: "issue", scopeId: "i1", stateKey: "k" },
        { scopeKind: "goal", scopeId: "g1", stateKey: "k" },
        { scopeKind: "run", scopeId: "r1", stateKey: "k" },
      ];

      // Set each with a different value
      for (let i = 0; i < scopeKinds.length; i++) {
        await h.ctx.state.set(scopeKinds[i], `value-${i}`);
      }

      // Verify each stored independently
      for (let i = 0; i < scopeKinds.length; i++) {
        const val = await h.ctx.state.get(scopeKinds[i]);
        expect(val, `scope kind ${scopeKinds[i].scopeKind} should have value-${i}`).toBe(`value-${i}`);
      }
    });
  });

  describe("namespace isolation", () => {
    it("different namespaces within same scope are isolated", async () => {
      const base: Omit<ScopeKey, "namespace"> = { scopeKind: "project", scopeId: "p1", stateKey: "cursor" };

      await h.ctx.state.set({ ...base, namespace: "linear" }, "cursor-A");
      await h.ctx.state.set({ ...base, namespace: "github" }, "cursor-B");

      expect(await h.ctx.state.get({ ...base, namespace: "linear" })).toBe("cursor-A");
      expect(await h.ctx.state.get({ ...base, namespace: "github" })).toBe("cursor-B");
    });

    it("omitting namespace defaults to 'default' (consistent retrieval)", async () => {
      // set without namespace
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, "value1");

      // set with explicit 'default' namespace
      await h.ctx.state.set({ scopeKind: "instance", namespace: "default", stateKey: "k" }, "value2");

      // Both refer to the same key — value2 should overwrite value1
      expect(await h.ctx.state.get({ scopeKind: "instance", stateKey: "k" })).toBe("value2");
    });

    it("deleting in one namespace does not affect another", async () => {
      const base = { scopeKind: "project" as const, scopeId: "p1", stateKey: "cache" };

      await h.ctx.state.set({ ...base, namespace: "ns1" }, "data1");
      await h.ctx.state.set({ ...base, namespace: "ns2" }, "data2");

      await h.ctx.state.delete({ ...base, namespace: "ns1" });

      expect(await h.ctx.state.get({ ...base, namespace: "ns1" })).toBeNull();
      expect(await h.ctx.state.get({ ...base, namespace: "ns2" })).toBe("data2");
    });
  });

  describe("harness.getState() direct access", () => {
    it("returns raw state for assertions", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "raw" }, { complex: true });
      const raw = h.getState({ scopeKind: "instance", stateKey: "raw" });
      expect(raw).toEqual({ complex: true });
    });

    it("returns undefined for unset keys (not null)", () => {
      const raw = h.getState({ scopeKind: "instance", stateKey: "never-set" });
      expect(raw).toBeUndefined();
    });
  });
});

// ===========================================================================
// Data handler registration and invocation
// ===========================================================================

describe("data handler registration and invocation", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(ALL_CAPABILITIES),
    });
  });

  it("registers and invokes a data handler by key", async () => {
    h.ctx.data.register("sync-health", async ({ companyId }) => {
      return { companyId, status: "synced" };
    });

    const result = await h.getData<{ companyId: unknown; status: string }>(
      "sync-health",
      { companyId: "co-1" },
    );

    expect(result.companyId).toBe("co-1");
    expect(result.status).toBe("synced");
  });

  it("throws when invoking an unregistered data handler", async () => {
    await expect(
      h.getData("non-existent"),
    ).rejects.toThrow(/No data handler registered for 'non-existent'/);
  });

  it("data handler can use ctx state internally", async () => {
    // Seed state
    await h.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "last-sync" },
      "2024-06-01T00:00:00Z",
    );

    h.ctx.data.register("sync-info", async ({ companyId }) => {
      const lastSync = await h.ctx.state.get({
        scopeKind: "company",
        scopeId: String(companyId),
        stateKey: "last-sync",
      });
      return { lastSync, isSynced: lastSync !== null };
    });

    const result = await h.getData<{ lastSync: unknown; isSynced: boolean }>(
      "sync-info",
      { companyId: "co-1" },
    );

    expect(result.lastSync).toBe("2024-06-01T00:00:00Z");
    expect(result.isSynced).toBe(true);
  });

  it("data handler receives params correctly", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    h.ctx.data.register("capture-params", async (params) => {
      capturedParams = params;
      return { ok: true };
    });

    await h.getData("capture-params", { a: 1, b: "two", c: [3] });
    expect(capturedParams).toEqual({ a: 1, b: "two", c: [3] });
  });

  it("data handler defaults params to empty object", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    h.ctx.data.register("default-params", async (params) => {
      capturedParams = params;
      return {};
    });

    await h.getData("default-params");
    expect(capturedParams).toEqual({});
  });

  it("supports multiple data handlers registered to different keys", async () => {
    h.ctx.data.register("handler-a", async () => ({ key: "a" }));
    h.ctx.data.register("handler-b", async () => ({ key: "b" }));

    const a = await h.getData<{ key: string }>("handler-a");
    const b = await h.getData<{ key: string }>("handler-b");

    expect(a.key).toBe("a");
    expect(b.key).toBe("b");
  });
});

// ===========================================================================
// Action handler registration and invocation
// ===========================================================================

describe("action handler registration and invocation", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(ALL_CAPABILITIES),
    });
  });

  it("registers and invokes an action handler by key", async () => {
    h.ctx.actions.register("resync", async ({ companyId }) => {
      return { triggered: true, companyId };
    });

    const result = await h.performAction<{ triggered: boolean; companyId: unknown }>(
      "resync",
      { companyId: "co-1" },
    );

    expect(result.triggered).toBe(true);
    expect(result.companyId).toBe("co-1");
  });

  it("throws when invoking an unregistered action handler", async () => {
    await expect(
      h.performAction("non-existent"),
    ).rejects.toThrow(/No action handler registered for 'non-existent'/);
  });

  it("action handler can perform side effects through ctx", async () => {
    h.ctx.actions.register("mark-synced", async ({ issueId }) => {
      await h.ctx.state.set(
        { scopeKind: "issue", scopeId: String(issueId), stateKey: "synced" },
        true,
      );
      return { success: true };
    });

    await h.performAction("mark-synced", { issueId: "iss-42" });

    const synced = await h.ctx.state.get({
      scopeKind: "issue",
      scopeId: "iss-42",
      stateKey: "synced",
    });
    expect(synced).toBe(true);
  });

  it("action handler can emit events", async () => {
    const receivedEvents: string[] = [];
    h.ctx.events.on("plugin.*", async (event) => {
      receivedEvents.push(event.eventType);
    });

    h.ctx.actions.register("trigger-resync", async () => {
      await h.ctx.events.emit("resync-started", {});
      return { triggered: true };
    });

    await h.performAction("trigger-resync");
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]).toContain("resync-started");
  });

  it("action handler receives params correctly", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    h.ctx.actions.register("capture", async (params) => {
      capturedParams = params;
      return {};
    });

    await h.performAction("capture", { foo: "bar", count: 5 });
    expect(capturedParams).toEqual({ foo: "bar", count: 5 });
  });
});

// ===========================================================================
// Tool handler registration and invocation
// ===========================================================================

describe("tool handler registration and invocation", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(ALL_CAPABILITIES),
    });
  });

  it("registers and invokes a tool handler by name", async () => {
    h.ctx.tools.register(
      "search-issues",
      {
        displayName: "Search Issues",
        description: "Search for issues",
        parametersSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      async (params) => ({
        content: `Results for: ${(params as { query: string }).query}`,
      }),
    );

    const result = await h.executeTool("search-issues", { query: "bug" });
    expect(result.content).toBe("Results for: bug");
  });

  it("throws when invoking an unregistered tool", async () => {
    await expect(
      h.executeTool("non-existent", {}),
    ).rejects.toThrow(/No tool handler registered for 'non-existent'/);
  });

  it("tool handler receives params and ToolRunContext", async () => {
    let capturedParams: unknown = null;
    let capturedCtx: unknown = null;

    h.ctx.tools.register(
      "capture-tool",
      { displayName: "Capture", description: "Captures", parametersSchema: {} },
      async (params, runCtx) => {
        capturedParams = params;
        capturedCtx = runCtx;
        return { content: "ok" };
      },
    );

    await h.executeTool("capture-tool", { q: "test" }, {
      agentId: "agent-X",
      runId: "run-Y",
      companyId: "co-Z",
      projectId: "proj-W",
    });

    expect(capturedParams).toEqual({ q: "test" });
    expect(capturedCtx).toEqual({
      agentId: "agent-X",
      runId: "run-Y",
      companyId: "co-Z",
      projectId: "proj-W",
    });
  });

  it("tool handler provides default ToolRunContext when not specified", async () => {
    let capturedCtx: unknown = null;

    h.ctx.tools.register(
      "default-ctx",
      { displayName: "D", description: "D", parametersSchema: {} },
      async (_params, runCtx) => {
        capturedCtx = runCtx;
        return { content: "ok" };
      },
    );

    await h.executeTool("default-ctx", {});

    const ctx = capturedCtx as { agentId: string; runId: string; companyId: string; projectId: string };
    expect(ctx.agentId).toBe("agent-test");
    expect(ctx.companyId).toBe("company-test");
    expect(ctx.projectId).toBe("project-test");
    expect(ctx.runId).toBeDefined();
  });

  it("tool handler can return error results", async () => {
    h.ctx.tools.register(
      "error-tool",
      { displayName: "Error", description: "Fails", parametersSchema: {} },
      async () => ({ error: "Something went wrong" }),
    );

    const result = await h.executeTool("error-tool", {});
    expect(result.error).toBe("Something went wrong");
    expect(result.content).toBeUndefined();
  });

  it("tool handler can return data alongside content", async () => {
    h.ctx.tools.register(
      "data-tool",
      { displayName: "Data", description: "Returns data", parametersSchema: {} },
      async () => ({ content: "Summary", data: { count: 42, items: ["a", "b"] } }),
    );

    const result = await h.executeTool("data-tool", {});
    expect(result.content).toBe("Summary");
    expect(result.data).toEqual({ count: 42, items: ["a", "b"] });
  });
});

// ===========================================================================
// Activity, metrics, and logger capture
// ===========================================================================

describe("activity log capture", () => {
  it("captures activity log entries", async () => {
    const h = createTestHarness({
      manifest: manifest(["activity.log.write"]),
    });

    await h.ctx.activity.log({ message: "Synced 5 issues" });
    await h.ctx.activity.log({
      message: "Created entity",
      entityType: "linear-issue",
      entityId: "LIN-1",
      metadata: { url: "https://linear.app/LIN-1" },
    });

    expect(h.activity).toHaveLength(2);
    expect(h.activity[0]).toEqual({ message: "Synced 5 issues" });
    expect(h.activity[1]).toEqual({
      message: "Created entity",
      entityType: "linear-issue",
      entityId: "LIN-1",
      metadata: { url: "https://linear.app/LIN-1" },
    });
  });
});

describe("metrics capture", () => {
  it("captures metric data points", async () => {
    const h = createTestHarness({
      manifest: manifest(["metrics.write"]),
    });

    await h.ctx.metrics.write("sync.duration", 1234);
    await h.ctx.metrics.write("sync.records", 42, { region: "us-east" });

    expect(h.metrics).toHaveLength(2);
    expect(h.metrics[0]).toEqual({ name: "sync.duration", value: 1234 });
    expect(h.metrics[1]).toEqual({
      name: "sync.records",
      value: 42,
      tags: { region: "us-east" },
    });
  });
});

describe("logger capture", () => {
  it("captures all log levels", () => {
    const h = createTestHarness({
      manifest: manifest([]),
    });

    h.ctx.logger.info("Info message", { key: "val" });
    h.ctx.logger.warn("Warn message");
    h.ctx.logger.error("Error message", { code: 500 });
    h.ctx.logger.debug("Debug message");

    expect(h.logs).toHaveLength(4);
    expect(h.logs[0]).toEqual({ level: "info", message: "Info message", meta: { key: "val" } });
    expect(h.logs[1]).toEqual({ level: "warn", message: "Warn message" });
    expect(h.logs[2]).toEqual({ level: "error", message: "Error message", meta: { code: 500 } });
    expect(h.logs[3]).toEqual({ level: "debug", message: "Debug message" });
  });
});

// ===========================================================================
// Entity operations — upsert, list, filtering, deduplication
// ===========================================================================

describe("entity operations through test harness", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(ALL_CAPABILITIES),
    });
  });

  describe("upsert", () => {
    it("creates a new entity with generated id", async () => {
      const record = await h.ctx.entities.upsert({
        entityType: "linear-issue",
        scopeKind: "company",
        scopeId: "co-1",
        data: { url: "https://linear.app/LIN-1" },
      });

      expect(record.id).toBeDefined();
      expect(record.entityType).toBe("linear-issue");
      expect(record.scopeKind).toBe("company");
      expect(record.scopeId).toBe("co-1");
      expect(record.data).toEqual({ url: "https://linear.app/LIN-1" });
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();
    });

    it("upserts by external ID (same id on repeat)", async () => {
      const first = await h.ctx.entities.upsert({
        entityType: "gh-pr",
        scopeKind: "project",
        scopeId: "p1",
        externalId: "PR-123",
        title: "First title",
        data: { state: "open" },
      });

      const second = await h.ctx.entities.upsert({
        entityType: "gh-pr",
        scopeKind: "project",
        scopeId: "p1",
        externalId: "PR-123",
        title: "Updated title",
        data: { state: "merged" },
      });

      expect(second.id).toBe(first.id);
      expect(second.title).toBe("Updated title");
      expect(second.data).toEqual({ state: "merged" });
    });

    it("different external IDs create distinct entities", async () => {
      const a = await h.ctx.entities.upsert({
        entityType: "ticket",
        scopeKind: "instance",
        externalId: "A-1",
        data: {},
      });
      const b = await h.ctx.entities.upsert({
        entityType: "ticket",
        scopeKind: "instance",
        externalId: "A-2",
        data: {},
      });

      expect(a.id).not.toBe(b.id);
    });
  });

  describe("list with filters", () => {
    beforeEach(async () => {
      await h.ctx.entities.upsert({
        entityType: "ticket",
        scopeKind: "company",
        scopeId: "c1",
        externalId: "T-1",
        status: "open",
        data: {},
      });
      await h.ctx.entities.upsert({
        entityType: "ticket",
        scopeKind: "company",
        scopeId: "c1",
        externalId: "T-2",
        status: "closed",
        data: {},
      });
      await h.ctx.entities.upsert({
        entityType: "pr",
        scopeKind: "project",
        scopeId: "p1",
        externalId: "PR-1",
        data: {},
      });
    });

    it("lists all entities without filter", async () => {
      const all = await h.ctx.entities.list({});
      expect(all).toHaveLength(3);
    });

    it("filters by entityType", async () => {
      const tickets = await h.ctx.entities.list({ entityType: "ticket" });
      expect(tickets).toHaveLength(2);
      expect(tickets.every((e) => e.entityType === "ticket")).toBe(true);
    });

    it("filters by scopeKind", async () => {
      const companyEntities = await h.ctx.entities.list({ scopeKind: "company" });
      expect(companyEntities).toHaveLength(2);
    });

    it("filters by scopeId", async () => {
      const c1Entities = await h.ctx.entities.list({ scopeId: "c1" });
      expect(c1Entities).toHaveLength(2);
    });

    it("filters by externalId", async () => {
      const result = await h.ctx.entities.list({ externalId: "T-1" });
      expect(result).toHaveLength(1);
      expect(result[0].externalId).toBe("T-1");
    });

    it("supports limit", async () => {
      const limited = await h.ctx.entities.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("supports offset", async () => {
      const all = await h.ctx.entities.list({});
      const offset = await h.ctx.entities.list({ offset: 1 });
      expect(offset).toHaveLength(2);
      expect(offset[0].id).toBe(all[1].id);
    });

    it("supports combined filters", async () => {
      const result = await h.ctx.entities.list({
        entityType: "ticket",
        scopeKind: "company",
        scopeId: "c1",
      });
      expect(result).toHaveLength(2);
    });
  });
});

// ===========================================================================
// Event dispatch and filtering
// ===========================================================================

describe("event dispatch and filtering through test harness", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(["events.subscribe", "events.emit"]),
    });
  });

  it("dispatches events to exact-match handlers", async () => {
    const received: PluginEvent[] = [];
    h.ctx.events.on("issue.created", async (event) => {
      received.push(event);
    });

    await h.emit("issue.created", { title: "New issue" });

    expect(received).toHaveLength(1);
    expect(received[0].eventType).toBe("issue.created");
    expect(received[0].payload).toEqual({ title: "New issue" });
  });

  it("does not dispatch to non-matching handlers", async () => {
    const received: string[] = [];
    h.ctx.events.on("issue.created", async () => {
      received.push("created");
    });
    h.ctx.events.on("issue.updated", async () => {
      received.push("updated");
    });

    await h.emit("issue.created", {});
    expect(received).toEqual(["created"]);
  });

  it("dispatches plugin.* wildcard events", async () => {
    const received: string[] = [];
    h.ctx.events.on("plugin.*", async (event) => {
      received.push(event.eventType);
    });

    await h.emit("plugin.acme.linear.sync-done", { count: 42 });
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("plugin.acme.linear.sync-done");
  });

  it("supports event filter by projectId", async () => {
    const received: PluginEvent[] = [];
    h.ctx.events.on(
      "issue.created",
      { projectId: "proj-1" },
      async (event) => { received.push(event); },
    );

    // Matching event
    await h.emit("issue.created", { projectId: "proj-1", title: "A" });
    // Non-matching event
    await h.emit("issue.created", { projectId: "proj-2", title: "B" });

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ projectId: "proj-1", title: "A" });
  });

  it("supports event filter by companyId", async () => {
    const received: PluginEvent[] = [];
    h.ctx.events.on(
      "issue.created",
      { companyId: "co-1" },
      async (event) => { received.push(event); },
    );

    await h.emit("issue.created", { companyId: "co-1" });
    await h.emit("issue.created", { companyId: "co-2" });

    expect(received).toHaveLength(1);
  });

  it("event envelope includes proper fields", async () => {
    const received: PluginEvent[] = [];
    h.ctx.events.on("issue.created", async (event) => {
      received.push(event);
    });

    await h.emit("issue.created", { title: "Test" }, {
      actorId: "user-1",
      actorType: "user",
      entityId: "iss-1",
      entityType: "issue",
    });

    expect(received[0].eventId).toBeDefined();
    expect(received[0].occurredAt).toBeDefined();
    expect(received[0].actorId).toBe("user-1");
    expect(received[0].actorType).toBe("user");
    expect(received[0].entityId).toBe("iss-1");
    expect(received[0].entityType).toBe("issue");
  });

  it("ctx.events.emit namespaces events with plugin ID", async () => {
    const received: string[] = [];
    h.ctx.events.on("plugin.*", async (event) => {
      received.push(event.eventType);
    });

    // Plugin emit auto-namespaces: plugin.<pluginId>.<name>
    await h.ctx.events.emit("sync-done", { count: 10 });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("plugin.test.host-services.sync-done");
  });
});

// ===========================================================================
// Job handler registration and invocation
// ===========================================================================

describe("job handler registration and invocation", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness({
      manifest: manifest(["jobs.schedule", "plugin.state.write", "metrics.write"]),
    });
  });

  it("registers and invokes a job handler", async () => {
    let receivedJobKey: string | null = null;

    h.ctx.jobs.register("full-sync", async (job) => {
      receivedJobKey = job.jobKey;
    });

    await h.runJob("full-sync");
    expect(receivedJobKey).toBe("full-sync");
  });

  it("throws when running an unregistered job", async () => {
    await expect(h.runJob("non-existent")).rejects.toThrow(
      /No job handler registered for 'non-existent'/,
    );
  });

  it("provides default PluginJobContext fields", async () => {
    let capturedJob: unknown = null;

    h.ctx.jobs.register("check", async (job) => {
      capturedJob = job;
    });

    await h.runJob("check");

    const job = capturedJob as { jobKey: string; runId: string; trigger: string; scheduledAt: string };
    expect(job.jobKey).toBe("check");
    expect(job.runId).toBeDefined();
    expect(job.trigger).toBe("manual");
    expect(job.scheduledAt).toBeDefined();
  });

  it("allows overriding PluginJobContext fields", async () => {
    let capturedJob: unknown = null;

    h.ctx.jobs.register("sync", async (job) => {
      capturedJob = job;
    });

    await h.runJob("sync", {
      runId: "custom-run-id",
      trigger: "schedule",
      scheduledAt: "2024-01-01T00:00:00Z",
    });

    const job = capturedJob as { runId: string; trigger: string; scheduledAt: string };
    expect(job.runId).toBe("custom-run-id");
    expect(job.trigger).toBe("schedule");
    expect(job.scheduledAt).toBe("2024-01-01T00:00:00Z");
  });

  it("job handler can perform side effects through ctx", async () => {
    h.ctx.jobs.register("report", async () => {
      await h.ctx.state.set({ scopeKind: "instance", stateKey: "last-report" }, new Date().toISOString());
      await h.ctx.metrics.write("reports.generated", 1);
    });

    await h.runJob("report");

    const lastReport = h.getState({ scopeKind: "instance", stateKey: "last-report" });
    expect(lastReport).toBeDefined();
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0].name).toBe("reports.generated");
  });
});

// ===========================================================================
// Config operations
// ===========================================================================

describe("config operations through test harness", () => {
  it("returns initial config", async () => {
    const h = createTestHarness({
      manifest: manifest([]),
      config: { apiKey: "sk-123", workspace: "default" },
    });

    const config = await h.ctx.config.get();
    expect(config).toEqual({ apiKey: "sk-123", workspace: "default" });
  });

  it("returns empty object when no config provided", async () => {
    const h = createTestHarness({
      manifest: manifest([]),
    });

    const config = await h.ctx.config.get();
    expect(config).toEqual({});
  });

  it("harness.setConfig() updates the config returned by ctx.config.get()", async () => {
    const h = createTestHarness({
      manifest: manifest([]),
      config: { apiKey: "old" },
    });

    h.setConfig({ apiKey: "new", workspace: "updated" });
    const config = await h.ctx.config.get();
    expect(config).toEqual({ apiKey: "new", workspace: "updated" });
  });

  it("config.get() returns a copy (modifying result does not affect internal state)", async () => {
    const h = createTestHarness({
      manifest: manifest([]),
      config: { key: "value" },
    });

    const config1 = await h.ctx.config.get();
    (config1 as Record<string, unknown>).key = "mutated";

    const config2 = await h.ctx.config.get();
    expect(config2).toEqual({ key: "value" }); // original unchanged
  });
});

// ===========================================================================
// Seeded data reads (companies, projects, issues, agents, goals)
// ===========================================================================

describe("seeded data reads through test harness", () => {
  it("seed() populates companies for ctx.companies.list/get", async () => {
    const h = createTestHarness({
      manifest: manifest(["companies.read"]),
    });

    h.seed({
      companies: [
        { id: "c1", name: "Acme Corp", createdAt: new Date(), updatedAt: new Date() } as any,
        { id: "c2", name: "Beta Inc", createdAt: new Date(), updatedAt: new Date() } as any,
      ],
    });

    const companies = await h.ctx.companies.list();
    expect(companies).toHaveLength(2);

    const company = await h.ctx.companies.get("c1");
    expect(company).toBeDefined();
    expect((company as any).name).toBe("Acme Corp");
  });

  it("seed() populates issues for ctx.issues.list/get", async () => {
    const h = createTestHarness({
      manifest: manifest(["issues.read", "issues.create", "issue.comments.read", "issue.comments.create"]),
    });

    const now = new Date();
    h.seed({
      issues: [
        {
          id: "i1",
          companyId: "c1",
          projectId: "p1",
          goalId: null,
          parentId: null,
          title: "Bug fix",
          description: null,
          status: "todo",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          issueNumber: null,
          identifier: null,
          requestDepth: 0,
          billingCode: null,
          assigneeAdapterOverrides: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const issues = await h.ctx.issues.list({ companyId: "c1" });
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Bug fix");

    const issue = await h.ctx.issues.get("i1", "c1");
    expect(issue).not.toBeNull();
    expect(issue!.status).toBe("todo");
  });

  it("ctx.issues.create creates new issue and stores it", async () => {
    const h = createTestHarness({
      manifest: manifest(["issues.read", "issues.create"]),
    });

    const created = await h.ctx.issues.create({
      companyId: "c1",
      title: "New issue",
      description: "A test issue",
    });

    expect(created.id).toBeDefined();
    expect(created.title).toBe("New issue");
    expect(created.status).toBe("todo");

    const fetched = await h.ctx.issues.get(created.id, "c1");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("New issue");
  });

  it("ctx.issues.update mutates stored issue", async () => {
    const h = createTestHarness({
      manifest: manifest(["issues.read", "issues.create", "issues.update"]),
    });

    const created = await h.ctx.issues.create({
      companyId: "c1",
      title: "Original",
    });

    const updated = await h.ctx.issues.update(created.id, { title: "Updated", status: "in_progress" }, "c1");
    expect(updated.title).toBe("Updated");

    const fetched = await h.ctx.issues.get(created.id, "c1");
    expect(fetched!.title).toBe("Updated");
  });

  it("ctx.issues.createComment creates and lists comments", async () => {
    const h = createTestHarness({
      manifest: manifest(["issues.read", "issues.create", "issue.comments.read", "issue.comments.create"]),
    });

    const issue = await h.ctx.issues.create({ companyId: "c1", title: "Test" });

    const comment = await h.ctx.issues.createComment(issue.id, "Hello world", "c1");
    expect(comment.id).toBeDefined();
    expect(comment.body).toBe("Hello world");
    expect(comment.issueId).toBe(issue.id);

    const comments = await h.ctx.issues.listComments(issue.id, "c1");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Hello world");
  });

  it("returns null for non-existent entities", async () => {
    const h = createTestHarness({
      manifest: manifest(["companies.read", "projects.read", "agents.read", "goals.read"]),
    });

    expect(await h.ctx.companies.get("missing")).toBeNull();
    expect(await h.ctx.projects.get("missing", "c1")).toBeNull();
    expect(await h.ctx.agents.get("missing", "c1")).toBeNull();
    expect(await h.ctx.goals.get("missing", "c1")).toBeNull();
  });

  it("hides cross-company records from direct reads", async () => {
    const h = createTestHarness({
      manifest: manifest([
        "projects.read",
        "issues.read",
        "issue.comments.read",
        "agents.read",
        "goals.read",
      ]),
    });

    const now = new Date();
    h.seed({
      projects: [
        {
          id: "p2",
          companyId: "c2",
          name: "Other company project",
          description: null,
          color: null,
          icon: null,
          goalId: null,
          repoUrl: null,
          repoProvider: null,
          repoName: null,
          repoOwner: null,
          repoDefaultBranch: null,
          localPath: null,
          worktreeRoot: null,
          createdAt: now,
          updatedAt: now,
          urlKey: "other-company-project",
          goalIds: [],
          goals: [],
          workspaces: [],
          primaryWorkspace: null,
        },
      ],
      issues: [
        {
          id: "i2",
          companyId: "c2",
          projectId: null,
          goalId: null,
          parentId: null,
          title: "Other company issue",
          description: null,
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          issueNumber: null,
          identifier: null,
          requestDepth: 0,
          billingCode: null,
          assigneeAdapterOverrides: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      issueComments: [
        {
          id: "ic2",
          companyId: "c2",
          issueId: "i2",
          authorAgentId: null,
          authorUserId: null,
          body: "Hidden comment",
          createdAt: now,
          updatedAt: now,
        },
      ],
      agents: [
        {
          id: "a2",
          companyId: "c2",
          name: "Other agent",
          title: null,
          role: "engineer",
          reportsTo: null,
          status: "active",
          adapterType: "codex-local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: [],
          capabilities: null,
          budgetMonthlyCents: 0,
          metadata: null,
          terminatedAt: null,
          createdAt: now,
          updatedAt: now,
          urlKey: "other-agent",
        },
      ],
      goals: [
        {
          id: "g2",
          companyId: "c2",
          parentGoalId: null,
          projectId: null,
          title: "Other goal",
          description: null,
          status: "todo",
          level: "company",
          priority: "medium",
          targetDate: null,
          ownerAgentId: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    expect(await h.ctx.projects.get("p2", "c1")).toBeNull();
    expect(await h.ctx.issues.get("i2", "c1")).toBeNull();
    expect(await h.ctx.issues.listComments("i2", "c1")).toEqual([]);
    expect(await h.ctx.agents.get("a2", "c1")).toBeNull();
    expect(await h.ctx.goals.get("g2", "c1")).toBeNull();
  });

  it("rejects cross-company issue mutations", async () => {
    const h = createTestHarness({
      manifest: manifest([
        "issues.read",
        "issues.create",
        "issues.update",
        "issue.comments.create",
      ]),
    });

    const created = await h.ctx.issues.create({
      companyId: "c2",
      title: "Hidden issue",
    });

    await expect(
      h.ctx.issues.update(created.id, { title: "Nope" }, "c1"),
    ).rejects.toThrow("Issue not found");
    await expect(
      h.ctx.issues.createComment(created.id, "Hello", "c1"),
    ).rejects.toThrow("Issue not found");
  });
});

// ===========================================================================
// Agent write operations (pause, resume, invoke)
// ===========================================================================

describe("agent write operations through test harness", () => {
  const AGENT_SEED = {
    id: "a1",
    companyId: "c1",
    name: "Test Agent",
    title: null,
    role: "engineer" as const,
    reportsTo: null,
    status: "active" as const,
    adapterType: "codex-local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: [],
    capabilities: null,
    budgetMonthlyCents: 0,
    metadata: null,
    terminatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    urlKey: "test-agent",
  };

  describe("agents.pause", () => {
    it("pauses an active agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.pause"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const paused = await h.ctx.agents.pause("a1", "c1");
      expect(paused.status).toBe("paused");
    });

    it("rejects pausing a cross-company agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.pause"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, companyId: "c2" }] });

      await expect(h.ctx.agents.pause("a1", "c1")).rejects.toThrow(/Agent not found/);
    });

    it("rejects pausing a terminated agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.pause"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "terminated" as const }] });

      await expect(h.ctx.agents.pause("a1", "c1")).rejects.toThrow(/terminated/i);
    });
  });

  describe("agents.resume", () => {
    it("resumes a paused agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.resume"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "paused" as const }] });

      const resumed = await h.ctx.agents.resume("a1", "c1");
      expect(resumed.status).toBe("idle");
    });

    it("rejects resuming a cross-company agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.resume"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, companyId: "c2", status: "paused" as const }] });

      await expect(h.ctx.agents.resume("a1", "c1")).rejects.toThrow(/Agent not found/);
    });

    it("rejects resuming a terminated agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.resume"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "terminated" as const }] });

      await expect(h.ctx.agents.resume("a1", "c1")).rejects.toThrow(/terminated/i);
    });

    it("rejects resuming a pending_approval agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.resume"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "pending_approval" as const }] });

      await expect(h.ctx.agents.resume("a1", "c1")).rejects.toThrow(/pending.?approval/i);
    });
  });

  describe("agents.invoke", () => {
    it("invokes an active agent and returns runId", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const result = await h.ctx.agents.invoke("a1", "c1", { prompt: "Run health check" });
      expect(result.runId).toBeDefined();
      expect(typeof result.runId).toBe("string");
    });

    it("invokes an idle agent and returns runId", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "idle" as const }] });

      const result = await h.ctx.agents.invoke("a1", "c1", {
        prompt: "Generate report",
        reason: "Scheduled daily report",
      });
      expect(result.runId).toBeDefined();
    });

    it("rejects invoking a cross-company agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, companyId: "c2" }] });

      await expect(
        h.ctx.agents.invoke("a1", "c1", { prompt: "test" }),
      ).rejects.toThrow(/Agent not found/);
    });

    it("rejects invoking a paused agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "paused" as const }] });

      await expect(
        h.ctx.agents.invoke("a1", "c1", { prompt: "test" }),
      ).rejects.toThrow(/not invokable.*paused/i);
    });

    it("rejects invoking a terminated agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "terminated" as const }] });

      await expect(
        h.ctx.agents.invoke("a1", "c1", { prompt: "test" }),
      ).rejects.toThrow(/not invokable.*terminated/i);
    });

    it("rejects invoking a pending_approval agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "pending_approval" as const }] });

      await expect(
        h.ctx.agents.invoke("a1", "c1", { prompt: "test" }),
      ).rejects.toThrow(/not invokable.*pending_approval/i);
    });

    it("rejects invoking a non-existent agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agents.invoke"]),
      });

      await expect(
        h.ctx.agents.invoke("missing", "c1", { prompt: "test" }),
      ).rejects.toThrow(/Agent not found/);
    });
  });
});

// ===========================================================================
// Secrets and assets through test harness
// ===========================================================================

describe("secrets through test harness", () => {
  it("resolves secret references with a predictable format", async () => {
    const h = createTestHarness({
      manifest: manifest(["secrets.read-ref"]),
    });

    const value = await h.ctx.secrets.resolve("MY_API_KEY");
    expect(value).toBe("resolved:MY_API_KEY");
  });
});

describe("assets through test harness", () => {
  it("upload returns assetId and url, getUrl retrieves it", async () => {
    const h = createTestHarness({
      manifest: manifest(["assets.write", "assets.read"]),
    });

    const uploaded = await h.ctx.assets.upload(
      "screenshot.png",
      "image/png",
      new Uint8Array([0, 1, 2, 3]),
    );

    expect(uploaded.assetId).toBeDefined();
    expect(uploaded.url).toContain("screenshot.png");

    const url = await h.ctx.assets.getUrl(uploaded.assetId);
    expect(url).toContain(uploaded.assetId);
  });

  it("getUrl throws for non-existent asset", async () => {
    const h = createTestHarness({
      manifest: manifest(["assets.read"]),
    });

    await expect(h.ctx.assets.getUrl("missing")).rejects.toThrow(/Asset not found/);
  });
});

// ===========================================================================
// Integration: definePlugin + createTestHarness
// ===========================================================================

describe("integration: definePlugin with createTestHarness", () => {
  it("runs a full plugin lifecycle through the harness", async () => {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.logger.info("Plugin starting");

        // Register event handler
        ctx.events.on("issue.created", async (event) => {
          await ctx.state.set(
            { scopeKind: "issue", scopeId: event.entityId!, stateKey: "seen" },
            true,
          );
          await ctx.activity.log({
            message: `Processed issue: ${event.entityId}`,
            entityType: "issue",
            entityId: event.entityId,
          });
        });

        // Register job handler
        ctx.jobs.register("daily-sync", async (job) => {
          ctx.logger.info("Running sync", { runId: job.runId });
          await ctx.metrics.write("sync.runs", 1, { trigger: job.trigger });
        });

        // Register data handler
        ctx.data.register("sync-status", async ({ companyId }) => {
          const lastSync = await ctx.state.get({
            scopeKind: "company",
            scopeId: String(companyId),
            stateKey: "last-sync",
          });
          return { lastSync, status: lastSync ? "synced" : "never" };
        });

        // Register action handler
        ctx.actions.register("force-sync", async ({ companyId }) => {
          await ctx.state.set(
            { scopeKind: "company", scopeId: String(companyId), stateKey: "force-sync" },
            true,
          );
          return { queued: true };
        });

        // Register tool handler
        ctx.tools.register(
          "lookup-issue",
          { displayName: "Lookup Issue", description: "Look up issue", parametersSchema: {} },
          async (params) => ({
            content: `Issue ${(params as { id: string }).id} found`,
          }),
        );
      },

      async onHealth() {
        return { status: "ok" };
      },
    });

    const h = createTestHarness({
      manifest: manifest([
        "events.subscribe",
        "events.emit",
        "jobs.schedule",
        "plugin.state.read",
        "plugin.state.write",
        "activity.log.write",
        "metrics.write",
        "agent.tools.register",
      ]),
    });

    // Run setup
    await plugin.definition.setup(h.ctx);

    // Verify logging
    expect(h.logs[0]).toEqual({ level: "info", message: "Plugin starting" });

    // Dispatch event
    await h.emit("issue.created", { title: "Bug" }, { entityId: "iss-1", entityType: "issue" });

    // Verify event handler side effects
    expect(h.getState({ scopeKind: "issue", scopeId: "iss-1", stateKey: "seen" })).toBe(true);
    expect(h.activity).toHaveLength(1);
    expect(h.activity[0].message).toBe("Processed issue: iss-1");

    // Run job
    await h.runJob("daily-sync", { trigger: "schedule" });

    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: "info", message: "Running sync" }),
    );
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0].name).toBe("sync.runs");

    // Invoke data handler
    const syncStatus = await h.getData<{ lastSync: unknown; status: string }>(
      "sync-status",
      { companyId: "co-1" },
    );
    expect(syncStatus.status).toBe("never");

    // Invoke action handler
    const actionResult = await h.performAction<{ queued: boolean }>(
      "force-sync",
      { companyId: "co-1" },
    );
    expect(actionResult.queued).toBe(true);
    expect(h.getState({ scopeKind: "company", scopeId: "co-1", stateKey: "force-sync" })).toBe(true);

    // Invoke tool handler
    const toolResult = await h.executeTool("lookup-issue", { id: "ISS-42" });
    expect(toolResult.content).toBe("Issue ISS-42 found");

    // Health check
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});

// ===========================================================================
// Agent sessions through test harness
// ===========================================================================

describe("agent sessions through test harness", () => {
  const AGENT_SEED = {
    id: "a1",
    companyId: "c1",
    name: "Chat Agent",
    title: null,
    role: "engineer" as const,
    reportsTo: null,
    status: "active" as const,
    adapterType: "claude_local" as const,
    adapterConfig: {},
    runtimeConfig: {},
    permissions: [],
    capabilities: null,
    budgetMonthlyCents: 0,
    metadata: null,
    terminatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    urlKey: "chat-agent",
  };

  describe("sessions.create", () => {
    it("creates a session and returns AgentSession", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");
      expect(session.sessionId).toBeDefined();
      expect(session.agentId).toBe("a1");
      expect(session.companyId).toBe("c1");
      expect(session.status).toBe("active");
      expect(session.createdAt).toBeDefined();
    });

    it("creates a session with optional taskKey and reason", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1", {
        taskKey: "my-task",
        reason: "chat",
      });
      expect(session.sessionId).toBeDefined();
      expect(session.agentId).toBe("a1");
    });

    it("blocks create without agent.sessions.create capability", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      await expect(
        h.ctx.agents.sessions.create("a1", "c1"),
      ).rejects.toThrow(/capability/i);
    });
  });

  describe("sessions.list", () => {
    it("lists sessions for an agent", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create", "agent.sessions.list"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      await h.ctx.agents.sessions.create("a1", "c1");
      await h.ctx.agents.sessions.create("a1", "c1");

      const sessions = await h.ctx.agents.sessions.list("a1", "c1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentId).toBe("a1");
      expect(sessions[1].agentId).toBe("a1");
    });

    it("returns empty array when no sessions exist", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.list"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const sessions = await h.ctx.agents.sessions.list("a1", "c1");
      expect(sessions).toEqual([]);
    });

    it("blocks list without agent.sessions.list capability", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read"]),
      });

      await expect(
        h.ctx.agents.sessions.list("a1", "c1"),
      ).rejects.toThrow(/capability/i);
    });
  });

  describe("sessions.sendMessage", () => {
    it("sends a message and returns runId", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create", "agent.sessions.send"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");
      const result = await h.ctx.agents.sessions.sendMessage(session.sessionId, "c1", {
        prompt: "Hello agent",
      });

      expect(result.runId).toBeDefined();
      expect(typeof result.runId).toBe("string");
    });

    it("delivers streaming events via onEvent callback", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create", "agent.sessions.send"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");

      const events: unknown[] = [];
      await h.ctx.agents.sessions.sendMessage(session.sessionId, "c1", {
        prompt: "Hello",
        onEvent: (event) => events.push(event),
      });

      // Simulate events from the harness
      h.simulateSessionEvent(session.sessionId, {
        runId: "run-1",
        seq: 1,
        eventType: "chunk",
        stream: "stdout",
        message: "Hello back!",
        payload: null,
      });

      h.simulateSessionEvent(session.sessionId, {
        runId: "run-1",
        seq: 2,
        eventType: "done",
        stream: null,
        message: null,
        payload: null,
      });

      expect(events).toHaveLength(2);
      expect((events[0] as { eventType: string }).eventType).toBe("chunk");
      expect((events[0] as { message: string }).message).toBe("Hello back!");
      expect((events[1] as { eventType: string }).eventType).toBe("done");
    });

    it("blocks sendMessage without agent.sessions.send capability", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");

      await expect(
        h.ctx.agents.sessions.sendMessage(session.sessionId, "c1", { prompt: "hi" }),
      ).rejects.toThrow(/capability/i);
    });

    it("rejects sending to non-existent session", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.send"]),
      });

      await expect(
        h.ctx.agents.sessions.sendMessage("missing-session", "c1", { prompt: "hi" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("sessions.close", () => {
    it("closes an active session", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create", "agent.sessions.close", "agent.sessions.list"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");
      await h.ctx.agents.sessions.close(session.sessionId, "c1");

      // Session should no longer appear in list
      const sessions = await h.ctx.agents.sessions.list("a1", "c1");
      expect(sessions.filter((s) => s.sessionId === session.sessionId)).toHaveLength(0);
    });

    it("rejects closing a non-existent session", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.close"]),
      });

      await expect(
        h.ctx.agents.sessions.close("missing", "c1"),
      ).rejects.toThrow(/not found/i);
    });

    it("blocks close without agent.sessions.close capability", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session = await h.ctx.agents.sessions.create("a1", "c1");

      await expect(
        h.ctx.agents.sessions.close(session.sessionId, "c1"),
      ).rejects.toThrow(/capability/i);
    });
  });

  describe("session event isolation", () => {
    it("events for one session do not leak to another", async () => {
      const h = createTestHarness({
        manifest: manifest(["agents.read", "agent.sessions.create", "agent.sessions.send"]),
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });

      const session1 = await h.ctx.agents.sessions.create("a1", "c1");
      const session2 = await h.ctx.agents.sessions.create("a1", "c1");

      const events1: unknown[] = [];
      const events2: unknown[] = [];

      await h.ctx.agents.sessions.sendMessage(session1.sessionId, "c1", {
        prompt: "msg1",
        onEvent: (e) => events1.push(e),
      });
      await h.ctx.agents.sessions.sendMessage(session2.sessionId, "c1", {
        prompt: "msg2",
        onEvent: (e) => events2.push(e),
      });

      // Send event only to session1
      h.simulateSessionEvent(session1.sessionId, {
        runId: "run-1",
        seq: 1,
        eventType: "chunk",
        stream: "stdout",
        message: "For session 1 only",
        payload: null,
      });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });
  });
});
