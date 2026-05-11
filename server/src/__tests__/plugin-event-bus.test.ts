/**
 * @fileoverview MO-070 — TDD coverage for plugin-event-bus.
 *
 * The event bus is load-bearing for plugin-to-plugin communication
 * (PLUGIN_SPEC.md §16). Vexion plugins (council-chat, mem0-sync-poc)
 * emit and subscribe through this bus.
 *
 * MO-070 Phase B — covers:
 *   - Namespace auto-prefix on emit
 *   - Namespace-spoofing guard (cannot emit "plugin.*" directly)
 *   - Wildcard pattern matching (trailing .*)
 *   - Filter pre-delivery
 *   - Error isolation (one bad handler doesn't break delivery to others)
 *   - Subscription scope isolation between plugins
 */

import { describe, expect, it, vi } from "vitest";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

describe("plugin-event-bus — emit + auto-namespace", () => {
  it("auto-prefixes plugin-emitted events with `plugin.<pluginId>.`", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.forPlugin("watcher").subscribe("plugin.acme.linear.sync-done", handler);
    await bus.forPlugin("acme.linear").emit("sync-done", "c-1", { count: 5 });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject({
      eventType: "plugin.acme.linear.sync-done",
      companyId: "c-1",
      actorType: "plugin",
      actorId: "acme.linear",
    });
  });

  it("rejects empty event name (namespace-collision guard)", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("acme").emit("", "c-1", {})).rejects.toThrow(/non-empty event name/i);
    await expect(bus.forPlugin("acme").emit("   ", "c-1", {})).rejects.toThrow(/non-empty event name/i);
  });

  it("rejects empty companyId", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("acme").emit("sync-done", "", {})).rejects.toThrow(/companyId/i);
  });

  it("rejects emit with 'plugin.' prefix (spoofing guard)", async () => {
    // A plugin must not be able to emit events that look like they came from
    // another plugin or the core. The bus auto-namespaces, so emitting
    // `plugin.foo.bar` would double-prefix AND let a plugin spoof.
    const bus = createPluginEventBus();
    await expect(
      bus.forPlugin("acme").emit("plugin.other.sync-done", "c-1", {}),
    ).rejects.toThrow(/must not include the "plugin\."/i);
  });
});

describe("plugin-event-bus — pattern matching", () => {
  it("matches exact event types", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("watcher").subscribe("issue.created" as any, handler);

    await bus.emit({
      eventId: "e-1",
      eventType: "issue.created",
      occurredAt: "2026-01-01T00:00:00Z",
      entityId: "iss-1",
      entityType: "issue",
      payload: {},
    } as any);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("matches trailing wildcard `plugin.foo.*`", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("watcher").subscribe("plugin.acme.linear.*", handler);

    await bus.forPlugin("acme.linear").emit("sync-done", "c-1", {});
    await bus.forPlugin("acme.linear").emit("error", "c-1", {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does NOT match across plugin boundaries (acme.linear.* does not catch acme.github.*)", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("watcher").subscribe("plugin.acme.linear.*", handler);

    await bus.forPlugin("acme.github").emit("sync-done", "c-1", {});

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("plugin-event-bus — filters", () => {
  it("pre-filters by companyId — non-matching events do not reach handler", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("watcher").subscribe("issue.created" as any, { companyId: "c-1" }, handler);

    await bus.emit({
      eventId: "e-1",
      eventType: "issue.created",
      companyId: "c-2",  // different company
      occurredAt: "2026-01-01T00:00:00Z",
      entityId: "iss-1",
      entityType: "issue",
      payload: {},
    } as any);

    expect(handler).not.toHaveBeenCalled();
  });

  it("filter requires handler arg — throws on missing", () => {
    const bus = createPluginEventBus();
    expect(() => {
      bus.forPlugin("watcher").subscribe("issue.created" as any, { companyId: "c-1" } as any);
    }).toThrow(/Handler function is required/i);
  });
});

describe("plugin-event-bus — isolation + error handling", () => {
  it("a failing handler does not block other plugins' handlers", async () => {
    const bus = createPluginEventBus();
    const goodHandler = vi.fn().mockResolvedValue(undefined);
    const badHandler = vi.fn().mockRejectedValue(new Error("boom"));

    bus.forPlugin("good").subscribe("issue.created" as any, goodHandler);
    bus.forPlugin("bad").subscribe("issue.created" as any, badHandler);

    const result = await bus.emit({
      eventId: "e-1",
      eventType: "issue.created",
      occurredAt: "2026-01-01T00:00:00Z",
      entityId: "iss-1",
      entityType: "issue",
      payload: {},
    } as any);

    expect(goodHandler).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.pluginId).toBe("bad");
  });

  it("a synchronously-throwing handler is caught and reported as a delivery error (not swallowed silently)", async () => {
    const bus = createPluginEventBus();
    const syncThrow = vi.fn(() => { throw new Error("sync boom"); }) as any;

    bus.forPlugin("bad").subscribe("issue.created" as any, syncThrow);

    const result = await bus.emit({
      eventId: "e-1",
      eventType: "issue.created",
      occurredAt: "2026-01-01T00:00:00Z",
      entityId: "iss-1",
      entityType: "issue",
      payload: {},
    } as any);

    expect(result.errors).toHaveLength(1);
    expect((result.errors[0]?.error as Error).message).toBe("sync boom");
  });

  it("clearPlugin removes all subscriptions for that plugin only", async () => {
    const bus = createPluginEventBus();
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);

    bus.forPlugin("a").subscribe("issue.created" as any, handlerA);
    bus.forPlugin("b").subscribe("issue.created" as any, handlerB);
    expect(bus.subscriptionCount()).toBe(2);

    bus.clearPlugin("a");
    expect(bus.subscriptionCount("a")).toBe(0);
    expect(bus.subscriptionCount("b")).toBe(1);

    await bus.emit({
      eventId: "e-1",
      eventType: "issue.created",
      occurredAt: "2026-01-01T00:00:00Z",
      entityId: "iss-1",
      entityType: "issue",
      payload: {},
    } as any);

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });
});
