import { describe, expect, it } from "vitest";
import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxIssueRef,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import { buildNeedsYouForest, chainStats, isActionableAsk } from "./needs-you-chains";

function blockerRef(
  id: string,
  terminalBlockers?: IssueRelationIssueSummary[],
): IssueRelationIssueSummary & IssueBlockedInboxIssueRef {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    status: "blocked",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...(terminalBlockers ? { terminalBlockers } : {}),
  };
}

function attention(overrides: Partial<IssueBlockedInboxAttention>): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "high",
    stoppedSinceAt: null,
    owner: { type: "unknown", agentId: null, userId: null, label: null },
    action: { label: "Inspect blocker chain", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    parentId: null,
    blockedBy: undefined,
    blockedInboxAttention: null,
    title: overrides.id,
    status: "blocked",
    ...overrides,
  } as unknown as Issue;
}

describe("isActionableAsk", () => {
  it("is true for a linked approval", () => {
    expect(isActionableAsk(makeIssue({ id: "a", blockedInboxAttention: attention({ approvalId: "ap-1" }) }))).toBe(true);
  });
  it("is true for a pending interaction", () => {
    expect(isActionableAsk(makeIssue({ id: "a", blockedInboxAttention: attention({ interactionId: "in-1" }) }))).toBe(true);
  });
  it("is false for blocked-chain context with no decision attached", () => {
    expect(isActionableAsk(makeIssue({ id: "a", blockedInboxAttention: attention({}) }))).toBe(false);
    expect(isActionableAsk(makeIssue({ id: "a", blockedInboxAttention: null }))).toBe(false);
  });
});

describe("buildNeedsYouForest", () => {
  it("leaves unrelated issues as flat roots (no regression)", () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" }), makeIssue({ id: "c" })];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["a", "b", "c"]);
    expect([...forest.childrenOf.keys()]).toHaveLength(0);
  });

  it("nests a 4-deep blocker chain into a single linear tree (approval at the leaf)", () => {
    // a blocked-by b blocked-by c blocked-by d, with d holding the approval.
    const issues = [
      makeIssue({ id: "a", blockedBy: [blockerRef("b")] }),
      makeIssue({ id: "b", blockedBy: [blockerRef("c")] }),
      makeIssue({ id: "c", blockedBy: [blockerRef("d")] }),
      makeIssue({ id: "d", blockedInboxAttention: attention({ reason: "pending_board_decision", approvalId: "ap-1" }) }),
    ];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["a"]);
    expect(forest.childrenOf.get("a")).toEqual(["b"]);
    expect(forest.childrenOf.get("b")).toEqual(["c"]);
    expect(forest.childrenOf.get("c")).toEqual(["d"]);
    expect(forest.childrenOf.get("d")).toBeUndefined();
    expect(chainStats("a", forest)).toEqual({ size: 4, asks: 1 });
  });

  it("keeps the chain linear when the top also lists transitive terminalBlockers", () => {
    // a's blockedBy carries both the direct blocker b and the terminal leaf d. d should still nest
    // under its closest ancestor c, not jump straight under a.
    const issues = [
      makeIssue({ id: "a", blockedBy: [blockerRef("b", [blockerRef("d")])] }),
      makeIssue({ id: "b", blockedBy: [blockerRef("c")] }),
      makeIssue({ id: "c", blockedBy: [blockerRef("d")] }),
      makeIssue({ id: "d", blockedInboxAttention: attention({ approvalId: "ap-1" }) }),
    ];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["a"]);
    expect(forest.childrenOf.get("c")).toEqual(["d"]);
    expect(forest.childrenOf.get("a")).toEqual(["b"]);
  });

  it("nests a sub-issue hierarchy (epic → story → subtask)", () => {
    const issues = [
      makeIssue({ id: "epic" }),
      makeIssue({ id: "story", parentId: "epic" }),
      makeIssue({ id: "subtask", parentId: "story", blockedInboxAttention: attention({ interactionId: "in-1" }) }),
    ];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["epic"]);
    expect(forest.childrenOf.get("epic")).toEqual(["story"]);
    expect(forest.childrenOf.get("story")).toEqual(["subtask"]);
  });

  it("connects top directly to a deep leaf when intermediate links are not flagged", () => {
    // Only a (top) and d (leaf approval) are in the list; b/c are not flagged. a's attention names
    // d as its leafIssue, so the approval still surfaces nested under a rather than floating alone.
    const issues = [
      makeIssue({ id: "a", blockedInboxAttention: attention({ leafIssue: blockerRef("d") }) }),
      makeIssue({ id: "d", blockedInboxAttention: attention({ approvalId: "ap-1" }) }),
    ];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["a"]);
    expect(forest.childrenOf.get("a")).toEqual(["d"]);
  });

  it("renders a lone flagged leaf as a standalone root", () => {
    const issues = [makeIssue({ id: "d", blockedInboxAttention: attention({ approvalId: "ap-1" }) })];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["d"]);
    expect(forest.childrenOf.size).toBe(0);
  });

  it("does not loop or duplicate on a cyclic blocker relation", () => {
    const issues = [
      makeIssue({ id: "a", blockedBy: [blockerRef("b")] }),
      makeIssue({ id: "b", blockedBy: [blockerRef("a")] }),
    ];
    const forest = buildNeedsYouForest(issues);
    // Exactly one of the two becomes the root; the other nests under it — no infinite recursion,
    // and every issue appears exactly once across roots + children.
    const placed = new Set<string>(forest.roots);
    for (const children of forest.childrenOf.values()) for (const c of children) placed.add(c);
    expect(placed).toEqual(new Set(["a", "b"]));
    expect(forest.roots).toHaveLength(1);
  });

  it("orders roots by where each cluster first appears in the source list", () => {
    const issues = [
      makeIssue({ id: "solo1" }),
      makeIssue({ id: "top", blockedBy: [blockerRef("leaf")] }),
      makeIssue({ id: "solo2" }),
      makeIssue({ id: "leaf", blockedInboxAttention: attention({ approvalId: "ap-1" }) }),
    ];
    const forest = buildNeedsYouForest(issues);
    expect(forest.roots).toEqual(["solo1", "top", "solo2"]);
  });
});
