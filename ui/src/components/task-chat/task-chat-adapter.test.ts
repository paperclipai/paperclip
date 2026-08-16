import { describe, expect, it } from "vitest";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { commentsToTaskChatItems } from "./task-chat-adapter";

describe("commentsToTaskChatItems", () => {
  it("carries feedback delivery state from a human comment into the bubble model", () => {
    const feedbackDelivery = {
      state: "exhausted_needs_attention" as const,
      sourceCommentId: "comment-feedback",
      attempt: 3,
      maxAttempts: 3,
      nextAttemptAt: null,
      lastAttemptAt: "2026-08-14T12:00:00.000Z",
      deliveredAt: null,
      targetRunId: null,
      targetRunAgentId: null,
      canRetry: true,
      retryInFlight: false,
      safeFailureReason: "The agent could not be reached.",
      batchedCommentCount: 1,
    };
    const comments = [{
      id: "comment-feedback",
      body: "Please use the updated requirements.",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      feedbackDelivery,
      createdAt: "2026-08-14T12:00:00.000Z",
    } as unknown as IssueChatComment];

    const [item] = commentsToTaskChatItems(comments);

    if (item.kind !== "message") throw new Error("expected message item");
    expect(item.feedbackDelivery).toEqual(feedbackDelivery);
  });

  it("never tags posted comments interstitial — the run's final reply keeps its bubble", () => {
    const comments = [
      {
        id: "c1",
        body: "Here is the finished work.",
        authorType: "agent",
        authorAgentId: "agent-1",
        runId: "run-1",
        createdAt: "2026-07-31T12:00:10.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("message");
    if (item.kind !== "message") return;
    expect(item.author).toBe("agent");
    expect(item.interstitial).toBeUndefined();
  });

  it("classifies system comments as system even with a derivable run→agent linkage (PAP-443)", () => {
    const comments = [
      {
        id: "c-sys",
        body: "Paperclip automatically retried dispatch, but it still has no live execution path.",
        authorType: "system",
        authorAgentId: null,
        derivedAuthorAgentId: "agent-1",
        createdAt: "2026-08-07T09:00:00.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item.kind !== "message") throw new Error("expected message item");
    expect(item.author).toBe("system");
  });

  it("carries presentation, metadata, and the raw timestamp for system comments", () => {
    const presentation = {
      kind: "system_notice",
      tone: "warning",
      title: "Run recovery",
      detailsDefaultOpen: true,
    };
    const metadata = {
      version: 1,
      sections: [{ rows: [{ type: "text", label: "Reason", text: "quota" }] }],
    };
    const comments = [
      {
        id: "c-sys",
        body: "Recovery notice.",
        authorType: "system",
        presentation,
        metadata,
        runAgentId: "agent-1",
        createdAt: new Date("2026-08-07T09:00:00.000Z"),
      } as unknown as IssueChatComment,
      {
        id: "c-agent",
        body: "Agent reply.",
        authorType: "agent",
        authorAgentId: "agent-1",
        presentation: null,
        metadata,
        createdAt: "2026-08-07T09:01:00.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    const [sys, agent] = items;
    if (sys.kind !== "message" || agent.kind !== "message") throw new Error("expected messages");
    expect(sys.presentation).toEqual(presentation);
    expect(sys.metadata).toEqual(metadata);
    expect(sys.runAgentId).toBe("agent-1");
    expect(sys.createdAtIso).toBe("2026-08-07T09:00:00.000Z");
    // Non-system authors keep the item lean — no structured notice fields.
    expect(agent.presentation).toBeUndefined();
    expect(agent.metadata).toBeUndefined();
    expect(agent.runAgentId).toBeUndefined();
    expect(agent.createdAtIso).toBeUndefined();
  });
});
