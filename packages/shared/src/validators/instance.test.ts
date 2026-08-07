import { describe, expect, it } from "vitest";
import { instanceSsoSettingsSchema, patchInstanceSsoSettingsSchema } from "./instance.js";

describe("instanceSsoSettingsSchema", () => {
  it("parses the DB default '{}' as SSO disabled with no providers", () => {
    expect(instanceSsoSettingsSchema.parse({})).toEqual({
      enabled: false,
      providers: [],
    });
  });
});

describe("patchInstanceSsoSettingsSchema", () => {
  it("accepts an empty patch", () => {
    expect(patchInstanceSsoSettingsSchema.parse({})).toEqual({});
  });

  it("accepts a partial patch of just enabled", () => {
    expect(patchInstanceSsoSettingsSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
  });
});
