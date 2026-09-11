import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
  PAPERCLIP_QUESTION_SET_SCHEMA,
  parsePaperclipQuestionResponse,
  parsePaperclipQuestionSet,
  type PaperclipQuestionSet,
} from "./question-set.js";

const questionSet: PaperclipQuestionSet = {
  schema: PAPERCLIP_QUESTION_SET_SCHEMA,
  title: "Release input",
  questions: [
    {
      id: "environment",
      prompt: "Where should we deploy?",
      required: true,
      answerMode: "single_select",
      options: [
        { id: "staging", label: "Staging", recommended: true },
        { id: "production", label: "Production" },
      ],
      customAnswer: { enabled: true, label: "Other" },
    },
    {
      id: "replicas",
      prompt: "How many replicas?",
      required: true,
      answerMode: "text",
      textValidation: { inputType: "integer", minimum: 1, maximum: 20 },
    },
  ],
};

describe("Paperclip question-set contract", () => {
  it("round-trips the portable presentation model", () => {
    expect(parsePaperclipQuestionSet(questionSet)).toEqual(questionSet);
    expect(parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { selectedOptionIds: ["staging"] },
        replicas: { text: "3" },
      },
    })).toEqual({
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { selectedOptionIds: ["staging"] },
        replicas: { text: "3" },
      },
    });
  });

  it("rejects missing, unknown, and provider-shaped answers", () => {
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: { environment: { selectedOptionIds: ["unknown"] }, replicas: { text: "3" } },
    })).toThrow(/unknown option/);
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: { environment: { selectedOptionIds: ["staging"] } },
    })).toThrow(/replicas.*required/);
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      answers: { environment: { answers: ["Staging"] } },
    })).toThrow(/paperclip.question_response.v1/);
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { answers: ["Staging"] },
        replicas: { text: "3" },
      },
    })).toThrow(/canonical response contract/);
  });

  it("applies typed numeric validation before an adapter sees the answer", () => {
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { customText: "Canary" },
        replicas: { text: "3.5" },
      },
    })).toThrow(/valid integer/);
    expect(() => parsePaperclipQuestionResponse(questionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { customText: "Canary" },
        replicas: { text: "21" },
      },
    })).toThrow(/at most 20/);
  });

  const decisionQuestionSet = {
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: "Confirm the rollout",
    questions: [
      {
        id: "rollout",
        prompt: "Ship the migration to all customers today?",
        required: true,
        answerMode: "single_select" as const,
        intent: "decision" as const,
        recommendationRationale:
          "Staging is recommended because the canary window is still open and the rollback is one command.",
        options: [
          { id: "staging", label: "Stage first", recommended: true },
          { id: "all-customers", label: "All customers now" },
        ],
      },
    ],
  };

  it("round-trips a recommended decision question", () => {
    expect(parsePaperclipQuestionSet(decisionQuestionSet)).toEqual(decisionQuestionSet);
    expect(() => parsePaperclipQuestionResponse(decisionQuestionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: { rollout: { selectedOptionIds: ["staging"] } },
    })).not.toThrow();
  });

  it("refuses a decision question with no recommendation or rationale", () => {
    expect(() => parsePaperclipQuestionSet({
      ...decisionQuestionSet,
      questions: [{
        ...decisionQuestionSet.questions[0],
        recommendationRationale: undefined,
      }],
    })).toThrow(/recommendationRationale/);
    expect(() => parsePaperclipQuestionSet({
      ...decisionQuestionSet,
      questions: [{
        ...decisionQuestionSet.questions[0],
        options: [
          { id: "staging", label: "Stage first", recommended: true },
          { id: "all-customers", label: "All customers now", recommended: true },
        ],
      }],
    })).toThrow(/at most one option may be recommended/);
    expect(() => parsePaperclipQuestionSet({
      ...decisionQuestionSet,
      questions: [{
        ...decisionQuestionSet.questions[0],
        customAnswer: { enabled: true as const },
      }],
    })).toThrow(/custom answer/);
  });

  it("refuses a decision answered only with free text", () => {
    expect(() => parsePaperclipQuestionResponse(decisionQuestionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: { rollout: { customText: "Ship it everywhere" } },
    })).toThrow();
    expect(() => parsePaperclipQuestionResponse(decisionQuestionSet, {
      schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA,
      answers: { rollout: { selectedOptionIds: [] } },
    })).toThrow();
  });

  it("keeps information questions conversational", () => {
    const parsed = parsePaperclipQuestionSet(questionSet);
    expect(parsed).toEqual(questionSet);
    expect(parsed.questions[0].intent).toBeUndefined();
  });
});
