import { describe, expect, it } from "vitest";
import { statusCardRefreshPolicySchema, statusCardSchema, statusCardUpdateSchema } from "./status-card.js";

describe.each([
  ["status card daily spend", statusCardSchema.pick({ todayCostCents: true }), "todayCostCents"],
  ["status card update spend", statusCardUpdateSchema.pick({ costCents: true }), "costCents"],
] as const)("%s", (_name, schema, field) => {
  it.each([0, 0.0000001, 0.1234567, 25, 4_000_000_000.125])("preserves valid cents: %s", (amount) => {
    expect(schema.parse({ [field]: amount })).toEqual({ [field]: amount });
  });

  it.each([-0.0000001, -1, NaN, Infinity, -Infinity, "0.1234567", null])("rejects invalid cents: %s", (amount) => {
    expect(schema.safeParse({ [field]: amount }).success).toBe(false);
  });
});

describe("statusCardRefreshPolicySchema", () => {
  it("accepts valid IANA timezones", () => {
    expect(statusCardRefreshPolicySchema.parse({
      mode: "interval",
      intervalMinutes: 15,
      activeHours: { start: "09:00", end: "17:00", timezone: "America/New_York" },
    }).activeHours?.timezone).toBe("America/New_York");
  });

  it("rejects invalid timezone identifiers", () => {
    const result = statusCardRefreshPolicySchema.safeParse({
      mode: "interval",
      intervalMinutes: 15,
      activeHours: { start: "09:00", end: "17:00", timezone: "Not/A_Timezone" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Invalid timezone identifier" })]));
    }
  });
});
