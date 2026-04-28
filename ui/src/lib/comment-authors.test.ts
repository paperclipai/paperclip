import { describe, expect, it } from "vitest";

import { resolveCommentAuthorIdentity } from "./comment-authors";

describe("resolveCommentAuthorIdentity", () => {
  it("prefers the explicit author agent", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: "agent-ceo",
          authorUserId: "local-board",
          runAgentId: "agent-other",
        },
        "local-board",
      ),
    ).toEqual({
      kind: "agent",
      agentId: "agent-ceo",
      name: "agent-ceo",
    });
  });

  it("uses the linked run agent when a board-authored comment belongs to an agent run", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "local-board",
          runAgentId: "agent-ceo",
        },
        "local-board",
      ),
    ).toEqual({
      kind: "agent",
      agentId: "agent-ceo",
      name: "agent-ceo",
    });
  });

  it("shows You only for the current user's own non-agent comment", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "local-board",
          runAgentId: null,
        },
        "local-board",
      ),
    ).toEqual({
      kind: "user",
      agentId: null,
      name: "You",
    });
  });

  it("falls back to Board for board-authored comments from someone else", () => {
    expect(
      resolveCommentAuthorIdentity(
        {
          authorAgentId: null,
          authorUserId: "local-board",
          runAgentId: null,
        },
        "someone-else",
      ),
    ).toEqual({
      kind: "user",
      agentId: null,
      name: "Board",
    });
  });
});
