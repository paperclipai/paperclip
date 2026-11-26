import { describe, expect, it } from "vitest";
import { uniqueIssuePrefix } from "./issue-prefix.js";

describe("uniqueIssuePrefix", () => {
  it("does not repeat across more companies than four hex characters can name", () => {
    const count = 70_000;
    const prefixes = new Set(Array.from({ length: count }, () => uniqueIssuePrefix("S")));
    expect(prefixes.size).toBe(count);
  });

  it("keeps the tag and an uppercase hex suffix", () => {
    expect(uniqueIssuePrefix("CS")).toMatch(/^CS[0-9A-F]{12}$/);
  });
});
