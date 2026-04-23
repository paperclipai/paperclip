import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  updateCompanySchema,
  supportedLocaleSchema,
} from "./index.js";

describe("localization contracts", () => {
  it("defaults the instance locale to english", () => {
    expect(instanceGeneralSettingsSchema.parse({}).locale).toBe("en");
  });

  it("accepts null company overrides and rejects unsupported locales", () => {
    expect(updateCompanySchema.parse({ localeOverride: null }).localeOverride).toBeNull();
    expect(() => supportedLocaleSchema.parse("fr")).toThrow(/Invalid enum value/);
  });
});
