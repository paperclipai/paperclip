import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_MERGE_GATE_IDS,
  autonomousMergeDecisionSchema,
  createAutonomousMergeGateEvidence,
  decideControlledAutonomousMerge,
  redactAutonomousMergeMetadata,
  type AutonomousMergeGateEvidence,
  type AutonomousMergeRequest,
} from "./autonomous-merge-gate.js";

const baseMetadata = {
  summary: "verified",
  exitCode: 0,
  changedFiles: 2,
};

function gateEvidence(
  gateId: (typeof AUTONOMOUS_MERGE_GATE_IDS)[number],
  decision: "PASS" | "FAIL" | "SKIP" = "PASS",
): AutonomousMergeGateEvidence {
  return createAutonomousMergeGateEvidence({
    gateId,
    decision,
    evidenceRef: `artifact://run-001/${gateId.toLowerCase()}`,
    metadata: baseMetadata,
  });
}

function baseRequest(): AutonomousMergeRequest {
  return {
    workerId: "worker-001",
    taskId: "task-001",
    scopeId: "scope-001",
    gates: AUTONOMOUS_MERGE_GATE_IDS.map((gateId) => gateEvidence(gateId)),
  };
}

describe("controlled autonomous merge gate", () => {
  it("allows a merge only when worker, task, scope, and all required gates pass", () => {
    const decision = decideControlledAutonomousMerge(baseRequest());

    expect(decision).toMatchObject({
      decisionId: "autonomous-merge/worker-001/task-001/scope-001/ALLOW",
      outcome: "ALLOW",
      reasonCode: "all_gates_passed",
      failedGates: [],
    });
    expect(decision.evidence.map((entry) => entry.gateId)).toEqual([...AUTONOMOUS_MERGE_GATE_IDS]);
  });

  it.each(AUTONOMOUS_MERGE_GATE_IDS)("denies merge when %s is not PASS", (gateId) => {
    const request = baseRequest();
    request.gates = request.gates.map((entry) =>
      entry.gateId === gateId ? { ...entry, decision: "FAIL" as const } : entry,
    );

    expect(decideControlledAutonomousMerge(request)).toMatchObject({
      outcome: "DENY",
      reasonCode: "gate_failed",
      failedGates: [gateId],
    });
  });

  it("denies missing, duplicate, and skipped gates instead of guessing an allow", () => {
    const missingGlobal = baseRequest();
    missingGlobal.gates = missingGlobal.gates.filter((entry) => entry.gateId !== "global");
    expect(decideControlledAutonomousMerge(missingGlobal)).toMatchObject({
      outcome: "DENY",
      reasonCode: "missing_gate",
      failedGates: ["global"],
    });

    const duplicateTest = baseRequest();
    duplicateTest.gates = [...duplicateTest.gates, gateEvidence("test")];
    expect(decideControlledAutonomousMerge(duplicateTest)).toMatchObject({
      outcome: "DENY",
      reasonCode: "duplicate_gate",
      failedGates: ["test"],
    });

    const skippedSecurity = baseRequest();
    skippedSecurity.gates = skippedSecurity.gates.map((entry) =>
      entry.gateId === "security" ? { ...entry, decision: "SKIP" as const } : entry,
    );
    expect(decideControlledAutonomousMerge(skippedSecurity)).toMatchObject({
      outcome: "DENY",
      reasonCode: "gate_failed",
      failedGates: ["security"],
    });
  });

  it("is deterministic regardless of gate evidence order and round-trips through JSON", () => {
    const request = baseRequest();
    const shuffled: AutonomousMergeRequest = {
      ...request,
      gates: [...request.gates].reverse(),
    };
    const first = decideControlledAutonomousMerge(request);
    const second = decideControlledAutonomousMerge(shuffled);

    expect(second).toEqual(first);
    expect(autonomousMergeDecisionSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it("redacts secret-bearing metadata and exposes only bounded evidence fields", () => {
    const metadata = redactAutonomousMergeMetadata({
      summary: "verified with token=private-value and chainOfThought=private reasoning",
      exitCode: 0,
      changedFiles: 3,
      apiKey: "private-value",
      rawOutput: "private output",
      hostPath: "/srv/private",
    });

    expect(metadata).toEqual({
      summary: "[REDACTED]",
      exitCode: 0,
      changedFiles: 3,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private|token|apiKey|chainOfThought|rawOutput|hostPath/i);
    expect(autonomousMergeDecisionSchema.safeParse({
      ...decideControlledAutonomousMerge(baseRequest()),
      secret: "nope",
    }).success).toBe(false);
  });
});
