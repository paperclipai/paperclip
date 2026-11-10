import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT_OPTIONS, layoutHierarchy } from "./auto-layout";
import { syntheticOrg } from "./synthetic-org";

function overlaps(points: Array<{ x: number; y: number }>, width: number, height: number): number {
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  let count = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length && sorted[j]!.y - sorted[i]!.y < height; j += 1) {
      if (Math.abs(sorted[j]!.x - sorted[i]!.x) < width) count += 1;
    }
  }
  return count;
}

describe("layoutHierarchy", () => {
  it("centers a manager above its reports in top-down mode", () => {
    const layout = layoutHierarchy([
      { id: "ceo", reportsTo: null },
      { id: "a", reportsTo: "ceo" },
      { id: "b", reportsTo: "ceo" },
    ]);
    const ceo = layout.get("ceo")!;
    const a = layout.get("a")!;
    const b = layout.get("b")!;
    expect(a.y).toBe(b.y);
    expect(a.y).toBeGreaterThan(ceo.y);
    expect(ceo.x).toBeCloseTo((a.x + b.x) / 2);
  });

  it("swaps axes in left-right mode", () => {
    const layout = layoutHierarchy(
      [
        { id: "ceo", reportsTo: null },
        { id: "a", reportsTo: "ceo" },
      ],
      { direction: "LR" },
    );
    expect(layout.get("a")!.x).toBeGreaterThan(layout.get("ceo")!.x);
  });

  it("places every node exactly once without overlap for 250 agents in both directions", () => {
    const members = syntheticOrg(250);
    for (const direction of ["TB", "LR"] as const) {
      const layout = layoutHierarchy(members, { direction });
      expect(layout.size).toBe(250);
      expect(overlaps([...layout.values()], DEFAULT_LAYOUT_OPTIONS.nodeWidth, DEFAULT_LAYOUT_OPTIONS.nodeHeight)).toBe(0);
    }
  });

  it("wraps a wide row of leaf reports", () => {
    const members = [
      { id: "ceo", reportsTo: null },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, reportsTo: "ceo" })),
    ];
    const layout = layoutHierarchy(members);
    const xs = new Set([...layout.entries()].filter(([id]) => id !== "ceo").map(([, point]) => point.x));
    expect(xs.size).toBe(DEFAULT_LAYOUT_OPTIONS.leafWrap);
    expect(overlaps([...layout.values()], DEFAULT_LAYOUT_OPTIONS.nodeWidth, DEFAULT_LAYOUT_OPTIONS.nodeHeight)).toBe(0);
  });

  it("treats missing managers as roots and survives cycles and deep chains", () => {
    const cyclic = layoutHierarchy([
      { id: "a", reportsTo: "b" },
      { id: "b", reportsTo: "a" },
      { id: "orphan", reportsTo: "gone" },
      { id: "self", reportsTo: "self" },
    ]);
    expect(cyclic.size).toBe(4);
    const chain = Array.from({ length: 3_000 }, (_, i) => ({ id: `n${i}`, reportsTo: i === 0 ? null : `n${i - 1}` }));
    expect(layoutHierarchy(chain).size).toBe(3_000);
  });
});
