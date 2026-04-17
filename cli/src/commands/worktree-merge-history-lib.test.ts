import { describe, expect, it } from "vitest";
import { parseWorktreeMergeScopes, WORKTREE_MERGE_SCOPES } from "./worktree-merge-history-lib.js";

describe("parseWorktreeMergeScopes", () => {
  it("returns all scopes when called with undefined", () => {
    const result = parseWorktreeMergeScopes(undefined);
    expect(result).toEqual(["issues", "comments"]);
  });

  it("returns all scopes for empty string", () => {
    expect(parseWorktreeMergeScopes("")).toEqual(["issues", "comments"]);
  });

  it("returns all scopes for whitespace-only string", () => {
    expect(parseWorktreeMergeScopes("   ")).toEqual(["issues", "comments"]);
  });

  it("parses a single valid scope", () => {
    expect(parseWorktreeMergeScopes("issues")).toEqual(["issues"]);
  });

  it("parses multiple valid scopes", () => {
    const result = parseWorktreeMergeScopes("issues,comments");
    expect(result).toContain("issues");
    expect(result).toContain("comments");
  });

  it("deduplicates repeated scopes", () => {
    const result = parseWorktreeMergeScopes("issues,issues,comments");
    expect(result.filter((s) => s === "issues")).toHaveLength(1);
  });

  it("trims whitespace from scope values", () => {
    expect(parseWorktreeMergeScopes("  issues , comments  ")).toContain("issues");
  });

  it("is case-insensitive", () => {
    expect(parseWorktreeMergeScopes("ISSUES")).toEqual(["issues"]);
  });

  it("throws for invalid scope value", () => {
    expect(() => parseWorktreeMergeScopes("invalid-scope")).toThrow();
  });

  it("throws when all values are invalid", () => {
    expect(() => parseWorktreeMergeScopes("bad1,bad2")).toThrow();
  });
});

describe("WORKTREE_MERGE_SCOPES", () => {
  it("includes 'issues' and 'comments'", () => {
    expect(WORKTREE_MERGE_SCOPES).toContain("issues");
    expect(WORKTREE_MERGE_SCOPES).toContain("comments");
  });
});
