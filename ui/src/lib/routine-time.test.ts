import { describe, expect, it } from "vitest";
import { formatRoutineTime } from "./routine-time";

describe("formatRoutineTime", () => {
  it("renders a scheduled instant in the trigger timezone", () => {
    expect(
      formatRoutineTime(
        "2026-07-20T06:15:00.000Z",
        "Europe/Zurich",
        { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
      ),
    ).toBe("08:15");
  });

  it("falls back safely for an invalid timezone", () => {
    expect(formatRoutineTime("2026-07-20T06:15:00.000Z", "Not/AZone")).toBeTruthy();
  });
});
