import { describe, expect, it } from "vitest";
import type { Issue, IssueBlockerAttention } from "@paperclipai/shared";
import {
  resolveInboxIssueBlockerAttention,
  resolveIssueLiveDescendantCount,
} from "./inbox-live-descendants";

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    status: "blocked",
    blockerAttention: null,
    liveDescendantCount: 0,
    ...overrides,
  } as unknown as Issue;
}

function makeBlockerAttention(
  overrides: Partial<IssueBlockerAttention> = {},
): IssueBlockerAttention {
  return {
    state: "none",
    reason: null,
    unresolvedBlockerCount: 0,
    coveredBlockerCount: 0,
    stalledBlockerCount: 0,
    attentionBlockerCount: 0,
    sampleBlockerIdentifier: null,
    sampleStalledBlockerIdentifier: null,
    ...overrides,
  };
}

describe("inbox live descendant status helpers", () => {
  it("combines server and loaded live descendant counts without double-counting", () => {
    expect(resolveIssueLiveDescendantCount(makeIssue({ liveDescendantCount: 3 }), 1)).toBe(3);
    expect(resolveIssueLiveDescendantCount(makeIssue({ liveDescendantCount: 0 }), 2)).toBe(2);
    expect(resolveIssueLiveDescendantCount(makeIssue({ liveDescendantCount: -1 }), 2.7)).toBe(2);
  });

  it("synthesizes covered blocker attention for a blocked row with live descendants", () => {
    const attention = resolveInboxIssueBlockerAttention(
      makeIssue({ liveDescendantCount: 2 }),
      { isLive: false },
    );

    expect(attention).toMatchObject({
      state: "covered",
      reason: "active_child",
      coveredBlockerCount: 2,
    });
  });

  it("uses loaded live descendants when the server count is absent", () => {
    const attention = resolveInboxIssueBlockerAttention(
      makeIssue({ liveDescendantCount: undefined }),
      { isLive: false, loadedSubtreeLiveCount: 1 },
    );

    expect(attention?.state).toBe("covered");
    expect(attention?.coveredBlockerCount).toBe(1);
  });

  it("keeps urgent blocked attention red even when descendants are live", () => {
    for (const state of ["needs_attention", "stalled"] as const) {
      const original = makeBlockerAttention({ state, reason: "attention_required" });
      const attention = resolveInboxIssueBlockerAttention(
        makeIssue({ blockerAttention: original, liveDescendantCount: 4 }),
        { isLive: false },
      );

      expect(attention).toBe(original);
    }
  });

  it("does not synthesize covered attention for the live row itself or non-blocked parents", () => {
    expect(
      resolveInboxIssueBlockerAttention(
        makeIssue({ status: "blocked", liveDescendantCount: 2 }),
        { isLive: true },
      ),
    ).toBeNull();
    expect(
      resolveInboxIssueBlockerAttention(
        makeIssue({ status: "done", liveDescendantCount: 2 }),
        { isLive: false },
      ),
    ).toBeNull();
  });
});
