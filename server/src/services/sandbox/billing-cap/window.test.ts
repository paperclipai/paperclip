import { describe, expect, it } from "vitest";
import { isSameUtcDay, isSameUtcMonth, utcDayBounds, utcMonthBounds } from "./window.js";

describe("billing-cap UTC windows", () => {
  it("returns midnight-to-midnight day bounds", () => {
    const at = new Date(Date.UTC(2026, 4, 17, 13, 22, 11));
    const { start, end } = utcDayBounds(at);
    expect(start.toISOString()).toBe("2026-05-17T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-18T00:00:00.000Z");
  });
  it("returns first-of-month-to-first-of-next-month bounds", () => {
    const at = new Date(Date.UTC(2026, 4, 17));
    const { start, end } = utcMonthBounds(at);
    expect(start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
  it("rolls month bounds across December", () => {
    const at = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    const { start, end } = utcMonthBounds(at);
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("isSameUtcDay distinguishes adjacent UTC days", () => {
    const a = new Date(Date.UTC(2026, 4, 17, 23, 59, 59));
    const b = new Date(Date.UTC(2026, 4, 18, 0, 0, 0));
    expect(isSameUtcDay(a, b)).toBe(false);
  });
  it("isSameUtcMonth treats first-of-month and last-of-month-1 as different", () => {
    const a = new Date(Date.UTC(2026, 4, 31));
    const b = new Date(Date.UTC(2026, 5, 1));
    expect(isSameUtcMonth(a, b)).toBe(false);
  });
});
