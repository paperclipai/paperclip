import { describe, expect, it } from "vitest";
import { freshSessionRetryContext } from "./fresh-session-retry-context.js";

const consumed = {
  wakeCommentId: "c2", wakeCommentIds: ["c1", "c2"], commentId: "c2", commentIds: ["c1", "c2"], latestCommentId: "c2",
  explicitUserContinuation: true, resumeIntent: true, followUpRequested: true, paperclipWake: {}, paperclipWakeComment: {},
  paperclipTaskMarkdown: "task", paperclipTurnContext: {},
};

describe("freshSessionRetryContext", () => {
  it("drops consumed wake input from an ordinary task run", () => {
    const context = freshSessionRetryContext({ issueId: "issue", source: "issue.comment", paperclipHarnessCheckedOut: true, ...consumed });
    expect(context).toEqual({ issueId: "issue", source: "issue.comment", paperclipHarnessCheckedOut: true });
  });

  it.each(["chat:github", "chat:slack:recovery"])("keeps the admitted %s message batch without the failed run's proofs", (source) => {
    const context = freshSessionRetryContext({
      issueId: "issue", source, chatConversationId: "conversation", paperclipHarnessCheckedOut: false,
      paperclipExternalChatExecutionBound: true, ...consumed,
    });
    expect(context).toEqual({
      issueId: "issue", source, chatConversationId: "conversation",
      wakeCommentIds: ["c1", "c2"], wakeCommentId: "c2", commentId: "c2",
    });
  });

  it("does not invent a batch or keep one for sources outside the run-bound chat boundary", () => {
    expect(freshSessionRetryContext({ source: "chat:github", wakeCommentId: "c1" })).toEqual({ source: "chat:github" });
    expect(freshSessionRetryContext({ source: "chat:agentmail", wakeCommentIds: ["c1"] })).toEqual({ source: "chat:agentmail" });
    expect(freshSessionRetryContext(null)).toEqual({});
  });
});
