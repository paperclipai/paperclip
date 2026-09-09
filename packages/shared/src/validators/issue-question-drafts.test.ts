import { describe, expect, it } from "vitest";
import {
  putQuestionDraftRequestSchema,
  questionDraftResponseSchema,
} from "./issue.js";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTERACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("question draft contract", () => {
  it("accepts partial answers without requiring complete forms", () => {
    const parsed = putQuestionDraftRequestSchema.parse({
      answers: [{ questionId: "q1", optionIds: [] }],
      expectedRevision: 0,
    });

    expect(parsed.answers).toEqual([{ questionId: "q1", optionIds: [] }]);
  });

  it("preserves whitespace with an explicit optimistic revision guard", () => {
    const parsed = putQuestionDraftRequestSchema.parse({
      answers: [{ questionId: "q1", optionIds: ["a"], otherText: "  custom  " }],
      expectedRevision: 3,
    });

    expect(parsed.expectedRevision).toBe(3);
    expect(parsed.answers[0].otherText).toBe("  custom  ");
  });

  it("rejects malformed draft payloads", () => {
    expect(() => putQuestionDraftRequestSchema.parse({ answers: [] })).toThrow();
    expect(() => putQuestionDraftRequestSchema.parse({ expectedRevision: 0, answers: [{ questionId: "", optionIds: [] }] })).toThrow();
    expect(() => putQuestionDraftRequestSchema.parse({ expectedRevision: 0, answers: [{ questionId: "q1" }] })).toThrow();
    expect(() => putQuestionDraftRequestSchema.parse({ expectedRevision: 0, answers: "q1" })).toThrow();
    expect(() => putQuestionDraftRequestSchema.parse({
      answers: [],
      expectedRevision: -1,
    })).toThrow();
    expect(() => putQuestionDraftRequestSchema.parse({
      answers: Array.from({ length: 65 }, (_, index) => ({ questionId: `q${index}`, optionIds: [] })),
      expectedRevision: 0,
    })).toThrow();
  });


  it("rejects draft responses without a positive revision", () => {
    expect(() => questionDraftResponseSchema.parse({
      interactionId: INTERACTION_ID,
      issueId: ISSUE_ID,
      revision: 0,
      answers: [],
      updatedAt: new Date().toISOString(),
    })).toThrow();
  });
});
