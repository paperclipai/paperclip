import { describe, it, expect } from "vitest";
import { PLUGIN_EVENT_TYPES } from "./constants.js";
import type { PluginEventType } from "./constants.js";

describe("PLUGIN_EVENT_TYPES — WS-3 lifecycle events", () => {
  it("includes plugin.installed", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.installed");
  });

  it("includes plugin.uninstalled", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.uninstalled");
  });

  it("includes plugin.enabled", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.enabled");
  });

  it("includes plugin.disabled", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.disabled");
  });

  it("PluginEventType union accepts plugin.installed literal", () => {
    const t: PluginEventType = "plugin.installed";
    expect(t).toBe("plugin.installed");
  });

  it("PluginEventType union accepts plugin.uninstalled literal", () => {
    const t: PluginEventType = "plugin.uninstalled";
    expect(t).toBe("plugin.uninstalled");
  });

  it("PluginEventType union accepts plugin.enabled literal", () => {
    const t: PluginEventType = "plugin.enabled";
    expect(t).toBe("plugin.enabled");
  });

  it("PluginEventType union accepts plugin.disabled literal", () => {
    const t: PluginEventType = "plugin.disabled";
    expect(t).toBe("plugin.disabled");
  });
});
