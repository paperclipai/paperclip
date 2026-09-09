import { describe, expect, it } from "vitest";
import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import {
  draftAnswersKey,
  draftAnswersToLegacyForm,
  draftAnswersToQuestionResponse,
  legacyFormToDraftAnswers,
  questionResponseToDraftAnswers,
} from "./interaction-question-draft";

const LEGACY_QUESTIONS = [
  { id: "q1" },
  { id: "q2" },
];

const QUESTION_SET = {
  schema: "paperclip.question_set.v1",
  questions: [
    {
      id: "q1",
      prompt: "Pick one",
      required: true,
      answerMode: "single_select",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      customAnswer: { enabled: true, label: "Other" },
    },
    {
      id: "q2",
      prompt: "Describe it",
      required: false,
      answerMode: "text",
    },
  ],
} as unknown as PaperclipQuestionSet;

describe("legacy question draft converters", () => {
  it("round-trips option selections and Other text", () => {
    const canonical = legacyFormToDraftAnswers({
      questions: LEGACY_QUESTIONS,
      draftAnswers: { q1: ["a"] },
      draftOtherAnswers: { q2: " custom " },
      otherActive: { q2: true },
    });

    expect(canonical).toEqual([
      { questionId: "q1", optionIds: ["a"] },
      { questionId: "q2", optionIds: [], otherText: " custom " },
    ]);

    const form = draftAnswersToLegacyForm(canonical);
    expect(form).toEqual({
      draftAnswers: { q1: ["a"], q2: [] },
      draftOtherAnswers: { q2: " custom " },
      otherActive: { q2: true },
    });
  });

  it("omits questions without a value so partial drafts stay partial", () => {
    expect(legacyFormToDraftAnswers({
      questions: LEGACY_QUESTIONS,
      draftAnswers: {},
      draftOtherAnswers: { q2: "   " },
      otherActive: { q2: true },
    })).toEqual([{ questionId: "q2", optionIds: [], otherText: "   " }]);

    expect(draftAnswersToLegacyForm([])).toEqual({
      draftAnswers: {},
      draftOtherAnswers: {},
      otherActive: {},
    });
  });
});

describe("task-chat question draft converters", () => {
  it("round-trips select and text answers through the canonical shape", () => {
    const canonical = questionResponseToDraftAnswers(QUESTION_SET, {
      q1: { selectedOptionIds: ["a"], customText: " extra " },
      q2: { text: " hello " },
    });

    expect(canonical).toEqual([
      { questionId: "q1", optionIds: ["a"], otherText: " extra " },
      { questionId: "q2", optionIds: [], otherText: " hello " },
    ]);

    const restored = draftAnswersToQuestionResponse(QUESTION_SET, canonical);
    expect(restored).toEqual({
      responseAnswers: {
        q1: { selectedOptionIds: ["a"], customText: " extra " },
        q2: { text: " hello " },
      },
      customActive: { q1: true },
    });
  });

  it("skips unanswered questions", () => {
    expect(questionResponseToDraftAnswers(QUESTION_SET, {
      q1: { selectedOptionIds: [] },
      q2: {},
    })).toEqual([]);
  });

  it("restores an active Other field before any text is entered", () => {
    const canonical = questionResponseToDraftAnswers(QUESTION_SET, { q1: { customText: "" } });
    expect(draftAnswersToQuestionResponse(QUESTION_SET, canonical)).toEqual({
      responseAnswers: { q1: { selectedOptionIds: [], customText: "" } },
      customActive: { q1: true },
    });
    expect(draftAnswersKey(canonical)).not.toBe(draftAnswersKey([]));
  });
});

describe("draftAnswersKey", () => {
  it("treats reorderings as identical content", () => {
    const a = [
      { questionId: "q1", optionIds: ["b", "a"] },
      { questionId: "q2", optionIds: [] as string[], otherText: "x" },
    ];
    const b = [
      { questionId: "q2", optionIds: [] as string[], otherText: "x" },
      { questionId: "q1", optionIds: ["a", "b"] },
    ];
    expect(draftAnswersKey(a)).toBe(draftAnswersKey(b));
  });

  it("distinguishes real edits", () => {
    expect(draftAnswersKey([{ questionId: "q1", optionIds: ["a"] }])).not.toBe(
      draftAnswersKey([{ questionId: "q1", optionIds: ["b"] }]),
    );
  });
});

