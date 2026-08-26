import { describe, expect, it } from "vitest";
import { classifyEquivalentFailure, classifyRepeatedResourceCeiling, type FailureObservation } from "./equivalent-failure.js";

const now = new Date("2026-08-10T12:00:00.000Z");

function failure(overrides: Partial<FailureObservation> = {}): FailureObservation {
  return {
    agentId: "agent-1",
    issueId: "issue-1",
    routineId: null,
    fingerprint: null,
    occurredAt: new Date("2026-08-10T11:00:00.000Z"),
    status: "failed",
    ...overrides,
  };
}

describe("classifyEquivalentFailure", () => {
  it("classifies two genuine failures for the same agent and issue", () => {
    const match = classifyEquivalentFailure([failure(), failure({ occurredAt: new Date("2026-08-10T10:00:00.000Z") })], now);

    expect(match).toMatchObject({ kind: "agent_issue", agentId: "agent-1", issueId: "issue-1" });
  });

  it("classifies two genuine failures for the same routine and fingerprint", () => {
    const match = classifyEquivalentFailure([
      failure({ agentId: "agent-1", issueId: "issue-1", routineId: "routine-1", fingerprint: "input-v1" }),
      failure({ agentId: "agent-2", issueId: "issue-2", routineId: "routine-1", fingerprint: "input-v1" }),
    ], now);

    expect(match).toMatchObject({ kind: "routine_fingerprint", routineId: "routine-1", fingerprint: "input-v1" });
  });

  it("does not classify a single failure or non-equivalent failures", () => {
    expect(classifyEquivalentFailure([failure()], now)).toBeNull();
    expect(classifyEquivalentFailure([failure(), failure({ issueId: "issue-2" })], now)).toBeNull();
  });

  it("does not classify failures outside the rolling 24-hour window", () => {
    expect(classifyEquivalentFailure([
      failure(),
      failure({ occurredAt: new Date("2026-08-09T11:59:59.999Z") }),
    ], now)).toBeNull();
  });

  it("excludes benign cancellation and transient lock contention", () => {
    expect(classifyEquivalentFailure([
      failure(),
      failure({ status: "cancelled" }),
    ], now)).toBeNull();
    expect(classifyEquivalentFailure([
      failure(),
      failure({ errorCode: "transient_lock_contention" }),
    ], now)).toBeNull();
    expect(classifyEquivalentFailure([
      failure({ errorCode: "antigravity_transient_silent_exit" }),
      failure({
        occurredAt: new Date("2026-08-10T10:00:00.000Z"),
        errorCode: "antigravity_transient_silent_exit",
      }),
    ], now)).toBeNull();
  });
it("excludes resource ceilings from breaker judgment (TSMC-20910 instances 3-4)", () => {
    for (const code of ["token_budget_exhausted", "max_turns_exhausted", "issue_generation_ceiling_exceeded"]) {
      expect(classifyEquivalentFailure([
        failure({ errorCode: code }),
        failure({ occurredAt: new Date("2026-08-10T10:00:00.000Z"), errorCode: code }),
      ], now)).toBeNull();
    }
    // A ceiling paired with one genuine failure is still only ONE genuine failure.
    expect(classifyEquivalentFailure([
      failure({ errorCode: "token_budget_exhausted" }),
      failure({ occurredAt: new Date("2026-08-10T10:00:00.000Z") }),
    ], now)).toBeNull();
  });
});

// TSMC-21870. Measured 2026-08-26 over 30h on claude-sonnet-5: 16 cards absorbed 55
// turn-exhausted runs costing $156.08 — 50% of the entire claude bill — while 7 cards
// that failed once cost $18.37. The lane exclusion is right; the card was unbounded.
describe("classifyRepeatedResourceCeiling", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  const obs = (over: Partial<FailureObservation> = {}): FailureObservation => ({
    agentId: "agent-1",
    issueId: "issue-1",
    routineId: null,
    fingerprint: "max_turns_exhausted",
    occurredAt: at(10),
    status: "failed",
    errorCode: "max_turns_exhausted",
    ...over,
  });

  it("does NOT fire on a single ceiling verdict — one oversized attempt is information", () => {
    expect(classifyRepeatedResourceCeiling([obs()], now)).toBeNull();
  });

  it("fires on the second equivalent ceiling verdict for the same card", () => {
    const match = classifyRepeatedResourceCeiling([obs({ occurredAt: at(60) }), obs()], now);
    expect(match).not.toBeNull();
    expect(match?.issueId).toBe("issue-1");
    expect(match?.errorCode).toBe("max_turns_exhausted");
    expect(match?.occurrences).toBe(2);
  });

  it("reproduces TSR-5837: five turn-exhausted runs on one card", () => {
    const five = [10, 60, 120, 200, 300].map((m) => obs({ occurredAt: at(m) }));
    expect(classifyRepeatedResourceCeiling(five, now)?.occurrences).toBe(5);
  });

  it("counts per CARD, not per lane — two cards failing once each is not a match", () => {
    const spread = [obs({ issueId: "issue-1" }), obs({ issueId: "issue-2" })];
    expect(classifyRepeatedResourceCeiling(spread, now)).toBeNull();
  });

  it("does not conflate different ceiling codes on the same card", () => {
    const mixed = [obs({ errorCode: "max_turns_exhausted" }), obs({ errorCode: "token_budget_exhausted" })];
    expect(classifyRepeatedResourceCeiling(mixed, now)).toBeNull();
  });

  it("ignores non-ceiling failures — those belong to the lane breaker", () => {
    const other = [obs({ errorCode: "adapter_failed" }), obs({ errorCode: "adapter_failed" })];
    expect(classifyRepeatedResourceCeiling(other, now)).toBeNull();
  });

  it("ignores observations outside the 24h window", () => {
    const stale = [obs({ occurredAt: at(60 * 30) }), obs({ occurredAt: at(60 * 40) })];
    expect(classifyRepeatedResourceCeiling(stale, now)).toBeNull();
  });

  it("covers every resource-ceiling code, not just max_turns", () => {
    for (const code of ["token_budget_exhausted", "issue_generation_ceiling_exceeded", "max_turns_exhausted"]) {
      const pair = [obs({ errorCode: code, occurredAt: at(30) }), obs({ errorCode: code })];
      expect(classifyRepeatedResourceCeiling(pair, now)?.errorCode, code).toBe(code);
    }
  });

  it("still leaves the LANE breaker untouched — ceilings never pause an agent", () => {
    const pair = [obs({ occurredAt: at(30) }), obs()];
    expect(classifyEquivalentFailure(pair, now)).toBeNull();
  });
});
