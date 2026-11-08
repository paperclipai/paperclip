import { describe, expect, it } from "vitest";

import { EVAL_BUNDLE_SCHEMA, type EvalBundle } from "./eval-bundle.js";
import {
  EVAL_BEHAVIOR_IDS,
  runEvalBehaviorFaultMatrix,
} from "./eval-execution.js";
import { buildEvalSliceReport } from "./eval-slice.js";

function bundle(): EvalBundle {
  return {
    schema: EVAL_BUNDLE_SCHEMA,
    provider: {
      runtime: "deterministic-harness",
      transport: "in-process",
      protocolVersion: "v1",
    },
    model: { id: "scripted-eval-agent" },
    launchContext: {
      workingDirectoryClass: "ephemeral-fixture",
      scenarioId: "eval-behavior-fault-matrix-v1",
      turnTimeoutMs: 1_000,
    },
    promptPolicy: {
      id: "deterministic-behavior-driver-v1",
      callTemplate: "Invoke the declared semantic operation sequence.",
      restraintTemplate: "Make no semantic call.",
    },
    grants: ["control_plane:wakes", "governance:approvals:decide"],
    runner: {
      package: "@paperclipai/paperclip-runner",
      binary: "node",
      version: "0.1.2",
    },
    controlPlaneAdapter: {
      kind: "mock",
      contract: "paperclip.capability.mock-state.v1",
    },
    faultInjection: [
      { id: "fault-authz", class: "authorization", description: "deny approval decision exposure" },
      { id: "fault-conflict", class: "conflict", description: "submit a stale plan revision" },
      { id: "fault-retry", class: "retry", description: "fail the first artifact registration attempt" },
      { id: "fault-provider", class: "provider_capability", description: "omit wake scheduling from the tool surface" },
    ],
  };
}

describe("runEvalBehaviorFaultMatrix", () => {
  it("executes eight green/red behaviors and all four declared fault classes", async () => {
    const candidate = bundle();
    const results = await runEvalBehaviorFaultMatrix(candidate);
    const report = buildEvalSliceReport(
      candidate,
      results.map((result) => result.observation),
    );

    expect(report.aggregate).toMatchObject({ caseCount: 16, passed: 8 });
    for (const behavior of EVAL_BEHAVIOR_IDS) {
      expect(report.cases.find((entry) => entry.observation.caseId === `${behavior}:green`)?.scorecard.overall.passed).toBe(true);
      expect(report.cases.find((entry) => entry.observation.caseId === `${behavior}:red`)?.scorecard.overall.passed).toBe(false);
    }

    const faults = results.flatMap((result) => {
      const fault = result.observation.provenance?.faultInjection;
      return fault === undefined ? [] : [fault];
    });
    expect(faults.map((fault) => fault.class).sort()).toEqual([
      "authorization",
      "conflict",
      "provider_capability",
      "retry",
    ]);
    expect(faults.every((fault) => fault.evidenceIds.length > 0)).toBe(true);
  });
});
