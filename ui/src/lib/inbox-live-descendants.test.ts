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

  it.each([undefined, 0, 1, 3])("does not infer business coverage from navigation count %s", (liveDescendantCount) => {
    const issue = makeIssue({ liveDescendantCount });
    expect(resolveIssueLiveDescendantCount(issue, 1)).toBeGreaterThan(0);
    expect(resolveInboxIssueBlockerAttention(issue)).toBeNull();
  });

  it.each(["none", "covered", "needs_attention", "stalled"] as const)("preserves server attention %s regardless of navigation counts", (state) => {
    const original = makeBlockerAttention({ state });
    expect(resolveInboxIssueBlockerAttention(makeIssue({ blockerAttention: original, liveDescendantCount: 4 }))).toBe(original);
  });
});
