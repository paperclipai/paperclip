import { describe, expect, it, vi } from "vitest";
import {
  createPluginStreamBus,
  publishWorkerStreamNotification,
} from "../services/plugin-stream-bus.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

describe("PluginStreamBus", () => {
  it("delivers a published event only to subscribers of the matching tuple", () => {
    const bus = createPluginStreamBus();
    const match = vi.fn();
    const wrongChannel = vi.fn();
    const wrongCompany = vi.fn();

    bus.subscribe("plugin-a", "chan-1", "co-1", match);
    bus.subscribe("plugin-a", "chan-2", "co-1", wrongChannel);
    bus.subscribe("plugin-a", "chan-1", "co-2", wrongCompany);

    bus.publish("plugin-a", "chan-1", "co-1", { type: "text", text: "hi" });

    expect(match).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith({ type: "text", text: "hi" }, "message");
    expect(wrongChannel).not.toHaveBeenCalled();
    expect(wrongCompany).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("p", "c", "co", listener);

    bus.publish("p", "c", "co", { n: 1 });
    unsubscribe();
    bus.publish("p", "c", "co", { n: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ n: 1 }, "message");
  });
});

describe("publishWorkerStreamNotification", () => {
  it("maps streams.emit to a 'message' event and forwards the payload", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "chat:thread", "co", listener);

    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "chat:thread",
      companyId: "co",
      event: { type: "text", text: "token" },
    });

    expect(listener).toHaveBeenCalledWith({ type: "text", text: "token" }, "message");
  });

  it("maps streams.open and streams.close to their event types", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("p", "c", "co", listener);

    publishWorkerStreamNotification(bus, "p", "streams.open", { channel: "c", companyId: "co" });
    publishWorkerStreamNotification(bus, "p", "streams.close", { channel: "c", companyId: "co" });

    expect(listener).toHaveBeenNthCalledWith(1, null, "open");
    expect(listener).toHaveBeenNthCalledWith(2, null, "close");
  });

  it("drops notifications missing channel or companyId", () => {
    const bus = createPluginStreamBus();
    const publishSpy = vi.spyOn(bus, "publish");

    publishWorkerStreamNotification(bus, "p", "streams.emit", { companyId: "co", event: {} });
    publishWorkerStreamNotification(bus, "p", "streams.emit", { channel: "c", event: {} });

    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe("PluginWorkerManager stream handler wiring", () => {
  it("exposes a settable stream-notification handler (fixes the orphaned-bus case)", () => {
    // Regression guard for the wiring gap: the server must be able to attach the
    // stream handler to a manager it was handed (the production entrypoint
    // injects the manager), not only via the constructor. A manager that lacked
    // this setter would leave the SSE bus orphaned — opening connections that
    // never receive events instead of failing fast.
    const manager = createPluginWorkerManager();
    expect(typeof manager.setStreamNotificationHandler).toBe("function");
    // Setting and detaching must not throw.
    expect(() => manager.setStreamNotificationHandler(() => {})).not.toThrow();
    expect(() => manager.setStreamNotificationHandler(null)).not.toThrow();
  });
});
