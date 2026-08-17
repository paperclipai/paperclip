import { describe, expect, it } from "vitest";
import { classifyEquivalentFailure, type FailureObservation } from "./equivalent-failure.js";

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
