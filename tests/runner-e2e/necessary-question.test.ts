import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { continuationScenario, necessaryQuestionContract } from "./continuation-cases.js";
import { gradeNecessaryQuestion } from "./necessary-question.js";
import { gradeContinuation, type ContinuationCheckpoint } from "./continuation-scoring.js";
import { gradeLifecycleBaseline } from "./lifecycle-baseline.js";

type Row = Record<string, any>;
function recording(provider = false): any[] {
  const contract = necessaryQuestionContract(), scenario = continuationScenario("necessary-free-text", "nonce");
  const card: Row = { id: "card", kind: "ask_user_questions", status: "pending", companyId: "company", issueId: "task", createdByAgentId: "agent",
    sourceRunId: "first", continuationPolicy: provider ? "none" : "wake_assignee",
    idempotencyKey: provider ? "paperclip-runner-question:first:request" : "question",
    payload: { ...(provider ? { runtimeRequestId: "request" } : {}), questionSet: { schema: "paperclip.question_set.v1", description: contract.context,
      questions: [{ id: "reference", answerMode: "text", prompt: contract.prompt, required: true }] } } };
  const run: Row = { id: "first", companyId: "company", issueId: "task", agentId: "agent", status: provider ? "running" : "succeeded", runtimeMode: "native",
    nativePhase: provider ? "running" : "committed", resultJson: { finalizationPhase: provider ? null : "committed", semanticToolReceipts: provider ? {} : {
      question: { operationId: "request_human_input", result: { disposition: "applied", interaction: structuredClone(card) } },
    } } };
  const initial = { phase: "initial", issue: { id: "task", companyId: "company", assigneeAgentId: "agent", status: provider ? "in_progress" : "in_review" },
    lifecycle: { executionRunId: provider ? "first" : null, scheduledRetry: null, activeRecoveryAction: null, monitorNextCheckAt: null },
    runs: [run], interactions: [card], documents: [], children: [], attachments: [], comments: [],
    questionPresentation: { interactionId: "card", promptVisible: true, contextVisible: true } };
  const final = structuredClone(initial) as Row;
  final.phase = "final"; final.issue.status = "done"; final.lifecycle.executionRunId = null;
  final.interactions[0] = { ...final.interactions[0], status: "answered", resolvedByUserId: "local-board",
    result: { answers: [{ questionId: "reference", optionIds: [], otherText: scenario.answer }] } };
  if (provider) { final.runs[0].status = "succeeded"; final.runs[0].nativePhase = "committed"; final.runs[0].resultJson.finalizationPhase = "committed"; }
  else final.runs.push({ ...structuredClone(run), id: "second", contextSnapshot: { issueId: "task", sourceRunId: "first",
    interactionId: "card", interactionKind: "ask_user_questions", interactionStatus: "answered" } });
  final.outputDocument = { issueId: "task", key: "confirmation", revisionId: "revision", href: "/QA/issues/task#document-confirmation", visibleBody: `Booking confirmed: ${scenario.answer}` };
  final.documents = [{ key: "confirmation", body: `Booking confirmed: ${scenario.answer}`, latestRevisionId: "revision" }];
  return [structuredClone(initial), final];
}
const failures = (points: ContinuationCheckpoint[]) => gradeNecessaryQuestion(points, continuationScenario("necessary-free-text", "nonce").answer).filter(check => !check.passed);

describe("necessary free-text question journey", () => {
  it.each([false, true])("accepts one exactly bound answer on the provider path=%s", provider => {
    const points = recording(provider);
    expect(failures(points)).toEqual([]);
    expect(gradeContinuation({ ...continuationScenario("necessary-free-text", "nonce"), runtimeMode: "native", checkpoints: points }).filter(check => !check.passed)).toEqual([]);
    expect(gradeLifecycleBaseline(points).filter(check => !check.passed)).toEqual([]);
  });
  it.each([
    ["title without question", (points: Row[]) => { points[0].interactions[0].payload.questionSet.questions[0].prompt = "Booking reference"; }],
    ["missing explanation", (points: Row[]) => { delete points[0].interactions[0].payload.questionSet.description; }],
    ["choice instead of text", (points: Row[]) => { points[0].interactions[0].payload.questionSet.questions[0].answerMode = "single_select"; }],
    ["optional question", (points: Row[]) => { points[0].interactions[0].payload.questionSet.questions[0].required = false; }],
    ["hidden context", (points: Row[]) => { points[0].questionPresentation.contextVisible = false; }],
    ["unrelated rendered card", (points: Row[]) => { points[0].questionPresentation.interactionId = "foreign"; }],
    ["missing semantic receipt", (points: Row[]) => { points[0].runs[0].resultJson.semanticToolReceipts = {}; }],
    ["foreign question", (points: Row[]) => { points[0].interactions[0].companyId = "foreign"; }],
    ["foreign resolved company", (points: Row[]) => { points[1].interactions[0].companyId = "foreign"; }],
    ["changed creator", (points: Row[]) => { points[1].interactions[0].createdByAgentId = "foreign"; }],
    ["changed idempotency key", (points: Row[]) => { points[1].interactions[0].idempotencyKey = "foreign"; }],
    ["changed continuation policy", (points: Row[]) => { points[1].interactions[0].continuationPolicy = "none"; }],
    ["fabricated agent answer", (points: Row[]) => { points[1].interactions[0].resolvedByAgentId = "agent"; }],
    ["wrong answer", (points: Row[]) => { points[1].interactions[0].result.answers[0].otherText = "invented"; }],
    ["duplicate answer", (points: Row[]) => { points[1].interactions[0].result.answers.push(points[1].interactions[0].result.answers[0]); }],
    ["changed question", (points: Row[]) => { points[1].interactions[0].payload.questionSet.questions[0].prompt = "Different question"; }],
    ["duplicate wake", (points: Row[]) => { points[1].runs.push({ ...points[1].runs[1], id: "third" }); }],
    ["wrong wake binding", (points: Row[]) => { points[1].runs[1].contextSnapshot.interactionId = "foreign"; }],
    ["uncommitted result", (points: Row[]) => { points[1].runs[1].resultJson.finalizationPhase = "pending"; }],
    ["wrong saved result", (points: Row[]) => { points[1].documents[0].body = "Claimed complete"; }],
    ["inaccessible result", (points: Row[]) => { delete points[1].outputDocument; }],
    ["foreign linked task", (points: Row[]) => { points[1].outputDocument.issueId = "foreign"; }],
    ["different linked document", (points: Row[]) => { points[1].outputDocument.key = "other"; }],
    ["stale linked revision", (points: Row[]) => { points[1].outputDocument.revisionId = "older"; }],
    ["wrong displayed content", (points: Row[]) => { points[1].outputDocument.visibleBody = "Claimed complete"; }],
    ["duplicate question", (points: Row[]) => { points[1].interactions.push(points[1].interactions[0]); }],
  ] as const)("rejects %s", (_name, change) => { const points = recording(); change(points); expect(failures(points).length).toBeGreaterThan(0); });
  it("does not put the required answer in the original request", () => {
    const scenario = continuationScenario("necessary-free-text", "nonce");
    expect(scenario.prompt).not.toContain(scenario.marker);
    expect(scenario.prompt).toContain("has not been supplied");
  });
  it("registers four explicit development cells without claiming staging or Slack proof", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "necessary-question");
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map(cell => cell.profile.model))).toEqual(new Set(["gpt-6.1-sol", "claude-opus-5-5"]));
    expect(cells.every(cell => cell.suite.manualOnly && cell.suite.groups.length === 0 && cell.suite.definitionMetadata?.stagingQualification === false && cell.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(runnerMatrix.filter(cell => cell.suite.id === "question-resume")).toHaveLength(2);
    expect(runnerMatrix.filter(cell => cell.suite.id === "continuation")).toHaveLength(23);
  });
});
