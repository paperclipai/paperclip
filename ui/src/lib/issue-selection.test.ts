import { describe, expect, it } from "vitest";
import {
  emptySelection,
  summarizeBatchOutcome,
  toggleIssueSelection,
} from "./issue-selection";

describe("toggleIssueSelection", () => {
  it("adds the id and moves the anchor on a plain click into empty selection", () => {
    const next = toggleIssueSelection(emptySelection(), "a", false, ["a", "b", "c"]);
    expect([...next.selectedIds]).toEqual(["a"]);
    expect(next.anchorId).toBe("a");
  });

  it("removes the id on a plain click when already selected", () => {
    const start = { selectedIds: new Set(["a", "b"]), anchorId: "b" };
    const next = toggleIssueSelection(start, "a", false, ["a", "b"]);
    expect([...next.selectedIds]).toEqual(["b"]);
    expect(next.anchorId).toBe("a");
  });

  it("selects the inclusive range between anchor and click on shift-click (forward)", () => {
    const start = { selectedIds: new Set(["a"]), anchorId: "a" };
    const next = toggleIssueSelection(start, "d", true, ["a", "b", "c", "d", "e"]);
    expect([...next.selectedIds].sort()).toEqual(["a", "b", "c", "d"]);
    expect(next.anchorId).toBe("d");
  });

  it("selects the inclusive range on shift-click going backward", () => {
    const start = { selectedIds: new Set(["d"]), anchorId: "d" };
    const next = toggleIssueSelection(start, "b", true, ["a", "b", "c", "d", "e"]);
    expect([...next.selectedIds].sort()).toEqual(["b", "c", "d"]);
    expect(next.anchorId).toBe("b");
  });

  it("merges shift-click range with existing selection without removing prior picks", () => {
    const start = { selectedIds: new Set(["x", "a"]), anchorId: "a" };
    const next = toggleIssueSelection(start, "c", true, ["a", "b", "c"]);
    expect([...next.selectedIds].sort()).toEqual(["a", "b", "c", "x"]);
  });

  it("falls back to a plain toggle when no anchor is set", () => {
    const start = { selectedIds: new Set<string>(), anchorId: null };
    const next = toggleIssueSelection(start, "b", true, ["a", "b", "c"]);
    expect([...next.selectedIds]).toEqual(["b"]);
    expect(next.anchorId).toBe("b");
  });

  it("falls back to a plain toggle when the anchor is no longer in the rendered order", () => {
    const start = { selectedIds: new Set(["gone"]), anchorId: "gone" };
    const next = toggleIssueSelection(start, "b", true, ["a", "b", "c"]);
    // "gone" is no longer rendered (e.g. filtered out), so range falls back to toggle on "b"
    expect([...next.selectedIds].sort()).toEqual(["b", "gone"]);
    expect(next.anchorId).toBe("b");
  });

  it("uses the rendered DFS order so range respects nested view, not flat sort order", () => {
    // In nested view the DFS order is p1, c1, p2, c2 even when the flat sort
    // order is p1, p2, c1, c2. Shift-click from p1 to p2 must include c1
    // because c1 is rendered between them.
    const rendered = ["p1", "c1", "p2", "c2"];
    const start = { selectedIds: new Set(["p1"]), anchorId: "p1" };
    const next = toggleIssueSelection(start, "p2", true, rendered);
    expect([...next.selectedIds].sort()).toEqual(["c1", "p1", "p2"]);
  });
});

describe("summarizeBatchOutcome", () => {
  it("reports zero failures when every requested id succeeds", () => {
    const outcome = summarizeBatchOutcome(["a", "b"], [
      { id: "a", success: true },
      { id: "b", success: true },
    ]);
    expect(outcome).toEqual({
      failedIds: [],
      firstError: undefined,
      succeededCount: 2,
      totalRequested: 2,
    });
  });

  it("captures failed ids and the first error message", () => {
    const outcome = summarizeBatchOutcome(["a", "b", "c"], [
      { id: "a", success: true },
      { id: "b", success: false, error: "not found" },
      { id: "c", success: false, error: "forbidden" },
    ]);
    expect(outcome.failedIds.sort()).toEqual(["b", "c"]);
    expect(outcome.firstError).toBe("not found");
    expect(outcome.succeededCount).toBe(1);
    expect(outcome.totalRequested).toBe(3);
  });

  it("treats requested ids missing from the response as failures (server silently dropped them)", () => {
    const outcome = summarizeBatchOutcome(["a", "b", "c"], [
      { id: "a", success: true },
      // "b" and "c" are absent from results — must be counted as failures
    ]);
    expect(outcome.failedIds.sort()).toEqual(["b", "c"]);
    expect(outcome.succeededCount).toBe(1);
  });

  it("treats a missing results array as a total failure", () => {
    const outcome = summarizeBatchOutcome(["a", "b"], undefined);
    expect(outcome.failedIds.sort()).toEqual(["a", "b"]);
    expect(outcome.succeededCount).toBe(0);
    expect(outcome.totalRequested).toBe(2);
  });

  it("does not double-count an id that appears in both failures and missing buckets", () => {
    const outcome = summarizeBatchOutcome(["a"], [
      { id: "a", success: false, error: "boom" },
    ]);
    expect(outcome.failedIds).toEqual(["a"]);
    expect(outcome.firstError).toBe("boom");
  });
});
