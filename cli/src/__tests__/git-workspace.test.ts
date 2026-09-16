import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { detectGitWorkspaceInfo, isLinkedGitWorktree } from "../commands/git-workspace.js";

const cleanupDirectories: string[] = [];

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    fs.rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Git worktree detection", () => {
  it("distinguishes a linked worktree from the primary checkout and non-Git paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-git-workspace-"));
    cleanupDirectories.push(root);
    const primary = path.join(root, "primary");
    const linked = path.join(root, "linked");
    fs.mkdirSync(primary);
    execFileSync("git", ["init"], { cwd: primary, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "Paperclip Test"], { cwd: primary });
    fs.writeFileSync(path.join(primary, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: primary });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: primary, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "linked-test", linked], {
      cwd: primary,
      stdio: "ignore",
    });

    const primaryInfo = detectGitWorkspaceInfo(primary);
    const linkedInfo = detectGitWorkspaceInfo(linked);
    expect(primaryInfo?.gitDir).toBe(primaryInfo?.commonDir);
    expect(linkedInfo?.gitDir).not.toBe(linkedInfo?.commonDir);
    expect(isLinkedGitWorktree(primary)).toBe(false);
    expect(isLinkedGitWorktree(linked)).toBe(true);
    expect(detectGitWorkspaceInfo(root)).toBeNull();
    expect(isLinkedGitWorktree(root)).toBe(false);
  });
});
