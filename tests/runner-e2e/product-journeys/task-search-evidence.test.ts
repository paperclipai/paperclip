import { describe, expect, it } from "vitest";
import { taskSearchEvidencePasses, type SearchTask } from "./task-search-evidence.js";
import { parseTargetConfig, preparationPreview } from "./catalog.js";
import { journeyRequiredChecks } from "./success-contract.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import type { RunnerE2EResult } from "../types.js";

function evidence(): Parameters<typeof taskSearchEvidencePasses>[0] {
  const common = { companyId: "company-1", assigneeUserId: "user-1", assigneeAgentId: null } as const;
  const expected: SearchTask[] = [
    { ...common, id: "target", identifier: "QA-1", title: "needle-campaign target", description: "Exact target context.", status: "backlog" },
    { ...common, id: "status-control", identifier: "QA-2", title: "needle-campaign control", description: "Completed control context.", status: "done" },
    { ...common, id: "search-control", identifier: "QA-3", title: "unrelated control", description: "Other search context.", status: "backlog" },
  ];
  return { expected, saved: structuredClone(expected), runs: [[], [], []], marker: "needle-campaign",
    searchIds: ["status-control", "target"], filteredIds: ["target"], reloadedIds: ["target"], returnedIds: ["target"],
    reloadedQuery: "needle-campaign", returnedQuery: "needle-campaign", reloadedStatusSelected: true, returnedStatusSelected: true,
    openedIdentifier: "QA-1", reopenedIdentifier: "QA-1", titleVisible: true, descriptionVisible: true };
}

describe("task search and filter independent evidence", () => {
  it("accepts the exact target and controls independent of result order", () => {
    expect(taskSearchEvidencePasses(evidence())).toEqual({ search: true, filter: true, persistence: true, reopen: true, noAgentWork: true });
  });
  it.each([
    ["missing target", ["status-control"]], ["missing status control", ["target"]],
    ["unrelated control", ["target", "status-control", "search-control"]],
    ["duplicate target", ["target", "target"]], ["unknown result", ["target", "unknown:QA-9"]],
  ])("rejects search evidence with %s", (_name, searchIds) => {
    expect(taskSearchEvidencePasses({ ...evidence(), searchIds }).search).toBe(false);
  });
  it.each([[], ["status-control"], ["target", "status-control"], ["target", "search-control"]])("rejects wrong or unfiltered results %j", (...filteredIds) => {
    expect(taskSearchEvidencePasses({ ...evidence(), filteredIds }).filter).toBe(false);
  });
  it.each(["reloadedQuery", "returnedQuery"] as const)("rejects lost %s", key => {
    expect(taskSearchEvidencePasses({ ...evidence(), [key]: "" }).persistence).toBe(false);
  });
  it.each(["reloadedStatusSelected", "returnedStatusSelected"] as const)("rejects a lost status filter at %s", key => {
    expect(taskSearchEvidencePasses({ ...evidence(), [key]: false }).persistence).toBe(false);
  });
  it.each(["reloadedIds", "returnedIds"] as const)("rejects a control after %s", key => {
    expect(taskSearchEvidencePasses({ ...evidence(), [key]: ["target", "status-control"] }).persistence).toBe(false);
  });
  it.each(["openedIdentifier", "reopenedIdentifier"] as const)("rejects the wrong task at %s", key => {
    expect(taskSearchEvidencePasses({ ...evidence(), [key]: "QA-2" }).reopen).toBe(false);
  });
  it.each(["titleVisible", "descriptionVisible"] as const)("requires visible saved %s", key => {
    expect(taskSearchEvidencePasses({ ...evidence(), [key]: false }).reopen).toBe(false);
  });
  it.each(["id", "identifier", "companyId", "title", "description", "status", "assigneeUserId", "assigneeAgentId"] as const)("rejects changed saved %s", key => {
    const input = evidence();
    Object.assign(input.saved[0]!, { [key]: "wrong" });
    expect(taskSearchEvidencePasses(input).reopen).toBe(false);
  });
  it("rejects missing saved records and incomplete control ownership", () => {
    const input = evidence(); input.saved = [null];
    expect(taskSearchEvidencePasses(input).reopen).toBe(false);
    const missingControl = evidence(); missingControl.expected = missingControl.expected.slice(0, 2);
    expect(Object.values(taskSearchEvidencePasses(missingControl))).toEqual([false, false, false, false, false]);
  });
  it("requires the controls to differ in the property each one tests", () => {
    const input = evidence(); input.expected[1]!.status = "backlog";
    expect(taskSearchEvidencePasses(input).filter).toBe(false);
    const sameMarker = evidence(); sameMarker.expected[2]!.description = sameMarker.marker;
    expect(taskSearchEvidencePasses(sameMarker).search).toBe(false);
  });
  it.each([[[], []], [[], null, []], [[{ runId: "unexpected" }], [], []], [[], [], [{ runId: "control-run" }]]])("rejects missing or nonzero run evidence %j", (...runs) => {
    expect(taskSearchEvidencePasses({ ...evidence(), runs }).noAgentWork).toBe(false);
  });
});

describe("task search journey reporting contract", () => {
  it("previews a reusable browser journey without private access or model allowance", () => {
    const preview = preparationPreview(parseTargetConfig({ version: 1, id: "qa", mode: "existing-cloud",
      adapterModule: "/not-installed-private-adapter.mjs", journeys: ["task-search-filter"], executionEnvironment: "daytona",
      baseline: { features: {}, connections: [] }, limits: { durationMs: 60000, modelBudgetCents: 0, maxRuns: 0 } }));
    expect(preview.journeys).toMatchObject([{ id: "task-search-filter", capabilities: ["tasks/organize"], paid: false }]);
    expect(preview.limits.maxRuns).toBe(0);
    expect(preview.modelProfileId).toBeNull();
  });
  function result(): RunnerE2EResult {
    return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "test",
      executionId: "product-journeys.qa.browser.daytona.task-search-filter", profileId: "browser", environmentId: "daytona",
      caseId: "task-search-filter", provider: null, model: null, runtimeMode: "none", status: "passed", cleanup: "passed",
      attempt: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000,
      productJourney: { outcome: "passed", startingState: "recipe", phases: [{ phase: "journey", outcome: "passed" }],
        checks: journeyRequiredChecks["task-search-filter"]!.map(id => ({ id, passed: true })),
        privacy: "private", resourceDisposition: "released", deployment: { kind: "cloud", targetId: "qa",
          origin: "https://qa.example.test", commit: "a".repeat(40), cloudRelease: "test", runtimeImage: null, configurationHash: "test" } } };
  }
  it("requires every closed check and zero model/native work", () => {
    expect(() => validateRetainedRunnerResult(result())).not.toThrow();
    for (const id of journeyRequiredChecks["task-search-filter"]!) {
      const missing = result(); missing.productJourney!.checks = missing.productJourney!.checks.filter(check => check.id !== id);
      expect(() => validateRetainedRunnerResult(missing)).toThrow();
    }
    for (const extra of [{ provider: "openai" }, { model: "unexpected" }, { runtimeMode: "native" }, { runIds: ["unexpected"] }]) {
      expect(() => validateRetainedRunnerResult({ ...result(), ...extra })).toThrow();
    }
  });
});
