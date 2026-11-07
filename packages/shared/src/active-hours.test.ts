import { describe, expect, it, vi } from "vitest";
import {
  activeHoursWindowSchema,
  isValidTimeZone,
  isWithinActiveHours,
  nextActiveHoursStart,
  parseHmToMinutes,
} from "./active-hours.js";

const nyHours = {
  start: "09:00",
  end: "18:00",
  timezone: "America/New_York",
} as const;

describe("active hours", () => {
  it("treats an omitted window as always inside", () => {
    const now = new Date("2026-07-15T03:00:00.000Z");
    expect(isWithinActiveHours(undefined, now)).toBe(true);
    expect(isWithinActiveHours(null, now)).toBe(true);
  });

  it("is inside the window, before start, and at/after end in America/New_York", () => {
    // 09:00 EDT (UTC-4) on 2026-07-15.
    expect(isWithinActiveHours(nyHours, new Date("2026-07-15T13:00:00.000Z"))).toBe(true);
    // 08:59 EDT.
    expect(isWithinActiveHours(nyHours, new Date("2026-07-15T12:59:00.000Z"))).toBe(false);
    // 17:59 EDT.
    expect(isWithinActiveHours(nyHours, new Date("2026-07-15T21:59:00.000Z"))).toBe(true);
    // 18:00 EDT is exclusive.
    expect(isWithinActiveHours(nyHours, new Date("2026-07-15T22:00:00.000Z"))).toBe(false);
  });

  it("wraps overnight windows across midnight", () => {
    const overnight = { start: "22:00", end: "06:00", timezone: "UTC" };
    expect(isWithinActiveHours(overnight, new Date("2026-07-15T22:00:00.000Z"))).toBe(true);
    expect(isWithinActiveHours(overnight, new Date("2026-07-15T23:30:00.000Z"))).toBe(true);
    expect(isWithinActiveHours(overnight, new Date("2026-07-16T05:59:00.000Z"))).toBe(true);
    expect(isWithinActiveHours(overnight, new Date("2026-07-16T06:00:00.000Z"))).toBe(false);
    expect(isWithinActiveHours(overnight, new Date("2026-07-15T21:59:00.000Z"))).toBe(false);
  });

  it("uses the IANA timezone so DST offsets stay correct", () => {
    // 09:00 EST (UTC-5) in January is inside 09:00–18:00 New York.
    expect(isWithinActiveHours(nyHours, new Date("2026-01-15T14:00:00.000Z"))).toBe(true);
    // 08:59 EST is still before start.
    expect(isWithinActiveHours(nyHours, new Date("2026-01-15T13:59:00.000Z"))).toBe(false);
    // 09:00 EDT (UTC-4) in July is the same wall-clock start.
    expect(isWithinActiveHours(nyHours, new Date("2026-07-15T13:00:00.000Z"))).toBe(true);
  });

  it("parses HH:MM into minutes and rejects invalid clock strings", () => {
    expect(parseHmToMinutes("00:00")).toBe(0);
    expect(parseHmToMinutes("09:00")).toBe(540);
    expect(parseHmToMinutes("23:59")).toBe(23 * 60 + 59);
    expect(parseHmToMinutes("24:00")).toBeNull();
    expect(parseHmToMinutes("9:00")).toBeNull();
    expect(parseHmToMinutes("09:60")).toBeNull();
  });

  it("rejects an invalid timezone on the schema", () => {
    const result = activeHoursWindowSchema.safeParse({
      start: "09:00",
      end: "18:00",
      timezone: "Not/A_Timezone",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: "Invalid timezone identifier" })]),
      );
    }
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/A_Timezone")).toBe(false);
  });
});

describe("nextActiveHoursStart", () => {
  const window = { start: "09:00", end: "18:00", timezone: "UTC" };

  it("returns the next opening when outside the window", () => {
    expect(nextActiveHoursStart(window, new Date("2026-07-15T22:00:00.000Z"))?.toISOString())
      .toBe("2026-07-16T09:00:00.000Z");
  });

  it("returns the rounded-up minute when already inside the window", () => {
    expect(nextActiveHoursStart(window, new Date("2026-07-15T12:00:30.000Z"))?.toISOString())
      .toBe("2026-07-15T12:01:00.000Z");
  });

  it("returns null for a window that never opens", () => {
    expect(nextActiveHoursStart({ start: "09:00", end: "09:00", timezone: "UTC" }, new Date("2026-07-15T12:00:00.000Z")))
      .toBeNull();
  });

  it("does not format any time for a window that never opens", () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      nextActiveHoursStart({ start: "09:00", end: "09:00", timezone: "UTC" }, new Date("2026-07-15T12:00:00.000Z"));
      expect(formatToParts).not.toHaveBeenCalled();
    } finally {
      formatToParts.mockRestore();
    }
  });

  it("checks a closed window only at its ends when no clock change falls in the wait", () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      nextActiveHoursStart(window, new Date("2026-07-15T18:00:00.000Z"));
      expect(formatToParts).toHaveBeenCalledTimes(2);
    } finally {
      formatToParts.mockRestore();
    }
  });

  it("finds a window that reopens when the clock moves back", () => {
    // 01:20 EDT, 40 minutes before New York repeats 01:00 to 02:00.
    const hours = { start: "00:00", end: "01:15", timezone: "America/New_York" };
    expect(nextActiveHoursStart(hours, new Date("2026-11-01T05:20:00.000Z"))?.toISOString())
      .toBe("2026-11-01T06:00:00.000Z");
  });

  it("reuses one formatter per timezone", () => {
    const zone = { start: "09:00", end: "18:00", timezone: "Asia/Kathmandu" };
    const DateTimeFormat = vi.spyOn(Intl, "DateTimeFormat");
    try {
      nextActiveHoursStart(zone, new Date("2026-07-15T18:00:00.000Z"));
      isWithinActiveHours(zone, new Date("2026-07-15T18:00:00.000Z"));
      expect(DateTimeFormat).toHaveBeenCalledTimes(1);
    } finally {
      DateTimeFormat.mockRestore();
    }
  });

  it("matches a minute-by-minute scan around clock changes", () => {
    const scan = (hours: { start: string; end: string; timezone: string }, from: Date) => {
      const first = Math.ceil(from.getTime() / 60_000) * 60_000;
      for (let offset = 0; offset <= 2 * 24 * 60; offset += 1) {
        const candidate = new Date(first + offset * 60_000);
        if (isWithinActiveHours(hours, candidate)) return candidate.toISOString();
      }
      return null;
    };
    const spans = [
      ["00:00", "01:15"],
      ["01:30", "02:15"],
      ["02:15", "02:45"],
      ["03:30", "06:00"],
      ["22:00", "06:00"],
    ];
    const zones = {
      "America/New_York": ["2026-03-08T07:00:00.000Z", "2026-11-01T06:00:00.000Z"],
      "Europe/Berlin": ["2026-03-29T01:00:00.000Z", "2026-10-25T01:00:00.000Z"],
      "Australia/Lord_Howe": ["2026-04-04T15:00:00.000Z", "2026-10-03T15:30:00.000Z"],
      "Antarctica/Troll": ["2026-03-29T01:00:00.000Z", "2026-10-25T01:00:00.000Z"],
    };
    for (const [timezone, changes] of Object.entries(zones)) {
      for (const change of changes) {
        for (const [start, end] of spans) {
          const hours = { start, end, timezone };
          for (let minutes = -26 * 60; minutes <= 3 * 60; minutes += 40) {
            const from = new Date(new Date(change).getTime() + minutes * 60_000 + 17_000);
            expect(nextActiveHoursStart(hours, from)?.toISOString() ?? null).toBe(scan(hours, from));
          }
        }
      }
    }
  }, 30_000);
});
