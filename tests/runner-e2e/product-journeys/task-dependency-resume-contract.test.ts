import { describe, expect, it } from "vitest";
import { parseTargetConfig, productJourneys } from "./catalog.js";
import { agentJourneyRunCountValid, journeyRequiredChecks } from "./success-contract.js";
import { TASK_DEPENDENCY_RESUME_CHECKS } from "./task-dependency-resume-evidence.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import type { RunnerE2EResult } from "../types.js";

const caseId = "task-dependency-resume";
const configuration = () => ({ version: 1, id: "qa-fixture", mode: "existing-cloud", executionEnvironment: "daytona",
  adapterModule: "/private/qa-provider.mjs", journeys: [caseId], baseline: { features: {}, connections: [] },
  limits: { durationMs: 600_000, modelBudgetCents: 500, maxRuns: 1 } });
function retained(): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "fixture", caseId,
    executionId: `product-journeys.qa-fixture.configured-agent.daytona.${caseId}`, profileId: "configured-agent", environmentId: "daytona",
    provider: "opencode", model: "fixture-model", runtimeMode: "native", status: "passed", cleanup: "passed", attempt: 1,
    startedAt: "2020-01-01T00:00:00Z", finishedAt: "2020-01-01T00:01:00Z", durationMs: 60_000, runIds: ["run"],
    productJourney: { outcome: "passed", startingState: "recipe", privacy: "private", resourceDisposition: "retained",
      phases: (["authentication", "setup", "journey", "collection", "cleanup"] as const).map(phase => ({ phase, outcome: "passed" })),
      checks: TASK_DEPENDENCY_RESUME_CHECKS.map(id => ({ id, passed: true })), deployment: { kind: "cloud", targetId: "qa-fixture",
        origin: "https://qa.example.test", commit: "a".repeat(40), cloudRelease: "b".repeat(40), runtimeImage: null, configurationHash: "fixture" } } };
}
describe("dependency journey registration and retained acceptance", () => {
  it("is explicit and requires exactly one bounded configured native run", () => {
    expect(productJourneys.find(row => row.id === caseId)).toMatchObject({ paid: true, requires: ["company", "board-user", "task-write", "agent"] });
    expect(parseTargetConfig(configuration()).journeys).toEqual([caseId]);
    expect(journeyRequiredChecks[caseId]).toEqual(TASK_DEPENDENCY_RESUME_CHECKS);
    expect(agentJourneyRunCountValid(caseId, 1)).toBe(true);
    for (const count of [0, 2]) {
      const value = configuration(); value.limits.maxRuns = count;
      expect(() => parseTargetConfig(value)).toThrow("agent_journeys_require_bounded_runs");
      expect(agentJourneyRunCountValid(caseId, count)).toBe(false);
    }
    expect(() => parseTargetConfig({ ...configuration(), limits: { ...configuration().limits, modelBudgetCents: 0 } })).toThrow();
  });
  it("accepts a complete retained measurement and rejects partial checks, runtime or cleanup", () => {
    expect(() => validateRetainedRunnerResult(retained())).not.toThrow();
    for (const change of [
      (r: RunnerE2EResult) => { r.productJourney!.checks.pop(); },
      (r: RunnerE2EResult) => { r.productJourney!.checks[0]!.passed = false; },
      (r: RunnerE2EResult) => { r.runIds = []; },
      (r: RunnerE2EResult) => { r.runIds = ["run", "extra"]; },
      (r: RunnerE2EResult) => { r.runtimeMode = "none"; },
      (r: RunnerE2EResult) => { r.cleanup = "failed"; },
    ]) { const row = retained(); change(row); expect(() => validateRetainedRunnerResult(row)).toThrow(); }
  });
});
