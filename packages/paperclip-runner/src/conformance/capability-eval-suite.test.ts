import { describe, expect, it } from "vitest";

import { runCapabilityEvalSuite } from "./capability-eval-suite.js";

describe("Capability offline eval conformance", () => {
  it("executes all 106 checked-in cases against the deterministic mock adapter", async () => {
    const report = await runCapabilityEvalSuite();
    expect(report.cases).toBe(106);
    expect(report.groups).toHaveLength(16);
    expect(report.assertionClasses).toEqual([
      "agent_tool_contract",
      "authorization_policy",
      "combined_multi_hop",
      "control_plane_invariant",
      "restraint_no_call",
    ]);
    expect(report.fakeAgentOperationCount).toBe(report.codexOperationCount);
    expect(report.boundedCodexSample).toHaveLength(16);
    expect(report.results.every((result) =>
      result.caseId &&
      result.semanticOperation &&
      result.authorizationDecision &&
      result.expectedSemantics.length > 0 &&
      result.finalState.expected === result.finalState.observed,
    )).toBe(true);
  });
});
