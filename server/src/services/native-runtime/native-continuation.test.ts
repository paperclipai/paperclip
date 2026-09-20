import { describe, expect, it } from "vitest";
import { buildNativeContinuationPrompt } from "./native-continuation.js";

const issue = { title: "Original task", description: "Retain my long task brief." };
const message = { id: "new", body: "Yes, please proceed.", authorType: "user", authorId: "board", sourceTrust: "user", createdByRunId: null };
const wake = {
  reason: "issue_commented",
  executionContinuation: {
    version: 1,
    objective: message.body,
    messages: [{ ...message, id: "old", body: "OLD_HISTORY" }, message],
    resumeDelta: { baseRunId: "prior", messages: [message] },
    completedWork: { summary: "OLD_SUMMARY" },
    humanResponses: [{ id: "old-question", result: { answer: "OLD_ANSWER" } }],
  },
  comments: [message], continuationSummary: { markdown: "OLD_SUMMARY" },
};
const build = (value: unknown = wake, previousIssue = issue) => buildNativeContinuationPrompt({ wakePayload: value, previousRunId: "prior", issue, previousIssue });

describe("native continuation event projection", () => {
  it("sends a new comment once without the unchanged brief, objective, history or summary", () => {
    const text = build()!;
    expect(text.split(message.body)).toHaveLength(2);
    for (const old of [issue.description, issue.title, "OLD_HISTORY", "OLD_SUMMARY", "OLD_ANSWER"]) expect(text).not.toContain(old);
    expect(JSON.parse(text).messages[0]).toMatchObject({ authorType: "user", body: message.body });
    expect(text.length).toBeLessThan(600);
  });
  it("only uses a delta whose base matches the actual previous run", () => {
    expect(build({ ...wake, executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "different", messages: [message] } } })).toBeNull();
    expect(build({ ...wake, executionContinuation: null })).toBeNull();
  });
  it("delivers the current authenticated answer once, not all prior answers", () => {
    const text = build({ ...wake, interactionId: "new-question", executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] }, humanResponses: [...wake.executionContinuation.humanResponses, { id: "new-question", kind: "ask_user_questions", status: "answered", resolvedByUserId: "board", result: { answer: "NEW_ANSWER" } }] } })!;
    expect(text.split("NEW_ANSWER")).toHaveLength(2);
    expect(text).not.toContain("OLD_ANSWER");
    expect(JSON.parse(text).humanResponses[0].resolvedByUserId).toBe("board");
  });
  it("includes external child completion and actual brief edits", () => {
    const text = build({ ...wake, reason: "issue_children_completed", childIssueSummaries: [{ id: "child", status: "done", summary: "CHILD_RESULT" }] }, { ...issue, description: "old brief" })!;
    expect(JSON.parse(text).taskChanges).toEqual({ description: issue.description });
    expect(text).toContain("CHILD_RESULT");
  });
  it.each([{ fallbackFetchNeeded: true }, { recovery: { cause: "interrupted" } }, { externalChatExecutionBound: true }, { reason: "issue_assigned" }])("retains bootstrap framing for special wakes: %j", (extra) => {
    expect(build({ ...wake, ...extra })).toBeNull();
  });
});
