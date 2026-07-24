import { describe, expect, it } from "vitest";
import {
  COMPANY_SETTINGS_SURFACES,
  INSTANCE_SETTINGS_SURFACES,
  type CompanySettingsSurface,
} from "./constants.js";

describe("settings-surface taxonomy", () => {
  it("enumerates the company surfaces in canonical order", () => {
    expect(COMPANY_SETTINGS_SURFACES).toEqual([
      "company.general",
      "company.members",
      "company.invites",
      "company.secrets",
      "company.plugins",
    ]);
  });

  it("enumerates the instance surfaces in canonical order", () => {
    expect(INSTANCE_SETTINGS_SURFACES).toEqual([
      "instance.general",
      "instance.environments",
      "instance.access",
      "instance.heartbeats",
      "instance.experimental",
      "instance.plugins",
      "instance.adapters",
    ]);
  });

  it("keeps the namespaces disjoint and prefixed", () => {
    for (const surface of COMPANY_SETTINGS_SURFACES) {
      expect(surface.startsWith("company.")).toBe(true);
    }
    for (const surface of INSTANCE_SETTINGS_SURFACES) {
      expect(surface.startsWith("instance.")).toBe(true);
      expect(COMPANY_SETTINGS_SURFACES as readonly string[]).not.toContain(surface);
    }
  });

  it("type-checks CompanySettingsSurface as the element union", () => {
    const surface: CompanySettingsSurface = "company.members";
    expect(COMPANY_SETTINGS_SURFACES).toContain(surface);
  });
});
