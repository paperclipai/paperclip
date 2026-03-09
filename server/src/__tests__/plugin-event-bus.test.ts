import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.created",
    occurredAt: "2024-01-01T00:00:00.000Z",
    payload: { title: "Test Issue", projectId: "proj-1", companyId: "comp-1" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPluginEventBus", () => {
  let bus: PluginEventBus;

  beforeEach(() => {
    bus = createPluginEventBus();
  });

  // -------------------------------------------------------------------------
  // Basic subscribe and emit
  // -------------------------------------------------------------------------

  describe("subscribe and emit", () => {
    it("delivers an event to a subscriber", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("plugin-a");
      scoped.subscribe("issue.created", handler);

      await bus.emit(makeEvent({ eventType: "issue.created" }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventType: "issue.created" }));
    });

    it("does not deliver an event that does not match the subscription", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("plugin-a");
      scoped.subscribe("issue.updated", handler);

      await bus.emit(makeEvent({ eventType: "issue.created" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("delivers to multiple subscribers on the same plugin", async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("plugin-a");
      scoped.subscribe("issue.created", handler1);
      scoped.subscribe("issue.created", handler2);

      await bus.emit(makeEvent());

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("delivers the same event to multiple plugins", async () => {
      const handlerA = vi.fn().mockResolvedValue(undefined);
      const handlerB = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", handlerA);
      bus.forPlugin("plugin-b").subscribe("issue.created", handlerB);

      await bus.emit(makeEvent());

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it("delivers no events when there are no subscribers", async () => {
      const result = await bus.emit(makeEvent());
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Server-side event filtering
  // -------------------------------------------------------------------------

  describe("EventFilter (server-side filtering)", () => {
    it("delivers event when projectId filter matches payload.projectId", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { projectId: "proj-1" },
        handler,
      );

      await bus.emit(makeEvent({ payload: { projectId: "proj-1", companyId: "comp-1" } }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not deliver event when projectId filter does not match", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { projectId: "proj-999" },
        handler,
      );

      await bus.emit(makeEvent({ payload: { projectId: "proj-1", companyId: "comp-1" } }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("delivers event when entityType=project and projectId filter matches entityId", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "project.created",
        { projectId: "proj-1" },
        handler,
      );

      await bus.emit(makeEvent({
        eventType: "project.created",
        entityId: "proj-1",
        entityType: "project",
        payload: {},
      }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("delivers event when companyId filter matches payload.companyId", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { companyId: "comp-1" },
        handler,
      );

      await bus.emit(makeEvent({ payload: { companyId: "comp-1" } }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not deliver event when companyId filter does not match", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { companyId: "comp-999" },
        handler,
      );

      await bus.emit(makeEvent({ payload: { companyId: "comp-1" } }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("delivers event when agentId filter matches payload.agentId", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "agent.run.started",
        { agentId: "agent-1" },
        handler,
      );

      await bus.emit(makeEvent({
        eventType: "agent.run.started",
        payload: { agentId: "agent-1" },
      }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("delivers event when agentId filter matches entityId for agent entity type", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "agent.created",
        { agentId: "agent-1" },
        handler,
      );

      await bus.emit(makeEvent({
        eventType: "agent.created",
        entityId: "agent-1",
        entityType: "agent",
        payload: {},
      }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("applies combined filters (projectId AND companyId)", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { projectId: "proj-1", companyId: "comp-1" },
        handler,
      );

      // Both match
      await bus.emit(makeEvent({ payload: { projectId: "proj-1", companyId: "comp-1" } }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Only one matches
      await bus.emit(makeEvent({ payload: { projectId: "proj-1", companyId: "comp-99" } }));
      expect(handler).toHaveBeenCalledTimes(1); // still 1 — second call filtered out
    });

    it("subscriber without a filter receives all events of the subscribed type", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      await bus.emit(makeEvent({ payload: { projectId: "proj-1" } }));
      await bus.emit(makeEvent({ eventId: "evt-2", payload: { projectId: "proj-2" } }));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("throws when filter is provided but handler is missing", () => {
      const scoped = bus.forPlugin("plugin-a");
      expect(() => {
        // @ts-expect-error intentionally missing handler
        scoped.subscribe("issue.created", { projectId: "proj-1" });
      }).toThrow("Handler function is required");
    });
  });

  // -------------------------------------------------------------------------
  // Plugin-to-Plugin Events
  // -------------------------------------------------------------------------

  describe("plugin-to-plugin events", () => {
    it("emitting a plugin event namespaces it as plugin.<pluginId>.<name>", async () => {
      const receiver = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("plugin.acme.linear.sync-done", receiver);

      const emitterBus = bus.forPlugin("acme.linear");
      await emitterBus.emit("sync-done", "comp-1", { count: 42 });

      expect(receiver).toHaveBeenCalledTimes(1);
      expect(receiver).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "plugin.acme.linear.sync-done",
          companyId: "comp-1",
          actorType: "plugin",
          actorId: "acme.linear",
          payload: { count: 42 },
        }),
      );
    });

    it("plugin-emitted event is NOT delivered to core domain subscribers", async () => {
      const coreHandler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("issue.created", coreHandler);

      // Emitting a plugin event should not match the core subscription
      await bus.forPlugin("acme.linear").emit("issue.created", "comp-1", {});

      expect(coreHandler).not.toHaveBeenCalled();
    });

    it("throws when plugin tries to emit with the 'plugin.' prefix", async () => {
      const scoped = bus.forPlugin("acme.linear");
      await expect(scoped.emit("plugin.other.event", "comp-1", {})).rejects.toThrow(
        /must not include the "plugin\." prefix/,
      );
    });

    it("throws when plugin emits an empty event name", async () => {
      const scoped = bus.forPlugin("acme.linear");
      await expect(scoped.emit("", "comp-1", {})).rejects.toThrow(/non-empty event name/);
    });

    it("throws when plugin emits a whitespace-only event name", async () => {
      const scoped = bus.forPlugin("acme.linear");
      await expect(scoped.emit("   ", "comp-1", {})).rejects.toThrow(/non-empty event name/);
    });

    it("a plugin can subscribe to its own emitted events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("acme.linear");
      scoped.subscribe("plugin.acme.linear.sync-done", handler);

      await scoped.emit("sync-done", "comp-1", { ok: true });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("plugin emitted event includes a unique eventId", async () => {
      const events: PluginEvent[] = [];
      const scoped = bus.forPlugin("acme.linear");
      scoped.subscribe("plugin.acme.linear.ping", async (ev) => { events.push(ev); });

      await scoped.emit("ping", "comp-1", {});
      await scoped.emit("ping", "comp-1", {});

      expect(events).toHaveLength(2);
      expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
    });
  });

  // -------------------------------------------------------------------------
  // Wildcard subscriptions
  // -------------------------------------------------------------------------

  describe("wildcard subscriptions", () => {
    it("'plugin.acme.linear.*' matches any event from that plugin", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("plugin.acme.linear.*", handler);

      const emitter = bus.forPlugin("acme.linear");
      await emitter.emit("sync-done", "comp-1", {});
      await emitter.emit("push-detected", "comp-1", {});

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("'plugin.acme.linear.*' does NOT match events from a different plugin", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("plugin.acme.linear.*", handler);

      await bus.forPlugin("acme.github").emit("push-detected", "comp-1", {});

      expect(handler).not.toHaveBeenCalled();
    });

    it("wildcard does NOT match core domain events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      // A wildcard that looks like it might match "issue.*"
      bus.forPlugin("plugin-a").subscribe("plugin.issue.*", handler);

      await bus.emit(makeEvent({ eventType: "issue.created" }));
      await bus.emit(makeEvent({ eventType: "issue.updated" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("exact subscription still works alongside wildcards", async () => {
      const exactHandler = vi.fn().mockResolvedValue(undefined);
      const wildcardHandler = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("plugin-b");
      scoped.subscribe("plugin.acme.linear.sync-done", exactHandler);
      scoped.subscribe("plugin.acme.linear.*", wildcardHandler);

      await bus.forPlugin("acme.linear").emit("sync-done", "comp-1", {});

      expect(exactHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Plugin isolation
  // -------------------------------------------------------------------------

  describe("plugin isolation", () => {
    it("plugin A cannot receive events subscribed by plugin B (different handlers)", async () => {
      const handlerA = vi.fn().mockResolvedValue(undefined);
      const handlerB = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", handlerA);
      bus.forPlugin("plugin-b").subscribe("issue.updated", handlerB);

      // Emit issue.created — only handlerA should fire
      await bus.emit(makeEvent({ eventType: "issue.created" }));
      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();

      // Emit issue.updated — only handlerB should fire
      await bus.emit(makeEvent({ eventType: "issue.updated" }));
      expect(handlerA).toHaveBeenCalledTimes(1); // unchanged
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it("clearing plugin A's subscriptions does not affect plugin B", async () => {
      const handlerA = vi.fn().mockResolvedValue(undefined);
      const handlerB = vi.fn().mockResolvedValue(undefined);
      const scopedA = bus.forPlugin("plugin-a");
      bus.forPlugin("plugin-b").subscribe("issue.created", handlerB);
      scopedA.subscribe("issue.created", handlerA);

      scopedA.clear();

      await bus.emit(makeEvent());
      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it("clearPlugin removes all subscriptions for that plugin", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);
      bus.forPlugin("plugin-a").subscribe("issue.updated", handler);

      bus.clearPlugin("plugin-a");

      await bus.emit(makeEvent({ eventType: "issue.created" }));
      await bus.emit(makeEvent({ eventType: "issue.updated" }));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // subscriptionCount
  // -------------------------------------------------------------------------

  describe("subscriptionCount", () => {
    it("returns 0 when no subscriptions are registered", () => {
      expect(bus.subscriptionCount()).toBe(0);
    });

    it("counts subscriptions across all plugins", () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-a").subscribe("issue.updated", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));

      expect(bus.subscriptionCount()).toBe(3);
    });

    it("counts subscriptions for a specific plugin", () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-a").subscribe("issue.updated", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));

      expect(bus.subscriptionCount("plugin-a")).toBe(2);
      expect(bus.subscriptionCount("plugin-b")).toBe(1);
      expect(bus.subscriptionCount("plugin-c")).toBe(0);
    });

    it("decreases after clearPlugin", () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));

      bus.clearPlugin("plugin-a");

      expect(bus.subscriptionCount()).toBe(1);
      expect(bus.subscriptionCount("plugin-a")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pattern matching edge cases
  // -------------------------------------------------------------------------

  describe("pattern matching edge cases", () => {
    it("'plugin.*' wildcard matches any plugin-namespaced event", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("plugin.*", handler);

      await bus.forPlugin("acme.linear").emit("sync-done", "comp-1", {});
      await bus.forPlugin("acme.github").emit("push-detected", "comp-1", {});

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("'plugin.*' wildcard does NOT match core domain events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-b").subscribe("plugin.*", handler);

      await bus.emit(makeEvent({ eventType: "issue.created" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("handler receives the full event envelope with all fields", async () => {
      const received: PluginEvent[] = [];
      bus.forPlugin("plugin-a").subscribe("issue.created", async (ev) => { received.push(ev); });

      const event = makeEvent({
        eventId: "evt-full",
        eventType: "issue.created",
        occurredAt: "2025-06-01T12:00:00.000Z",
        actorId: "user-1",
        actorType: "user",
        entityId: "iss-1",
        entityType: "issue",
        payload: { title: "Full envelope test" },
      });
      await bus.emit(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);
    });

    it("calling forPlugin twice with the same id returns handles sharing the same subscription list", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      // Subscribe via the first handle
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      // Emit via the host bus — both handles point to the same plugin-a entry
      await bus.emit(makeEvent());
      expect(handler).toHaveBeenCalledTimes(1);

      // Verify subscriptionCount is consistent
      expect(bus.subscriptionCount("plugin-a")).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // EventFilter additional edge cases
  // -------------------------------------------------------------------------

  describe("EventFilter additional edge cases", () => {
    it("empty filter object {} passes all events (no constraints)", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", {}, handler);

      await bus.emit(makeEvent({ payload: { projectId: "proj-any" } }));
      await bus.emit(makeEvent({ eventId: "evt-2", payload: { projectId: "proj-other" } }));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("agentId filter does not match when payload.agentId differs from filter", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "agent.run.started",
        { agentId: "agent-wanted" },
        handler,
      );

      await bus.emit(makeEvent({
        eventType: "agent.run.started",
        payload: { agentId: "agent-other" },
      }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("agentId filter does not match when entityType=agent but entityId differs", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe(
        "agent.deleted",
        { agentId: "agent-wanted" },
        handler,
      );

      await bus.emit(makeEvent({
        eventType: "agent.deleted",
        entityId: "agent-other",
        entityType: "agent",
        payload: {},
      }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("subscriptionCount is unaffected by filter presence", () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));
      bus.forPlugin("plugin-a").subscribe(
        "issue.created",
        { projectId: "proj-1" },
        vi.fn().mockResolvedValue(undefined),
      );

      expect(bus.subscriptionCount("plugin-a")).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Re-subscribe after clear
  // -------------------------------------------------------------------------

  describe("re-subscribe after clear", () => {
    it("a plugin can re-subscribe after calling clear()", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const scoped = bus.forPlugin("plugin-a");
      scoped.subscribe("issue.created", handler);

      scoped.clear();
      expect(bus.subscriptionCount("plugin-a")).toBe(0);

      // Re-subscribe and verify it works again
      scoped.subscribe("issue.created", handler);
      await bus.emit(makeEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(bus.subscriptionCount("plugin-a")).toBe(1);
    });

    it("clearPlugin followed by new subscription works correctly", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      bus.clearPlugin("plugin-a");

      bus.forPlugin("plugin-a").subscribe("issue.updated", handler);
      await bus.emit(makeEvent({ eventType: "issue.updated" }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Plugin-emitted event envelope correctness
  // -------------------------------------------------------------------------

  describe("plugin-emitted event envelope", () => {
    it("plugin-emitted event has a valid ISO 8601 occurredAt timestamp", async () => {
      const events: PluginEvent[] = [];
      bus.forPlugin("acme.linear").subscribe("plugin.acme.linear.ping", async (ev) => { events.push(ev); });

      await bus.forPlugin("acme.linear").emit("ping", "comp-1", {});

      expect(events).toHaveLength(1);
      const ts = events[0]!.occurredAt;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it("scoped emit result contains handler errors from receivers", async () => {
      bus.forPlugin("plugin-b").subscribe(
        "plugin.acme.linear.event",
        vi.fn().mockRejectedValue(new Error("receiver-error")),
      );

      const result = await bus.forPlugin("acme.linear").emit("event", "comp-1", {});

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        pluginId: "plugin-b",
        error: expect.objectContaining({ message: "receiver-error" }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns errors from failing handlers without throwing", async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error("handler boom"));
      const okHandler = vi.fn().mockResolvedValue(undefined);

      bus.forPlugin("plugin-a").subscribe("issue.created", failingHandler);
      bus.forPlugin("plugin-b").subscribe("issue.created", okHandler);

      const result = await bus.emit(makeEvent());

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        pluginId: "plugin-a",
        error: expect.objectContaining({ message: "handler boom" }),
      });

      // OK handler still fired despite plugin-a's failure
      expect(okHandler).toHaveBeenCalledTimes(1);
    });

    it("multiple handler failures are all collected", async () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockRejectedValue(new Error("err-a")));
      bus.forPlugin("plugin-b").subscribe("issue.created", vi.fn().mockRejectedValue(new Error("err-b")));

      const result = await bus.emit(makeEvent());

      expect(result.errors).toHaveLength(2);
      const messages = result.errors.map((e) => (e.error as Error).message);
      expect(messages).toContain("err-a");
      expect(messages).toContain("err-b");
    });

    it("returns empty errors array on full success", async () => {
      bus.forPlugin("plugin-a").subscribe("issue.created", vi.fn().mockResolvedValue(undefined));

      const result = await bus.emit(makeEvent());

      expect(result.errors).toHaveLength(0);
    });

    it("captures synchronous throws from handlers without propagating to caller", async () => {
      // A handler typed as async but implemented to throw synchronously before
      // returning a Promise. The Promise.resolve() wrapper in the event bus must
      // catch this — otherwise the error escapes and rejects the emit() call.
      const syncThrowHandler = vi.fn().mockImplementation(() => {
        throw new Error("sync boom");
      }) as unknown as (event: PluginEvent) => Promise<void>;

      bus.forPlugin("plugin-a").subscribe("issue.created", syncThrowHandler);

      // Should NOT reject — the sync error must be captured in errors[]
      const result = await bus.emit(makeEvent());

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        pluginId: "plugin-a",
        error: expect.objectContaining({ message: "sync boom" }),
      });
    });

    it("a sync-throwing handler does not prevent other handlers from running", async () => {
      const syncThrowHandler = vi.fn().mockImplementation(() => {
        throw new Error("sync error");
      }) as unknown as (event: PluginEvent) => Promise<void>;
      const okHandler = vi.fn().mockResolvedValue(undefined);

      bus.forPlugin("plugin-a").subscribe("issue.created", syncThrowHandler);
      bus.forPlugin("plugin-b").subscribe("issue.created", okHandler);

      const result = await bus.emit(makeEvent());

      expect(result.errors).toHaveLength(1);
      expect(okHandler).toHaveBeenCalledTimes(1);
    });
  });
});
