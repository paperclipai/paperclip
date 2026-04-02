import { describe, expect, it } from "vitest";
import { computeHealthScore, type HealthScoreInput } from "../src/health-score.js";

function makeInput(overrides: Partial<HealthScoreInput> = {}): HealthScoreInput {
  return {
    status: "running",
    heartbeatAgeSec: 60,
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 5000,
    runSuccessRate: 1.0,
    ...overrides,
  };
}

describe("computeHealthScore", () => {
  // --- Full score ---

  it("returns 100 for a perfectly healthy agent", () => {
    const result = computeHealthScore(makeInput());
    expect(result.score).toBe(100);
    expect(result.healthStatus).toBe("healthy");
    expect(result.breakdown).toEqual({
      heartbeat: 30,
      errorState: 25,
      budget: 25,
      runSuccess: 20,
    });
  });

  // --- Heartbeat dimension (30 pts) ---

  it("gives 30 pts for heartbeat age < 5 min", () => {
    expect(computeHealthScore(makeInput({ heartbeatAgeSec: 299 })).breakdown.heartbeat).toBe(30);
  });

  it("gives 15 pts for heartbeat age between 5 and 15 min", () => {
    expect(computeHealthScore(makeInput({ heartbeatAgeSec: 300 })).breakdown.heartbeat).toBe(15);
    expect(computeHealthScore(makeInput({ heartbeatAgeSec: 900 })).breakdown.heartbeat).toBe(15);
  });

  it("gives 0 pts for heartbeat age > 15 min", () => {
    expect(computeHealthScore(makeInput({ heartbeatAgeSec: 901 })).breakdown.heartbeat).toBe(0);
  });

  it("gives 0 pts when heartbeat age is null (never seen)", () => {
    expect(computeHealthScore(makeInput({ heartbeatAgeSec: null })).breakdown.heartbeat).toBe(0);
  });

  // --- Error state dimension (25 pts) ---

  it("gives 25 pts when status is not error", () => {
    expect(computeHealthScore(makeInput({ status: "running" })).breakdown.errorState).toBe(25);
    expect(computeHealthScore(makeInput({ status: "paused" })).breakdown.errorState).toBe(25);
  });

  it("gives 0 pts when status is error", () => {
    expect(computeHealthScore(makeInput({ status: "error" })).breakdown.errorState).toBe(0);
  });

  // --- Budget dimension (25 pts) ---

  it("gives 25 pts for budget utilization < 80%", () => {
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 10000, spentMonthlyCents: 7999 })).breakdown.budget,
    ).toBe(25);
  });

  it("gives 15 pts for budget utilization between 80% and 90%", () => {
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 10000, spentMonthlyCents: 8500 })).breakdown.budget,
    ).toBe(15);
  });

  it("gives 5 pts for budget utilization between 90% and 100%", () => {
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 10000, spentMonthlyCents: 9500 })).breakdown.budget,
    ).toBe(5);
  });

  it("gives 0 pts for exhausted budget (>= 100%)", () => {
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 10000, spentMonthlyCents: 10000 })).breakdown.budget,
    ).toBe(0);
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 10000, spentMonthlyCents: 12000 })).breakdown.budget,
    ).toBe(0);
  });

  it("gives 25 pts when no budget is set (unlimited)", () => {
    expect(
      computeHealthScore(makeInput({ budgetMonthlyCents: 0, spentMonthlyCents: 5000 })).breakdown.budget,
    ).toBe(25);
  });

  // --- Run success dimension (20 pts) ---

  it("gives 20 pts for 100% success rate", () => {
    expect(computeHealthScore(makeInput({ runSuccessRate: 1.0 })).breakdown.runSuccess).toBe(20);
  });

  it("gives 10 pts for 50% success rate", () => {
    expect(computeHealthScore(makeInput({ runSuccessRate: 0.5 })).breakdown.runSuccess).toBe(10);
  });

  it("gives 0 pts for 0% success rate", () => {
    expect(computeHealthScore(makeInput({ runSuccessRate: 0 })).breakdown.runSuccess).toBe(0);
  });

  it("gives 0 pts when run success rate is null (no data)", () => {
    expect(computeHealthScore(makeInput({ runSuccessRate: null })).breakdown.runSuccess).toBe(0);
  });

  // --- Health status thresholds ---

  it("returns healthy for score >= 70", () => {
    // 30 + 25 + 15 + 0 = 70
    const result = computeHealthScore(
      makeInput({ heartbeatAgeSec: 60, budgetMonthlyCents: 10000, spentMonthlyCents: 8500, runSuccessRate: null }),
    );
    expect(result.score).toBe(70);
    expect(result.healthStatus).toBe("healthy");
  });

  it("returns degraded for score >= 40 and < 70", () => {
    // 15 + 0 + 25 + 0 = 40
    const result = computeHealthScore(
      makeInput({ status: "error", heartbeatAgeSec: 600, runSuccessRate: null }),
    );
    expect(result.score).toBe(40);
    expect(result.healthStatus).toBe("degraded");
  });

  it("returns unhealthy for score < 40", () => {
    // 0 + 0 + 0 + 0 = 0
    const result = computeHealthScore({
      status: "error",
      heartbeatAgeSec: null,
      budgetMonthlyCents: 10000,
      spentMonthlyCents: 10000,
      runSuccessRate: 0,
    });
    expect(result.score).toBe(0);
    expect(result.healthStatus).toBe("unhealthy");
  });
});
