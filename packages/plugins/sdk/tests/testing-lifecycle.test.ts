import { describe, expect, it } from "vitest";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1, ResourceLifecycleEvent } from "../src/types.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "fixture.lifecycle", apiVersion: 1, version: "1.0.0", displayName: "Lifecycle", description: "Fixture",
  author: "Tests", categories: ["automation"], capabilities: ["events.subscribe"], entrypoints: {},
};

describe("Lifecycle inbox test harness", () => {
  it("delivers project creation, archive, and restore in order", async () => {
    const harness = createTestHarness({ manifest });
    const event: ResourceLifecycleEvent = { id: "1", companyId: "a", resourceType: "project", resourceId: "project", action: "create", createdAt: new Date(0).toISOString() };
    harness.seed({ lifecycleEvents: [event, { ...event, id: "2", action: "archive" }, { ...event, id: "3", action: "update" }] });
    for (const action of ["create", "archive", "update"]) {
      const [next] = await harness.ctx.events.listLifecycle("a");
      expect(next.action).toBe(action);
      await harness.ctx.events.acknowledgeLifecycle("a", next.id);
    }
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([]);
  });
  it("lets a plugin exercise retries, acknowledgment order, and company scope", async () => {
    const harness = createTestHarness({ manifest });
    const event: ResourceLifecycleEvent = { id: "1", companyId: "a", resourceType: "agent", resourceId: "agent", action: "create", createdAt: new Date(0).toISOString() };
    harness.seed({ lifecycleEvents: [event, { ...event, id: "2", action: "pause" }, { ...event, id: "3", companyId: "b" }] });
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([event]);
    expect(await harness.ctx.events.listLifecycle("a", 100, "1")).toEqual([]);
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([event]);
    await expect(harness.ctx.events.acknowledgeLifecycle("a", "2")).rejects.toThrow("earlier lifecycle events");
    await expect(harness.ctx.events.acknowledgeLifecycle("a", "3")).rejects.toThrow("not found");
    await harness.ctx.events.acknowledgeLifecycle("a", "1");
    await harness.ctx.events.acknowledgeLifecycle("a", "1");
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([expect.objectContaining({ action: "pause" })]);
    expect(await harness.ctx.events.listLifecycle("b")).toEqual([expect.objectContaining({ id: "3" })]);
    const denied = createTestHarness({ manifest, capabilities: [] });
    await expect(denied.ctx.events.listLifecycle("a")).rejects.toThrow("events.subscribe");
    await expect(denied.ctx.events.acknowledgeLifecycle("a", "1")).rejects.toThrow("events.subscribe");
  });
  it("delivers a backfilled creation before earlier transitions", async () => {
    const harness = createTestHarness({ manifest });
    const event: ResourceLifecycleEvent = { id: "1", companyId: "a", resourceType: "agent", resourceId: "agent", action: "pause", createdAt: new Date(0).toISOString() };
    harness.seed({ lifecycleEvents: [event, { ...event, id: "2", action: "resume" }, { ...event, id: "3", action: "create" }] });
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([expect.objectContaining({ id: "3", action: "create" })]);
    await expect(harness.ctx.events.acknowledgeLifecycle("a", "1")).rejects.toThrow("earlier lifecycle events");
    await harness.ctx.events.acknowledgeLifecycle("a", "3");
    expect(await harness.ctx.events.listLifecycle("a", 100, "3")).toEqual([]);
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([event]);
    await harness.ctx.events.acknowledgeLifecycle("a", "1");
    expect(await harness.ctx.events.listLifecycle("a")).toEqual([expect.objectContaining({ id: "2" })]);
  });

});
