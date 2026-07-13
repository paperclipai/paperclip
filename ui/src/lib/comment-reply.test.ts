import type { Agent, IssueComment } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  REPLY_EXCERPT_MAX_LENGTH,
  buildOptimisticReplyTo,
  buildReplyExcerpt,
  formatReplyAuthorName,
} from "./comment-reply";

function makeComment(overrides: Partial<IssueComment> = {}): IssueComment {
  const now = new Date("2026-04-06T13:00:00.000Z");
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "agent",
    authorAgentId: "agent-1",
    authorUserId: null,
    body: "Hello there",
    presentation: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildReplyExcerpt", () => {
  it("collapses runs of whitespace and newlines into a single line", () => {
    const { excerpt, truncated } = buildReplyExcerpt("  line one\n\n  line   two\t");
    expect(excerpt).toBe("line one line two");
    expect(truncated).toBe(false);
  });

  it("does not truncate a body at exactly the max length", () => {
    const body = "a".repeat(REPLY_EXCERPT_MAX_LENGTH);
    const { excerpt, truncated } = buildReplyExcerpt(body);
    expect(excerpt).toHaveLength(REPLY_EXCERPT_MAX_LENGTH);
    expect(truncated).toBe(false);
  });

  it("clamps and flags a body longer than the max length", () => {
    const body = "b".repeat(REPLY_EXCERPT_MAX_LENGTH + 50);
    const { excerpt, truncated } = buildReplyExcerpt(body);
    expect(excerpt).toHaveLength(REPLY_EXCERPT_MAX_LENGTH);
    expect(truncated).toBe(true);
  });

  it("trims trailing whitespace left at the clamp boundary", () => {
    const body = `${"word ".repeat(60)}`; // well over the limit, boundary lands on a space
    const { excerpt } = buildReplyExcerpt(body);
    expect(excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_LENGTH);
    expect(excerpt).toBe(excerpt.trimEnd());
  });
});

describe("buildOptimisticReplyTo", () => {
  it("mirrors the target's identity and a clamped excerpt", () => {
    const target = makeComment({
      id: "comment-src",
      authorType: "agent",
      authorAgentId: "agent-7",
      authorUserId: null,
      body: "c".repeat(REPLY_EXCERPT_MAX_LENGTH + 10),
    });
    const snapshot = buildOptimisticReplyTo(target);
    expect(snapshot).toEqual({
      commentId: "comment-src",
      authorType: "agent",
      authorAgentId: "agent-7",
      authorUserId: null,
      excerpt: "c".repeat(REPLY_EXCERPT_MAX_LENGTH),
      excerptTruncated: true,
    });
  });

  it("normalizes undefined author ids to null for a user comment", () => {
    const target = makeComment({
      id: "comment-user",
      authorType: "user",
      authorAgentId: undefined as unknown as string | null,
      authorUserId: "user-9",
      body: "short",
    });
    const snapshot = buildOptimisticReplyTo(target);
    expect(snapshot.authorAgentId).toBeNull();
    expect(snapshot.authorUserId).toBe("user-9");
    expect(snapshot.excerptTruncated).toBe(false);
  });
});

describe("formatReplyAuthorName", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-1", { id: "agent-1", name: "CodexCoder" } as Agent],
  ]);

  it("uses the agent name when the target is an agent in the map", () => {
    expect(
      formatReplyAuthorName({ authorType: "agent", authorAgentId: "agent-1", authorUserId: null }, { agentMap }),
    ).toBe("CodexCoder");
  });

  it("falls back to a short agent id when the agent is unknown", () => {
    expect(
      formatReplyAuthorName(
        { authorType: "agent", authorAgentId: "agent-abcdef123", authorUserId: null },
        { agentMap },
      ),
    ).toBe("agent-ab");
  });

  it("labels system authors as System", () => {
    expect(
      formatReplyAuthorName({ authorType: "system", authorAgentId: null, authorUserId: null }),
    ).toBe("System");
  });

  it("labels the current user's own comment as You", () => {
    expect(
      formatReplyAuthorName(
        { authorType: "user", authorAgentId: null, authorUserId: "user-1" },
        { currentUserId: "user-1" },
      ),
    ).toBe("You");
  });

  it("resolves another user's profile label instead of mislabeling them You", () => {
    const userProfileMap = new Map([["user-2", { label: "Ada Lovelace", image: null }]]);
    expect(
      formatReplyAuthorName(
        { authorType: "user", authorAgentId: null, authorUserId: "user-2" },
        { currentUserId: "user-1", userProfileMap },
      ),
    ).toBe("Ada Lovelace");
  });

  it("labels another user without a profile as User (never You)", () => {
    expect(
      formatReplyAuthorName(
        { authorType: "user", authorAgentId: null, authorUserId: "user-2" },
        { currentUserId: "user-1" },
      ),
    ).toBe("User");
  });

  it("labels the board principal as Board", () => {
    expect(
      formatReplyAuthorName(
        { authorType: "user", authorAgentId: null, authorUserId: "local-board" },
        { currentUserId: "user-1" },
      ),
    ).toBe("Board");
  });
});
