import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/constants.js";
import type { CostEvent } from "../src/contracts.js";
import {
  applyEvent,
  detect,
  emptyCompanyAggregates,
  stddev,
} from "../src/detector.js";

const DETECTED_AT = "2026-06-11T00:00:00.000Z";

function costEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    issueId: "issue-1",
    projectId: "project-1",
    heartbeatRunId: "run-1",
    provider: "aws_bedrock",
    model: "claude-opus-4-8",
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 500,
    costCents: 100,
    occurredAt: DETECTED_AT,
    ...overrides,
  };
}

describe("detector — aggregates (Welford)", () => {
  it("tracks count, mean, total, and breakdowns across events", () => {
    const aggregates = emptyCompanyAggregates();
    for (const cents of [100, 200, 300]) {
      applyEvent(aggregates, costEvent({ costCents: cents }));
    }
    const agg = aggregates.agents["agent-1"]!;
    expect(agg.count).toBe(3);
    expect(agg.mean).toBeCloseTo(200, 6);
    expect(agg.totalCents).toBe(600);
    expect(agg.byModel["claude-opus-4-8"]).toBe(600);
    expect(agg.byProvider["aws_bedrock"]).toBe(600);
  });

  it("computes a stable sample standard deviation", () => {
    const aggregates = emptyCompanyAggregates();
    for (const cents of [10, 20, 30, 40, 50]) {
      applyEvent(aggregates, costEvent({ costCents: cents }));
    }
    // population values 10..50 -> sample sd ~ 15.811
    expect(stddev(aggregates.agents["agent-1"]!)).toBeCloseTo(15.811, 2);
  });

  it("keeps per-agent aggregates independent", () => {
    const aggregates = emptyCompanyAggregates();
    applyEvent(aggregates, costEvent({ agentId: "agent-1", costCents: 100 }));
    applyEvent(aggregates, costEvent({ agentId: "agent-2", costCents: 900 }));
    expect(aggregates.agents["agent-1"]!.totalCents).toBe(100);
    expect(aggregates.agents["agent-2"]!.totalCents).toBe(900);
  });
});

describe("detector — absolute ceiling rule", () => {
  it("fires on the very first event with no history when at/above the ceiling", () => {
    const anomaly = detect(undefined, costEvent({ costCents: 6000 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).not.toBeNull();
    expect(anomaly!.rule).toBe("absolute_ceiling");
    expect(anomaly!.meanCents).toBeNull();
  });

  it("does not fire below the ceiling with no history", () => {
    const anomaly = detect(undefined, costEvent({ costCents: 4999 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).toBeNull();
  });

  it("fires exactly at the ceiling boundary", () => {
    const anomaly = detect(undefined, costEvent({ costCents: 5000 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).not.toBeNull();
    expect(anomaly!.rule).toBe("absolute_ceiling");
  });
});

describe("detector — z-score spike rule", () => {
  function baselineOf(cents: number[], agentId = "agent-1") {
    const aggregates = emptyCompanyAggregates();
    for (const c of cents) applyEvent(aggregates, costEvent({ agentId, costCents: c }));
    return aggregates.agents[agentId]!;
  }

  it("does not fire before minSamples even on a large value", () => {
    // 3 prior samples (< default minSamples of 8)
    const prior = baselineOf([100, 100, 100]);
    const anomaly = detect(prior, costEvent({ costCents: 400 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).toBeNull();
  });

  it("fires when a value exceeds the mean by more than zThreshold sigma", () => {
    // 8 samples clustered near 100 give a small sd; 1000 is a huge spike.
    const prior = baselineOf([90, 100, 110, 95, 105, 100, 100, 100]);
    const anomaly = detect(prior, costEvent({ costCents: 1000 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).not.toBeNull();
    expect(anomaly!.rule).toBe("z_score");
    expect(anomaly!.zScore).not.toBeNull();
    expect(anomaly!.zScore!).toBeGreaterThanOrEqual(DEFAULT_CONFIG.zThreshold);
    expect(anomaly!.meanCents).toBeGreaterThan(0);
  });

  it("does not fire for an in-distribution value", () => {
    const prior = baselineOf([90, 100, 110, 95, 105, 100, 100, 100]);
    const anomaly = detect(prior, costEvent({ costCents: 108 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).toBeNull();
  });

  it("does not fire when variance is zero (all identical) below the ceiling", () => {
    const prior = baselineOf([100, 100, 100, 100, 100, 100, 100, 100]);
    const anomaly = detect(prior, costEvent({ costCents: 200 }), DEFAULT_CONFIG, DETECTED_AT);
    expect(anomaly).toBeNull();
  });
});
