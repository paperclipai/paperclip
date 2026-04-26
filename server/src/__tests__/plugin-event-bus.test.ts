import { describe, it, expect, vi } from "vitest";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.created",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    actorType: "system",
    actorId: null,
    entityType: "issue",
    entityId: "iss-1",
    payload: { projectId: "proj-1" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// emit — basic delivery
// ---------------------------------------------------------------------------

describe("PluginEventBus.emit (basic delivery)", () => {
  it("delivers an event to a matching subscriber", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventType: "issue.created" }));
  });

  it("does NOT deliver when the event type does not match the subscription pattern", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);

    await bus.emit(makeEvent({ eventType: "agent.status" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to multiple plugins subscribed to the same event type", async () => {
    const bus = createPluginEventBus();
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", h1);
    bus.forPlugin("plugin-b").subscribe("issue.created", h2);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("returns errors from misbehaving handlers without disrupting other handlers", async () => {
    const bus = createPluginEventBus();
    const throwing = vi.fn().mockRejectedValue(new Error("handler failure"));
    const ok = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("bad-plugin").subscribe("issue.created", throwing);
    bus.forPlugin("good-plugin").subscribe("issue.created", ok);

    const result = await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(ok).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].pluginId).toBe("bad-plugin");
  });

  it("returns empty errors array on successful delivery", async () => {
    const bus = createPluginEventBus();
    bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));
    const result = await bus.emit(makeEvent());
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// emit — wildcard pattern matching
// ---------------------------------------------------------------------------

describe("PluginEventBus.emit (wildcard patterns)", () => {
  it("delivers to a '.*' wildcard subscriber", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("plugin.acme.linear.*", handler);

    await bus.emit(makeEvent({ eventType: "plugin.acme.linear.sync-done" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("does NOT deliver when the wildcard prefix does not match", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("plugin.acme.linear.*", handler);

    await bus.emit(makeEvent({ eventType: "plugin.acme.other.sync-done" }));

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// emit — EventFilter
// ---------------------------------------------------------------------------

describe("PluginEventBus.emit (EventFilter)", () => {
  it("passes events that match the companyId filter", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", { companyId: "co-1" }, handler);

    await bus.emit(makeEvent({ companyId: "co-1" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("blocks events that do NOT match the companyId filter", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", { companyId: "co-other" }, handler);

    await bus.emit(makeEvent({ companyId: "co-1" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("passes events matching projectId when entityType is 'project'", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("project.created", { projectId: "proj-1" }, handler);

    await bus.emit(makeEvent({
      eventType: "project.created",
      entityType: "project",
      entityId: "proj-1",
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("passes events matching projectId from payload when entityType is not 'project'", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", { projectId: "proj-1" }, handler);

    await bus.emit(makeEvent({
      eventType: "issue.created",
      entityType: "issue",
      payload: { projectId: "proj-1" },
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("blocks events when projectId filter does not match payload", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", { projectId: "proj-other" }, handler);

    await bus.emit(makeEvent({ eventType: "issue.created", payload: { projectId: "proj-1" } }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("throws when a filter is provided without a handler function", () => {
    const bus = createPluginEventBus();
    expect(() => {
      bus.forPlugin("plugin-a").subscribe("issue.created", { companyId: "co-1" }, undefined as never);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ScopedPluginEventBus.emit
// ---------------------------------------------------------------------------

describe("ScopedPluginEventBus.emit", () => {
  it("namespaces the event type as 'plugin.<pluginId>.<name>'", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-b").subscribe("plugin.plugin-a.*", handler);

    await bus.forPlugin("plugin-a").emit("sync-done", "co-1", { result: "ok" });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]![0] as PluginEvent;
    expect(event.eventType).toBe("plugin.plugin-a.sync-done");
    expect(event.actorType).toBe("plugin");
    expect(event.actorId).toBe("plugin-a");
  });

  it("throws when the event name is empty", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("plugin-a").emit("", "co-1", {})).rejects.toThrow(
      /non-empty event name/,
    );
  });

  it("throws when the companyId is empty", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("plugin-a").emit("sync-done", "", {})).rejects.toThrow(
      /companyId/,
    );
  });

  it("throws when the event name includes the 'plugin.' prefix", async () => {
    const bus = createPluginEventBus();
    await expect(
      bus.forPlugin("plugin-a").emit("plugin.sync-done", "co-1", {}),
    ).rejects.toThrow(/must not include the "plugin\." prefix/);
  });
});

// ---------------------------------------------------------------------------
// clearPlugin / ScopedPluginEventBus.clear
// ---------------------------------------------------------------------------

describe("clearPlugin / ScopedPluginEventBus.clear", () => {
  it("clearPlugin removes all subscriptions for the plugin", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", handler);
    bus.clearPlugin("plugin-a");

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("ScopedPluginEventBus.clear removes all subscriptions for that plugin", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    const scopedBus = bus.forPlugin("plugin-a");
    scopedBus.subscribe("issue.created", handler);
    scopedBus.clear();

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("clearPlugin does not affect subscriptions of other plugins", async () => {
    const bus = createPluginEventBus();
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", handlerA);
    bus.forPlugin("plugin-b").subscribe("issue.created", handlerB);
    bus.clearPlugin("plugin-a");

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// subscriptionCount
// ---------------------------------------------------------------------------

describe("subscriptionCount", () => {
  it("returns 0 when no subscriptions exist", () => {
    const bus = createPluginEventBus();
    expect(bus.subscriptionCount()).toBe(0);
  });

  it("returns the total subscription count", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn());
    bus.forPlugin("plugin-a").subscribe("agent.status", vi.fn());
    bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn());
    expect(bus.subscriptionCount()).toBe(3);
  });

  it("returns the count scoped to a specific plugin", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn());
    bus.forPlugin("plugin-a").subscribe("agent.status", vi.fn());
    bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn());
    expect(bus.subscriptionCount("plugin-a")).toBe(2);
    expect(bus.subscriptionCount("plugin-b")).toBe(1);
  });

  it("returns 0 after clearPlugin", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn());
    bus.clearPlugin("plugin-a");
    expect(bus.subscriptionCount("plugin-a")).toBe(0);
  });
});
