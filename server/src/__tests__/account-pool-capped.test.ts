import { describe, it, expect } from "vitest";
import { isSnapshotCappedNow } from "../services/account-pool.js";
import type { PoolAccountHealthSnapshot } from "../services/account-pool.js";

function snap(partial: Partial<PoolAccountHealthSnapshot>): PoolAccountHealthSnapshot {
  return {
    usedPercent: null,
    resetsAt: null,
    capped: false,
    windows: [],
    checkedAt: "",
    error: null,
    erroredAt: null,
    email: null,
    subscriptionType: null,
    ...partial,
  };
}

describe("isSnapshotCappedNow (reactive-rotation candidate skipping)", () => {
  const now = new Date("2026-06-04T12:00:00Z");

  it("null snapshot → not capped (eligible)", () => {
    expect(isSnapshotCappedNow(null, now)).toBe(false);
  });

  it("not capped → eligible", () => {
    expect(isSnapshotCappedNow(snap({ capped: false }), now)).toBe(false);
  });

  it("capped with a FUTURE reset → still capped (skip it)", () => {
    expect(isSnapshotCappedNow(snap({ capped: true, resetsAt: "2026-06-04T13:00:00Z" }), now)).toBe(true);
  });

  it("capped with a PAST reset → eligible again (limit cleared)", () => {
    expect(isSnapshotCappedNow(snap({ capped: true, resetsAt: "2026-06-04T11:00:00Z" }), now)).toBe(false);
  });

  it("capped with no/invalid reset time → treat as capped", () => {
    expect(isSnapshotCappedNow(snap({ capped: true, resetsAt: null }), now)).toBe(true);
    expect(isSnapshotCappedNow(snap({ capped: true, resetsAt: "not-a-date" }), now)).toBe(true);
  });
});
