import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isMissingStorageObjectError,
  resolveGitWorktreeAddArgs,
  rebindWorkspaceCwd,
} from "./worktree.js";

// ============================================================================
// isMissingStorageObjectError
// ============================================================================

describe("isMissingStorageObjectError", () => {
  it("returns false for null", () => {
    expect(isMissingStorageObjectError(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isMissingStorageObjectError("not an object")).toBe(false);
  });

  it("returns true for error with code ENOENT", () => {
    expect(isMissingStorageObjectError({ code: "ENOENT" })).toBe(true);
  });

  it("returns true for error with status 404", () => {
    expect(isMissingStorageObjectError({ status: 404 })).toBe(true);
  });

  it("returns true for error with name NoSuchKey", () => {
    expect(isMissingStorageObjectError({ name: "NoSuchKey" })).toBe(true);
  });

  it("returns true for error with name NotFound", () => {
    expect(isMissingStorageObjectError({ name: "NotFound" })).toBe(true);
  });

  it("returns true for error with message 'Object not found.'", () => {
    expect(isMissingStorageObjectError({ message: "Object not found." })).toBe(true);
  });

  it("returns false for other error objects", () => {
    expect(isMissingStorageObjectError({ code: "EACCES", status: 403 })).toBe(false);
  });

  it("returns false for number", () => {
    expect(isMissingStorageObjectError(42)).toBe(false);
  });
});

// ============================================================================
// resolveGitWorktreeAddArgs
// ============================================================================

describe("resolveGitWorktreeAddArgs", () => {
  it("returns basic worktree add args when branch exists and no startPoint", () => {
    const args = resolveGitWorktreeAddArgs({
      branchName: "my-branch",
      targetPath: "/tmp/worktree",
      branchExists: true,
    });
    expect(args).toEqual(["worktree", "add", "/tmp/worktree", "my-branch"]);
  });

  it("returns -b flag args when branch does not exist", () => {
    const args = resolveGitWorktreeAddArgs({
      branchName: "new-branch",
      targetPath: "/tmp/worktree",
      branchExists: false,
    });
    expect(args).toContain("-b");
    expect(args).toContain("new-branch");
    expect(args).toContain("/tmp/worktree");
    // Default startPoint is HEAD
    expect(args).toContain("HEAD");
  });

  it("uses custom startPoint when provided and branch does not exist", () => {
    const args = resolveGitWorktreeAddArgs({
      branchName: "feature",
      targetPath: "/tmp/wt",
      branchExists: false,
      startPoint: "abc1234",
    });
    expect(args).toContain("abc1234");
    expect(args).not.toContain("HEAD");
  });

  it("uses -b flag when branch exists but startPoint is provided", () => {
    const args = resolveGitWorktreeAddArgs({
      branchName: "my-branch",
      targetPath: "/tmp/worktree",
      branchExists: true,
      startPoint: "main",
    });
    expect(args).toContain("-b");
    expect(args).toContain("main");
  });
});

// ============================================================================
// rebindWorkspaceCwd
// ============================================================================

describe("rebindWorkspaceCwd", () => {
  it("returns targetRepoRoot when workspaceCwd equals sourceRepoRoot", () => {
    const result = rebindWorkspaceCwd({
      sourceRepoRoot: "/src/repo",
      targetRepoRoot: "/tgt/repo",
      workspaceCwd: "/src/repo",
    });
    expect(result).toBe(path.resolve("/tgt/repo"));
  });

  it("maps a subdirectory from source to target", () => {
    const result = rebindWorkspaceCwd({
      sourceRepoRoot: "/src/repo",
      targetRepoRoot: "/tgt/repo",
      workspaceCwd: "/src/repo/packages/server",
    });
    expect(result).toBe(path.resolve("/tgt/repo/packages/server"));
  });

  it("returns null when workspaceCwd is outside sourceRepoRoot", () => {
    const result = rebindWorkspaceCwd({
      sourceRepoRoot: "/src/repo",
      targetRepoRoot: "/tgt/repo",
      workspaceCwd: "/other/path",
    });
    expect(result).toBeNull();
  });

  it("returns null for path traversal above sourceRepoRoot", () => {
    const result = rebindWorkspaceCwd({
      sourceRepoRoot: "/src/repo",
      targetRepoRoot: "/tgt/repo",
      workspaceCwd: "/src/repo/../other",
    });
    expect(result).toBeNull();
  });
});
