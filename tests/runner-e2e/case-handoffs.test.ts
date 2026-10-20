import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites, validateRunnerCatalog } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { caseHandoffRunFailure, gradeCaseHandoffs, hasNativeHandoffReceipt, type CaseHandoffObservation } from "./case-handoffs-scoring.js";
import { isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";
import { classifyFailure } from "./failure-classifier.js";

it("preserves provider refusal evidence instead of calling it a workflow assertion failure", () => {
  const failure = caseHandoffRunFailure([{ id: "run", status: "failed", resultJson: {
    nativeTurnFailure: { httpStatus: 429, codexErrorInfo: "responseTooManyFailedAttempts" },
  } }]);
  expect(failure).toContain("HTTP 429");
  expect(classifyFailure(new Error(failure))).toBe("transient_infrastructure");
  expect(caseHandoffRunFailure([{ status: "running" }])).toBeUndefined();
});

it("admits only the explicitly selected fixture case for public screenshots", () => {
  const target = { issuePrefix: "PAP", issueId: "task", issueIdentifier: "PAP-1", caseId: "case", caseIdentifier: "PAP-C1" };
  expect(isPublicRunnerScreenshotRoute("http://127.0.0.1:3100/PAP/cases/PAP-C1", target)).toBe(true);
  expect(isPublicRunnerScreenshotRoute("http://127.0.0.1:3100/PAP/cases/PAP-C2", target)).toBe(false);
  expect(isPublicRunnerScreenshotRoute("https://example.test/PAP/cases/PAP-C1", target)).toBe(false);
  expect(isPublicRunnerScreenshotRoute("http://127.0.0.1:3100/PAP/cases/PAP-C1", { ...target, caseId: undefined })).toBe(false);
});

function valid(): CaseHandoffObservation {
  const agents = { triage: "triage", implementation: "implementation", verification: "verification" };
  const targets = [agents.triage, agents.implementation, agents.verification, agents.implementation];
  const phases = ["triage", "implementation", "verification", "revision"];
  const issue = { id: "task", status: "done", assigneeAgentId: agents.implementation };
  const caseRecord = { id: "case", workIssueId: "task", phase: "revision", handoffVersion: 4, pendingHandoff: null };
  return { nonce: "nonce", companyId: "company", taskId: "task", caseId: "case", agents, issue, caseRecord,
    tasks: [issue], cases: [caseRecord], pendingInteractions: 0,
    handoffs: phases.map((phase, index) => ({ id: `handoff-${index}`, caseId: "case", issueId: "task", version: index + 1, phase,
      toAgentId: targets[index], fromAgentId: targets[index - 1] ?? null, sourceRunId: index ? `run-${index - 1}` : null, state: "delivered" })),
    runs: targets.map((agentId, index) => ({ id: `run-${index}`, agentId, companyId: "company", nativeIssueId: "task", runtimeMode: "native", status: "succeeded" })),
    handoffToolRunIds: ["run-0", "run-1", "run-2"],
    documents: Object.fromEntries([
      ["answer", { body: JSON.stringify({ nonce: "nonce", a: 2, b: 3, result: 5, verified: true }), createdByAgentId: agents.implementation, updatedByAgentId: agents.implementation }],
      ...phases.map((phase, index) => [`phase-${phase}`, { body: JSON.stringify({ nonce: "nonce", phase, caseId: "case", taskId: "task", handoffVersion: index + 1, result: 5 }), createdByAgentId: targets[index], updatedByAgentId: targets[index] }]),
    ]),
  };
}

describe("same-task case handoff Product E2E", () => {
  it("discovers three explicit local credential cells without widening arithmetic coverage", () => {
    validateRunnerCatalog();
    const suite = runnerSuites.find(row => row.id === "case-handoffs")!;
    const cells = runnerMatrix.filter(row => row.suite.id === suite.id);
    expect(cells.map(row => row.id)).toEqual(["case-handoffs.runner-codex-subscription.local.same-task-roundtrip",
      "case-handoffs.runner-codex-subscription.local.receipt-smoke", "case-handoffs.runner-codex.local.receipt-smoke"]);
    expect(suite.manualOnly).toBe(true);
    expect(cells[0]!.requiredCredentials).toEqual(["CODEX_AUTH_JSON"]);
    expect(cells[0]!.task).toMatchObject({ flow: "case_handoff", minimumExpectedRunCount: 4, expectedRunCount: 6, automaticRetryPolicy: "single_attempt" });
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "case-handoffs"]))).toHaveLength(3);
    expect(cells.map(cell => cell.requiredCredentials)).toEqual([["CODEX_AUTH_JSON"], ["CODEX_AUTH_JSON"], ["OPENAI_API_KEY"]]);
    expect(runnerMatrix.some(cell => cell.id === "case-handoffs.runner-codex.local.same-task-roundtrip")).toBe(false);
    for (const cell of cells) {
      expect(selectRunnerExecutions(parseRunnerSelectors(["--id", cell.id])).map(row => row.id)).toEqual([cell.id]);
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.suite.id === suite.id)).toBe(false);
    const agent = cells[0]!.profile.buildAgent({ environmentId: "env", environmentFixtureId: "local", workspacePath: "/tmp/work", secretRefs: {}, executionId: "fixture" });
    expect(agent).not.toHaveProperty("instructionsBundle");
    expect(agent.adapterConfig).toMatchObject({ provider: "codex", env: {} });
  });
  it("uses ordinary encrypted secret references for the API receipt profile", () => {
    const apiCell = runnerMatrix.find(cell => cell.id === "case-handoffs.runner-codex.local.receipt-smoke")!;
    const subscriptionCell = runnerMatrix.find(cell => cell.id === "case-handoffs.runner-codex-subscription.local.receipt-smoke")!;
    const reference = { type: "secret_ref" as const, secretId: "22222222-2222-4222-8222-222222222222", version: "latest" as const };
    const agent = apiCell.profile.buildAgent({ environmentId: "env", environmentFixtureId: "local", workspacePath: "/tmp/work",
      secretRefs: { OPENAI_API_KEY: reference }, executionId: "api-receipt" });
    expect(apiCell.profile.model).toBe(subscriptionCell.profile.model);
    expect(apiCell.task).toBe(subscriptionCell.task);
    expect(agent).not.toHaveProperty("instructionsBundle");
    expect(agent.adapterConfig).toMatchObject({ provider: "codex", env: { OPENAI_API_KEY: reference, CODEX_API_KEY: reference } });
    expect((agent.adapterConfig as Record<string, unknown>).env).not.toHaveProperty("CODEX_HOME");
  });
  it("passes durable public evidence and fails plausible wrong or missing results", () => {
    expect(gradeCaseHandoffs(valid()).every(check => check.passed)).toBe(true);
    for (const mutate of [
      (o: CaseHandoffObservation) => { o.documents.answer = { body: JSON.stringify({ nonce: "nonce", a: 2, b: 3, result: 6, verified: true }) }; },
      (o: CaseHandoffObservation) => { delete o.documents["phase-verification"]; },
      (o: CaseHandoffObservation) => { o.caseRecord.workIssueId = "replacement-task"; },
      (o: CaseHandoffObservation) => { o.handoffs[2]!.issueId = "replacement-task"; },
      (o: CaseHandoffObservation) => { o.handoffToolRunIds = []; },
      (o: CaseHandoffObservation) => { o.runs.push({ id: "unaccounted" }); },
      (o: CaseHandoffObservation) => { o.pendingInteractions = 1; },
      (o: CaseHandoffObservation) => { o.documents["phase-verification"]!.updatedByAgentId = o.agents.implementation; },
    ]) {
      const o = valid(); mutate(o);
      expect(gradeCaseHandoffs(o).some(check => !check.passed)).toBe(true);
    }
  });
  it("requires correlated native tool lifecycle, never model prose", () => {
    const event = (seq: number, eventType: string, payload: unknown) => ({ seq, eventType, protocolSchemaVersion: 2,
      payload: { prpEvent: { schema: "paperclip.prp.event.v2", schemaVersion: 2, sourceKind: "runner", payload } } });
    const events = [event(1, "tool.execution.started", { name: "handoff_case", executionId: "call" }),
      event(2, "tool.execution.completed", { name: "handoff_case", executionId: "call", status: "completed" })];
    expect(hasNativeHandoffReceipt(events)).toBe(true);
    expect(hasNativeHandoffReceipt(events.slice(1))).toBe(false);
    const actualDriverShape = [event(1, "item.started", { kind: "dynamicToolCall", item: { type: "tool_use", id: "call", name: "handoff_case" } }),
      event(2, "item.completed", { kind: "dynamicToolCall", item: { type: "tool_result", id: "call", result: { handoffId: "handoff", taskId: "task", callerMustYield: true } } })];
    expect(hasNativeHandoffReceipt(actualDriverShape)).toBe(true);
    expect(hasNativeHandoffReceipt(actualDriverShape.slice(1))).toBe(false);
    const terminalDriverShape = [actualDriverShape[0]!,
      event(2, "item.completed", { kind: "dynamicToolCall", item: { type: "tool_result", id: "call", result: {
        handoffId: "handoff", taskId: "task", callerMustYield: false, destinationKind: "done", state: "awaiting_completion",
      } } })];
    expect(hasNativeHandoffReceipt(terminalDriverShape)).toBe(true);
    expect(hasNativeHandoffReceipt(terminalDriverShape.slice(1))).toBe(false);
    expect(hasNativeHandoffReceipt([event(1, "item.completed", { kind: "agentMessage", text: "I called handoff_case" })])).toBe(false);
  });
});
