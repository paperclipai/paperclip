import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../src/testing.js";

const baseManifest: PaperclipPluginManifestV1 = {
  id: "test.state-list",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "State List Test",
  description: "harness test",
  author: "test",
  categories: ["connector"],
  capabilities: ["plugin.state.read", "plugin.state.write"],
  entrypoints: { worker: "./worker.js" },
};

describe("state.list (test harness)", () => {
  it("returns empty array when no entries exist", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    expect(await h.ctx.state.list()).toEqual([]);
  });

  it("returns all plugin entries with row shape when no filter given", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "a" }, { n: 1 });
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "b" }, { n: 2 });

    const rows = await h.ctx.state.list();
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.stateKey).sort();
    expect(keys).toEqual(["a", "b"]);
    for (const r of rows) {
      expect(r.scopeKind).toBe("instance");
      expect(typeof r.updatedAt).toBe("string");
      expect(new Date(r.updatedAt).toString()).not.toBe("Invalid Date");
      expect(r.namespace).toBe("default");
    }
  });

  it("filters by scopeKind", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "k1" }, 1);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "c1", stateKey: "k2" }, 2);

    const rows = await h.ctx.state.list({ scopeKind: "company" });
    expect(rows).toHaveLength(1);
    expect(rows[0].stateKey).toBe("k2");
    expect(rows[0].scopeId).toBe("c1");
  });

  it("filters by scopeId", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "project", scopeId: "p1", stateKey: "k" }, 1);
    await h.ctx.state.set({ scopeKind: "project", scopeId: "p2", stateKey: "k" }, 2);

    const rows = await h.ctx.state.list({ scopeKind: "project", scopeId: "p2" });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(2);
  });

  it("filters by namespace", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "instance", namespace: "sessions", stateKey: "k1" }, 1);
    await h.ctx.state.set({ scopeKind: "instance", namespace: "cursors", stateKey: "k2" }, 2);

    const rows = await h.ctx.state.list({ namespace: "sessions" });
    expect(rows).toHaveLength(1);
    expect(rows[0].stateKey).toBe("k1");
  });

  it("reflects delete in subsequent list", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "a" }, 1);
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "b" }, 2);
    await h.ctx.state.delete({ scopeKind: "instance", stateKey: "a" });

    const rows = await h.ctx.state.list();
    expect(rows.map((r) => r.stateKey)).toEqual(["b"]);
  });

  it("refreshes updatedAt when set() overwrites an existing key", async () => {
    const h = createTestHarness({ manifest: baseManifest });
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, 1);
    const [first] = await h.ctx.state.list();
    await new Promise((r) => setTimeout(r, 2));
    await h.ctx.state.set({ scopeKind: "instance", stateKey: "k" }, 2);
    const [second] = await h.ctx.state.list();
    expect(second.value).toBe(2);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
  });

  it("denies list without plugin.state.read capability", async () => {
    const h = createTestHarness({
      manifest: baseManifest,
      capabilities: ["plugin.state.write"],
    });
    await expect(h.ctx.state.list()).rejects.toThrow(/plugin\.state\.read/);
  });
});
