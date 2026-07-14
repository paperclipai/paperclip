import { describe, expect, it } from "vitest";
import type { PluginRecord, PluginStatus } from "@paperclipai/shared";

import {
  eePluginPageLink,
  eePluginSettingsLink,
  findEePlugin,
  PAPERCLIP_EE_PLUGIN_KEY,
  resolveEeAvailability,
  resolveEeSkillPolicyState,
} from "./ee-skill-policy";

function eePlugin(status: PluginStatus, over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "ee-uuid",
    pluginKey: PAPERCLIP_EE_PLUGIN_KEY,
    packageName: "@paperclipai/plugin-paperclip-ee",
    version: "0.1.0",
    apiVersion: 1,
    categories: [],
    manifestJson: {} as PluginRecord["manifestJson"],
    status,
    installOrder: 0,
    packagePath: null,
    lastError: null,
    installedAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe("findEePlugin", () => {
  it("returns null when the list is empty or EE is absent", () => {
    expect(findEePlugin(undefined)).toBeNull();
    expect(findEePlugin([])).toBeNull();
    expect(findEePlugin([eePlugin("ready", { pluginKey: "other.plugin" })])).toBeNull();
  });

  it("finds the EE plugin by its stable key", () => {
    expect(findEePlugin([eePlugin("ready")])?.pluginKey).toBe(PAPERCLIP_EE_PLUGIN_KEY);
  });
});

describe("resolveEeAvailability", () => {
  it("maps absent → absent", () => {
    expect(resolveEeAvailability(null)).toBe("absent");
    expect(resolveEeAvailability(eePlugin("uninstalled"))).toBe("absent");
  });
  it("maps ready/installed → enabled", () => {
    expect(resolveEeAvailability(eePlugin("ready"))).toBe("enabled");
    expect(resolveEeAvailability(eePlugin("installed"))).toBe("enabled");
  });
  it("maps disabled → disabled", () => {
    expect(resolveEeAvailability(eePlugin("disabled"))).toBe("disabled");
  });
  it("maps error/upgrade_pending → error", () => {
    expect(resolveEeAvailability(eePlugin("error"))).toBe("error");
    expect(resolveEeAvailability(eePlugin("upgrade_pending"))).toBe("error");
  });
});

describe("resolveEeSkillPolicyState", () => {
  it("bundles availability with the resolved plugin", () => {
    const state = resolveEeSkillPolicyState([eePlugin("disabled")]);
    expect(state.availability).toBe("disabled");
    expect(state.plugin?.pluginKey).toBe(PAPERCLIP_EE_PLUGIN_KEY);
  });
});

describe("eePluginPageLink", () => {
  it("returns null without a plugin or prefix", () => {
    expect(eePluginPageLink(null, "ACME")).toBeNull();
    expect(eePluginPageLink(eePlugin("ready"), null)).toBeNull();
  });
  it("builds the /:companyPrefix/plugins/:pluginId route", () => {
    expect(eePluginPageLink(eePlugin("ready"), "ACME")).toBe("/ACME/plugins/ee-uuid");
  });
});

describe("eePluginSettingsLink", () => {
  it("routes to instance plugin settings by key", () => {
    expect(eePluginSettingsLink(eePlugin("disabled"))).toBe(
      "/company/settings/instance/plugins/paperclipai.paperclip-ee",
    );
  });
});
