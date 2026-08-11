import { describe, expect, it } from "vitest";
import {
  issueChatLongThreadAgentMap,
  issueChatLongThreadComments,
  issueChatLongThreadEvents,
  issueChatLongThreadLinkedRuns,
  issueChatLongThreadMarkdownCommentIds,
  issueChatLongThreadTranscriptsByRunId,
  LONG_THREAD_COMMENT_COUNT,
  LONG_THREAD_MARKDOWN_COMMENT_COUNT,
} from "./issueChatLongThreadFixture";
import { buildIssueChatMessages } from "../lib/issue-chat-messages";

describe("issueChatLongThreadFixture", () => {
  it("builds a deterministic long issue-thread shape", () => {
    const messages = buildIssueChatMessages({
      comments: issueChatLongThreadComments,
      timelineEvents: issueChatLongThreadEvents,
      linkedRuns: issueChatLongThreadLinkedRuns,
      liveRuns: [],
      agentMap: issueChatLongThreadAgentMap,
      currentUserId: "user-board",
      transcriptsByRunId: issueChatLongThreadTranscriptsByRunId,
      hasOutputForRun: (runId) => issueChatLongThreadTranscriptsByRunId.has(runId),
    });

    expect(issueChatLongThreadComments).toHaveLength(LONG_THREAD_COMMENT_COUNT);
    expect(issueChatLongThreadMarkdownCommentIds.size).toBe(LONG_THREAD_MARKDOWN_COMMENT_COUNT);
    expect(messages.length).toBeGreaterThanOrEqual(450);
    expect(messages.filter((message) => message.role === "assistant").length).toBeGreaterThanOrEqual(
      LONG_THREAD_MARKDOWN_COMMENT_COUNT,
    );
  });

  it("keeps markdown rows markdown-heavy enough to exercise MarkdownBody", () => {
    const markdownComments = issueChatLongThreadComments.filter((comment) =>
      issueChatLongThreadMarkdownCommentIds.has(comment.id),
    );

    expect(markdownComments).toHaveLength(LONG_THREAD_MARKDOWN_COMMENT_COUNT);
    for (const comment of markdownComments.slice(0, 5)) {
      expect(comment.body).toContain("## Baseline note");
      expect(comment.body).toContain("```ts");
      expect(comment.body).toContain("| Metric | Value |");
    }
  });
});
