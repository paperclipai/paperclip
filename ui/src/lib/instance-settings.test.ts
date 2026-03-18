import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "./instance-settings";

describe("normalizeRememberedInstanceSettingsPath", () => {
  it("keeps known instance settings pages", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/experimental")).toBe(
      "/instance/settings/experimental",
    );
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/plugins/example?tab=config#logs")).toBe(
      "/instance/settings/plugins/example?tab=config#logs",
    );
  });

  it("falls back to the default page for unknown paths", () => {
    expect(normalizeRememberedInstanceSettingsPath("/instance/settings/nope")).toBe(
      DEFAULT_INSTANCE_SETTINGS_PATH,
    );
    expect(normalizeRememberedInstanceSettingsPath(null)).toBe(DEFAULT_INSTANCE_SETTINGS_PATH);
  });
});
