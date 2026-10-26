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

  it("drops a notification whose channel or companyId is not a string", () => {
    const bus = createPluginStreamBus();
    const publishSpy = vi.spyOn(bus, "publish");

    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: 7,
      companyId: "co",
      event: {},
    });
    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "c",
      companyId: { id: "co" },
      event: {},
    });

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("never reaches a subscriber on another company", () => {
    const bus = createPluginStreamBus();
    const mine = vi.fn();
    const theirs = vi.fn();
    bus.subscribe("p", "c", "co-1", mine);
    bus.subscribe("p", "c", "co-2", theirs);

    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "c",
      companyId: "co-1",
      event: { type: "text" },
    });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it("never reaches a subscriber on another channel", () => {
    const bus = createPluginStreamBus();
    const mine = vi.fn();
    const theirs = vi.fn();
    bus.subscribe("p", "c", "co", mine);
    bus.subscribe("p", "other", "co", theirs);

    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "c",
      companyId: "co",
      event: { type: "text" },
    });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });
});

describe("PluginWorkerManager stream handler wiring", () => {
  it("exposes a settable stream-notification handler", () => {
    const manager = createPluginWorkerManager();
    expect(typeof manager.setStreamNotificationHandler).toBe("function");
    expect(() => manager.setStreamNotificationHandler(() => {})).not.toThrow();
    expect(() => manager.setStreamNotificationHandler(null)).not.toThrow();
  });
});
