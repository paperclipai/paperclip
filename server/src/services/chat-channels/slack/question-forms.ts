import type { ModalResponse } from "chat";
import type { ChatQuestionFormSubmitTokenPayload } from "../../chat-question-forms.js";

/** Keep Slack's modal open when canonical answer validation rejects a field. */
export function slackQuestionFormValidationError(
  error: unknown,
  fields: ChatQuestionFormSubmitTokenPayload["fields"],
): ModalResponse | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as { status?: unknown; details?: { code?: unknown } };
  if (failure.status !== 422 || failure.details?.code !== "invalid_question_response") return null;
  const message = error instanceof Error ? error.message : "";
  const field = fields.find(item =>
    message === `Question ${item.questionId} does not match the required format`) ?? fields[0];
  if (!field) return null;
  return {
    action: "errors",
    errors: {
      [field.fieldId]: message.includes("does not match the required format")
        ? "Use the required format shown above."
        : "The answer could not be validated. Please try again.",
    },
  };
}
