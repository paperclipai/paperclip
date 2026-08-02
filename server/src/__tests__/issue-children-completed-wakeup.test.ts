import { describe, expect, it } from "vitest";
import { buildIssueChildrenCompletedWakeIdempotencyKey } from "../services/issue-children-completed-wakeup.ts";

describe("buildIssueChildrenCompletedWakeIdempotencyKey", () => {
  it("collapses onto the same key when the same child re-completes with an unchanged sibling set", () => {
    const first = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "watchdog-1",
      childIssueIds: ["watchdog-1"],
    });
    const second = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "watchdog-1",
      childIssueIds: ["watchdog-1"],
    });
    expect(first).toBe(second);
  });

  it("is stable regardless of sibling id ordering", () => {
    const a = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-2",
      childIssueIds: ["child-1", "child-2"],
    });
    const b = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-2",
      childIssueIds: ["child-2", "child-1"],
    });
    expect(a).toBe(b);
  });

  it("differs when a different child is the one that completed", () => {
    const a = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1", "child-2"],
    });
    const b = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-2",
      childIssueIds: ["child-1", "child-2"],
    });
    expect(a).not.toBe(b);
  });

  it("differs when the sibling set changes (e.g. a new child was added)", () => {
    const a = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1"],
    });
    const b = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1", "child-2"],
    });
    expect(a).not.toBe(b);
  });

  it("differs across parents", () => {
    const a = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-1",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1"],
    });
    const b = buildIssueChildrenCompletedWakeIdempotencyKey({
      parentIssueId: "parent-2",
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1"],
    });
    expect(a).not.toBe(b);
  });
});
