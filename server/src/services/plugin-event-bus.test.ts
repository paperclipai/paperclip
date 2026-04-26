import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { createPluginEventBus } from "./plugin-event-bus.js";

// Helper to build a minimal PluginEvent envelope for tests.
function makeEvent(overrides: Partial<PluginEvent> & { eventType: PluginEvent["eventType"] }): PluginEvent {
  return {
    eventId: "evt-1",
    occurredAt: new Date().toISOString(),
    companyId: "co-1",
    payload: {},
    ...overrides,
  };
}

// ============================================================================
// createPluginEventBus — basic emit delivery
// ============================================================================

describe("createPluginEventBus — basic delivery", () => {
  it("delivers event to a subscribed handler", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("acme.linear").subscribe("issue.created", handler);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not deliver event to handler subscribed to a different type", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("acme.linear").subscribe("issue.updated", handler);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers the event object to the handler", async () => {
    const bus = createPluginEventBus();
    let received: PluginEvent | undefined;
    bus.forPlugin("plug-1").subscribe("agent.updated", async (event) => {
      received = event;
    });
    const event = makeEvent({ eventType: "agent.updated" });

    await bus.emit(event);

    expect(received).toBe(event);
  });

  it("delivers to multiple plugins subscribed to the same event type", async () => {
    const bus = createPluginEventBus();
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plugin-a").subscribe("issue.created", handlerA);
    bus.forPlugin("plugin-b").subscribe("issue.created", handlerB);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it("delivers to multiple subscriptions in the same plugin", async () => {
    const bus = createPluginEventBus();
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const scoped = bus.forPlugin("my-plugin");
    scoped.subscribe("issue.created", h1);
    scoped.subscribe("issue.created", h2);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("returns empty errors array when all handlers succeed", async () => {
    const bus = createPluginEventBus();
    bus.forPlugin("p").subscribe("issue.created", async () => {});

    const { errors } = await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// createPluginEventBus — wildcard pattern matching
// ============================================================================

describe("createPluginEventBus — wildcard subscriptions", () => {
  it("wildcard pattern delivers events with matching prefix", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("my-plugin").subscribe("plugin.acme.linear.*", handler);

    await bus.emit(makeEvent({ eventType: "plugin.acme.linear.sync-done" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("wildcard does not match unrelated plugin namespace", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("my-plugin").subscribe("plugin.acme.linear.*", handler);

    await bus.emit(makeEvent({ eventType: "plugin.other.sync-done" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("top-level plugin wildcard delivers all plugin-namespaced events", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("observer").subscribe("plugin.*", handler);

    await bus.emit(makeEvent({ eventType: "plugin.acme.linear.sync-done" }));
    await bus.emit(makeEvent({ eventType: "plugin.other.some-event" }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("exact match still works alongside wildcards", async () => {
    const bus = createPluginEventBus();
    const exactHandler = vi.fn().mockResolvedValue(undefined);
    const wildcardHandler = vi.fn().mockResolvedValue(undefined);
    const scoped = bus.forPlugin("p");
    scoped.subscribe("plugin.acme.linear.sync-done", exactHandler);
    scoped.subscribe("plugin.acme.linear.*", wildcardHandler);

    await bus.emit(makeEvent({ eventType: "plugin.acme.linear.sync-done" }));

    expect(exactHandler).toHaveBeenCalledOnce();
    expect(wildcardHandler).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// createPluginEventBus — EventFilter
// ============================================================================

describe("createPluginEventBus — EventFilter", () => {
  it("delivers event when companyId filter matches", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", { companyId: "co-1" }, handler);

    await bus.emit(makeEvent({ eventType: "issue.created", companyId: "co-1" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not deliver when companyId filter does not match", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", { companyId: "co-X" }, handler);

    await bus.emit(makeEvent({ eventType: "issue.created", companyId: "co-1" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("filters by projectId from payload when entityType is not project", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", { projectId: "proj-1" }, handler);

    await bus.emit(makeEvent({
      eventType: "issue.created",
      entityType: "issue",
      payload: { projectId: "proj-1" },
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("filters by projectId from entityId when entityType is project", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("project.updated", { projectId: "proj-2" }, handler);

    await bus.emit(makeEvent({
      eventType: "project.updated",
      entityType: "project",
      entityId: "proj-2",
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not deliver when projectId filter does not match payload", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", { projectId: "proj-X" }, handler);

    await bus.emit(makeEvent({
      eventType: "issue.created",
      entityType: "issue",
      payload: { projectId: "proj-1" },
    }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("filters by agentId from payload when entityType is not agent", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("agent.run.started", { agentId: "agent-1" }, handler);

    await bus.emit(makeEvent({
      eventType: "agent.run.started",
      entityType: "run",
      payload: { agentId: "agent-1" },
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("filters by agentId from entityId when entityType is agent", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("agent.updated", { agentId: "agent-2" }, handler);

    await bus.emit(makeEvent({
      eventType: "agent.updated",
      entityType: "agent",
      entityId: "agent-2",
    }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("null filter delivers all events", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", handler);

    await bus.emit(makeEvent({ eventType: "issue.created", companyId: "any-company" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("multiple filter fields are ANDed", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("p").subscribe("issue.created", { companyId: "co-1", projectId: "proj-1" }, handler);

    // Both match
    await bus.emit(makeEvent({
      eventType: "issue.created",
      companyId: "co-1",
      entityType: "issue",
      payload: { projectId: "proj-1" },
    }));
    // Only companyId matches
    await bus.emit(makeEvent({
      eventType: "issue.created",
      companyId: "co-1",
      entityType: "issue",
      payload: { projectId: "proj-X" },
    }));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// createPluginEventBus — error isolation
// ============================================================================

describe("createPluginEventBus — handler error isolation", () => {
  it("returns handler error in errors array instead of throwing", async () => {
    const bus = createPluginEventBus();
    const err = new Error("handler exploded");
    bus.forPlugin("bad-plugin").subscribe("issue.created", async () => { throw err; });

    const { errors } = await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe(err);
    expect(errors[0]!.pluginId).toBe("bad-plugin");
  });

  it("delivers to a working plugin even when another plugin's handler throws", async () => {
    const bus = createPluginEventBus();
    const goodHandler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("bad-plugin").subscribe("issue.created", async () => { throw new Error("bad"); });
    bus.forPlugin("good-plugin").subscribe("issue.created", goodHandler);

    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(goodHandler).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// createPluginEventBus — clearPlugin / forPlugin.clear
// ============================================================================

describe("createPluginEventBus — clearPlugin", () => {
  it("clearPlugin stops delivery to that plugin", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("plug").subscribe("issue.created", handler);

    bus.clearPlugin("plug");
    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("forPlugin.clear() removes subscriptions for that plugin", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    const scoped = bus.forPlugin("plug");
    scoped.subscribe("issue.created", handler);

    scoped.clear();
    await bus.emit(makeEvent({ eventType: "issue.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("clearPlugin does not affect other plugins", async () => {
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

// ============================================================================
// createPluginEventBus — subscriptionCount
// ============================================================================

describe("createPluginEventBus — subscriptionCount", () => {
  it("returns 0 when no subscriptions exist", () => {
    const bus = createPluginEventBus();
    expect(bus.subscriptionCount()).toBe(0);
  });

  it("counts subscriptions globally", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("p1").subscribe("issue.created", async () => {});
    bus.forPlugin("p2").subscribe("issue.updated", async () => {});
    expect(bus.subscriptionCount()).toBe(2);
  });

  it("counts subscriptions for a specific plugin", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("p1").subscribe("issue.created", async () => {});
    bus.forPlugin("p1").subscribe("issue.updated", async () => {});
    bus.forPlugin("p2").subscribe("issue.created", async () => {});
    expect(bus.subscriptionCount("p1")).toBe(2);
    expect(bus.subscriptionCount("p2")).toBe(1);
  });

  it("decreases after clearPlugin", () => {
    const bus = createPluginEventBus();
    bus.forPlugin("p").subscribe("issue.created", async () => {});
    bus.forPlugin("p").subscribe("issue.updated", async () => {});
    bus.clearPlugin("p");
    expect(bus.subscriptionCount()).toBe(0);
  });
});

// ============================================================================
// createPluginEventBus — forPlugin scoped emit (plugin-to-plugin events)
// ============================================================================

describe("createPluginEventBus — forPlugin.emit", () => {
  it("emits event namespaced as plugin.<pluginId>.<name>", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.forPlugin("observer").subscribe("plugin.acme.linear.*", handler);

    await bus.forPlugin("acme.linear").emit("sync-done", "co-1", { count: 5 });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("throws when name is empty", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("p").emit("", "co-1", {})).rejects.toThrow();
  });

  it("throws when name starts with 'plugin.'", async () => {
    const bus = createPluginEventBus();
    await expect(
      bus.forPlugin("p").emit("plugin.spoof", "co-1", {}),
    ).rejects.toThrow();
  });

  it("throws when companyId is empty", async () => {
    const bus = createPluginEventBus();
    await expect(bus.forPlugin("p").emit("event-name", "", {})).rejects.toThrow();
  });
});
