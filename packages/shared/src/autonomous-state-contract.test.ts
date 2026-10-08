import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_STATE_CONTRACT_VERSION,
  MAX_AUTONOMOUS_ATTEMPTS,
  autonomousGateEvidenceSchema,
  autonomousStateEnvelopeSchema,
  createAutonomousFailureAction,
  evaluateAutonomousGate,
  nextFailureDisposition,
  transitionAutonomousState,
  type AutonomousStateEnvelope,
} from "./autonomous-state-contract.js";

const envelope: AutonomousStateEnvelope = {
  schemaVersion: AUTONOMOUS_STATE_CONTRACT_VERSION,
  executionId: "exec-001",
  taskId: "task-001",
  parentExecutionId: null,
  risk: "MEDIUM",
  state: "PENDING",
  dependencies: [{ dependencyId: "task-000", state: "PASS" }],
  workers: [{ workerId: "worker-001", role: "implementer", state: "PENDING" }],
  gates: [{ gateId: "gate-tests", decision: "SKIP" }],
  attempt: 1,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

describe("autonomous state contract", () => {
  it("accepts the canonical envelope and round-trips through JSON", () => {
    const parsed = autonomousStateEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));

    expect(parsed).toEqual(envelope);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects unknown fields, including secret-bearing fields", () => {
    expect(
      autonomousStateEnvelopeSchema.safeParse({ ...envelope, secret: "must-not-exist" }),
    ).toMatchObject({ success: false });
    expect(
      autonomousStateEnvelopeSchema.safeParse({
        ...envelope,
        workers: [{ ...envelope.workers[0], chainOfThought: "internal reasoning" }],
      }),
    ).toMatchObject({ success: false });
    expect(
      autonomousStateEnvelopeSchema.safeParse({
        ...envelope,
        workers: [{ ...envelope.workers[0], apiKey: "must-not-exist" }],
      }),
    ).toMatchObject({ success: false });
  });

  it("allows only the deterministic lifecycle transitions", () => {
    const planning = transitionAutonomousState(
      envelope,
      "PLANNING",
      "2026-09-27T00:00:01.000Z",
    );
    const running = transitionAutonomousState(
      planning,
      "RUNNING",
      "2026-09-27T00:00:02.000Z",
    );

    expect(planning.state).toBe("PLANNING");
    expect(running.state).toBe("RUNNING");
    expect(running.updatedAt).toBe("2026-09-27T00:00:02.000Z");
  });

  it("deterministically rejects invalid transitions", () => {
    expect(() => transitionAutonomousState(envelope, "PASS", envelope.updatedAt)).toThrow(
      "Invalid autonomous state transition: PENDING -> PASS",
    );
  });

  it("evaluates gate evidence from status, exit status, and observed output", () => {
    const passing = {
      gateId: "gate-tests",
      command: "pnpm test --filter @paperclipai/shared",
      expected: "0 failures",
      observed: "0 failures",
      exitCode: 0,
      status: "PASS" as const,
      timestamp: "2026-09-27T00:00:03.000Z",
      evidenceRef: "artifact://run-001/tests.txt",
    };
    const failing = { ...passing, observed: "1 failure", exitCode: 1, status: "FAIL" as const };
    const skipped = { ...passing, exitCode: null, status: "SKIP" as const };

    expect(autonomousGateEvidenceSchema.parse(passing)).toEqual(passing);
    expect(evaluateAutonomousGate(passing)).toBe("PASS");
    expect(evaluateAutonomousGate(failing)).toBe("FAIL");
    expect(evaluateAutonomousGate(skipped)).toBe("SKIP");
  });

  it("uses at most three attempts, then chooses replan or block", () => {
    expect(MAX_AUTONOMOUS_ATTEMPTS).toBe(3);
    expect(nextFailureDisposition(1, true)).toBe("RETRYING");
    expect(nextFailureDisposition(2, true)).toBe("RETRYING");
    expect(nextFailureDisposition(3, true)).toBe("REPLANNING");
    expect(nextFailureDisposition(3, false)).toBe("BLOCKED");
    expect(() => nextFailureDisposition(4, true)).toThrow("Attempt must be between 1 and 3");
  });

  it("creates a stable action placeholder without side effects", () => {
    const first = createAutonomousFailureAction({ ...envelope, state: "FAILED", attempt: 3 }, true);
    const second = createAutonomousFailureAction({ ...envelope, state: "FAILED", attempt: 3 }, true);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      actionId: "autonomous-action/exec-001/task-001/3/REPLANNING",
      kind: "REPLAN",
      nextState: "REPLANNING",
    });
    expect(Object.keys(first).sort()).toEqual([
      "actionId",
      "attempt",
      "executionId",
      "kind",
      "nextState",
      "taskId",
    ]);
  });
});
