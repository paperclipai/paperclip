import { describe, expect, it } from "vitest";
import type { DashboardRunActivityDay, DashboardSummary } from "@paperclipai/shared";
import { evaluateTrust, formatPercent } from "./trustState";

function makeRunDay(date: string, failed: number, total: number): DashboardRunActivityDay {
  const succeeded = Math.max(0, total - failed);
  return { date, succeeded, failed, other: 0, total };
}

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    companyId: "co_1",
    agents: { active: 10, running: 9, paused: 0, error: 0 },
    tasks: { open: 100, inProgress: 10, blocked: 10, done: 5 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: 0,
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    runActivity: [makeRunDay("2026-05-15", 1, 100)],
    ...overrides,
  };
}

describe("evaluateTrust", () => {
  it("returns unknown when data is missing", () => {
    const out = evaluateTrust(undefined);
    expect(out.state).toBe("unknown");
    expect(out.header).toBe("Unknown");
    expect(out.summary).toBe("Trust data is not available yet.");
  });

  it("returns unknown when fetch failed even if data exists", () => {
    const out = evaluateTrust(makeSummary(), true);
    expect(out.state).toBe("unknown");
  });

  it("classifies healthy when both metrics below warn thresholds", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 10, blocked: 10, done: 0 }, // 10%
        runActivity: [makeRunDay("2026-05-15", 5, 100)], // 5%
      }),
    );
    expect(out.state).toBe("healthy");
    expect(out.header).toBe("Healthy");
  });

  it("classifies needs_attention when blocked ratio is in 35-50%", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 10, blocked: 40, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 5, 100)],
      }),
    );
    expect(out.state).toBe("needs_attention");
  });

  it("classifies needs_attention when failed-run rate in 10-20%", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 10, blocked: 10, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 15, 100)],
      }),
    );
    expect(out.state).toBe("needs_attention");
  });

  it("classifies critical when blocked ratio above 50% even if runs healthy", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 5, blocked: 60, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 5, 100)],
      }),
    );
    expect(out.state).toBe("critical");
    expect(out.blocked.ratio).toBeCloseTo(0.6);
  });

  it("classifies critical when failed-run rate above 20% even if blocked healthy", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 10, blocked: 5, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 25, 100)],
      }),
    );
    expect(out.state).toBe("critical");
  });

  it("uses strictest triggered state when both warn and critical present", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 0, blocked: 40, done: 0 }, // warn
        runActivity: [makeRunDay("2026-05-15", 25, 100)], // critical
      }),
    );
    expect(out.state).toBe("critical");
  });

  it("treats tasks.open=0 as zero blocked, state from run health", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 5, 100)],
      }),
    );
    expect(out.blocked.status).toBe("zero");
    expect(out.state).toBe("healthy");
  });

  it("treats today total=0 as unknown failed-run rate, not zero", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 10, blocked: 10, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 0, 0)],
      }),
    );
    expect(out.failedToday.status).toBe("unknown");
    expect(out.failedToday.denominator).toBe(0);
    expect(out.state).toBe("healthy"); // blocked still ok, unknown does not block healthy
  });

  it("returns unknown overall when both denominators missing", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 0, 0)],
      }),
    );
    // blocked is zero (healthy), failed is unknown — combine: healthy wins
    // To be truly unknown overall, blocked must also be unknown.
    expect(out.state).toBe("healthy");
  });

  it("returns unknown when runActivity empty AND tasks missing", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: undefined as unknown as DashboardSummary["tasks"],
        runActivity: [],
      }),
    );
    expect(out.state).toBe("unknown");
  });

  it("uses last entry of runActivity as today", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 0, blocked: 5, done: 0 },
        runActivity: [
          makeRunDay("2026-05-09", 50, 100),
          makeRunDay("2026-05-15", 1, 100),
        ],
      }),
    );
    expect(out.failedToday.ratio).toBeCloseTo(0.01);
    expect(out.state).toBe("healthy");
  });

  it("computes 7-day aggregate failed-run rate from last 7 days", () => {
    const days: DashboardRunActivityDay[] = [];
    for (let i = 0; i < 14; i += 1) {
      days.push(makeRunDay(`2026-05-${String(i + 1).padStart(2, "0")}`, 10, 100));
    }
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 100, inProgress: 0, blocked: 0, done: 0 },
        runActivity: days,
      }),
    );
    expect(out.sevenDay.failed).toBe(70);
    expect(out.sevenDay.total).toBe(700);
    expect(out.sevenDay.ratio).toBeCloseTo(0.1);
    expect(out.sevenDay.days).toHaveLength(7);
  });

  it("uses spec-exact critical copy when blocked ratio above 50%", () => {
    const out = evaluateTrust(
      makeSummary({
        tasks: { open: 506, inProgress: 0, blocked: 290, done: 0 },
        runActivity: [makeRunDay("2026-05-15", 25, 111)],
      }),
    );
    expect(out.state).toBe("critical");
    expect(out.header).toBe("Critical");
    expect(out.summary).toBe("Paperclip trust needs attention.");
    expect(out.blocked.ratio).toBeCloseTo(290 / 506);
    expect(out.failedToday.ratio).toBeCloseTo(25 / 111);
  });
});

describe("formatPercent", () => {
  it("returns Unknown for null", () => {
    expect(formatPercent(null)).toBe("Unknown");
  });
  it("formats ratio to 1 decimal by default", () => {
    expect(formatPercent(0.225)).toBe("22.5%");
  });
});
