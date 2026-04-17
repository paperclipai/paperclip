import { describe, expect, it } from "vitest";
import { calendarDateKey } from "./utils";

describe("calendarDateKey", () => {
  it("can resolve a report date in an explicit timezone", () => {
    const now = new Date("2026-04-16T15:30:00Z");

    expect(calendarDateKey(now, "UTC")).toBe("2026-04-16");
    expect(calendarDateKey(now, "Asia/Seoul")).toBe("2026-04-17");
  });

  it("formats a local calendar date key without using UTC conversion", () => {
    const now = new Date(2026, 3, 17, 0, 30, 0);

    expect(calendarDateKey(now)).toBe("2026-04-17");
  });
});
