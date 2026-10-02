import { expect, it } from "vitest";
import { matchesRunCount, minimumRunCount } from "./run-count.js";

it("keeps ordinary cases exact and bounds either one steered run or two sequential runs", () => {
  const exact = { expectedRunCount: 2 };
  const ranged = { ...exact, minimumExpectedRunCount: 1 };
  expect(minimumRunCount(exact)).toBe(2);
  expect(minimumRunCount(ranged)).toBe(1);
  expect([0, 1, 2, 3].map(n => matchesRunCount(exact, n))).toEqual([false, false, true, false]);
  expect([0, 1, 2, 3].map(n => matchesRunCount(ranged, n))).toEqual([false, true, true, false]);
});
