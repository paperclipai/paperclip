import { describe, expect, it } from "vitest";
import { parsePaperclipQuestionResponse } from "../../contracts/question-set.js";
import { normalizeOpenCodeQuestionSet } from "./opencode-server-driver.js";

const question = { id: "reference", header: "Reference", question: "Which reference should appear in the note?",
  options: [{ label: "No reference", description: "Do not include a reference" }] };
const response = { schema: "paperclip.question_response.v1", answers: { reference: { customText: "Use AMBERexact." } } };

describe("OpenCode native written-answer defaults", () => {
  it.each([
    { name: "omitted native default", fields: {}, enabled: true },
    { name: "explicit native true", fields: { custom: true }, enabled: true },
    { name: "explicit native false", fields: { custom: false }, enabled: false },
    { name: "legacy alias true", fields: { allowCustom: true }, enabled: true },
    { name: "legacy alias false", fields: { allowCustom: false }, enabled: false },
    { name: "native opt-out takes precedence", fields: { custom: false, allowCustom: true }, enabled: false },
  ])("preserves $name without changing the supplied choice", ({ fields, enabled }) => {
    const set = normalizeOpenCodeQuestionSet([{ ...question, ...fields }]);
    expect(set.questions[0]).toMatchObject({ id: "reference", prompt: question.question, answerMode: "single_select",
      options: [{ id: "option-1", label: "No reference", description: "Do not include a reference" }] });
    if (enabled) {
      expect(set.questions[0].customAnswer).toEqual({ enabled: true, label: "Other", placeholder: "Enter another answer" });
      expect(parsePaperclipQuestionResponse(set, response)).toEqual(response);
    } else {
      expect(set.questions[0]).not.toHaveProperty("customAnswer");
      expect(() => parsePaperclipQuestionResponse(set, response)).toThrow("custom answers are not enabled");
    }
  });
  it.each([undefined, true, false])("keeps a question without choices text-only (custom=%s)", custom => {
    const set = normalizeOpenCodeQuestionSet([{ ...question, options: [], ...(custom === undefined ? {} : { custom }) }]);
    expect(set.questions[0]).toMatchObject({ id: "reference", answerMode: "text" });
    expect(set.questions[0]).not.toHaveProperty("options");
    expect(set.questions[0]).not.toHaveProperty("customAnswer");
    expect(parsePaperclipQuestionResponse(set, { ...response, answers: { reference: { text: "Use AMBERexact." } } }))
      .toEqual({ ...response, answers: { reference: { text: "Use AMBERexact." } } });
  });
});
