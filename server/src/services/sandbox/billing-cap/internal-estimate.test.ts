import { describe, expect, it } from "vitest";
import { summariseLeaseSpend } from "./internal-estimate.js";

describe("Source B internal estimate", () => {
  const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
  it("counts only overlap with the day window for past-day leases", () => {
    const sample = summariseLeaseSpend({
      leases: [
        {
          acquiredAt: new Date(Date.UTC(2026, 4, 16, 23, 0, 0)),
          releasedAt: new Date(Date.UTC(2026, 4, 17, 1, 0, 0)),
        },
      ],
      now,
      ratePerSecondCents: 0.01,
    });
    expect(sample.dayRuntimeSeconds).toBe(3600);
    expect(sample.dayCents).toBe(36);
    // Both days fall in the same month, so month accumulator gets full 2h.
    expect(sample.monthRuntimeSeconds).toBe(7200);
    expect(sample.monthCents).toBe(72);
  });
  it("treats active leases (releasedAt=null) as running until now", () => {
    const sample = summariseLeaseSpend({
      leases: [
        {
          acquiredAt: new Date(Date.UTC(2026, 4, 17, 11, 0, 0)),
          releasedAt: null,
        },
      ],
      now,
      ratePerSecondCents: 0.01,
    });
    expect(sample.dayRuntimeSeconds).toBe(3600);
    expect(sample.dayCents).toBe(36);
  });
  it("returns zero for leases fully outside the month window", () => {
    const sample = summariseLeaseSpend({
      leases: [
        {
          acquiredAt: new Date(Date.UTC(2026, 3, 1)),
          releasedAt: new Date(Date.UTC(2026, 3, 30)),
        },
      ],
      now,
      ratePerSecondCents: 0.01,
    });
    expect(sample.dayCents).toBe(0);
    expect(sample.monthCents).toBe(0);
  });
});
