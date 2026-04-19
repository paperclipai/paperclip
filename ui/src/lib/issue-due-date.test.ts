import { describe, expect, it } from "vitest";
import {
  formatLocalDateOnly,
  getIssueDueState,
  isValidDateOnly,
} from "./issue-due-date";

describe("issue due date helpers", () => {
  it("classifies active issue due dates relative to a fixed local day", () => {
    expect(getIssueDueState("2026-04-17", "todo", "2026-04-18")).toBe("overdue");
    expect(getIssueDueState("2026-04-18", "in_progress", "2026-04-18")).toBe("today");
    expect(getIssueDueState("2026-04-19", "blocked", "2026-04-18")).toBe("upcoming");
    expect(getIssueDueState(null, "todo", "2026-04-18")).toBe("none");
  });

  it("keeps terminal issues neutral even when the date is past", () => {
    expect(getIssueDueState("2026-04-17", "done", "2026-04-18")).toBe("neutral");
    expect(getIssueDueState("2026-04-17", "cancelled", "2026-04-18")).toBe("neutral");
  });

  it("validates date-only strings and formats local today without UTC conversion", () => {
    expect(isValidDateOnly("2026-02-28")).toBe(true);
    expect(isValidDateOnly("2026-02-30")).toBe(false);
    expect(isValidDateOnly("2026-02-28T00:00:00.000Z")).toBe(false);
    expect(formatLocalDateOnly(new Date(2026, 3, 5, 23, 59))).toBe("2026-04-05");
  });
});
