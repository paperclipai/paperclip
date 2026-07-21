import { describe, expect, it } from "vitest";
import { appendCapped } from "./live-log-buffer";

describe("appendCapped", () => {
  it("returns the same array reference when there is nothing to add", () => {
    const prev = [1, 2, 3];
    expect(appendCapped(prev, [], 10)).toBe(prev);
  });

  it("appends without trimming while under the cap", () => {
    expect(appendCapped([1, 2], [3, 4], 10)).toEqual([1, 2, 3, 4]);
  });

  it("keeps exactly the newest `max` entries when the result overflows", () => {
    expect(appendCapped([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
  });

  it("trims correctly when a single append batch is larger than the cap", () => {
    expect(appendCapped([1], [2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6]);
  });

  it("returns exactly `max` entries when the result lands on the cap", () => {
    const result = appendCapped([1, 2], [3], 3);
    expect(result).toEqual([1, 2, 3]);
    expect(result.length).toBe(3);
  });

  it("does not mutate its inputs", () => {
    const prev = [1, 2, 3];
    const additions = [4, 5];
    appendCapped(prev, additions, 3);
    expect(prev).toEqual([1, 2, 3]);
    expect(additions).toEqual([4, 5]);
  });
});
