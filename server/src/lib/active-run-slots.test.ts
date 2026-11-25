import { describe, expect, it } from "vitest";
import { assertActiveRunSlotBounds, slotsForActiveRuns } from "./active-run-slots.js";

describe("slotsForActiveRuns", () => {
  const bounds = assertActiveRunSlotBounds({ runsPerSlot: 10, floor: 4, ceiling: 21 });

  it("keeps the floor while few runs are active", () => {
    expect(slotsForActiveRuns(0, bounds)).toBe(4);
    expect(slotsForActiveRuns(40, bounds)).toBe(4);
  });

  it("adds a slot for each started group of active runs", () => {
    expect(slotsForActiveRuns(41, bounds)).toBe(5);
    expect(slotsForActiveRuns(200, bounds)).toBe(20);
  });

  it("never passes the ceiling", () => {
    expect(slotsForActiveRuns(201, bounds)).toBe(21);
    expect(slotsForActiveRuns(1_000, bounds)).toBe(21);
    expect(slotsForActiveRuns(Number.MAX_SAFE_INTEGER, bounds)).toBe(21);
  });

  it("treats an invalid run count as no active runs", () => {
    expect(slotsForActiveRuns(-5, bounds)).toBe(4);
    expect(slotsForActiveRuns(Number.NaN, bounds)).toBe(4);
  });

  it("rejects bounds whose ceiling is below the floor", () => {
    expect(() => assertActiveRunSlotBounds({ runsPerSlot: 10, floor: 5, ceiling: 4 })).toThrow("invalid_active_run_slot_bounds");
    expect(() => assertActiveRunSlotBounds({ runsPerSlot: 0, floor: 1, ceiling: 4 })).toThrow("invalid_active_run_slot_bounds");
  });
});
