import type { AskUserQuestionsPayload, PaperclipQuestionSetPayload } from "./types/issue.js";

function syntheticOptionId(existing: readonly string[], preferred: string): string {
  const ids = new Set(existing);
  let candidate = preferred;
  for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${preferred}_${suffix}`;
  return candidate;
}

/** Project a complete canonical form into the legacy storage/answer contract. */
export function questionSetToAskUserQuestionsPayload(
  questionSet: PaperclipQuestionSetPayload,
): AskUserQuestionsPayload {
  return {
    version: 1,
    ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
    ...(questionSet.submitLabel ? { submitLabel: questionSet.submitLabel.slice(0, 120) } : {}),
    questionSet,
    questions: questionSet.questions.map((question) => {
      const options = (question.options ?? []).map(({ id, label, description }) => ({
        id, label, ...(description !== undefined ? { description } : {}),
      }));
      const freeTextOption = question.answerMode === "text"
        ? {
            id: "paperclip_text_answer",
            label: question.header || "Type an answer",
            ...(question.textValidation?.inputType
              ? { description: `Expected ${question.textValidation.inputType} input` } : {}),
            freeText: true as const,
          }
        : question.customAnswer?.enabled
          ? {
              id: syntheticOptionId(options.map((option) => option.id), "paperclip_custom_answer"),
              label: question.customAnswer.label || "Other",
              ...(question.customAnswer.placeholder !== undefined
                ? { description: question.customAnswer.placeholder } : {}),
              freeText: true as const,
            }
          : null;
      return {
        id: question.id,
        prompt: question.prompt,
        ...((question.helpText || question.header) ? { helpText: question.helpText ?? question.header } : {}),
        selectionMode: question.answerMode === "multi_select" ? "multi" : "single",
        required: question.required,
        allowOther: freeTextOption !== null,
        options: freeTextOption ? [...options, freeTextOption] : options,
      };
    }),
  };
}
