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

function rows(...entries: Array<[string, string | null]>): DeferredCommentAuthorRow[] {
  return entries.map(([id, authorAgentId]) => ({ id, authorAgentId }));
}

describe("isExclusivelySelfAuthoredDeferredCommentWake", () => {
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
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A]),
      }),
    ).toBe(false);
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: undefined,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A]),
      }),
    ).toBe(false);
  });

  it("returns true when every deferred comment is authored by the assignee (the loop-blocking case)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A], [COMMENT_2, AGENT_A]),
      }),
    ).toBe(true);
  });

  it("returns false when at least one deferred comment is human-authored (a real user reply should reopen)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A], [COMMENT_2, null]),
      }),
    ).toBe(false);
  });

  it("returns false when a deferred comment was authored by a different agent (cross-agent mention should reopen)", () => {
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1, COMMENT_2],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A], [COMMENT_2, AGENT_B]),
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
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A], [COMMENT_2, AGENT_A]),
      }),
    ).toBe(false);
  });

  it("returns true for the single-comment self-authored DONE-summary case (the exact #3980 / #3935 trigger)", () => {
    // This is the smoking-gun shape: hermes_local agent posts its DONE summary
    // comment, the comment-post path enqueues a deferred wake, the promoter
    // runs, the comment table says authorAgentId === assigneeAgentId →
    // predicate returns true → caller skips the reopen → loop is broken.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, AGENT_A]),
      }),
    ).toBe(true);
  });

  it("returns false when assignee matches but comment author is null (human-posted to assignee's issue)", () => {
    // Common shape: human comments on the assigned agent's issue.
    // authorAgentId is null. Even though the assignee is set, this is a real
    // human reply and should reopen the done issue per the platform contract.
    expect(
      isExclusivelySelfAuthoredDeferredCommentWake({
        deferredCommentIds: [COMMENT_1],
        assigneeAgentId: AGENT_A,
        deferredCommentAuthors: rows([COMMENT_1, null]),
      }),
    ).toBe(false);
  });
});
