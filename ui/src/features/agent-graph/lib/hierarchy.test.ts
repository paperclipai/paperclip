import { describe, expect, it } from "vitest";
import { buildManagerIndex, checkReparent, wouldCreateCycle } from "./hierarchy";

const members = [
  { id: "ceo", reportsTo: null },
  { id: "cto", reportsTo: "ceo" },
  { id: "eng", reportsTo: "cto" },
  { id: "qa", reportsTo: "eng" },
  { id: "cfo", reportsTo: "ceo" },
];
const index = buildManagerIndex(members);

describe("wouldCreateCycle", () => {
  it("allows moving an agent under an unrelated manager or to the top", () => {
    expect(wouldCreateCycle(index, "qa", "cfo")).toBe(false);
    expect(wouldCreateCycle(index, "eng", null)).toBe(false);
  });

  it("rejects self-reporting and reporting to a descendant", () => {
    expect(wouldCreateCycle(index, "cto", "cto")).toBe(true);
    expect(wouldCreateCycle(index, "cto", "eng")).toBe(true);
    expect(wouldCreateCycle(index, "ceo", "qa")).toBe(true);
  });

  it("terminates on data that already contains a cycle", () => {
    const broken = buildManagerIndex([
      { id: "a", reportsTo: "b" },
      { id: "b", reportsTo: "a" },
      { id: "c", reportsTo: null },
    ]);
    expect(wouldCreateCycle(broken, "c", "a")).toBe(false);
    expect(wouldCreateCycle(broken, "a", "b")).toBe(true);
  });

  it("handles a 5,000 deep chain without recursion limits", () => {
    const chain = Array.from({ length: 5_000 }, (_, i) => ({ id: `n${i}`, reportsTo: i === 0 ? null : `n${i - 1}` }));
    const chainIndex = buildManagerIndex(chain);
    expect(wouldCreateCycle(chainIndex, "n0", "n4999")).toBe(true);
    expect(wouldCreateCycle(chainIndex, "n4999", "n0")).toBe(false);
  });
});

describe("checkReparent", () => {
  it("classifies each rejection", () => {
    expect(checkReparent(index, "qa", "cfo")).toEqual({ ok: true });
    expect(checkReparent(index, "qa", "eng")).toEqual({ ok: false, reason: "same-manager" });
    expect(checkReparent(index, "qa", "qa")).toEqual({ ok: false, reason: "self" });
    expect(checkReparent(index, "cto", "qa")).toEqual({ ok: false, reason: "cycle" });
    expect(checkReparent(index, "ghost", "ceo")).toEqual({ ok: false, reason: "unknown-agent" });
    expect(checkReparent(index, "qa", "ghost")).toEqual({ ok: false, reason: "unknown-manager" });
    expect(checkReparent(index, "ceo", null)).toEqual({ ok: false, reason: "same-manager" });
  });
});
