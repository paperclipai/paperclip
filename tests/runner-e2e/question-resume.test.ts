import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gradeQuestionResume, questionPath, validResumeQuestionForm, type QuestionPath } from "./question-resume-scoring.js";
import { gradeContinuation } from "./continuation-scoring.js";
import { gradeLifecycleBaseline } from "./lifecycle-baseline.js";
import { continuationScenario } from "./continuation-cases.js";
import { runnerMatrix } from "./catalog.js";

type Row = Record<string, any>;
function recording(paths: QuestionPath[] = ["provider", "semantic"]) {
  const runs: Row[] = [];
  const cards: Row[] = [];
  const points: any[] = [];
  const newRun = (previous?: Row) => ({ id: `run-${runs.length + 1}`, status: "running", runtimeMode: "native",
    companyId: "company", issueId: "task", agentId: "agent", resultJson: { semanticToolReceipts: {} },
    runnerProfileJson: { nativeExecutionInput: { task: { prompt: "actual native task input" } } },
    contextSnapshot: previous ? { issueId: "task", sourceRunId: previous.sourceRunId,
      interactionId: previous.id, interactionKind: "ask_user_questions", interactionStatus: "answered" } : {},
  });
  runs.push(newRun());
  const snap = (phase: string, documents: Row[] = []) => {
    const active = runs.find(r => r.status === "running");
    points.push(structuredClone({ phase, issue: { id: "task", companyId: "company", assigneeAgentId: "agent",
      status: phase === "final" ? "done" : active ? "in_progress" : "in_review" },
      lifecycle: { executionRunId: active?.id ?? null, scheduledRetry: null, activeRecoveryAction: null, monitorNextCheckAt: null },
      runs, interactions: cards, children: [], attachments: [], comments: [], documents }));
  };
  for (let n = 0; n < 2; n++) {
    const run = runs.at(-1)!;
    const provider = paths[n] === "provider", api = paths[n] === "api";
    const request = `request-${n}`;
    const idempotencyKey = provider ? `paperclip-runner-question:${run.id}:${request}` : `question-${n}`;
    const field = n === 0 ? { id: "field-1-question_0-hash", answerMode: "single_select", options: [
      { id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" },
    ] } : { id: "reference", answerMode: "text" };
    const questions: Row[] = [field];
    if (provider && n === 0) questions.push({ id: "field-2-question_0_custom-hash", answerMode: "text", header: "Other", required: false });
    const card: Row = { id: `card-${n}`, kind: "ask_user_questions", status: "pending",
      companyId: "company", issueId: "task", createdByAgentId: "agent", sourceRunId: run.id, idempotencyKey,
      continuationPolicy: provider ? "none" : "wake_assignee", createdByUserId: null,
      payload: { ...(provider ? { runtimeRequestId: request } : {}), questionSet: { questions } } };
    cards.push(card);
    if (!provider) {
      run.status = "succeeded";
      if (api) run.resultJson.apiToolReceipts = { ["a".repeat(64)]: { state: "completed", digest: "b".repeat(64),
        operationId: "POST /api/issues/{id}/interactions", result: { ok: true, status: 201,
          operationId: "POST /api/issues/{id}/interactions", data: structuredClone(card) } } };
      else run.resultJson.semanticToolReceipts[idempotencyKey] = { operationId: "request_human_input",
        result: { disposition: "applied", interaction: structuredClone(card) } };
    }
    snap(n === 0 ? "initial" : "answered");
    card.status = "answered"; card.resolvedByUserId = "local-board";
    card.result = { answers: [n === 0 ? { questionId: field.id, optionIds: ["pm"] } :
      { questionId: field.id, optionIds: [], otherText: "Use AMBERnonce." }] };
    if (!provider) runs.push(newRun(card));
  }
  runs.at(-1)!.status = "succeeded";
  snap("final", [{ key: "welcome-note", latestRevisionId: "revision", body: "Welcome to the afternoon meetup. Use AMBERnonce." }]);
  return points;
}
const failed = (r: any[]) => gradeQuestionResume(r, "AMBERnonce").filter(c => !c.passed).map(c => c.id);
const question = (r: any[], n = 0) => r[n].interactions[n];
function writtenReference(r: any[]) {
  for (const point of r.slice(1)) Object.assign(point.interactions[1].payload.questionSet.questions[0], {
    answerMode: "single_select", options: [{ id: "none", label: "No reference" }], customAnswer: { enabled: true },
  });
  return r;
}

describe("native question/resume path qualification", () => {
  it("accepts an explicit provider written answer without selecting a predefined option", () => {
    const r = writtenReference(recording(["provider", "provider"]));
    expect(failed(r)).toEqual([]);
    expect(validResumeQuestionForm(r[1], question(r, 1), false)).toBe(false);
  });
  it("rejects an inferred legacy freeText reference without a canonical question set", () => {
    const r = writtenReference(recording(["provider", "provider"]));
    for (const point of r.slice(1)) {
      const payload = point.interactions[1].payload;
      payload.questions = [{ id: "reference", prompt: "What reference should I include?", selectionMode: "single",
        options: [{ id: "write", label: "Write reference", freeText: true }] }];
      delete payload.questionSet;
    }
    expect(failed(r)).toContain("question-resume.forms");
  });
  it.each(["missing-custom", "disabled-custom", "missing-options", "duplicate-options", "missing-option-id", "multi-select", "extra-question",
    "wrong-request", "foreign-source", "foreign-agent", "foreign-company", "semantic", "api"])("rejects an unverified written-reference form: %s", kind => {
    const r = writtenReference(recording(["provider", kind === "semantic" || kind === "api" ? kind : "provider"]));
    const card = question(r, 1), field = card.payload.questionSet.questions[0];
    if (kind === "missing-custom") delete field.customAnswer;
    if (kind === "disabled-custom") field.customAnswer.enabled = false;
    if (kind === "missing-options") field.options = [];
    if (kind === "duplicate-options") field.options.push(structuredClone(field.options[0]));
    if (kind === "missing-option-id") delete field.options[0].id;
    if (kind === "multi-select") field.answerMode = "multi_select";
    if (kind === "extra-question") card.payload.questionSet.questions.push({ id: "extra", answerMode: "text" });
    if (kind === "wrong-request") card.payload.runtimeRequestId = "other";
    if (kind === "foreign-source") card.sourceRunId = "other";
    if (kind === "foreign-agent") card.createdByAgentId = "other";
    if (kind === "foreign-company") card.companyId = "other";
    expect(failed(r)).toContain("question-resume.forms");
  });
  it.each(["predefined-option", "wrong-text", "missing-text", "foreign-user", "changed-form"])("rejects a corrupt written-reference answer: %s", kind => {
    const r = writtenReference(recording(["provider", "provider"])), card = r[2].interactions[1], answer = card.result.answers[0];
    if (kind === "predefined-option") answer.optionIds = ["none"];
    if (kind === "wrong-text") answer.otherText = "Use OLD.";
    if (kind === "missing-text") delete answer.otherText;
    if (kind === "foreign-user") { card.resolvedByUserId = null; card.resolvedByAgentId = "agent"; }
    if (kind === "changed-form") card.payload.questionSet.questions[0].customAnswer.label = "Changed";
    expect(failed(r)).toContain("question-resume.text.answer");
  });
  it("accepts a native API creation receipt with the retained server response shape", () => {
    const point = JSON.parse(readFileSync(new URL("./fixtures/native-api-question.json", import.meta.url), "utf8"));
    expect(questionPath(point, point.interactions[0])).toBe("api");
    expect(validResumeQuestionForm(point, point.interactions[0], true)).toBe(true);
  });
  it.each(["missing", "pending", "wrong-operation", "wrong-result-operation", "unknown-outcome", "wrong-status", "missing-digest", "wrong-key",
    "foreign-card", "foreign-company", "foreign-issue", "foreign-agent", "foreign-source", "wrong-idempotency", "changed-form", "changed-compatibility-form",
    "board-created", "resolved-creation", "wrong-policy", "runtime-request", "legacy-run", "active-source", "foreign-run", "duplicate-source", "spoofed-store"])("rejects unverified native API provenance: %s", kind => {
    const point = JSON.parse(readFileSync(new URL("./fixtures/native-api-question.json", import.meta.url), "utf8"));
    const card = point.interactions[0], run = point.runs[0], receipts = run.resultJson.apiToolReceipts;
    const receipt = Object.values(receipts)[0] as Row, original = receipt.result.data;
    if (kind === "missing") delete run.resultJson.apiToolReceipts;
    if (kind === "pending") receipt.state = "pending";
    if (kind === "wrong-operation") receipt.operationId = "POST /api/issues/{id}/comments";
    if (kind === "wrong-result-operation") receipt.result.operationId = "POST /api/issues/{id}/comments";
    if (kind === "unknown-outcome") receipt.result.ok = false;
    if (kind === "wrong-status") receipt.result.status = 200;
    if (kind === "missing-digest") delete receipt.digest;
    if (kind === "wrong-key") run.resultJson.apiToolReceipts = { "model-authored-claim": receipt };
    if (kind === "foreign-card") original.id = "other";
    if (kind === "foreign-company") original.companyId = "other";
    if (kind === "foreign-issue") original.issueId = "other";
    if (kind === "foreign-agent") original.createdByAgentId = "other";
    if (kind === "foreign-source") original.sourceRunId = "other";
    if (kind === "wrong-idempotency") original.idempotencyKey = "other";
    if (kind === "changed-form") original.payload.questionSet.questions[0].options[1].label = "Other";
    if (kind === "changed-compatibility-form") original.payload.questions[0].prompt = "Other";
    if (kind === "board-created") original.createdByUserId = "other";
    if (kind === "resolved-creation") original.status = "answered";
    if (kind === "wrong-policy") card.continuationPolicy = "none";
    if (kind === "runtime-request") card.payload.runtimeRequestId = "fabricated-provider-request";
    if (kind === "legacy-run") run.runtimeMode = "legacy";
    if (kind === "active-source") run.status = "running";
    if (kind === "foreign-run") run.agentId = "other";
    if (kind === "duplicate-source") point.runs.push(structuredClone(run));
    if (kind === "spoofed-store") { run.resultJson.modelClaim = receipts; delete run.resultJson.apiToolReceipts; }
    expect(questionPath(point, card)).toBeNull();
  });
  it.each(["lost-receipt", "changed-receipt", "interactionId", "sourceRunId", "issueId", "interactionStatus", "duplicate-continuation"])("retains one immutable API receipt and one bound answer wake: %s", kind => {
    const r = recording(["api", "api"]), source = r[1].runs[0], next = r[1].runs[1];
    if (kind === "lost-receipt") delete source.resultJson.apiToolReceipts;
    else if (kind === "changed-receipt") source.resultJson.apiToolReceipts["a".repeat(64)].digest = "c".repeat(64);
    else if (kind === "duplicate-continuation") r[1].runs.push({ ...structuredClone(next), id: "extra" });
    else next.contextSnapshot[kind] = "other";
    expect(failed(r)).toContain("question-resume.choice.path");
  });
  it.each(["lost", "changed"])("rejects the first API receipt %s after the second answer", kind => {
    const r = recording(["api", "api"]), source = r[2].runs[0];
    if (kind === "lost") delete source.resultJson.apiToolReceipts;
    else source.resultJson.apiToolReceipts["a".repeat(64)].digest = "c".repeat(64);
    expect(failed(r)).toContain("question-resume.choice.path");
  });
  it("keeps the new journey explicit-only and the original documentation cells intact", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "question-resume");
    expect(cells.map(c => c.profile.id).sort()).toEqual(["runner-acpx-claude", "runner-codex"]);
    for (const c of cells) {
      expect(c.suite.manualOnly).toBe(true);
      expect(c.task).toMatchObject({ expectedRunCount: 3, minimumExpectedRunCount: 1, automaticRetryPolicy: "single_attempt" });
      expect(c.task.buildPrompt("nonce")).toBe(continuationScenario("question-tool-documentation", "nonce").prompt);
    }
    expect(runnerMatrix.filter(c => c.suite.id === "continuation")).toHaveLength(23);
  });
  it.each([
    ["provider", "provider"], ["provider", "semantic"], ["semantic", "provider"], ["semantic", "semantic"],
    ["api", "api"], ["api", "semantic"], ["semantic", "api"], ["provider", "api"], ["api", "provider"],
  ] as QuestionPath[][])("accepts exactly bound %s then %s journeys", (a, b) => {
    const r = recording([a,b]);
    expect(failed(r)).toEqual([]);
    expect(gradeContinuation({ ...continuationScenario("question-answer-resume", "nonce"), runtimeMode: "native", checkpoints: r }).filter(c => !c.passed)).toEqual([]);
    expect(gradeLifecycleBaseline(r).filter(c => !c.passed)).toEqual([]);
  });
  it.each([
    "Welcome to the afternoon meetup, AMBERnonce.",
    "Welcome to the afternoon meetup. Use AMBERnonce",
  ])("rejects a shortened supplied reference in the saved document: %s", body => {
    const r = recording();
    r[2].documents[0].body = body;
    expect(failed(r)).toContain("question-resume.complete-evidence");
  });
  it("does not admit an optional Other field on the semantic path", () => {
    const r = recording(["semantic", "semantic"]);
    const i = question(r);
    i.payload.questionSet.questions.push({ id: "field-2-question_0_custom-hash", answerMode: "text", header: "Other", required: false });
    expect(validResumeQuestionForm(r[0], i, true)).toBe(false);
  });
  it.each(["sourceRunId", "issueId", "companyId", "createdByAgentId", "idempotencyKey"])("rejects a provider card with mismatched %s", key => {
    const r = recording(); question(r)[key] = "unrelated";
    expect(failed(r)).toContain("question-resume.choice.path");
  });
  it("rejects a consistent foreign-company card/run pair on this task", () => {
    const r = recording(); question(r).companyId = "foreign"; r[0].runs[0].companyId = "foreign";
    expect(questionPath(r[0], question(r))).toBeNull();
  });
  it.each(["missing-request", "wrong-request", "terminal-run", "wrong-policy", "legacy-run"])("rejects invalid provider binding: %s", kind => {
    const r = recording(); const i = question(r);
    if (kind === "missing-request") delete i.payload.runtimeRequestId;
    if (kind === "wrong-request") i.payload.runtimeRequestId = "unrelated";
    if (kind === "terminal-run") r[0].runs[0].status = "succeeded";
    if (kind === "wrong-policy") i.continuationPolicy = "wake_assignee";
    if (kind === "legacy-run") r[0].runs[0].runtimeMode = "legacy";
    expect(questionPath(r[0], i)).toBeNull();
  });
  it.each(["missing", "wrong-operation", "rejected", "wrong-interaction", "wrong-source", "wrong-form"])("rejects missing or mismatched semantic receipt: %s", kind => {
    const r = recording(["semantic", "semantic"]); const i = question(r);
    const receipt = r[0].runs[0].resultJson.semanticToolReceipts[i.idempotencyKey];
    if (kind === "missing") delete r[0].runs[0].resultJson.semanticToolReceipts[i.idempotencyKey];
    if (kind === "wrong-operation") receipt.operationId = "write_document";
    if (kind === "rejected") receipt.result.disposition = "rejected";
    if (kind === "wrong-interaction") receipt.result.interaction.id = "unrelated";
    if (kind === "wrong-source") receipt.result.interaction.sourceRunId = "unrelated";
    if (kind === "wrong-form") receipt.result.interaction.payload.questionSet.questions = [];
    expect(questionPath(r[0], i)).toBeNull();
  });
  it.each(["required-other", "extra-question", "text-with-options", "two-early-cards"])("rejects the wrong form: %s", kind => {
    const r = recording(); const fields = question(r).payload.questionSet.questions;
    if (kind === "required-other") fields[1].required = true;
    if (kind === "extra-question") fields.push({ id: "extra", answerMode: "text" });
    if (kind === "text-with-options") question(r,1).payload.questionSet.questions[0].options = [{ id: "other" }];
    if (kind === "two-early-cards") r[0].interactions.push(structuredClone(question(r,1)));
    expect(failed(r)).toContain("question-resume.forms");
  });
  it.each(["agent-answer", "wrong-choice", "wrong-text", "duplicate-answer", "replaced-card", "changed-form", "changed-answer", "unanswered"])("rejects corrupt answer evidence: %s", kind => {
    const r = recording(); const first = r[1].interactions[0]; const last = r[2].interactions[1];
    if (kind === "agent-answer") { first.resolvedByUserId = null; first.resolvedByAgentId = "agent"; }
    if (kind === "wrong-choice") first.result.answers[0].optionIds = ["am"];
    if (kind === "wrong-text") last.result.answers[0].otherText = "wrong";
    if (kind === "duplicate-answer") first.result.answers.push(structuredClone(first.result.answers[0]));
    if (kind === "replaced-card") last.id = "replacement";
    if (kind === "changed-form") last.payload.questionSet.questions[0].prompt = "Changed question";
    if (kind === "changed-answer") r[2].interactions[0].result.answers[0].optionIds = ["am"];
    if (kind === "unanswered") last.status = "pending";
    expect(failed(r).some(id => id.endsWith(".answer"))).toBe(true);
  });
  it("rejects replacing a paused provider run with a fresh run", () => {
    const r = recording(); r[1].runs.push({ ...structuredClone(r[1].runs[0]), id: "replacement" });
    expect(failed(r)).toContain("question-resume.choice.path");
  });
  it.each(["interactionId", "sourceRunId", "issueId", "interactionStatus"])("rejects the wrong semantic response wake %s", key => {
    const r = recording(); r[2].runs[1].contextSnapshot[key] = "unrelated";
    expect(failed(r)).toContain("question-resume.text.path");
  });
  it.each(["lost-run", "duplicate-run", "extra-run", "missing-input", "missing-final", "missing-middle", "missing-output", "wrong-output"])("rejects incomplete continuation evidence: %s", kind => {
    const r = recording();
    if (kind === "lost-run") r[2].runs.shift();
    if (kind === "duplicate-run") r[2].runs.push(structuredClone(r[2].runs[0]));
    if (kind === "extra-run") r[2].runs.push({ ...structuredClone(r[2].runs[0]), id: "extra" });
    if (kind === "missing-input") delete r[2].runs[0].runnerProfileJson;
    if (kind === "missing-output") r[2].documents = [];
    if (kind === "wrong-output") r[2].documents[0].body = "Welcome AMBERnonce.";
    if (kind === "missing-final") r.pop();
    if (kind === "missing-middle") r.splice(1,1);
    expect(failed(r).length).toBeGreaterThan(0);
  });
});
