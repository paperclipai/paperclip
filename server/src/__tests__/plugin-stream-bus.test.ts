import { describe, it, expect, vi } from "vitest";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";
import type { StreamEventType } from "../services/plugin-stream-bus.js";

describe("createPluginStreamBus", () => {
  it("delivers a published event to a matching subscriber", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plug-a", "ch-1", "co-1", listener);
    bus.publish("plug-a", "ch-1", "co-1", { data: "hello" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ data: "hello" }, "message");
  });

  it("defaults eventType to 'message' when not specified", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "c", "co", listener);
    bus.publish("p", "c", "co", "payload");
    const [, eventType] = listener.mock.calls[0] as [unknown, StreamEventType];
    expect(eventType).toBe("message");
  });

  it("passes a custom eventType through to the listener", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "c", "co", listener);
    bus.publish("p", "c", "co", "bye", "close");
    const [, eventType] = listener.mock.calls[0] as [unknown, StreamEventType];
    expect(eventType).toBe("close");
  });

  it("does NOT deliver to a subscriber for a different pluginId", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plug-a", "ch-1", "co-1", listener);
    bus.publish("plug-b", "ch-1", "co-1", "ignored");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does NOT deliver to a subscriber for a different channel", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "ch-1", "co", listener);
    bus.publish("p", "ch-2", "co", "ignored");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does NOT deliver to a subscriber for a different companyId", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "ch", "co-1", listener);
    bus.publish("p", "ch", "co-2", "ignored");
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to multiple subscribers on the same key", () => {
    const bus = createPluginStreamBus();
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.subscribe("p", "ch", "co", l1);
    bus.subscribe("p", "ch", "co", l2);
    bus.publish("p", "ch", "co", "event");
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });

  it("stops delivering after unsubscribe is called", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("p", "ch", "co", listener);
    bus.publish("p", "ch", "co", "before");
    unsubscribe();
    bus.publish("p", "ch", "co", "after");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("cleans up the key set when the last subscriber unsubscribes", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("p", "ch", "co", listener);
    unsubscribe();
    // Subsequent publish should be a no-op (no error)
    expect(() => bus.publish("p", "ch", "co", "event")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op when publishing with no subscribers", () => {
    const bus = createPluginStreamBus();
    expect(() => bus.publish("p", "ch", "co", "event")).not.toThrow();
  });
});
