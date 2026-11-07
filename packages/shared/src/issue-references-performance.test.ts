import { describe, expect, it } from "vitest";
import { extractIssueReferenceMatches } from "./issue-references.js";

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

describe("issue reference extraction on pathological input", () => {
  it("scans a long alphanumeric run in linear time", () => {
    const run = "aB3".repeat(100_000);
    const { result, ms } = timed(() => extractIssueReferenceMatches(`${run}\nSee PAP-1.`));
    expect(result.map((match) => match.identifier)).toEqual(["PAP-1"]);
    expect(ms).toBeLessThan(2000);
  });

  it("keeps matching tokens that start mid-run after digits", () => {
    expect(extractIssueReferenceMatches("12PAP-5").map((match) => match.identifier)).toEqual(["PAP-5"]);
  });

  it("trims a long run of closing brackets in linear time", () => {
    const { result, ms } = timed(() => extractIssueReferenceMatches(`/${"]".repeat(200_000)}`));
    expect(result).toEqual([]);
    expect(ms).toBeLessThan(2000);
  });
});
