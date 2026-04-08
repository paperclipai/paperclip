import { describe, expect, it, vi } from "vitest";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";
import { createStreamBus } from "../services/stream-bus.js";

/**
 * Smoke tests for the plugin-stream-bus adapter over the generic
 * StreamBus primitive. These lock in the original public contract
 * (subscribe/publish signatures, fanout to matching (pluginId, channel,
 * companyId), event type passthrough) so the Phase 4 refactor does not
 * regress the plugin SSE pipeline.
 */
describe("PluginStreamBus adapter", () => {
  it("delivers events to matching (pluginId, channel, companyId)", () => {
    const bus = createPluginStreamBus();
    const received: Array<{ event: unknown; type: string }> = [];

    bus.subscribe("plugin-a", "chat", "company-1", (event, type) => {
      received.push({ event, type });
    });

    bus.publish("plugin-a", "chat", "company-1", { hello: "world" });
    expect(received).toEqual([{ event: { hello: "world" }, type: "message" }]);
  });

  it("event type passthrough (open|close|error|message)", () => {
    const bus = createPluginStreamBus();
    const types: string[] = [];
    bus.subscribe("p", "c", "co", (_e, t) => types.push(t));

    bus.publish("p", "c", "co", {}, "open");
    bus.publish("p", "c", "co", {}, "error");
    bus.publish("p", "c", "co", {}, "close");
    bus.publish("p", "c", "co", {}); // default message

    expect(types).toEqual(["open", "error", "close", "message"]);
  });

  it("does not cross streams across different plugin ids", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();

    bus.subscribe("plugin-a", "chat", "company-1", a);
    bus.subscribe("plugin-b", "chat", "company-1", b);

    bus.publish("plugin-a", "chat", "company-1", "msg");
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("does not cross streams across different company ids", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();

    bus.subscribe("plugin-a", "chat", "company-1", a);
    bus.subscribe("plugin-a", "chat", "company-2", b);

    bus.publish("plugin-a", "chat", "company-1", "msg");
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("does not cross streams across different channels", () => {
    const bus = createPluginStreamBus();
    const a = vi.fn();
    const b = vi.fn();

    bus.subscribe("plugin-a", "chat", "company-1", a);
    bus.subscribe("plugin-a", "notif", "company-1", b);

    bus.publish("plugin-a", "chat", "company-1", "msg");
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("unsubscribe stops delivery", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    const unsub = bus.subscribe("p", "c", "co", listener);

    bus.publish("p", "c", "co", 1);
    unsub();
    bus.publish("p", "c", "co", 2);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delegates to a shared underlying StreamBus when provided", () => {
    // Verifies that the Phase 4 wiring (one shared bus for plugin + room
    // + agent) actually routes plugin events through the shared instance.
    const base = createStreamBus();
    const pluginBus = createPluginStreamBus(base);

    // Subscribe via the adapter, publish via the shared primitive directly.
    const listener = vi.fn();
    pluginBus.subscribe("p", "c", "co", listener);

    base.publish("plugin", "p:c:co", "direct-primitive-event", "message");

    expect(listener).toHaveBeenCalledWith("direct-primitive-event", "message");
  });
});
