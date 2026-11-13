import { describe, expect, it } from "vitest";
import { forbidden, unprocessable } from "../../../errors.js";
import { slackQuestionFormValidationError } from "./question-forms.js";

const fields = ["first", "second"].map(questionId => ({
  fieldId: `field-${questionId}`, questionId, kind: "text" as const,
  maxLength: 3000, minLength: 0, inputType: "text" as const, required: true,
}));

describe("Slack canonical form validation feedback", () => {
  it("attaches a format error to its question without reflecting internal details", () => {
    expect(slackQuestionFormValidationError(unprocessable(
      "Question second does not match the required format", { code: "invalid_question_response" },
    ), fields)).toEqual({ action: "errors", errors: { "field-second": "Use the required format shown above." } });
  });

  it("uses safe feedback when canonical validation has no specific field", () => {
    expect(slackQuestionFormValidationError(unprocessable(
      "private validation detail", { code: "invalid_question_response" },
    ), fields)).toEqual({ action: "errors", errors: { "field-first": "The answer could not be validated. Please try again." } });
  });

  it("leaves authorization and unrelated failures to shared handling", () => {
    for (const error of [null, forbidden(), unprocessable("Other failure"), new Error("transport failure")]) {
      expect(slackQuestionFormValidationError(error, fields)).toBeNull();
    }
  });
});
