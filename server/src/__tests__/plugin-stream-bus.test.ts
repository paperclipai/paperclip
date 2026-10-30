import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createPluginStreamBus,
  publishWorkerStreamNotification,
} from "../services/plugin-stream-bus.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

const STREAM_WORKER_ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-streams.cjs",
);

const STREAM_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.stream-plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Stream test plugin",
  description: "Stream test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const STREAM_START_OPTIONS = {
  entrypointPath: STREAM_WORKER_ENTRYPOINT,
  manifest: STREAM_MANIFEST,
  config: {},
  instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
  apiVersion: 1 as const,
  hostHandlers: {},
};

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

  it("forwards a worker's stream notifications to the manager handler and on to the bus", async () => {
    const bus = createPluginStreamBus();
    const received: Array<{ event: unknown; eventType: string }> = [];
    bus.subscribe("test.stream-plugin", "chat", "co-1", (event, eventType) => {
      received.push({ event, eventType });
    });

    const manager = createPluginWorkerManager();
    manager.setStreamNotificationHandler((pluginId, method, params) =>
      publishWorkerStreamNotification(bus, pluginId, method, params),
    );
    try {
      await manager.startWorker("test.stream-plugin", STREAM_START_OPTIONS);
      await manager.call("test.stream-plugin", "emitStream", {
        channel: "chat",
        companyId: "co-1",
        event: { type: "text", text: "token" },
      });
    } finally {
      await manager.stopAll();
    }

    expect(received.map((entry) => entry.eventType)).toEqual(["open", "message", "close"]);
    expect(received[1]?.event).toEqual({ type: "text", text: "token" });
  });

  it("uses the handler that is set when the notification arrives, not at start", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const manager = createPluginWorkerManager();
    manager.setStreamNotificationHandler(first);
    try {
      await manager.startWorker("test.stream-plugin", STREAM_START_OPTIONS);
      manager.setStreamNotificationHandler(second);
      await manager.call("test.stream-plugin", "emitStream", {
        channel: "chat",
        companyId: "co-1",
        event: { n: 1 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(3);
    expect(second.mock.calls.map((call) => call[1])).toEqual([
      "streams.open",
      "streams.emit",
      "streams.close",
    ]);
    expect(second).toHaveBeenCalledWith("test.stream-plugin", "streams.emit", {
      channel: "chat",
      companyId: "co-1",
      event: { n: 1 },
    });
  });

  it("keeps a per-worker onStreamNotification instead of the manager handler", async () => {
    const managerHandler = vi.fn();
    const workerHandler = vi.fn();
    const manager = createPluginWorkerManager();
    manager.setStreamNotificationHandler(managerHandler);
    try {
      await manager.startWorker("test.stream-plugin", {
        ...STREAM_START_OPTIONS,
        onStreamNotification: workerHandler,
      });
      await manager.call("test.stream-plugin", "emitStream", {
        channel: "chat",
        companyId: "co-1",
        event: { n: 2 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(managerHandler).not.toHaveBeenCalled();
    expect(workerHandler).toHaveBeenCalledTimes(3);
    expect(workerHandler.mock.calls.map((call) => call[0])).toEqual([
      "streams.open",
      "streams.emit",
      "streams.close",
    ]);
  });

  it("forwards notifications from a manager built with the constructor option", async () => {
    const handler = vi.fn();
    const manager = createPluginWorkerManager({ onStreamNotification: handler });
    try {
      await manager.startWorker("test.stream-plugin", STREAM_START_OPTIONS);
      await manager.call("test.stream-plugin", "emitStream", {
        channel: "chat",
        companyId: "co-1",
        event: { n: 3 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe("PluginWorkerManager stream company binding", () => {
  it("drops a stream notification the host cannot bind to a company", async () => {
    const handler = vi.fn();
    const manager = createPluginWorkerManager({ onStreamNotification: handler });
    try {
      await manager.startWorker("test.stream-plugin", STREAM_START_OPTIONS);
      await manager.call("test.stream-plugin", "emitStreamProactively", {
        channel: "chat",
        targetCompanyId: "co-2",
        event: { n: 1 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers a proactive stream notification for a configured company", async () => {
    const handler = vi.fn();
    const manager = createPluginWorkerManager({ onStreamNotification: handler });
    try {
      await manager.startWorker("test.stream-plugin", {
        ...STREAM_START_OPTIONS,
        proactiveCompanyScopes: ["co-2"],
      });
      await manager.call("test.stream-plugin", "emitStreamProactively", {
        channel: "chat",
        targetCompanyId: "co-2",
        event: { n: 1 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(handler.mock.calls.map((call) => call[1])).toEqual([
      "streams.open",
      "streams.emit",
      "streams.close",
    ]);
    expect(handler).toHaveBeenCalledWith("test.stream-plugin", "streams.emit", {
      channel: "chat",
      companyId: "co-2",
      event: { n: 1 },
    });
  });

  it("drops a stream notification outside the live invocation's company", async () => {
    const handler = vi.fn();
    const manager = createPluginWorkerManager({ onStreamNotification: handler });
    try {
      await manager.startWorker("test.stream-plugin", STREAM_START_OPTIONS);
      await manager.call("test.stream-plugin", "emitStream", {
        channel: "chat",
        companyId: "co-1",
        streamCompanyId: "co-2",
        event: { n: 2 },
      });
    } finally {
      await manager.stopAll();
    }

    expect(handler).not.toHaveBeenCalled();
  });
});
