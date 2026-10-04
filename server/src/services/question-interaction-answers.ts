import type { AskUserQuestionsAnswer, AskUserQuestionsPayload, PaperclipQuestionSetPayload } from "@paperclipai/shared";
import { parsePaperclipQuestionResponse, type PaperclipQuestionResponse } from "../vendor/paperclip-runner/index.js";
import { validateQuestionPatterns } from "./question-pattern-validation.js";

function prepareQuestionInteractionAnswers(
  questionSet: PaperclipQuestionSetPayload,
  answers: readonly AskUserQuestionsAnswer[],
  storageQuestions: AskUserQuestionsPayload["questions"],
) {
  const answerByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const response: PaperclipQuestionResponse = {
    schema: "paperclip.question_response.v1",
    answers: {},
  };
  for (const question of questionSet.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (!answer) continue;
    if (question.answerMode === "text") {
      response.answers[question.id] = {
        ...(answer.otherText !== undefined && answer.otherText !== null
          ? { text: answer.otherText }
          : {}),
      };
    } else {
      const customOptionId = storageQuestions.find((entry) => entry.id === question.id)
        ?.options.find((option) => option.freeText)?.id ?? null;
      response.answers[question.id] = {
        selectedOptionIds: answer.optionIds.filter((optionId) => optionId !== customOptionId),
        ...(answer.otherText !== undefined && answer.otherText !== null
          ? { customText: answer.otherText }
          : {}),
      };
    }
  }
  // Historical dual forms may offer a written answer only in storage. Keep
  // that pending answer path usable; new creation rejects this mismatch.
  const answerableQuestionSet = {
    ...questionSet,
    questions: questionSet.questions.map((question) => {
      const storage = storageQuestions.find((entry) => entry.id === question.id);
      if (question.answerMode !== "text" && !question.customAnswer
        && (storage?.allowOther === true || storage?.options.some((option) => option.freeText))) {
        return { ...question, customAnswer: { enabled: true as const } };
      }
      return question;
    }),
  };
  // The portable parser uses JavaScript regexes. Validate all other fields
  // there, but run pattern matching only in a bounded, isolated worker.
  const withoutPatterns = {
    ...answerableQuestionSet,
    questions: answerableQuestionSet.questions.map((question) => {
      if (!question.textValidation) return question;
      const { pattern: _pattern, ...textValidation } = question.textValidation;
      return { ...question, textValidation };
    }),
  };
  const parsed = parsePaperclipQuestionResponse(withoutPatterns, response);
  const checks = answerableQuestionSet.questions.flatMap((question) => {
    const pattern = question.textValidation?.pattern;
    const answer = parsed.answers[question.id];
    const text = question.answerMode === "text" ? answer?.text : answer?.customText;
    return pattern !== undefined && text !== undefined ? [{ questionId: question.id, pattern, text }] : [];
  });
  return { parsed, checks };
}

/** Validate untrusted answers before persistence, including bounded patterns. */
export async function parseQuestionInteractionAnswers(
  questionSet: PaperclipQuestionSetPayload,
  answers: readonly AskUserQuestionsAnswer[],
  storageQuestions: AskUserQuestionsPayload["questions"],
): Promise<PaperclipQuestionResponse> {
  const { parsed, checks } = prepareQuestionInteractionAnswers(questionSet, answers, storageQuestions);
  await validateQuestionPatterns(checks);
  return parsed;
}

/** Saved answers already passed pattern validation; delivery must not depend on worker capacity. */
export function parseSavedQuestionInteractionAnswers(
  questionSet: PaperclipQuestionSetPayload,
  answers: readonly AskUserQuestionsAnswer[],
  storageQuestions: AskUserQuestionsPayload["questions"],
): PaperclipQuestionResponse {
  return prepareQuestionInteractionAnswers(questionSet, answers, storageQuestions).parsed;
}
