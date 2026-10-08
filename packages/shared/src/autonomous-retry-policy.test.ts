import { describe, expect, it } from "vitest";
import {
  autonomousRetryDecisionSchema,
  decideAutonomousRetry,
  DuplicateAutonomousReplanError,
  type AutonomousRetryInput,
} from "./autonomous-retry-policy.js";

const baseInput: AutonomousRetryInput = {
  executionId: "exec-001",
  taskId: "task-001",
  attempt: 1,
  failureKind: "TRANSIENT",
  canReplan: true,
  priorActionIds: [],
};

describe("autonomous retry policy", () => {
  it("uses deterministic exponential backoff for retry attempts one and two", () => {
    const first = decideAutonomousRetry({ ...baseInput, attempt: 1 });
    const second = decideAutonomousRetry({ ...baseInput, attempt: 2 });

    expect(first).toMatchObject({
      actionId: "autonomous-action/exec-001/task-001/1/RETRYING",
      disposition: "RETRYING",
      retryAfterMs: 1_000,
      failureKind: "TRANSIENT",
    });
    expect(second).toMatchObject({
      actionId: "autonomous-action/exec-001/task-001/2/RETRYING",
      disposition: "RETRYING",
      retryAfterMs: 2_000,
      failureKind: "TRANSIENT",
    });
  });

  it("chooses replan or block deterministically after the third transient failure", () => {
    expect(decideAutonomousRetry({ ...baseInput, attempt: 3, canReplan: true })).toMatchObject({
      actionId: "autonomous-replan/exec-001/task-001/3",
      disposition: "REPLANNING",
      retryAfterMs: null,
      reasonCode: "retry_budget_exhausted",
    });
    expect(decideAutonomousRetry({ ...baseInput, attempt: 3, canReplan: false })).toMatchObject({
      actionId: "autonomous-action/exec-001/task-001/3/BLOCKED",
      disposition: "BLOCKED",
      retryAfterMs: null,
      reasonCode: "retry_budget_exhausted",
    });
  });

  it.each([
    ["PERMANENT", "permanent_failure", null],
    ["DEPENDENCY", "dependency_blocked", "DEPENDENCY"],
    ["GATE", "gate_blocked", "GATE"],
  ] as const)("does not retry %s failures and preserves the failure distinction", (failureKind, reasonCode, blockedBy) => {
    const decision = decideAutonomousRetry({
      ...baseInput,
      failureKind,
      attempt: 1,
    });

    expect(decision).toMatchObject({
      disposition: "BLOCKED",
      retryAfterMs: null,
      reasonCode,
      blockedBy,
    });
  });

  it("rejects a duplicate deterministic replan action", () => {
    const input = {
      ...baseInput,
      attempt: 3,
      priorActionIds: ["autonomous-replan/exec-001/task-001/3"],
    };

    expect(() => decideAutonomousRetry(input)).toThrow(DuplicateAutonomousReplanError);
    expect(() => decideAutonomousRetry(input)).toThrow(
      "Autonomous replan action has already been issued",
    );
  });

  it("round-trips deterministic decisions and never accepts secret or reasoning fields", () => {
    const decision = decideAutonomousRetry({ ...baseInput, attempt: 2 });
    const roundTrip = autonomousRetryDecisionSchema.parse(JSON.parse(JSON.stringify(decision)));

    expect(roundTrip).toEqual(decision);
    expect(autonomousRetryDecisionSchema.safeParse({ ...decision, secret: "nope" }).success).toBe(false);
    expect(autonomousRetryDecisionSchema.safeParse({ ...decision, chainOfThought: "nope" }).success).toBe(false);
    expect(JSON.stringify(decision)).not.toMatch(/secret|token|password|chainOfThought|reasoning/i);
  });
});
