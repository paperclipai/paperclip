import { describe, expect, it } from "vitest";

import type { EvalBundle } from "./eval-bundle.js";
import type { EvalObservation } from "./eval-scoring.js";
import { buildEvalSliceReport, renderEvalSliceMarkdown } from "./eval-slice.js";

function bundle(): EvalBundle {
  return {
    schema: "paperclip.runner.eval-bundle.v1",
    provider: { runtime: "runnerd", transport: "codex-app-server", protocolVersion: "prp.v1" },
    model: { id: "gpt-5-codex" },
    launchContext: { workingDirectoryClass: "ephemeral-fixture", scenarioId: "slice", turnTimeoutMs: 60_000 },
    promptPolicy: { id: "exact-single-call", callTemplate: "Call {op}.", restraintTemplate: "No tools." },
    grants: ["discovery:tasks:read"],
    runner: { package: "@paperclipai/paperclip-runner", binary: "paperclip-runnerd", version: "0.0.0" },
    controlPlaneAdapter: { kind: "mock", contract: "paperclip.capability.control-plane.v1" },
    faultInjection: [],
  };
}

const trace = { runId: "r", sessionId: "s", turnId: "t", itemId: "i", receiptIds: ["rc"], terminalPresent: true };

function green(caseId: string): EvalObservation {
  return {
    caseId,
    controlPlaneOwned: false,
    expectedCalls: ["finish_task"],
    observedCalls: ["finish_task"],
    forbiddenCalls: ["checkout_task"],
    finalState: { expected: "mutated", observed: "mutated" },
    authorization: { expected: "allowed", observed: "allowed" },
    trace,
  };
}

function gateFail(caseId: string): EvalObservation {
  return { ...green(caseId), observedCalls: ["finish_task", "checkout_task"] };
}

describe("buildEvalSliceReport", () => {
  it("aggregates scorecards and content-addresses the bundle", () => {
    const report = buildEvalSliceReport(bundle(), [green("a"), gateFail("b")], { generatedFromLiveModel: true });
    expect(report.bundle.id).toMatch(/^evb-[0-9a-f]{16}$/);
    expect(report.generatedFromLiveModel).toBe(true);
    expect(report.aggregate.caseCount).toBe(2);
    expect(report.aggregate.passed).toBe(1);
    expect(report.aggregate.gateFailures).toBe(1);
    expect(report.aggregate.dimensionMeans.semantic_outcome).toBe(1);
    // Every scorecard carries the report bundle id.
    for (const entry of report.cases) expect(entry.scorecard.bundleId).toBe(report.bundle.id);
  });

  it("is deterministic", () => {
    const a = buildEvalSliceReport(bundle(), [green("a")]);
    const b = buildEvalSliceReport(bundle(), [green("a")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("refuses to build a report from a secret-carrying bundle", () => {
    const leaky = { ...bundle(), grants: ["not-a-grant"] };
    expect(() => buildEvalSliceReport(leaky, [green("a")])).toThrow();
  });
});

describe("renderEvalSliceMarkdown", () => {
  it("renders an inspectable table with no secrets", () => {
    const md = renderEvalSliceMarkdown(buildEvalSliceReport(bundle(), [green("a"), gateFail("b")]));
    expect(md).toContain("Runner eval slice");
    expect(md).toContain("| a |");
    expect(md).toContain("| b |");
    expect(md).toContain("FAIL");
    expect(md).not.toContain("sk-");
  });
});
