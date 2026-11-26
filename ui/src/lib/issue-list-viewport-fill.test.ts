import { describe, expect, it } from "vitest";
import { claimViewportFill } from "./issue-list-viewport-fill";

describe("claimViewportFill", () => {
  it("allows one fill per loaded issue set", () => {
    const latch: { current: string[] | null } = { current: null };
    const firstPage = ["a"];

    expect(claimViewportFill(latch, firstPage)).toBe(true);
    expect(claimViewportFill(latch, firstPage)).toBe(false);
  });

  it("allows the next fill after a page arrives, until the list can scroll", () => {
    const latch: { current: string[][] | null } = { current: null };
    const pages: string[][] = [["a"]];

    // Each successful server page produces a new loaded set.
    for (let page = 1; page <= 3; page += 1) {
      const loaded = [...pages];
      expect(claimViewportFill(latch, loaded)).toBe(true);
      pages.push([`page-${page}`]);
    }
  });

  it("does not retry while a failed fill leaves the loaded set unchanged", () => {
    const latch: { current: string[] | null } = { current: null };
    const loaded = ["a", "b"];

    expect(claimViewportFill(latch, loaded)).toBe(true);
    // The page request failed: the same set is checked again on every rerender.
    expect(claimViewportFill(latch, loaded)).toBe(false);
    expect(claimViewportFill(latch, loaded)).toBe(false);
  });
});
