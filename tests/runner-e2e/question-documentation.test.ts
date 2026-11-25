import { describe, expect, it } from "vitest";
import { gradeQuestionDocumentation } from "./question-documentation-scoring.js";
import type { ContinuationCheckpoint } from "./continuation-scoring.js";
import { runnerMatrix } from "./catalog.js";

function recording() {
  const choice = { id: "time", prompt: "Which time?", answerMode: "single_select", options: [
    { id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" },
  ] };
  const text = { id: "reference", prompt: "What reference?", answerMode: "text" };
  const first: any = { id: "first", kind: "ask_user_questions", status: "pending", payload: { questionSet: { questions: [choice] } } };
  const second: any = { id: "second", kind: "ask_user_questions", status: "pending", payload: { questionSet: { questions: [text] } } };
  const answeredFirst = { ...structuredClone(first), status: "answered", result: { answers: [{ questionId: "time", optionIds: ["pm"] }] } };
  const answeredSecond = { ...structuredClone(second), status: "answered", result: { answers: [{ questionId: "reference", optionIds: [], otherText: "Use AMBER123." }] } };
  const runs = [1, 2, 3].map(id => ({ id: String(id), status: "succeeded", runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: { task: { prompt: "Use Paperclip's request_human_input for durable task questions." } } } }));
  const checkpoint = (phase: ContinuationCheckpoint["phase"], interactions: any[], count: number): ContinuationCheckpoint => ({
    phase, issue: { id: "task", status: phase === "final" ? "done" : "in_review" }, children: [], attachments: [], comments: [],
    interactions, runs: runs.slice(0, count),
    documents: phase === "final" ? [{ key: "note", latestRevisionId: "saved", body: "Welcome to the afternoon meetup, AMBER123." }] : [],
  });
  return [checkpoint("initial", [first], 1), checkpoint("answered", [answeredFirst, second], 2), checkpoint("final", [structuredClone(answeredFirst), answeredSecond], 3)];
}
const failed = (checkpoints: ContinuationCheckpoint[]) => gradeQuestionDocumentation(checkpoints, "AMBER123").filter(c => !c.passed).map(c => c.id);

describe("question tool documentation regression", () => {
  it("runs against both native providers with production instructions", () => {
    const cells = runnerMatrix.filter(c => c.task.id === "question-tool-documentation");
    expect(cells.map(c => c.profile.id).sort()).toEqual(["runner-acpx-claude", "runner-codex"]);
    for (const c of cells) {
      const prompt = c.task.buildPrompt("nonce");
      expect(prompt).not.toMatch(/request_human_input|questionSet|selectionMode|payload\./);
      expect(c.suite.manualOnly).not.toBe(true);
    }
  });
  it("passes real choices followed by a text field and both recorded answers", () => {
    expect(failed(recording())).toEqual([]);
  });
  it("rejects a lone choice", () => {
    const r = recording();
    (r[0].interactions[0] as any).payload.questionSet.questions[0].options.shift();
    expect(failed(r)).toContain("meaningful-choice-form");
  });
  it("rejects a lone Other choice instead of a text field", () => {
    const r = recording();
    Object.assign((r[1].interactions[1] as any).payload.questionSet.questions[0], { answerMode: "single_select", options: [{ id: "other", label: "Other" }] });
    expect(failed(r)).toContain("text-form-after-choice");
  });
  it("rejects asking both questions before the first answer", () => {
    const r = recording();
    r[0].interactions.push(structuredClone(r[1].interactions[1]));
    expect(failed(r)).toContain("meaningful-choice-form");
  });
  it("rejects fabricated or duplicated responses", () => {
    const r = recording();
    (r[2].interactions[0] as any).result.answers[0].optionIds = ["am"];
    expect(failed(r)).toContain("actual-question-answers");
    r[2].interactions.push(structuredClone(r[2].interactions[1]));
    expect(failed(r)).toContain("actual-question-answers");
  });
  it("rejects the old instruction block copied into a later turn", () => {
    const r = recording();
    (r[2].runs[2] as any).runnerProfileJson.nativeExecutionInput.task.prompt += "\n## Questions that need a user response\npayload.questionSet";
    expect(failed(r)).toContain("question-guidance-not-in-wake");
  });
  it("requires recorded inputs rather than assuming docs-only delivery", () => {
    const r = recording();
    delete (r[2].runs[2] as any).runnerProfileJson;
    expect(failed(r)).toContain("question-guidance-not-in-wake");
  });
  it("requires both real answers in the saved result", () => {
    const r = recording();
    r[2].documents[0].body = "Welcome AMBER123.";
    expect(failed(r)).toContain("both-answers-in-output");
  });
});
