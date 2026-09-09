import { describe, expect, it, vi } from "vitest";
import {
  createPluginStreamBus,
  createPluginStreamNotificationHandler,
} from "../services/plugin-stream-bus.js";

describe("plugin worker stream publication", () => {
  it("fans out a manifest-addressed worker emit on the installed plugin record key", () => {
    const installedPluginId = "7c4e9157-5d59-47bf-a11a-0123456789ab";
    const manifestPluginId = "zenfire.event-bridge";
    const companyId = "company-a";
    const event = { eventId: "evt-1", type: "issue.updated" };
    const listener = vi.fn();
    const streamBus = createPluginStreamBus();

    streamBus.subscribe(installedPluginId, "board-events", companyId, listener);
    const handleNotification = createPluginStreamNotificationHandler(installedPluginId, streamBus);

    handleNotification("streams.emit", {
      pluginId: manifestPluginId,
      channel: "board-events",
      companyId,
      event,
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event, "message");
  });
});
