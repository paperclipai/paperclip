import { describe, expect, it } from "vitest";
import { gitErrorIncludes } from "../services/workspace-runtime.js";

describe("gitErrorIncludes", () => {
  it("matches old git 'already checked out' message", () => {
    const err = new Error("fatal: workspace already checked out at /path/to/worktree");
    expect(gitErrorIncludes(err, "already checked out")).toBe(true);
  });

  it("matches new git 2.42+ 'already used by worktree' message", () => {
    const err = new Error("fatal: a worktree with that name already exists at /path/to/worktree");
    expect(gitErrorIncludes(err, "already used by worktree")).toBe(true);
  });

  it("does not match unrelated messages", () => {
    const err = new Error("fatal: not a git repository");
    expect(gitErrorIncludes(err, "already checked out")).toBe(false);
    expect(gitErrorIncludes(err, "already used by worktree")).toBe(false);
  });
});
