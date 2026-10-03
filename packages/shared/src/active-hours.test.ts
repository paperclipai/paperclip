import { describe, expect, it } from "vitest";
import {
  activeHoursWindowSchema,
  isValidTimeZone,
  isWithinActiveHours,
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
