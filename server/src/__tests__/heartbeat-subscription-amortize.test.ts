import { describe, expect, it } from "vitest";

/**
 * Tests for the per-run amortization logic used in heartbeat.ts updateRuntimeState.
 *
 * The heartbeat computes amortizedCostCents as:
 *   plan.monthlyCostCents / daysInMonth / max(1, plan.seatCount)
 *
 * This is a per-day-per-seat share — a rough estimate that distributes the
 * monthly cost evenly across the days of the month.
 */

function computeAmortizedCostCents(
  plan: { monthlyCostCents: number; seatCount: number } | null,
  now: Date = new Date(),
): number | null {
  if (!plan) return null;
  const daysInMonth = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  return Math.round(
    plan.monthlyCostCents / daysInMonth / Math.max(1, plan.seatCount),
  );
}

describe("heartbeat subscription amortization logic", () => {
  it("returns null when no plan is found", () => {
    expect(computeAmortizedCostCents(null)).toBeNull();
  });

  it("divides monthly cost by days in a 31-day month", () => {
    const plan = { monthlyCostCents: 31000, seatCount: 1 };
    const march = new Date("2026-03-15T12:00:00Z");
    expect(computeAmortizedCostCents(plan, march)).toBe(1000);
  });

  it("divides monthly cost by days in a 28-day month", () => {
    const plan = { monthlyCostCents: 28000, seatCount: 1 };
    const feb = new Date("2026-02-15T12:00:00Z");
    expect(computeAmortizedCostCents(plan, feb)).toBe(1000);
  });

  it("divides monthly cost by days in a 30-day month", () => {
    const plan = { monthlyCostCents: 30000, seatCount: 1 };
    const april = new Date("2026-04-15T12:00:00Z");
    expect(computeAmortizedCostCents(plan, april)).toBe(1000);
  });

  it("accounts for seat count by dividing further", () => {
    const plan = { monthlyCostCents: 31000, seatCount: 5 };
    const march = new Date("2026-03-15T12:00:00Z");
    // 31000 / 31 / 5 = 200
    expect(computeAmortizedCostCents(plan, march)).toBe(200);
  });

  it("rounds the result to the nearest cent", () => {
    const plan = { monthlyCostCents: 20000, seatCount: 1 };
    const march = new Date("2026-03-15T12:00:00Z");
    // 20000 / 31 = 645.16... → rounds to 645
    expect(computeAmortizedCostCents(plan, march)).toBe(645);
  });

  it("handles $200/mo Cursor Pro in March (31 days)", () => {
    const plan = { monthlyCostCents: 20000, seatCount: 1 };
    const march = new Date("2026-03-15T12:00:00Z");
    const daily = computeAmortizedCostCents(plan, march)!;
    expect(daily).toBeGreaterThan(0);
    expect(Math.abs(daily * 31 - 20000)).toBeLessThan(32);
  });

  it("handles $100/mo Claude Max 5-seat in April (30 days)", () => {
    const plan = { monthlyCostCents: 10000, seatCount: 5 };
    const april = new Date("2026-04-15T12:00:00Z");
    // 10000 / 30 / 5 = 66.67 → 67
    const daily = computeAmortizedCostCents(plan, april)!;
    expect(daily).toBe(67);
  });

  it("uses seatCount=1 as minimum even if seatCount is 0", () => {
    const plan = { monthlyCostCents: 31000, seatCount: 0 };
    const march = new Date("2026-03-15T12:00:00Z");
    expect(computeAmortizedCostCents(plan, march)).toBe(1000);
  });
});
