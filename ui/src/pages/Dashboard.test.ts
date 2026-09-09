import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { deriveMonthCostCoverage, derivePausedAgentBanner } from "./Dashboard";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as unknown as Agent;
}

describe("derivePausedAgentBanner", () => {
  it("returns null with no agents loaded or an empty company", () => {
    expect(derivePausedAgentBanner(undefined)).toBeNull();
    expect(derivePausedAgentBanner([])).toBeNull();
  });

  it("prefers the imported banner and lists only import-paused agents", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "import" }),
      agent({ id: "b", status: "paused", pauseReason: "manual" }),
      agent({ id: "c", status: "idle" }),
    ]);
    expect(banner).toEqual({ kind: "imported", pausedImportedAgentIds: ["a"] });
  });

  it("falls back to the all-paused banner when no import pauses exist", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "paused", pauseReason: "system" }),
    ]);
    expect(banner).toEqual({ kind: "all-paused" });
  });

  it("shows nothing while at least one agent can run and none are import-paused", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "idle" }),
    ]);
    expect(banner).toBeNull();
  });
});

describe("deriveMonthCostCoverage", () => {
  it("treats a month with no cost events as unmeasured, not as a zero bill", () => {
    expect(deriveMonthCostCoverage({ monthReportedCount: 0, monthUnpricedCount: 0 })).toEqual({
      kind: "no-usage-reported",
    });
  });

  it("treats a zero subtotal with reported events as a genuine reported zero", () => {
    expect(deriveMonthCostCoverage({ monthReportedCount: 3, monthUnpricedCount: 0 })).toEqual({
      kind: "reported",
      reportedCount: 3,
    });
  });

  it("marks the subtotal incomplete when any observation is unpriced", () => {
    expect(deriveMonthCostCoverage({ monthReportedCount: 2, monthUnpricedCount: 1 })).toEqual({
      kind: "incomplete",
      reportedCount: 2,
      unpricedCount: 1,
    });
  });

  it("marks an unpriced-only month incomplete instead of free", () => {
    expect(deriveMonthCostCoverage({ monthReportedCount: 0, monthUnpricedCount: 4 })).toEqual({
      kind: "incomplete",
      reportedCount: 0,
      unpricedCount: 4,
    });
  });
});
