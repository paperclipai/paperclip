import type { ContinuationCheckpoint } from "./continuation-scoring.js";

type Row = Record<string, any>;
const questions = (checkpoint?: ContinuationCheckpoint): Row[] =>
  (checkpoint?.interactions ?? []).filter((value: any) => value.kind === "ask_user_questions") as Row[];
function form(row?: Row) {
  const payload = row?.payload;
  const canonical = payload?.questionSet?.questions;
  if (canonical) return canonical;
  return (payload?.questions ?? []).map((q: Row) => ({
    ...q, answerMode: q.selectionMode === "multi" ? "multi_select" : "single_select",
  }));
}

/** Checks real recorded forms, responses, and native task inputs; no model judge. */
export function gradeQuestionDocumentation(checkpoints: ContinuationCheckpoint[], marker: string) {
  const initial = checkpoints.find(c => c.phase === "initial");
  const middle = checkpoints.find(c => c.phase === "answered");
  const final = checkpoints.find(c => c.phase === "final");
  const first = questions(initial)[0];
  const next = questions(middle).filter(q => q.status === "pending");
  const choice = form(first)[0];
  const text = form(next[0])[0];
  const options: Row[] = choice?.options ?? [];
  const afternoon = options.find(o => /^afternoon\b/i.test(String(o.label).trim()));
  const firstAnswer = questions(final).find(q => q.id === first?.id);
  const secondAnswer = questions(final).find(q => q.id === next[0]?.id);
  const inputs = (final?.runs ?? []).map((run: any) => run.runnerProfileJson?.nativeExecutionInput?.task?.prompt);
  const checks = [
    {
      id: "meaningful-choice-form",
      passed: questions(initial).length === 1 && first?.status === "pending" && form(first).length === 1
        && choice?.answerMode === "single_select" && options.length >= 2
        && new Set(options.map(o => o.id)).size === options.length
        && options.some(o => /^morning\b/i.test(String(o.label).trim())) && Boolean(afternoon),
      detail: "The first card must show one single-choice question with distinct Morning and Afternoon options.",
    },
    {
      id: "text-form-after-choice",
      passed: questions(middle).length === 2 && next.length === 1 && form(next[0]).length === 1
        && next[0]?.id !== first?.id && text?.answerMode === "text"
        && !text?.options?.length && !text?.customAnswer
        && questions(middle).some(q => q.id === first?.id && q.status === "answered"),
      detail: "Only after the choice is answered may the second, text-only question appear.",
    },
    {
      id: "actual-question-answers",
      passed: questions(final).length === 2 && firstAnswer?.status === "answered" && secondAnswer?.status === "answered"
        && firstAnswer?.result?.answers?.some((a: Row) => a.questionId === choice?.id && a.optionIds?.includes(afternoon?.id))
        && secondAnswer?.result?.answers?.some((a: Row) => a.questionId === text?.id && a.otherText?.includes(marker)),
      detail: "Both real UI submissions must be persisted against their original question IDs, with no duplicate question cards.",
    },
    {
      id: "question-guidance-not-in-wake",
      passed: inputs.length >= 3 && inputs.every(prompt => typeof prompt === "string"
        && prompt.includes("Use Paperclip's request_human_input for durable task questions.")
        && !prompt.includes("## Questions that need a user response")
        && !prompt.includes("payload.questionSet")
        && !prompt.includes("Create a durable human question or approval card on the current Paperclip task bound to this run")),
      detail: "Every recorded native turn must retain the short routing hint without the old question block or copied tool-format instructions.",
    },
    {
      id: "both-answers-in-output",
      passed: Boolean(final?.documents.some(d => d.key !== "plan" && d.body.includes(marker) && /\bafternoon\b/i.test(d.body))),
      detail: "The saved note must use both the selected time and the literal reference supplied in the text answer.",
    },
  ];
  return checks.map(check => ({ ...check, passed: Boolean(check.passed) }));
}
