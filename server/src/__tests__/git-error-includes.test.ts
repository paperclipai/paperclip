import { describe, expect, it } from "vitest";

// Replicate the gitErrorIncludes function from workspace-runtime.ts
function gitErrorIncludes(error: unknown, needle: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

describe("gitErrorIncludes", () => {
  it("matches the old git worktree error message", () => {
    const err = new Error("fatal: 'feature/test' is already checked out at '/tmp/wt1'");
    expect(gitErrorIncludes(err, "already checked out")).toBe(true);
  });

  it("matches the new git 2.42+ worktree error message", () => {
    const err = new Error("fatal: 'feature/test' is already used by worktree at '/tmp/wt2'");
    expect(gitErrorIncludes(err, "already used by worktree")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    const err = new Error("fatal: pathspec 'feature/test' did not match any file(s) known to git");
    expect(gitErrorIncludes(err, "already checked out")).toBe(false);
    expect(gitErrorIncludes(err, "already used by worktree")).toBe(false);
  });

  it("is case-insensitive", () => {
    const err = new Error("fatal: 'feature/test' is already CHECKED OUT at '/tmp/wt1'");
    expect(gitErrorIncludes(err, "already checked out")).toBe(true);
  });
});
