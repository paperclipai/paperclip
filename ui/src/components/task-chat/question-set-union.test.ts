import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@/lib/issue-thread-interactions";
import { questionSetForInteraction } from "./question-set-union";

type Payload = AskUserQuestionsInteraction["payload"];

function questions(payload: Payload): AskUserQuestionsInteraction {
  return {
    id: "questions-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "ask_user_questions",
    title: "Three things to start",
    summary: null,
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-09-17T15:06:18.000Z"),
    updatedAt: new Date("2026-09-17T15:06:18.000Z"),
    resolvedAt: null,
    payload,
    result: null,
  } as AskUserQuestionsInteraction;
}

const choice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  prompt: `Pick ${id}`,
  selectionMode: "single" as const,
  required: true,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  ...extra,
});
const typed = (id: string) => ({
  id,
  prompt: `Describe ${id}`,
  selectionMode: "single" as const,
  required: true,
  options: [{ id: "type", label: "Type it" }],
});
const mirror = (id: string) => ({
  id,
  prompt: `Describe ${id}`,
  required: true,
  answerMode: "text" as const,
});

describe("questionSetForInteraction", () => {
  it("projects the legacy questions when no question set is stored", () => {
    const set = questionSetForInteraction(questions({ version: 1, questions: [choice("env")] } as Payload));
    expect(set.questions.map((question) => [question.id, question.answerMode])).toEqual([
      ["env", "single_select"],
    ]);
  });

  it("returns the stored question set untouched when it mirrors every question", () => {
    const questionSet = { schema: "paperclip.question_set.v1" as const, questions: [mirror("site")] };
    const set = questionSetForInteraction(
      questions({ version: 1, questions: [typed("site")], questionSet } as Payload),
    );
    expect(set).toBe(questionSet);
  });

  it("presents choice questions the stored question set leaves out, in the author's order", () => {
    const set = questionSetForInteraction(
      questions({
        version: 1,
        questions: [choice("env"), typed("site"), choice("analytics"), typed("handles")],
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [mirror("site"), mirror("handles")],
        },
      } as Payload),
    );
    expect(set.questions.map((question) => [question.id, question.answerMode])).toEqual([
      ["env", "single_select"],
      ["site", "text"],
      ["analytics", "single_select"],
      ["handles", "text"],
    ]);
  });

  it("gives a projected choice question the Other fallback unless the author disabled it", () => {
    const set = questionSetForInteraction(
      questions({
        version: 1,
        questions: [typed("site"), choice("open"), choice("closed", { allowOther: false })],
        questionSet: { schema: "paperclip.question_set.v1", questions: [mirror("site")] },
      } as Payload),
    );
    const byId = new Map(set.questions.map((question) => [question.id, question]));
    expect(byId.get("open")?.customAnswer).toEqual({ enabled: true });
    expect(byId.get("closed")?.customAnswer).toBeUndefined();
    expect(byId.get("site")?.customAnswer).toBeUndefined();
  });

  it("keeps a question required when the stored mirror relaxes it", () => {
    const set = questionSetForInteraction(
      questions({
        version: 1,
        questions: [typed("site")],
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [{ ...mirror("site"), required: false }],
        },
      } as Payload),
    );
    expect(set.questions).toEqual([{ ...mirror("site"), required: true }]);
  });

  it("keeps stored questions that have no legacy counterpart", () => {
    const set = questionSetForInteraction(
      questions({
        version: 1,
        questions: [choice("env")],
        questionSet: { schema: "paperclip.question_set.v1", questions: [mirror("extra")] },
      } as Payload),
    );
    expect(set.questions.map((question) => question.id)).toEqual(["env", "extra"]);
  });
});
