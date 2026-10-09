import { describe, expect, it } from "vitest";
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
    const provider = paths[n] === "provider";
    const request = `request-${n}`;
    const idempotencyKey = provider ? `paperclip-runner-question:${run.id}:${request}` : `question-${n}`;
    const field = n === 0 ? { id: "field-1-question_0-hash", answerMode: "single_select", options: [
      { id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" },
    ] } : { id: "reference", answerMode: "text" };
    const questions: Row[] = [field];
    if (provider && n === 0) questions.push({ id: "field-2-question_0_custom-hash", answerMode: "text", header: "Other", required: false });
    const card: Row = { id: `card-${n}`, kind: "ask_user_questions", status: "pending",
      companyId: "company", issueId: "task", createdByAgentId: "agent", sourceRunId: run.id, idempotencyKey,
      continuationPolicy: provider ? "none" : "wake_assignee",
      payload: { ...(provider ? { runtimeRequestId: request } : {}), questionSet: { questions } } };
    cards.push(card);
    if (!provider) {
      run.status = "succeeded";
      run.resultJson.semanticToolReceipts[idempotencyKey] = { operationId: "request_human_input",
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

describe("native question/resume path qualification", () => {
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
