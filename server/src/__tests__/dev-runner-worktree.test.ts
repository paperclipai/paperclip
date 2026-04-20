import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/aiteamcorp/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local Paperclip env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/aiteamcorp/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "AITEAMCORP_HOME=/tmp/paperclip-worktrees",
        "AITEAMCORP_INSTANCE_ID=feature-worktree",
        "AITEAMCORP_IN_WORKTREE=true",
        "AITEAMCORP_WORKTREE_NAME=feature-worktree",
        "AITEAMCORP_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      AITEAMCORP_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.AITEAMCORP_HOME).toBe("/tmp/paperclip-worktrees");
    expect(env.AITEAMCORP_INSTANCE_ID).toBe("already-set");
    expect(env.AITEAMCORP_IN_WORKTREE).toBe("true");
    expect(env.AITEAMCORP_OPTIONAL).toBe("");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/aiteamcorp/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });
});
