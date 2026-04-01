import { describe, expect, it } from "vitest";
import { formatSeatPauseReason, formatSeatPauseReasons } from "./seat-pause";

describe("seat pause formatting", () => {
  it("formats a single pause reason label", () => {
    expect(formatSeatPauseReason("budget_enforcement")).toBe("Budget enforcement");
  });

  it("formats multiple pause reasons", () => {
    expect(formatSeatPauseReasons(["manual_admin", "budget_enforcement"])).toBe(
      "Manual admin, Budget enforcement",
    );
  });

  it("returns none when no pause reasons are present", () => {
    expect(formatSeatPauseReasons([])).toBe("none");
  });
});
