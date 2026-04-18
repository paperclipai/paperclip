import { describe, expect, it } from "vitest";
import { resolveCommentAuthorIdentity } from "./comment-authors";

describe("resolveCommentAuthorIdentity", () => {
  it("prefers explicit author agent over run agent", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: "agent-a",
          authorUserId: null,
          runAgentId: "agent-b",
        },
        "user-1",
      ),
    ).toEqual({ kind: "agent", agentId: "agent-a" });
  });

  it("keeps the human author when a comment also belongs to an agent run", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "user-1",
          runAgentId: "run-agent",
        },
        "user-1",
      ),
    ).toEqual({ kind: "user", label: "You" });
  });

  it("uses the linked run agent when no explicit author is present", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: null,
          runAgentId: "agent-ceo",
        },
        "local-board",
      ),
    ).toEqual({ kind: "agent", agentId: "agent-ceo" });
  });

  it("labels current user comments as You", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "user-1",
          runAgentId: null,
        },
        "user-1",
      ),
    ).toEqual({ kind: "user", label: "You" });
  });

  it("falls back to board label for other user comments", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "local-board",
          runAgentId: null,
        },
        "user-1",
      ),
    ).toEqual({ kind: "user", label: "Board" });
  });
});
