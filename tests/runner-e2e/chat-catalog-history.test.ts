import { expect, it } from "vitest";
import { chatCatalogHumanHistoryMatches, verifyChatCatalogHumanQuestionAnswer, validChatCatalogHumanCounts } from "./chat-catalog-contract.js";
it("binds the canonical request after genuine setup history and retains native setup run identities", () => {
  const input = { implementation: { setupHumanMessageCount: 1, expectedHumanMessageCount: 2 },
    human: [{ id: "setup", body: "Remember this detail" }, { id: "query", body: "Use the detail" }],
    runIds: ["setup-run", "query-run"], boundary: { humanCommentIds: ["setup"], runIds: ["setup-run"] }, renderedQuery: "Use the detail" };
  expect(chatCatalogHumanHistoryMatches(input)).toBe(true);
  expect(chatCatalogHumanHistoryMatches({ ...input, human: [...input.human].reverse() })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...input, runIds: ["query-run"] })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...input, boundary: { ...input.boundary, humanCommentIds: ["injected"] } })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...input, human: [...input.human, { id: "hidden", body: "Please finish" }] })).toBe(false);
});
it("preserves zero-setup semantics and refuses impossible setup/total declarations", () => {
  expect(chatCatalogHumanHistoryMatches({ implementation: {}, human: [{ id: "query", body: "Original query" }], runIds: ["run"], boundary: { humanCommentIds: [], runIds: [] }, renderedQuery: "Original query" })).toBe(true);
  expect(validChatCatalogHumanCounts({ setupHumanMessageCount: 1, expectedHumanMessageCount: 1 })).toBe(false);
  expect(validChatCatalogHumanCounts({ setupHumanMessageCount: -1 })).toBe(false);
  expect(validChatCatalogHumanCounts({ setupHumanMessageCount: 0.5 })).toBe(false);
  expect(validChatCatalogHumanCounts({ setupHumanMessageCount: 0, expectedHumanMessageCount: 0, queryOutcome: "rejected" })).toBe(true);
});

function answerEvidence() {
  return { expected: { interactionId: "question", sourceRunId: "initial", userId: "person" }, companyId: "company", issueId: "source", agentId: "ceo", canonicalComment: { id: "query", authorUserId: "person" },
    interactions: [{ id: "question", companyId: "company", issueId: "source", sourceRunId: "initial", createdByAgentId: "ceo", addresseeUserId: "person", kind: "ask_user_questions" as const,
      status: "answered" as const, resolverPolicy: "human_only" as const, resolvedByUserId: "person", resolvedAt: "2026-11-04T13:30:00Z", result: { version: 1 as const, answers: [{ questionId: "saved", optionIds: ["yes"] }], summaryMarkdown: null } }],
    activity: [{ companyId: "company", entityId: "source", action: "issue.thread_interaction_answered", actorType: "user", actorId: "person", details: { interactionId: "question", interactionKind: "ask_user_questions", interactionStatus: "answered" } }],
    runs: [{ id: "initial", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-04T13:20:00Z", contextSnapshot: { issueId: "source", commentId: "query" } },
      { id: "confirmed", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-04T13:30:01Z", contextSnapshot: { issueId: "source", interactionId: "question" } }],
  };
}
it("counts one independently verified UI answer as the second declared credential action without fabricating a comment", () => {
  const raw = answerEvidence(), questionAnswer = verifyChatCatalogHumanQuestionAnswer(raw); expect(questionAnswer).toBeDefined();
  const human = [{ id: "query", body: "Original query" }];
  const input = { implementation: { scenarioId: "secrets.personal-secret", expectedHumanMessageCount: 2 }, human, questionAnswer,
    runIds: ["initial", "confirmed"], boundary: { humanCommentIds: [], runIds: [] }, renderedQuery: "Original query" };
  expect(chatCatalogHumanHistoryMatches(input)).toBe(true); expect(human).toHaveLength(1);
  expect(chatCatalogHumanHistoryMatches({ ...input, questionAnswer: undefined })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...input, human: [...human, { id: "extra", body: "Hidden nudge" }] })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...input, implementation: { scenarioId: "questions-and-approvals.multi-part-question", expectedHumanMessageCount: 2 } })).toBe(false);
});
it.each(["wrong user", "missing audit", "duplicate audit", "foreign issue", "unrelated answer", "early successor", "extra successor"])("rejects %s as human-answer accounting authority", fault => {
  const value = answerEvidence();
  if (fault === "wrong user") value.interactions[0]!.resolvedByUserId = "other-person";
  if (fault === "missing audit") value.activity = [];
  if (fault === "duplicate audit") value.activity.push(value.activity[0]!);
  if (fault === "foreign issue") value.interactions[0]!.issueId = "foreign";
  if (fault === "unrelated answer") value.expected.interactionId = "unrelated";
  if (fault === "early successor") value.runs[1]!.startedAt = "2026-11-04T13:29:00Z";
  if (fault === "extra successor") value.runs.push({ ...value.runs[1]!, id: "extra" });
  expect(verifyChatCatalogHumanQuestionAnswer(value)).toBeUndefined();
});
