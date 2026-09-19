import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import type { AskUserQuestionsInteraction } from "@/lib/issue-thread-interactions";

/**
 * The question set the compact card renders for an `ask_user_questions`
 * interaction.
 *
 * Agents mirror only their open-ended questions in `payload.questionSet`, while
 * the server validates answers against every entry of `payload.questions`.
 * Present the union, or a required choice question stays hidden and the card
 * can never be submitted.
 */
export function questionSetForInteraction(
  interaction: AskUserQuestionsInteraction,
): PaperclipQuestionSet {
  const presented = interaction.payload.questionSet;
  if (presented) {
    const presentedById = new Map(presented.questions.map((question) => [question.id, question]));
    // The server enforces `required` from `payload.questions`, so a mirror
    // that relaxes it would let the form submit an answer the server rejects.
    const requiredIds = new Set(
      interaction.payload.questions.filter((question) => question.required === true).map((question) => question.id),
    );
    const relaxesRequired = (question: PaperclipQuestionSet["questions"][number]) =>
      requiredIds.has(question.id) && question.required !== true;
    if (
      interaction.payload.questions.every((question) => presentedById.has(question.id)) &&
      !presented.questions.some(relaxesRequired)
    ) {
      return presented;
    }
    const allowsOther = new Map(
      interaction.payload.questions.map((question) => [question.id, question.allowOther !== false]),
    );
    // Follow the author's order in `payload.questions`, taking the presented
    // mirror of a question when there is one.
    const ordered = legacyQuestionSetQuestions(interaction).map((question) => {
      const mirrored = presentedById.get(question.id);
      if (mirrored) return relaxesRequired(mirrored) ? { ...mirrored, required: true } : mirrored;
      // The form-wide implicit "Other" is off once a questionSet is stored, so
      // projected choice questions carry the fallback the legacy card shows.
      return question.customAnswer || !allowsOther.get(question.id)
        ? question
        : { ...question, customAnswer: { enabled: true as const } };
    });
    const orderedIds = new Set(ordered.map((question) => question.id));
    const presentedOnly = presented.questions.filter((question) => !orderedIds.has(question.id));
    return { ...presented, questions: [...ordered, ...presentedOnly] };
  }
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel
      ? { submitLabel: interaction.payload.submitLabel }
      : {}),
    questions: legacyQuestionSetQuestions(interaction),
  };
}

function legacyQuestionSetQuestions(
  interaction: AskUserQuestionsInteraction,
): PaperclipQuestionSet["questions"] {
  return interaction.payload.questions.map((question) => {
    const freeText = question.options.find(
      (option) => option.freeText === true,
    );
    return {
      id: question.id,
      prompt: question.prompt,
      ...(question.helpText ? { helpText: question.helpText } : {}),
      required: question.required === true,
      answerMode:
        question.selectionMode === "multi"
          ? ("multi_select" as const)
          : ("single_select" as const),
      options: question.options
        .filter((option) => option.freeText !== true)
        .map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
      ...(freeText
        ? {
            customAnswer: {
              enabled: true as const,
              label: freeText.label,
              ...(freeText.description
                ? { placeholder: freeText.description }
                : {}),
            },
          }
        : {}),
    };
  });
}
