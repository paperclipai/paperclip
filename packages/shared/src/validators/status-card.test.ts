import { describe, expect, it } from "vitest";
import { statusCardRefreshPolicySchema } from "./status-card.js";

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
