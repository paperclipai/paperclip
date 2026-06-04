import { describe, expect, it } from "vitest";
import {
  awardSolicitBid,
  scoreSubmittedBid,
  simulateSolicitBid,
  type SolicitBidCandidate,
  type SubmittedBidInput,
} from "./solicit-bid-award.js";

const POOL: SolicitBidCandidate[] = [
  { agentId: "a-cto", agentName: "CTO", role: "cto", specialtyFit: 0.4, load: 7 },
  { agentId: "b-qa", agentName: "QA Engineer", role: "qa", specialtyFit: 0.55, load: 1 },
  { agentId: "c-eng", agentName: "Engineer", role: "engineer", specialtyFit: 0.6, load: 3 },
];

describe("solicit_bid deterministic award", () => {
  it("is deterministic: same inputs -> same winner and order", () => {
    const first = awardSolicitBid({ priority: "high", candidates: POOL, submittedBids: [] });
    const second = awardSolicitBid({ priority: "high", candidates: POOL, submittedBids: [] });
    expect(first.winnerAgentId).toBe(second.winnerAgentId);
    expect(first.bids.map((b) => b.agentId)).toEqual(second.bids.map((b) => b.agentId));
  });

  it("award matches the simulated baseline when every candidate submits an identical-to-simulated bid", () => {
    const baseline = awardSolicitBid({ priority: "high", candidates: POOL, submittedBids: [] });
    expect(baseline.bids.every((b) => b.simulated)).toBe(true);

    // Each candidate submits exactly what the manager would have simulated.
    const maxLoad = Math.max(1, ...POOL.map((c) => c.load));
    const submittedBids: SubmittedBidInput[] = POOL.map((c) => {
      const sim = simulateSolicitBid(c, "high", maxLoad, "fit_first");
      return {
        agentId: c.agentId,
        confidence: sim.confidence,
        estEffortHours: sim.estEffortHours,
        specialtyFit: sim.specialtyFit,
        rationale: "self-reported, matches simulated",
      };
    });
    const real = awardSolicitBid({ priority: "high", candidates: POOL, submittedBids });

    expect(real.winnerAgentId).toBe(baseline.winnerAgentId);
    expect(real.bids.map((b) => b.agentId)).toEqual(baseline.bids.map((b) => b.agentId));
    real.bids.forEach((bid, i) => {
      expect(bid.simulated).toBe(false);
      expect(bid.score).toBeCloseTo(baseline.bids[i].score, 10);
    });
  });

  it("quiet fleet never deadlocks: zero submissions still produces a winner via simulated fallback", () => {
    const result = awardSolicitBid({ priority: "medium", candidates: POOL, submittedBids: [] });
    expect(result.winnerAgentId).not.toBeNull();
    expect(result.bids.length).toBe(POOL.length);
    expect(result.bids.every((b) => b.simulated)).toBe(true);
  });

  it("mixes submitted and fallback bids — a strong real bid beats a weak simulated field", () => {
    const submittedBids: SubmittedBidInput[] = [
      { agentId: "a-cto", confidence: 0.95, estEffortHours: 2, specialtyFit: 0.99, rationale: "owned this subsystem" },
    ];
    const result = awardSolicitBid({ priority: "high", candidates: POOL, submittedBids });
    expect(result.winnerAgentId).toBe("a-cto");
    const cto = result.bids.find((b) => b.agentId === "a-cto");
    const others = result.bids.filter((b) => b.agentId !== "a-cto");
    expect(cto?.simulated).toBe(false);
    expect(others.every((b) => b.simulated)).toBe(true);
  });

  it("drops candidates whose bid falls below the fit gate", () => {
    const pool: SolicitBidCandidate[] = [
      { agentId: "ok", agentName: "Fit", role: "engineer", specialtyFit: 0.5, load: 0 },
      { agentId: "low", agentName: "Unfit", role: "engineer", specialtyFit: 0.05, load: 0 },
    ];
    const result = awardSolicitBid({ priority: "low", candidates: pool, submittedBids: [] });
    expect(result.ineligibleAgentIds).toEqual(["low"]);
    expect(result.bids.map((b) => b.agentId)).toEqual(["ok"]);
  });

  it("returns no winner when nobody clears the fit gate (no_candidate)", () => {
    const pool: SolicitBidCandidate[] = [
      { agentId: "low", agentName: "Unfit", role: "engineer", specialtyFit: 0.01, load: 0 },
    ];
    const result = awardSolicitBid({ priority: "low", candidates: pool, submittedBids: [] });
    expect(result.winnerAgentId).toBeNull();
    expect(result.bids).toEqual([]);
  });

  it("fit gate uses the manager-assigned fit — a self-reported specialtyFit cannot bypass it", () => {
    const pool: SolicitBidCandidate[] = [
      { agentId: "low", agentName: "Unfit", role: "engineer", specialtyFit: 0.05, load: 0 },
    ];
    // The agent self-reports a maxed-out fit, but the manager floor (0.05 < 0.12 gate) holds.
    const submittedBids: SubmittedBidInput[] = [
      { agentId: "low", confidence: 1, estEffortHours: 1, specialtyFit: 1, rationale: "trust me" },
    ];
    const result = awardSolicitBid({ priority: "low", candidates: pool, submittedBids });
    expect(result.ineligibleAgentIds).toEqual(["low"]);
    expect(result.winnerAgentId).toBeNull();
  });

  it("manager keeps authority over priority-fit — a self-reported bid cannot inflate it", () => {
    // submitted specialtyFit/confidence are honored; priorityFit stays role-derived.
    const candidate = POOL[2];
    const submitted: SubmittedBidInput = {
      agentId: candidate.agentId,
      confidence: 0.5,
      estEffortHours: 3,
      specialtyFit: 0.6,
      rationale: "x",
    };
    const scored = scoreSubmittedBid(candidate, submitted, "critical", 7, "fit_first");
    // engineer is not senior -> priorityFit 0.4 on critical work regardless of bid.
    expect(scored.priorityFit).toBe(0.4);
  });
});
