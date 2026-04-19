import { describe, expect, it } from "vitest";
import {
  addDays,
  firstOfMonth,
  monthGrid,
  taskDateRange,
  visibleMonthRange,
} from "./issue-date-ranges";

describe("issue date ranges", () => {
  it("builds today, tomorrow, and next 7 day filters", () => {
    expect(taskDateRange("today", "2026-04-19")).toEqual({ dueDate: "2026-04-19" });
    expect(taskDateRange("tomorrow", "2026-04-19")).toEqual({ dueDate: "2026-04-20" });
    expect(taskDateRange("next7", "2026-04-19")).toEqual({
      dueFrom: "2026-04-19",
      dueTo: "2026-04-25",
    });
  });

  it("handles local date math across month boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(firstOfMonth("2026-04-19")).toBe("2026-04-01");
  });

  it("starts month grids on Sunday and includes trailing days", () => {
    const grid = monthGrid("2026-04-01", "2026-04-19");

    expect(grid[0]?.date).toBe("2026-03-29");
    expect(grid[0]?.inCurrentMonth).toBe(false);
    expect(grid[3]?.date).toBe("2026-04-01");
    expect(grid.at(-1)?.date).toBe("2026-05-02");
    expect(grid.find((day) => day.date === "2026-04-19")?.isToday).toBe(true);
  });

  it("reports the visible query range for a month", () => {
    expect(visibleMonthRange("2026-04-19", "2026-04-19")).toEqual({
      from: "2026-03-29",
      to: "2026-05-02",
    });
  });
});
