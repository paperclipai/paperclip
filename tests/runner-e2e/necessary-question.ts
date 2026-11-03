import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { continuationScenario, continuationTasks, necessaryQuestionContract } from "./continuation-cases.js";
import { questionResumedOnce, sameQuestion, validResumeQuestionForm } from "./question-resume-scoring.js";
import type { ContinuationCheckpoint } from "./continuation-scoring.js";
import type { RunnerTaskFixture } from "./types.js";

type Row = Record<string, any>;
export const necessaryQuestionTask: RunnerTaskFixture = {
  ...continuationTasks.find(task => task.id === "answer-updates-scope")!,
  id: "necessary-free-text", label: "Necessary free-text question and one continuation",
  expectedRunCount: 2, minimumExpectedRunCount: 1, attemptTimeoutMs: { local: 10 * 60_000, daytona: 15 * 60_000 }, turnTimeoutMs: 4 * 60_000,
  buildTitle: nonce => `Booking confirmation ${nonce}`,
  buildPrompt: nonce => continuationScenario("necessary-free-text", nonce).prompt,
  buildVisibleMarker: nonce => continuationScenario("necessary-free-text", nonce).marker,
};

export function gradeNecessaryQuestion(checkpoints: ContinuationCheckpoint[], answer: string) {
  const initial = checkpoints.find(point => point.phase === "initial"), final = checkpoints.find(point => point.phase === "final");
  const cards = (point?: ContinuationCheckpoint) => (point?.interactions ?? []).filter((value: any) => value.kind === "ask_user_questions") as Row[];
  const pending = cards(initial), finished = cards(final), question = pending[0], resolved = finished[0];
  const field = question?.payload?.questionSet?.questions?.[0], contract = necessaryQuestionContract();
  const check = (id: string, passed: boolean, detail: string) => ({ id, passed: Boolean(passed), detail });
  const response = resolved?.result?.answers, document = final?.documents[0], navigation = final?.outputDocument;
  return [
    check("necessary-question.form", checkpoints.length === 2 && !!initial && pending.length === 1 && question?.status === "pending" && initial.documents.length === 0 && initial.attachments.length === 0 &&
      validResumeQuestionForm(initial, question, false) && field?.required === true && field.prompt === contract.prompt &&
      [question.payload.questionSet.description, field.helpText].includes(contract.context),
      "One bound text-only question must show the required prompt and its explanation before delivery."),
    check("necessary-question.visible", initial?.questionPresentation?.interactionId === question?.id &&
      initial?.questionPresentation?.promptVisible === true && initial?.questionPresentation?.contextVisible === true,
      "The browser must observe the actual question and context, not only its title."),
    check("necessary-question.answer", finished.length === 1 && !!question && sameQuestion(question, resolved) && resolved?.status === "answered" &&
      typeof resolved.resolvedByUserId === "string" && !!resolved.resolvedByUserId && !resolved.resolvedByAgentId &&
      Array.isArray(response) && response.length === 1 && response[0]?.questionId === field?.id && response[0]?.otherText === answer &&
      !response[0]?.optionIds?.length,
      "One real user answer must remain attached to the unchanged question."),
    check("necessary-question.one-continuation", questionResumedOnce(initial, final, question) && !!final && final.runs.length <= 2 &&
      final.runs.every((run: Row) => run.status === "succeeded" && run.runtimeMode === "native" && run.nativePhase === "committed" && run.resultJson?.finalizationPhase === "committed"),
      "The answer must resume its bound provider run or admit exactly one bound semantic successor, without duplicate work."),
    check("necessary-question.result", final?.issue.status === "done" && final.documents.length === 1 &&
      !!document?.latestRevisionId && document?.body.trim() === `Booking confirmed: ${answer}` &&
      navigation?.issueId === final.issue.id && navigation?.key === document.key && navigation?.revisionId === document.latestRevisionId &&
      navigation?.visibleBody === document.body.trim(),
      "The final reply must open this task's saved confirmation and show its exact answer."),
  ];
}

export function necessaryQuestionDigest() {
  const hash = createHash("sha256");
  for (const file of ["necessary-question.ts", "continuation-cases.ts", "continuation-flow.ts", "continuation-scoring.ts", "question-resume-scoring.ts", "stock-harness.ts"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
