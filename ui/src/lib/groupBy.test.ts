import { describe, expect, it } from "vitest";
import { groupBy } from "./groupBy.js";

describe("groupBy", () => {
  it("groups items by a string key", () => {
    const items = [
      { type: "a", value: 1 },
      { type: "b", value: 2 },
      { type: "a", value: 3 },
    ];
    const result = groupBy(items, (item) => item.type);
    expect(result["a"]).toHaveLength(2);
    expect(result["b"]).toHaveLength(1);
  });

  it("returns an empty object for an empty array", () => {
    expect(groupBy([], (item) => String(item))).toEqual({});
  });

  it("groups all items under the same key when keyFn returns same value", () => {
    const items = [1, 2, 3];
    const result = groupBy(items, () => "all");
    expect(result["all"]).toEqual([1, 2, 3]);
  });

  it("preserves item order within each group", () => {
    const items = [
      { k: "a", v: 1 },
      { k: "a", v: 2 },
      { k: "a", v: 3 },
    ];
    const result = groupBy(items, (i) => i.k);
    expect(result["a"].map((i) => i.v)).toEqual([1, 2, 3]);
  });

  it("handles items with many distinct keys", () => {
    const items = [1, 2, 3, 4, 5];
    const result = groupBy(items, (n) => String(n % 2 === 0 ? "even" : "odd"));
    expect(result["even"]).toEqual([2, 4]);
    expect(result["odd"]).toEqual([1, 3, 5]);
  });

  it("works with string items", () => {
    const words = ["apple", "ant", "bear", "bat", "cat"];
    const result = groupBy(words, (w) => w[0]);
    expect(result["a"]).toEqual(["apple", "ant"]);
    expect(result["b"]).toEqual(["bear", "bat"]);
    expect(result["c"]).toEqual(["cat"]);
  });
});
