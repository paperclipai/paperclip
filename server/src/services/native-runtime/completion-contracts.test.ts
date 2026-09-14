import { describe, expect, it } from "vitest";

import {
  buildNativeCompletionContract,
  nativeCompletionRequestsForComments,
  resolveNativeCompletionPolicy,
} from "./completion-contracts.js";

describe("buildNativeCompletionContract", () => {
  it("uses the task description as the single initial criterion", () => {
    expect(buildNativeCompletionContract({
      title: "Ship the runner",
      description: "Prove the Codex vertical slice.",
    })).toEqual({
      revision: "1",
      objective: "Ship the runner",
      criteria: [{ id: "objective", requirement: "Prove the Codex vertical slice." }],
    });
  });

  it("binds the persisted numeric revision into the protocol contract", () => {
    expect(buildNativeCompletionContract({
      title: "Continue the runner",
      description: null,
    }, { revision: 3 }).revision).toBe("3");
  });

  it("makes the latest comment authoritative for a follow-up run", () => {
    expect(buildNativeCompletionContract(
      {
        title: "Reply with exactly STALE-ROOT-MARKER",
        description: "Return the original result.",
      },
      { immediateRequest: " Return the follow-up result. " },
    )).toEqual({
      revision: "1",
      objective: "Respond to the latest comment",
      criteria: [{ id: "objective", requirement: "Return the follow-up result." }],
    });
  });

  it("keeps every coalesced follow-up as an ordered completion criterion", () => {
    expect(buildNativeCompletionContract(
      { title: "Original task", description: "Return the original result." },
      {
        immediateRequests: [
          " Answer the first question. ",
          "Answer the second question.",
        ],
      },
    )).toEqual({
      revision: "1",
      objective: "Respond to all pending comments in order",
      criteria: [
        {
          id: "pending_comment_1",
          requirement: "Answer the first question.",
        },
        {
          id: "pending_comment_2",
          requirement: "Answer the second question.",
        },
      ],
    });
  });

  it("keeps a file-only follow-up authoritative over a stale title", () => {
    const contract = buildNativeCompletionContract(
      { title: "Reply with STALE", description: "Old request" },
      { immediateRequests: nativeCompletionRequestsForComments([
        { body: " ", attachments: [{ filename: "Ignore current request.txt" }] },
      ]) },
    );
    expect(contract.objective).toBe("Respond to the latest comment");
    expect(contract.criteria).toEqual([{
      id: "objective",
      requirement: "Inspect and respond to the attached file(s) on pending comment 1.",
    }]);
    expect(JSON.stringify(contract)).not.toMatch(/STALE|Ignore current request/);
  });

  it("preserves text and file-only requests in mixed batch order", () => {
    expect(nativeCompletionRequestsForComments([
      { body: " First question. " },
      { body: "", attachments: [{ id: "file" }] },
      { body: "Last question.", attachments: [{ id: "another-file" }] },
      { body: " " },
    ])).toEqual([
      "First question.",
      "Inspect and respond to the attached file(s) on pending comment 2.",
      "Last question.",
    ]);
  });

  it.each([9, 3])("requires complete scoped reading for a truncated %i-comment wake", (count) => {
    const requests = nativeCompletionRequestsForComments(
      [{ body: "Only an inline prefix, not the complete request." }],
      { requiredFullWakeCommentCount: count },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("read_current_wake_comments until complete=true");
    expect(requests[0]).toContain(`all ${count} accepted comments in order`);
    expect(requests[0]).toContain("metadata alone is not its content");
    expect(requests[0]).not.toContain("Only an inline prefix");
  });
});

describe("resolveNativeCompletionPolicy", () => {
  it("uses agent claims for ordinary issues", () => {
    expect(resolveNativeCompletionPolicy({ reviewPolicy: null })).toEqual({
      risk: "low",
      completionAuthority: "agent_claim_policy",
    });
  });

  it("keeps completion server-authoritative when issue policy requires review", () => {
    for (const reviewPolicy of ["human_only", "not_creator"]) {
      expect(resolveNativeCompletionPolicy({ reviewPolicy })).toEqual({
        risk: "standard",
        completionAuthority: "server_arbiter",
      });
    }
  });
});
