import { describe, expect, it } from "vitest";
import type { StatusCardUpdate } from "@paperclipai/shared";

import {
  estimateStatusCardCost,
  rollupUpdates,
  rollupUpdatesToday,
} from "./format";

function update(overrides: Partial<StatusCardUpdate>): StatusCardUpdate {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    cardId: "00000000-0000-0000-0000-000000000001",
    kind: "full",
    trigger: "manual",
    generationIssueId: null,
    runId: null,
    changes: [],
    inputTokens: 1000,
    outputTokens: 500,
    costCents: 2,
    model: null,
    queryVersion: 1,
    changeSummary: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "ok",
    error: null,
    ...overrides,
  };
}

function iso(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // Noon avoids DST/midnight edge cases in the local-day filter.
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

describe("rollupUpdates (lifetime)", () => {
  it("sums the whole ledger and excludes compile rows from the update count", () => {
    const rollup = rollupUpdates([
      update({ kind: "full", inputTokens: 3000, outputTokens: 1000, costCents: 3, startedAt: iso(0) }),
      update({ kind: "compile", inputTokens: 500, outputTokens: 100, costCents: 1, startedAt: iso(0) }),
      update({ kind: "incremental", inputTokens: 1000, outputTokens: 200, costCents: 2, startedAt: iso(5) }),
    ]);
    // full + incremental = 2 updates (compile excluded from count)
    expect(rollup.updateCount).toBe(2);
    // tokens/cost still include the compile spend
    expect(rollup.totalTokens).toBe(3000 + 1000 + 500 + 100 + 1000 + 200);
    expect(rollup.totalCostCents).toBe(3 + 1 + 2);
  });
});

describe("rollupUpdatesToday", () => {
  it("only counts updates started today and drops older ledger rows", () => {
    const rollup = rollupUpdatesToday([
      update({ kind: "full", inputTokens: 2000, outputTokens: 600, costCents: 3, startedAt: iso(0) }),
      update({ kind: "compile", inputTokens: 400, outputTokens: 100, costCents: 1, startedAt: iso(0) }),
      // yesterday + last week — must not be counted as "today"
      update({ kind: "full", inputTokens: 9999, outputTokens: 9999, costCents: 99, startedAt: iso(1) }),
      update({ kind: "incremental", inputTokens: 9999, outputTokens: 9999, costCents: 99, startedAt: iso(7) }),
    ]);
    // Only today's full rebuild counts as an update (compile excluded).
    expect(rollup.updateCount).toBe(1);
    // Today's tokens/cost include today's compile but not older days.
    expect(rollup.totalTokens).toBe(2000 + 600 + 400 + 100);
    expect(rollup.totalCostCents).toBe(3 + 1);
  });
});

describe("estimateStatusCardCost", () => {
  it("manual mode = a single per-refresh rebuild", () => {
    const est = estimateStatusCardCost({ mode: "manual", triggers: {} as never });
    expect(est.primary).toContain("per refresh");
    expect(est.note).toMatch(/only cost/i);
  });

  it("interval mode scales with the interval and reacts to the daily token cap", () => {
    const uncapped = estimateStatusCardCost({ mode: "interval", intervalMinutes: 60, triggers: {} as never });
    // 24h / 60min = 24 updates/day upper bound
    expect(uncapped.primary).toContain("Up to ~24 updates/day");
    expect(uncapped.primary).toContain("every 60 min");

    const capped = estimateStatusCardCost({
      mode: "interval",
      intervalMinutes: 60,
      dailyTokenCap: 10_000,
      triggers: {} as never,
    });
    // 10_000 / 2_000 est tokens = 5 updates before the cap bites
    expect(capped.primary).toContain("Up to ~5 updates/day");
    expect(capped.note).toMatch(/daily token cap/i);
  });

  it("reactive mode reports the per-hour ceiling", () => {
    const est = estimateStatusCardCost({ mode: "reactive", maxUpdatesPerHour: 4, debounceSeconds: 60, triggers: {} as never });
    expect(est.primary).toContain("up to 4/hour");
    // 24h * 4/hr = 96 updates/day upper bound
    expect(est.primary).toContain("Up to ~96 updates/day");
  });

  it("interval mode honours the active-hours window", () => {
    const est = estimateStatusCardCost({
      mode: "interval",
      intervalMinutes: 60,
      activeHours: { start: "08:00", end: "20:00", timezone: "UTC" },
      triggers: {} as never,
    });
    // 12h window / 60min = 12 updates/day
    expect(est.primary).toContain("Up to ~12 updates/day");
    expect(est.primary).toContain("during active hours");
  });
});
