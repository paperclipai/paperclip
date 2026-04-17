import { describe, expect, it } from "vitest";
import { formatDayKeyForTimeZone, getLast14Days } from "./activity-chart-days";

describe("formatDayKeyForTimeZone", () => {
  it("uses the viewer timezone instead of UTC when grouping dashboard data", () => {
    expect(formatDayKeyForTimeZone("2026-04-10T17:24:00Z", "UTC")).toBe("2026-04-10");
    expect(formatDayKeyForTimeZone("2026-04-10T17:24:00Z", "Asia/Seoul")).toBe("2026-04-11");
  });
});

describe("getLast14Days", () => {
  it("ends the dashboard window on the viewer's local calendar day", () => {
    expect(getLast14Days(new Date("2026-04-10T17:24:00Z"), "Asia/Seoul")).toEqual([
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04",
      "2026-04-05",
      "2026-04-06",
      "2026-04-07",
      "2026-04-08",
      "2026-04-09",
      "2026-04-10",
      "2026-04-11",
    ]);
  });
});
