import { describe, expect, it } from "vitest";
import { COMPANY_SETTINGS_SURFACES } from "../constants.js";
import {
  instanceVisibilitySettingsSchema,
  patchInstanceVisibilitySettingsSchema,
} from "./instance.js";

describe("instance visibility validators", () => {
  it("defaults companySurfaces to ALL company surfaces (self-hoster parity)", () => {
    expect(instanceVisibilitySettingsSchema.parse({})).toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });
  });

  it("accepts an explicit subset", () => {
    expect(
      instanceVisibilitySettingsSchema.parse({
        companySurfaces: ["company.members", "company.general"],
      }),
    ).toEqual({ companySurfaces: ["company.members", "company.general"] });
  });

  it("accepts an explicit empty list (everything hidden)", () => {
    expect(instanceVisibilitySettingsSchema.parse({ companySurfaces: [] })).toEqual({
      companySurfaces: [],
    });
  });

  it("rejects unknown surfaces", () => {
    expect(
      instanceVisibilitySettingsSchema.safeParse({
        companySurfaces: ["company.members", "instance.general"],
      }).success,
    ).toBe(false);
    expect(
      instanceVisibilitySettingsSchema.safeParse({ companySurfaces: ["bogus"] }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      instanceVisibilitySettingsSchema.safeParse({ companySurfaces: [], extra: true }).success,
    ).toBe(false);
  });

  it("PATCH schema requires companySurfaces and is strict", () => {
    expect(patchInstanceVisibilitySettingsSchema.safeParse({}).success).toBe(false);
    expect(
      patchInstanceVisibilitySettingsSchema.parse({ companySurfaces: ["company.secrets"] }),
    ).toEqual({ companySurfaces: ["company.secrets"] });
  });
});
