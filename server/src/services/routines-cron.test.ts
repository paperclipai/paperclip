import { afterEach, describe, expect, it, vi } from "vitest";
import { getZonedMinuteParts, nextCronTickInTimeZone } from "./routines.js";

describe("nextCronTickInTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the next UTC midnight for a midnight cron", () => {
    const next = nextCronTickInTimeZone("0 0 * * *", "UTC", new Date("2026-06-10T12:30:45Z"));
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("normalizes hour 24 from h24-cycle locale data so midnight crons still fire", () => {
    // Some ICU versions resolve `hour12: false` to the h24 cycle and format
    // midnight as "24"; simulate that so the regression is covered everywhere.
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      date,
    ) {
      return original.call(this, date).map((part) =>
        part.type === "hour" && Number(part.value) === 0 ? { ...part, value: "24" } : part,
      );
    });

    expect(getZonedMinuteParts(new Date("2026-06-11T00:05:00Z"), "UTC").hour).toBe(0);

    const next = nextCronTickInTimeZone("0 0 * * *", "UTC", new Date("2026-06-10T12:30:45Z"));
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });
});
