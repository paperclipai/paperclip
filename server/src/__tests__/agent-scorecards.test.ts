import { describe, expect, it } from "vitest";
import {
  computeAgentScorecards,
  MIN_SAMPLE_DONE,
  MIN_SAMPLE_RUNS,
  type AgentScorecardInput,
  type AgentScorecardOptions,
} from "../services/agent-scorecards.js";

const OPTS: AgentScorecardOptions = {
  windowDays: 30,
  windowStart: "2026-05-14T00:00:00.000Z",
  windowEnd: "2026-06-13T00:00:00.000Z",
  generatedAt: "2026-06-13T00:00:00.000Z",
};

function input(partial: Partial<AgentScorecardInput> & { agentId: string; agentName: string }): AgentScorecardInput {
  return {
    status: "active",
    doneIssues: 0,
    costCents: 0,
    runs: { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0 },
    reviews: { pass: 0, warn: 0, block: 0 },
    ...partial,
  };
}

describe("computeAgentScorecards", () => {
  it("computes cost/done, failure rate, and review pass for a high-sample agent", () => {
    const result = computeAgentScorecards(
      [
        input({
          agentId: "a1",
          agentName: "Strong",
          doneIssues: 20,
          costCents: 60000, // $600.00
          runs: { succeeded: 45, failed: 4, timedOut: 1, cancelled: 3 },
          reviews: { pass: 9, warn: 0, block: 1 },
        }),
      ],
      OPTS,
    );
    const a = result.agents[0];
    expect(a.costUsd).toBe(600);
    expect(a.costPerDoneIssue).toBe(30); // 600 / 20
    expect(a.completedRuns).toBe(50); // 45 + 4 + 1 (cancelled excluded)
    expect(a.cancelledRuns).toBe(3);
    expect(a.failedRuns).toBe(5); // failed + timedOut
    expect(a.failureRate).toBe(0.1); // 5 / 50
    expect(a.reviewedIssues).toBe(10);
    expect(a.passedReviews).toBe(9);
    expect(a.reviewPassRate).toBe(0.9); // 9 / 10
    expect(a.lowSample).toBe(false);
    expect(a.perMetricSufficient).toEqual({
      costPerDoneIssue: true,
      failureRate: true,
      reviewPassRate: true,
    });
  });

  it("returns null cost/done for a zero-done agent that still burned cost", () => {
    const result = computeAgentScorecards(
      [input({ agentId: "a2", agentName: "Burned", doneIssues: 0, costCents: 41200 })],
      OPTS,
    );
    const a = result.agents[0];
    expect(a.costUsd).toBe(412);
    expect(a.costPerDoneIssue).toBeNull(); // never 0 or Infinity
    expect(a.perMetricSufficient.costPerDoneIssue).toBe(false);
  });

  it("flags a low-sample agent and does not rank it as a real performer", () => {
    const result = computeAgentScorecards(
      [
        input({
          agentId: "a3",
          agentName: "Newbie",
          doneIssues: 1,
          costCents: 500,
          runs: { succeeded: 1, failed: 1, timedOut: 0, cancelled: 0 },
          reviews: { pass: 1, warn: 0, block: 0 },
        }),
      ],
      OPTS,
    );
    const a = result.agents[0];
    // numbers are computed...
    expect(a.costPerDoneIssue).toBe(5);
    expect(a.failureRate).toBe(0.5);
    expect(a.reviewPassRate).toBe(1); // 1/1 — would look "perfect" without the gate
    // ...but every metric is flagged insufficient and the agent is low-sample.
    expect(a.lowSample).toBe(true);
    expect(a.perMetricSufficient).toEqual({
      costPerDoneIssue: false,
      failureRate: false,
      reviewPassRate: false,
    });
    expect(a.doneIssues).toBeLessThan(MIN_SAMPLE_DONE);
    expect(a.completedRuns).toBeLessThan(MIN_SAMPLE_RUNS);
  });

  it("returns all-null metrics for a zero-activity agent", () => {
    const result = computeAgentScorecards(
      [input({ agentId: "a4", agentName: "Idle" })],
      OPTS,
    );
    const a = result.agents[0];
    expect(a.costPerDoneIssue).toBeNull();
    expect(a.failureRate).toBeNull();
    expect(a.reviewPassRate).toBeNull();
    expect(a.lowSample).toBe(true);
  });

  it("treats warn and block verdicts as not-pass", () => {
    const result = computeAgentScorecards(
      [
        input({
          agentId: "a5",
          agentName: "Mixed",
          doneIssues: 6,
          costCents: 6000,
          reviews: { pass: 5, warn: 3, block: 2 },
        }),
      ],
      OPTS,
    );
    const a = result.agents[0];
    expect(a.reviewedIssues).toBe(10);
    expect(a.passedReviews).toBe(5);
    expect(a.reviewPassRate).toBe(0.5); // 5 / 10, warn+block excluded from numerator
  });

  it("ranks meaningful agents ahead of low-sample ones, cheapest cost/done first", () => {
    const result = computeAgentScorecards(
      [
        input({ agentId: "low", agentName: "Low", doneIssues: 1, costCents: 100 }),
        input({ agentId: "pricey", agentName: "Pricey", doneIssues: 10, costCents: 50000 }),
        input({ agentId: "cheap", agentName: "Cheap", doneIssues: 10, costCents: 10000 }),
      ],
      OPTS,
    );
    expect(result.agents.map((a) => a.agentId)).toEqual(["cheap", "pricey", "low"]);
  });

  it("echoes window + sample-floor metadata", () => {
    const result = computeAgentScorecards([], OPTS);
    expect(result.windowDays).toBe(30);
    expect(result.minSampleDone).toBe(MIN_SAMPLE_DONE);
    expect(result.minSampleRuns).toBe(MIN_SAMPLE_RUNS);
    expect(result.agents).toEqual([]);
  });
});
