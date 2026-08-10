import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "./instance-settings";

describe("normalizeRememberedInstanceSettingsPath", () => {
  it("canonicalizes known instance settings pages under company settings", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/general")).toBe(
      "/company/settings/instance/general",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/experimental")).toBe(
      "/company/settings/instance/experimental",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/environments")).toBe(
      "/company/settings/instance/environments",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/plugins/example?tab=config#logs")).toBe(
      "/company/settings/instance/plugins/example?tab=config#logs",
    );
    expect(normalizeRememberedInstanceSettingsPath("/PAP/company/settings/instance/adapters")).toBe(
      "/company/settings/instance/adapters",
    );
    expect(normalizeRememberedInstanceSettingsPath("/company/settings/instance/general")).toBe(
      "/company/settings/instance/general",
    );
    expect(normalizeRememberedInstanceSettingsPath("/company/settings/instance/plugins/example?tab=config#logs")).toBe(
      "/company/settings/instance/plugins/example?tab=config#logs",
    );
    expect(normalizeRememberedInstanceSettingsPath("/company/settings/environments")).toBe(
      "/company/settings/instance/environments",
    );
    expect(normalizeRememberedInstanceSettingsPath("/settings/access?tab=users#admins")).toBe(
      "/company/settings/instance/access?tab=users#admins",
    );
    expect(normalizeRememberedInstanceSettingsPath("/PAP/settings/plugins/example")).toBe(
      "/company/settings/instance/plugins/example",
    );
  });

  it("falls back to the default page for unknown paths", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/nope")).toBe(
      DEFAULT_INSTANCE_SETTINGS_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath(null)).toBe(DEFAULT_INSTANCE_SETTINGS_PATH);
  });
});
