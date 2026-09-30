import { describe, expect, it } from "vitest";
import { DEFAULT_QUOTA_PACING_SETTINGS } from "../types/quota-pacing.js";
import {
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  patchQuotaPacingSettingsSchema,
  quotaPacingSettingsSchema,
} from "./instance.js";

describe("quota pacing settings schema", () => {
  it("defaults to pacing off in auto mode", () => {
    expect(quotaPacingSettingsSchema.parse({})).toEqual({
      enabled: false,
      mode: "auto",
      sessionReservePercent: 20,
      weeklyAllowancePercent: 8,
      pollIntervalSec: 300,
    });
    expect(quotaPacingSettingsSchema.parse({})).toEqual(DEFAULT_QUOTA_PACING_SETTINGS);
  });

  it("gives general settings the pacing defaults when the stored row has none", () => {
    expect(instanceGeneralSettingsSchema.parse({}).quotaPacing).toEqual(DEFAULT_QUOTA_PACING_SETTINGS);
  });

  it.each([
    ["auto"],
    ["full"],
    ["half"],
    ["low"],
  ])("accepts mode %s", (mode) => {
    expect(quotaPacingSettingsSchema.safeParse({ mode }).success).toBe(true);
  });

  it.each([
    ["an unknown mode", { mode: "turbo" }],
    ["a negative session reserve", { sessionReservePercent: -1 }],
    ["a session reserve above 60", { sessionReservePercent: 61 }],
    ["a fractional session reserve", { sessionReservePercent: 12.5 }],
    ["a negative weekly allowance", { weeklyAllowancePercent: -1 }],
    ["a weekly allowance above 30", { weeklyAllowancePercent: 31 }],
    ["a poll interval under 5 minutes", { pollIntervalSec: 299 }],
    ["a poll interval above 1 hour", { pollIntervalSec: 3601 }],
    ["a non-boolean enabled flag", { enabled: "yes" }],
  ])("rejects %s", (_label, value) => {
    expect(quotaPacingSettingsSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the range limits", () => {
    expect(
      quotaPacingSettingsSchema.safeParse({
        sessionReservePercent: 60,
        weeklyAllowancePercent: 30,
        pollIntervalSec: 3600,
      }).success,
    ).toBe(true);
    expect(
      quotaPacingSettingsSchema.safeParse({
        sessionReservePercent: 0,
        weeklyAllowancePercent: 0,
        pollIntervalSec: 300,
      }).success,
    ).toBe(true);
  });
});

describe("quota pacing patch schema", () => {
  it("keeps only the keys the caller sends", () => {
    expect(patchQuotaPacingSettingsSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(patchInstanceGeneralSettingsSchema.parse({ quotaPacing: { mode: "low" } })).toEqual({
      quotaPacing: { mode: "low" },
    });
  });

  it("rejects unknown pacing keys", () => {
    expect(patchQuotaPacingSettingsSchema.safeParse({ maxRuns: 2 }).success).toBe(false);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ quotaPacing: { enabled: true, maxRuns: 2 } }).success,
    ).toBe(false);
  });

  it("applies the same bounds as the stored settings", () => {
    expect(patchQuotaPacingSettingsSchema.safeParse({ pollIntervalSec: 60 }).success).toBe(false);
    expect(patchQuotaPacingSettingsSchema.safeParse({ sessionReservePercent: 70 }).success).toBe(false);
  });

  it("leaves pacing absent from a patch that does not send it", () => {
    expect(patchInstanceGeneralSettingsSchema.parse({ censorUsernameInLogs: true })).toEqual({
      censorUsernameInLogs: true,
    });
  });
});
