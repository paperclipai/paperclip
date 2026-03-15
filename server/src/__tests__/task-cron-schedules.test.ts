import { describe, expect, it } from "vitest";
import { computeNextCronTrigger } from "../services/task-cron-schedules.js";

describe("computeNextCronTrigger", () => {
  it("computes the next trigger in UTC", () => {
    const from = new Date("2026-03-15T10:42:00.000Z");
    const next = computeNextCronTrigger({
      expression: "*/15 * * * *",
      timezone: "UTC",
      from,
    });
    expect(next.toISOString()).toBe("2026-03-15T10:45:00.000Z");
  });

  it("supports non-UTC timezones", () => {
    const from = new Date("2026-03-15T16:20:00.000Z");
    const next = computeNextCronTrigger({
      expression: "0 9 * * *",
      timezone: "America/New_York",
      from,
    });
    // 9:00 AM America/New_York (EDT) on this date is 13:00 UTC.
    expect(next.toISOString()).toBe("2026-03-16T13:00:00.000Z");
  });

  it("falls back to UTC for invalid timezones", () => {
    const from = new Date("2026-03-15T10:42:00.000Z");
    const next = computeNextCronTrigger({
      expression: "*/15 * * * *",
      timezone: "Invalid/Timezone",
      from,
    });
    expect(next.toISOString()).toBe("2026-03-15T10:45:00.000Z");
  });

  it("throws for invalid cron expressions", () => {
    expect(() =>
      computeNextCronTrigger({
        expression: "not-a-cron",
        timezone: "UTC",
        from: new Date("2026-03-15T10:42:00.000Z"),
      }),
    ).toThrow();
  });
});
