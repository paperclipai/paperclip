import { expect, it } from "vitest";
import { gradeAntigravityJourneyTurn } from "./antigravity-journey-evidence.js";
import { antigravityEvidenceFixture, antigravityTurnFixture } from "./antigravity-journey-test-fixtures.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { RunnerE2EResult } from "./types.js";

// Independent synthetic counterexamples; these are not historical/live receipts.
it("requires a control-plane acceptance receipt even when Done metadata and bytes agree", () => {
  const fixture = antigravityTurnFixture();
  fixture.events = fixture.events.filter(event => event.eventType !== "run.result.accepted");
  expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
});

it("rejects provider-authored acceptance and an accepted result different from the settled result", () => {
  for (const wrongSource of [true, false]) {
    const fixture = antigravityTurnFixture();
    const accepted = fixture.events.find(event => event.eventType === "run.result.accepted");
    expect(accepted).toBeDefined();
    if (wrongSource) accepted!.payload.prpEvent.sourceKind = "runner";
    else (accepted!.payload.prpEvent.payload as Record<string, unknown>).result = { schema: "paperclip.run_result.v1", summary: "Different accepted result" };
    expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
  }
});

it("requires the accepted result's terminal receipt instead of only a terminal run row", () => {
  const fixture = antigravityTurnFixture();
  fixture.events = fixture.events.filter(event => event.eventType !== "run.terminal");
  expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
});

it("requires a follow-up to read the prior file before writing and read the updated file afterward", () => {
  for (const removeBefore of [true, false]) {
    const fixture = antigravityTurnFixture(true);
    const edits = fixture.events.filter(event => event.eventType === "tool.execution.completed" && ["edit", "write"].includes(event.payload.prpEvent.payload.operation));
    const boundary = removeBefore ? Math.min(...edits.map(event => event.seq)) : Math.max(...edits.map(event => event.seq));
    const excludedCalls = new Set(fixture.events.filter(event => event.eventType === "tool.execution.completed"
      && event.payload.prpEvent.payload.operation === "read"
      && (removeBefore ? event.seq < boundary : event.seq > boundary)).map(event => event.payload.prpEvent.payload.executionId));
    expect(excludedCalls.size).toBeGreaterThan(0);
    fixture.events = fixture.events.filter(event => !excludedCalls.has(event.payload.prpEvent.payload.executionId));
    expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
  }
});

function retainedResult(): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2", executionId: "antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn", suiteId: "antigravity-agent-journey",
    profileId: "runner-antigravity", environmentId: "local", caseId: "saved-subscription-two-turn", provider: "acpx", model: "gemini-3.8-flash-low", runtimeMode: "native",
    attempt: 1, status: "passed", cleanup: "passed", durationMs: 1000, startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z",
    issueId: "task", runIds: ["run-first", "run-second"], antigravityJourney: antigravityEvidenceFixture(),
    screenshots: [{ id: "persisted", label: "Synthetic assertion calibration only", file: "synthetic.png", sha256: "a".repeat(64) }],
  };
}

it("accepts the fully correlated synthetic retained baseline used by the wrong-binding controls", () => {
  expect(() => validateRetainedRunnerResult(retainedResult())).not.toThrow();
});

it.each(["companyId", "agentId", "connectionId"] as const)("rejects a passing report with a foreign or missing top-level %s binding", key => {
  for (const missing of [false, true]) {
    const result = retainedResult();
    if (missing) delete result.antigravityJourney![key];
    else result.antigravityJourney![key] = "foreign-object";
    expect(() => validateRetainedRunnerResult(result)).toThrow("result.antigravityJourney");
  }
});

it("rejects retained turn proofs attached to a different report task", () => {
  const result = retainedResult();
  result.issueId = "different-task";
  expect(() => validateRetainedRunnerResult(result)).toThrow("result.antigravityJourney");
});
