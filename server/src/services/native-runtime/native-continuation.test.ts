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


describe("plain-text Slack continuation projection", () => {
  const slackComment = { ...message, author: { type: "user", id: "board" } };
  const slackWake = {
    ...wake,
    reason: "External chat message received",
    issue: { id: "task", title: "OLD_EXACT_REPLY", description: "Started from Slack", workMode: "standard" },
    externalChatProvider: "slack", checkedOutByHarness: true,
    comments: [slackComment],
    commentIds: [message.id], latestCommentId: message.id,
    commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    attachmentOmissions: [],
  };
  const buildChat = (value: unknown = slackWake) => buildNativeContinuationPrompt({
    wakePayload: value, previousRunId: "prior", issue: slackWake.issue,
    previousIssue: slackWake.issue,
    allowExternalChat: true,
  });
  it("sends the new message once without prior titles, history or instructions", () => {
    const text = buildChat()!;
    expect(text).not.toBeNull();
    expect(JSON.parse(text)).toEqual({ messages: [message] });
    expect(text).not.toContain("OLD_EXACT_REPLY");
    expect(text).not.toContain("OLD_HISTORY");
    expect(text.length).toBeLessThan(600);
  });
  it("excludes edited history and prior agent output outside the current Slack delivery", () => {
    const text = buildChat({ ...slackWake, executionContinuation: {
      ...wake.executionContinuation,
      resumeDelta: { baseRunId: "prior", messages: [
        { ...message, id: "old-edited", body: "STALE_DIRECTION" },
        { ...message, id: "old-reply", authorType: "agent", body: "OLD_AGENT_REPLY" },
        message,
      ] },
    } });
    expect(JSON.parse(text!).messages).toEqual([message]);
    expect(text).not.toContain("STALE_DIRECTION");
    expect(text).not.toContain("OLD_AGENT_REPLY");
  });
  it("preserves an actual task brief edit beside the current message", () => {
    const text = buildNativeContinuationPrompt({
      wakePayload: slackWake, previousRunId: "prior", allowExternalChat: true,
      issue: { ...slackWake.issue, description: "Updated scope" }, previousIssue: slackWake.issue,
    });
    expect(JSON.parse(text!).taskChanges).toEqual({ description: "Updated scope" });
  });
  it("accepts the verified non-assignee chat binding", () => {
    expect(buildChat({ ...slackWake, checkedOutByHarness: false, externalChatExecutionBound: true })).not.toBeNull();
  });
  it.each([
    { comments: [{ ...slackComment, attachments: [{ id: "file" }] }] },
    { comments: [{ ...slackComment, attachments: "malformed" }] },
    { comments: [{ ...slackComment, body: "EDITED_SINCE_DELTA" }] },
    { comments: [{ ...slackComment, author: { type: "user", id: "different-user" } }] },
    { attachmentOmissions: [{ commentId: message.id, notice: "Unavailable input" }] },
    { externalChatProvider: "discord" },
    { checkedOutByHarness: false },
    { truncated: true },
    { fallbackFetchNeeded: true },
    { comments: [{ ...slackComment, bodyTruncated: true }] },
    { interactionId: "approval", interactionKind: "request_confirmation" },
    { recovery: { cause: "interrupted" } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "wrong", messages: [message] } } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] } } },
    { commentIds: [message.id, "missing"], latestCommentId: "missing" },
    { commentIds: [message.id, message.id], latestCommentId: message.id },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [message, message] } } },
  ])("keeps specialized or incomplete input on the full path: %j", (extra) => {
    expect(buildChat({ ...slackWake, ...extra })).toBeNull();
  });
  it("requires the constructor to explicitly opt into chat continuation", () => {
    expect(build(slackWake)).toBeNull();
  });
});
