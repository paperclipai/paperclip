import { describe, expect, it } from "vitest";
import {
  isExclusivelySelfAuthoredDeferredCommentWake,
  type DeferredCommentAuthorRow,
} from "./heartbeat-self-comment-wake.js";

const AGENT_A = "00000000-0000-0000-0000-00000000000a";
const AGENT_B = "00000000-0000-0000-0000-00000000000b";
const COMMENT_1 = "11111111-1111-1111-1111-111111111111";
const COMMENT_2 = "22222222-2222-2222-2222-222222222222";
const COMMENT_3 = "33333333-3333-3333-3333-333333333333";

/**
 * Test fixture builder. Each entry is `[commentId, authorAgentId, createdByRunAgentId]`
 * — the two signals the helper consumes per row.
 */
function rows(
  ...entries: Array<[string, string | null, string | null]>
): DeferredCommentAuthorRow[] {
  return entries.map(([id, authorAgentId, createdByRunAgentId]) => ({
    id,
    authorAgentId,
    createdByRunAgentId,
  }));
}

describe("isExclusivelySelfAuthoredDeferredCommentWake", () => {
  // -- Boundary cases (no recognition possible) --

  it("returns false when no comment IDs are passed (wake is not comment-driven)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: [],
      }),
    ).toBe(false);
  });

  it("returns false when the issue has no assignee agent", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: null,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A, AGENT_A]),
      }),
    ).toBe(false);
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: undefined,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A, AGENT_A]),
      }),
    ).toBe(false);
  });

  it("returns false when the lookup returned fewer rows than IDs requested (missing/deleted comments)", () => {
    // Conservative: missing rows mean we don't know who authored them.
    // Better to let the existing predicate decide than to silently skip a
    // possibly-legitimate reopen.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2, COMMENT_3],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, AGENT_A, AGENT_A],
          [COMMENT_2, AGENT_A, AGENT_A],
        ),
      }),
    ).toBe(false);
  });

  // -- Signal 1: author_agent_id (MCP-routed self-comments) --

  it("returns true when every deferred comment is authored by the assignee via author_agent_id (MCP-routed path)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, AGENT_A, AGENT_A],
          [COMMENT_2, AGENT_A, AGENT_A],
        ),
      }),
    ).toBe(true);
  });

  it("returns true for the single-comment MCP-routed DONE-summary case (the exact #3980 / #3935 trigger via MCP path)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A, AGENT_A]),
      }),
    ).toBe(true);
  });

  // -- Signal 2: created_by_run_id (shell-routed self-comments on local_trusted) --

  it("returns true when every deferred comment was created during the assignee's own run, even if author_agent_id is null (shell-routed path on local_trusted)", () => {
    // This is the exact shape produced by an agent posting via `curl` from
    // its own terminal on local_trusted: the auth middleware loses the
    // agent identity (so author_agent_id is null + author_user_id is
    // 'local-board'), but the run-level comment plumbing still links the
    // comment to the agent's heartbeat run via created_by_run_id.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, null, AGENT_A],
          [COMMENT_2, null, AGENT_A],
        ),
      }),
    ).toBe(true);
  });

  it("returns true for mixed self-comments — some MCP-routed (author_agent_id set), some shell-routed (only createdByRunAgentId matches)", () => {
    // Real-world shape observed in production: an agent posts most comments
    // via MCP but one or two via shell within the same run. All are still
    // self-authored — the loop must not fire.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2, COMMENT_3],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, AGENT_A, AGENT_A], // MCP-routed
          [COMMENT_2, null, AGENT_A],    // shell-routed
          [COMMENT_3, AGENT_A, AGENT_A], // MCP-routed
        ),
      }),
    ).toBe(true);
  });

  // -- Real human / cross-agent comments (must NOT be treated as self) --

  it("returns false when at least one deferred comment is human-authored (a real user reply should reopen)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, AGENT_A, AGENT_A],
          [COMMENT_2, null, null], // human comment from the dashboard — neither signal matches
        ),
      }),
    ).toBe(false);
  });

  it("returns false when a deferred comment was authored by a different agent (cross-agent mention should reopen)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows(
          [COMMENT_1, AGENT_A, AGENT_A],
          [COMMENT_2, AGENT_B, AGENT_B],
        ),
      }),
    ).toBe(false);
  });

  it("returns false when assignee matches but comment author is null AND createdByRunAgentId is null (human reply to assignee's issue)", () => {
    // Common shape: a real human comments on the assigned agent's issue from
    // the dashboard. Neither signal links the comment to an agent run.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, null, null]),
      }),
    ).toBe(false);
  });

  it("returns false when a comment's createdByRunAgentId is a different agent (a cross-agent run posted on the assignee's issue)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, null, AGENT_B]),
      }),
    ).toBe(false);
  });
});
