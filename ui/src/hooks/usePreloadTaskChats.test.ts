import { describe, expect, it } from "vitest";
import { topRenderedNavEntryRefs } from "./usePreloadTaskChats";

type Entry = Parameters<typeof topRenderedNavEntryRefs>[0][number];

const row = (index: number, budgetOrdinal = index + 1): Entry =>
  ({ type: "issue", issue: { id: `id-${index}`, identifier: `T-${index}` }, budgetOrdinal });

describe("topRenderedNavEntryRefs", () => {
  it("takes the first ten rendered rows in display order and skips group headers", () => {
    const entries: Entry[] = [{ type: "group" }, row(0), row(1), { type: "group" }, ...Array.from({ length: 20 }, (_, index) => row(index + 2))];
    expect(topRenderedNavEntryRefs(entries, 100)).toEqual(Array.from({ length: 10 }, (_, index) => `T-${index}`));
  });

  it("skips rows past the render budget", () => {
    // Rows of a collapsed group consume budget but have no entries; later rows can fall past it.
    const entries: Entry[] = [row(0, 1), row(1, 2), row(2, 150), row(3, 151)];
    expect(topRenderedNavEntryRefs(entries, 100)).toEqual(["T-0", "T-1"]);
  });

  it("stops reading at the limit in a list of thousands of rows", () => {
    let reads = 0;
    const entries = new Proxy(Array.from({ length: 5_000 }, (_, index) => row(index)), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads += 1;
          if (reads > 10) throw new Error("read past the preload limit");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(topRenderedNavEntryRefs(entries, 10_000)).toHaveLength(10);
    expect(reads).toBe(10);
  });
});
