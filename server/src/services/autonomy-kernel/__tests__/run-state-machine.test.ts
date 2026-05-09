import { describe, expect, it } from "vitest";
import { autonomyKernelService, RunStateMachineError, validateRunTransition } from "../index.js";
import type { RecordTransitionInput } from "../types.js";

const baseTransition: Omit<RecordTransitionInput, "fromState" | "toState"> = {
  companyId: "00000000-0000-0000-0000-000000000001",
  runId: "00000000-0000-0000-0000-000000000002",
};

function transition(input: Pick<RecordTransitionInput, "fromState" | "toState"> & Partial<RecordTransitionInput>) {
  return {
    ...baseTransition,
    ...input,
  } satisfies RecordTransitionInput;
}

describe("autonomy kernel run state machine", () => {
  it("creates the autonomy kernel service factory", () => {
    const service = autonomyKernelService({} as never);

    expect(service).toMatchObject({
      preflightRun: expect.any(Function),
      authorizeRun: expect.any(Function),
      recordTransition: expect.any(Function),
      recordEvidence: expect.any(Function),
      validateEvidence: expect.any(Function),
      createIncident: expect.any(Function),
      resolveIncident: expect.any(Function),
      evaluateContinuation: expect.any(Function),
      getCompanyLaneStatus: expect.any(Function),
      getAutonomyInbox: expect.any(Function),
    });
  });

  it("allows canonical lifecycle transitions", () => {
    const validTransitions: Array<Pick<RecordTransitionInput, "fromState" | "toState"> & Partial<RecordTransitionInput>> = [
      { fromState: null, toState: "planned" },
      { fromState: "planned", toState: "preflight" },
      { fromState: "preflight", toState: "authorized" },
      { fromState: "authorized", toState: "queued" },
      { fromState: "queued", toState: "running" },
      { fromState: "running", toState: "evidence_extraction" },
      { fromState: "evidence_extraction", toState: "evidence_validation" },
      { fromState: "evidence_validation", toState: "issue_update" },
      { fromState: "issue_update", toState: "continuation_decision" },
      { fromState: "continuation_decision", toState: "queued" },
      {
        fromState: "evidence_validation",
        toState: "terminal",
        terminalClassification: "succeeded_with_evidence",
        evidenceEntryIds: ["evidence-1"],
      },
      {
        fromState: "running",
        toState: "terminal",
        terminalClassification: "failed_agent_runtime",
      },
      {
        fromState: "preflight_failed",
        toState: "terminal",
        terminalClassification: "failed_preflight",
      },
    ];

    for (const candidate of validTransitions) {
      expect(() => validateRunTransition(transition(candidate))).not.toThrow();
    }
  });

  it("throws typed errors for invalid transitions", () => {
    expect(() => validateRunTransition(transition({ fromState: "planned", toState: "running" }))).toThrow(
      RunStateMachineError,
    );

    try {
      validateRunTransition(transition({ fromState: "planned", toState: "running" }));
    } catch (error) {
      expect(error).toBeInstanceOf(RunStateMachineError);
      expect((error as RunStateMachineError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("keeps terminal states immutable except controller override with incident", () => {
    expect(() =>
      validateRunTransition(transition({ fromState: "terminal", toState: "planned" })),
    ).toThrowError(/immutable/);

    expect(() =>
      validateRunTransition(
        transition({
          fromState: "terminal",
          toState: "planned",
          controllerOverride: true,
        }),
      ),
    ).toThrowError(/incident/);

    expect(() =>
      validateRunTransition(
        transition({
          fromState: "terminal",
          toState: "planned",
          controllerOverride: true,
          incidentIds: ["incident-1"],
        }),
      ),
    ).not.toThrow();
  });

  it("does not allow generic success or evidence-free useful success", () => {
    expect(() =>
      validateRunTransition(
        transition({
          fromState: "running",
          toState: "terminal",
          terminalClassification: "succeeded" as never,
        }),
      ),
    ).toThrowError(/Generic success/);

    expect(() =>
      validateRunTransition(
        transition({
          fromState: "evidence_validation",
          toState: "terminal",
          terminalClassification: "succeeded_with_evidence",
        }),
      ),
    ).toThrowError(/requires at least one evidence/);
  });

  it("rejects terminal classifications on non-terminal transitions", () => {
    expect(() =>
      validateRunTransition(
        transition({
          fromState: "planned",
          toState: "preflight",
          terminalClassification: "failed_preflight",
        }),
      ),
    ).toThrowError(/only be set on transitions to terminal/);
  });
});
