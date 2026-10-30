import { describe, expect, it } from "vitest";
import { parseTargetConfig, productJourneys } from "./catalog.js";
import { agentJourneyRunCountValid } from "./success-contract.js";

describe("portable clarification journey admission", () => {
  it("declares the existing two-question story as a bounded native journey", () => {
    expect(productJourneys.find(j => j.id === "question-answer-resume")).toMatchObject({ paid: true, requires: ["company", "board-user", "task-write", "agent"] });
    const config = { version: 1, id: "attached", mode: "existing-cloud", adapterModule: "/private/provider.mjs",
      executionEnvironment: "daytona", journeys: ["question-answer-resume"], baseline: { features: {}, connections: [] },
      limits: { durationMs: 600_000, modelBudgetCents: 500, maxRuns: 3 } };
    expect(parseTargetConfig(config).journeys).toEqual(["question-answer-resume"]);
    for (const maxRuns of [0, 1, 2, 4]) expect(() => parseTargetConfig({ ...config, limits: { ...config.limits, maxRuns } })).toThrow();
  });
  it("admits exactly the provider/semantic bounds without changing existing exact-count stories", () => {
    for (const count of [1, 2, 3]) expect(agentJourneyRunCountValid("question-answer-resume", count)).toBe(true);
    for (const count of [undefined, 0, 4, 1.5]) expect(agentJourneyRunCountValid("question-answer-resume", count)).toBe(false);
    expect(agentJourneyRunCountValid("plan-revise-accept", 2)).toBe(false);
    expect(agentJourneyRunCountValid("plan-revise-accept", 3)).toBe(true);
  });
});

import { clarificationQuestionFailure, gradeClarificationEvidence } from "./clarification-evidence.js";
import { continuationScenario } from "../continuation-cases.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { journeyRequiredChecks } from "./success-contract.js";
import type { JourneyContext } from "./types.js";

type Row = Record<string, any>;
const context = { company: { id: "company" }, user: { id: "board" }, environmentId: "daytona",
  agent: { id: "agent", provider: "opencode", model: "model", runtimeMode: "native" } } as JourneyContext;
function recording(paths: Array<"provider" | "semantic" | "api">) {
  const runs: Row[] = [], cards: Row[] = [], checkpoints: any[] = [];
  const createRun = (previous?: Row) => ({ id: `run-${runs.length}`, status: "running", runtimeMode: "native", companyId: "company", issueId: "task", agentId: "agent",
    contextSnapshot: { paperclipEnvironment: { id: "daytona" }, ...(previous ? { issueId: "task", sourceRunId: previous.sourceRunId,
      interactionId: previous.id, interactionKind: "ask_user_questions", interactionStatus: "answered" } : {}) },
    resultJson: { semanticToolReceipts: {} }, runnerProfileJson: { nativeExecutionInput: { task: { prompt: continuationScenario("question-answer-resume", "nonce").prompt }, provider: { kind: "opencode", model: "model" } } } });
  const document = { issueId: "task", companyId: "company", key: "welcome-note", latestRevisionId: "revision", createdByAgentId: "agent", updatedByAgentId: "agent", body: "Welcome to the afternoon meetup. Use AMBERnonce." };
  const snapshot = (phase: string) => checkpoints.push(structuredClone({ phase,
    issue: { id: "task", companyId: "company", assigneeAgentId: "agent", status: phase === "final" ? "done" : "in_review" },
    runs, interactions: cards, children: [], attachments: [], comments: [], documents: phase === "final" ? [document] : [] }));
  runs.push(createRun());
  for (const [index, path] of paths.entries()) {
    const run = runs.at(-1)!;
    const field = index === 0 ? { id: "choice", answerMode: "single_select", options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" }] } : { id: "reference", answerMode: "text" };
    const request = `request-${index}`, semantic = path !== "provider";
    const card: Row = { id: `question-${index}`, kind: "ask_user_questions", status: "pending", companyId: "company", issueId: "task", createdByAgentId: "agent", sourceRunId: run.id,
      idempotencyKey: semantic ? `semantic-${index}` : `paperclip-runner-question:${run.id}:${request}`, continuationPolicy: semantic ? "wake_assignee" : "none", createdByUserId: null,
      payload: { ...(semantic ? {} : { runtimeRequestId: request }), questionSet: { questions: [field] } } };
    cards.push(card);
    if (semantic) {
      run.status = "succeeded";
      if (path === "api") run.resultJson.apiToolReceipts = { ["a".repeat(64)]: { state: "completed", digest: "b".repeat(64),
        operationId: "POST /api/issues/{id}/interactions", result: { ok: true, status: 201,
          operationId: "POST /api/issues/{id}/interactions", data: structuredClone(card) } } };
      else run.resultJson.semanticToolReceipts[card.idempotencyKey] = { operationId: "request_human_input", result: { disposition: "applied", interaction: structuredClone(card) } };
    }
    snapshot(index === 0 ? "initial" : "answered");
    card.status = "answered"; card.resolvedByUserId = "board";
    card.result = { answers: [{ questionId: field.id, optionIds: index === 0 ? ["pm"] : [], ...(index === 1 ? { otherText: "Use AMBERnonce." } : {}) }] };
    if (semantic) runs.push(createRun(card));
  }
  runs.at(-1)!.status = "succeeded"; snapshot("final");
  return { checkpoints, readback: { issueId: "task", key: document.key, revisionId: document.latestRevisionId, body: document.body, visibleBody: document.body } };
}
const failures = (f: ReturnType<typeof recording>) => gradeClarificationEvidence(context, "task", "AMBERnonce", f.checkpoints, f.readback).filter(c => !c.passed);

describe("attached clarification evidence", () => {
  it.each([true, false])("rejects an incomplete API receipt instead of inferring native question evidence (choice=%s)", choice => {
    const f = recording(["semantic", "semantic"]), point = f.checkpoints[choice ? 0 : 1];
    const question = point.interactions.find((i: Row) => i.status === "pending"), source = point.runs.at(-1);
    source.resultJson = { apiToolReceipts: { call: { state: "completed", operationId: "POST /api/issues/{id}/interactions",
      result: { ok: true, data: { id: question.id } } } } };
    expect(clarificationQuestionFailure(point, question, choice)).toBe(`clarification_${choice ? "choice" : "text"}_api_fallback`);
    expect(failures(f).some(check => check.id === `question-resume.${choice ? "choice" : "text"}.path`)).toBe(true);
    delete source.resultJson.apiToolReceipts;
    expect(clarificationQuestionFailure(point, question, choice)).toBe(`clarification_${choice ? "choice" : "text"}_native_path_invalid`);
  });
  it("distinguishes an invalid form from a correctly bound semantic question", () => {
    const point = recording(["semantic", "semantic"]).checkpoints[0], question = point.interactions[0];
    expect(clarificationQuestionFailure(point, question, true)).toBeUndefined();
    question.payload.questionSet.questions[0].answerMode = "text";
    point.runs[0].resultJson.semanticToolReceipts[question.idempotencyKey].result.interaction.payload = structuredClone(question.payload);
    expect(clarificationQuestionFailure(point, question, true)).toBe("clarification_choice_form_invalid");
  });
  it.each([["provider", "provider"], ["provider", "semantic"], ["semantic", "provider"], ["semantic", "semantic"],
    ["api", "api"], ["api", "semantic"], ["semantic", "api"], ["provider", "api"], ["api", "provider"]] as const)("accepts the real %s/%s paths with native binding and reload proof", (...paths) => {
    expect(failures(recording([...paths]))).toEqual([]);
  });
  it.each(["foreign-user", "foreign-agent-document", "foreign-task-document", "lost-revision", "wrong-visible-answer", "changed-readback-body", "premature-document", "extra-child", "foreign-model", "foreign-environment", "missing-native-input", "duplicate-question", "wrong-answer"])("rejects a plausible false pass: %s", kind => {
    for (const path of ["semantic", "api"] as const) {
      const f = recording([path, path]), first = f.checkpoints[0], final = f.checkpoints[2];
      if (kind === "foreign-user") final.interactions[1].resolvedByUserId = "other-board";
      if (kind === "foreign-agent-document") final.documents[0].updatedByAgentId = "other-agent";
      if (kind === "foreign-task-document") final.documents[0].issueId = "other-task";
      if (kind === "lost-revision") f.readback.revisionId = "old-revision";
      if (kind === "wrong-visible-answer") f.readback.visibleBody = "Welcome to the morning meetup.";
      if (kind === "changed-readback-body") f.readback.body += " changed";
      if (kind === "premature-document") first.documents = [final.documents[0]];
      if (kind === "extra-child") final.children.push({ id: "extra-child" });
      if (kind === "foreign-model") final.runs[0].runnerProfileJson.nativeExecutionInput.provider.model = "other-model";
      if (kind === "foreign-environment") final.runs[0].contextSnapshot.paperclipEnvironment.id = "local";
      if (kind === "missing-native-input") delete final.runs[0].runnerProfileJson.nativeExecutionInput.task.prompt;
      if (kind === "duplicate-question") final.interactions.push(structuredClone(final.interactions[1]));
      if (kind === "wrong-answer") final.interactions[1].result.answers[0].otherText = "Use the old reference.";
      expect(failures(f).length).toBeGreaterThan(0);
    }
  });
  it("requires reload evidence even for a correct API document", () => {
    const f = recording(["provider", "provider"]);
    expect(gradeClarificationEvidence(context, "task", "AMBERnonce", f.checkpoints).some(c => c.id === "question-document-reloaded" && !c.passed)).toBe(true);
  });
  it("retains 1–3 bound native runs but rejects zero and excess work", () => {
    const result = { schema: "paperclip.runner-e2e.result/v2", executionId: "product-journeys.attached.configured-agent.daytona.question-answer-resume", suiteId: "product-journeys", suiteDefinitionHash: "definition",
      attempt: 1, status: "passed", profileId: "configured-agent", environmentId: "daytona", caseId: "question-answer-resume", provider: "opencode", model: "model", runtimeMode: "native",
      startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:00:01Z", durationMs: 1000, cleanup: "passed", runIds: ["run-0"],
      productJourney: { targetId: "attached", outcome: "passed", startingState: "recipe", privacy: "private", resourceDisposition: "retained",
        phases: [{ phase: "journey", outcome: "passed" }], checks: journeyRequiredChecks["question-answer-resume"]!.map(id => ({ id, passed: true })),
        deployment: { kind: "cloud", targetId: "attached", origin: "https://example.test", commit: "a".repeat(40), cloudRelease: "b".repeat(40), runtimeImage: "immutable-image", configurationHash: "config" } } };
    for (const count of [1, 2, 3]) expect(() => validateRetainedRunnerResult({ ...result, runIds: Array.from({ length: count }, (_, i) => `run-${i}`) })).not.toThrow();
    for (const count of [0, 4]) expect(() => validateRetainedRunnerResult({ ...result, runIds: Array.from({ length: count }, (_, i) => `run-${i}`) })).toThrow("result.agentJourneyRun");
  });
});
