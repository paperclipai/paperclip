import { describe, expect, it, vi } from "vitest";
import { createPluginStreamBus } from "./plugin-stream-bus.js";

// ============================================================================
// createPluginStreamBus — subscribe and publish
// ============================================================================

describe("createPluginStreamBus — basic pub/sub", () => {
  it("delivers a published event to a subscribed listener", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("my-plugin", "data", "company-1", listener);

    bus.publish("my-plugin", "data", "company-1", { value: 42 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ value: 42 }, "message");
  });

  it("defaults eventType to 'message' when not provided", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "c", "co", listener);
    bus.publish("p", "c", "co", "payload");
    expect(listener).toHaveBeenCalledWith("payload", "message");
  });

  it("passes explicit eventType through to the listener", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "c", "co", listener);
    bus.publish("p", "c", "co", null, "open");
    expect(listener).toHaveBeenCalledWith(null, "open");
  });

  it("delivers to multiple subscribers of the same channel", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("p", "c", "co", a);
    bus.subscribe("p", "c", "co", b);
    bus.publish("p", "c", "co", "event");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// createPluginStreamBus — key isolation
// ============================================================================

describe("createPluginStreamBus — key isolation", () => {
  it("does not deliver to a listener on a different channel", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin", "channel-A", "company-1", listener);

    bus.publish("plugin", "channel-B", "company-1", "event");

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not deliver to a listener for a different company", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin", "channel", "company-1", listener);

    bus.publish("plugin", "channel", "company-2", "event");

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not deliver to a listener for a different plugin", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin-A", "channel", "company", listener);

    bus.publish("plugin-B", "channel", "company", "event");

    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to the correct subscriber when multiple (plugin, channel, company) combinations are active", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("plugin", "ch-A", "company", a);
    bus.subscribe("plugin", "ch-B", "company", b);

    bus.publish("plugin", "ch-A", "company", "for-a");

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });
});

// ============================================================================
// createPluginStreamBus — unsubscribe
// ============================================================================

describe("createPluginStreamBus — unsubscribe", () => {
  it("returns an unsubscribe function", () => {
    const bus = createPluginStreamBus();
    const unsubscribe = bus.subscribe("p", "c", "co", vi.fn());
    expect(typeof unsubscribe).toBe("function");
  });

  it("stops delivering events after unsubscribe is called", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("p", "c", "co", listener);

    unsubscribe();
    bus.publish("p", "c", "co", "event");

    expect(listener).not.toHaveBeenCalled();
  });

  it("only removes the specific subscriber, not all subscribers", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = bus.subscribe("p", "c", "co", a);
    bus.subscribe("p", "c", "co", b);

    unsubA();
    bus.publish("p", "c", "co", "event");

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("does not throw when unsubscribe is called twice", () => {
    const bus = createPluginStreamBus();
    const unsubscribe = bus.subscribe("p", "c", "co", vi.fn());
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});

// ============================================================================
// createPluginStreamBus — publish to empty bus
// ============================================================================

describe("createPluginStreamBus — publish with no subscribers", () => {
  it("does not throw when publishing to a channel with no subscribers", () => {
    const bus = createPluginStreamBus();
    expect(() => bus.publish("p", "c", "co", "event")).not.toThrow();
  });
});

// ============================================================================
// createPluginStreamBus — multiple events
// ============================================================================

describe("createPluginStreamBus — multiple events", () => {
  it("delivers each event in order to the same listener", () => {
    const bus = createPluginStreamBus();
    const received: unknown[] = [];
    bus.subscribe("p", "c", "co", (event) => received.push(event));

    bus.publish("p", "c", "co", "first");
    bus.publish("p", "c", "co", "second");
    bus.publish("p", "c", "co", "third");

    expect(received).toEqual(["first", "second", "third"]);
  });

  it("handles all StreamEventType variants without error", () => {
    const bus = createPluginStreamBus();
    const types: string[] = [];
    bus.subscribe("p", "c", "co", (_, t) => types.push(t));

    bus.publish("p", "c", "co", null, "message");
    bus.publish("p", "c", "co", null, "open");
    bus.publish("p", "c", "co", null, "close");
    bus.publish("p", "c", "co", null, "error");

    expect(types).toEqual(["message", "open", "close", "error"]);
  });
});
