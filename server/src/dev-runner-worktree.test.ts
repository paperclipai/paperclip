import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "./dev-runner-worktree.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// resolveWorktreeEnvFilePath — pure path computation
// ============================================================================

describe("resolveWorktreeEnvFilePath", () => {
  it("returns the path to .paperclip/.env inside rootDir", () => {
    const result = resolveWorktreeEnvFilePath("/project/my-worktree");
    expect(result).toBe(path.resolve("/project/my-worktree", ".paperclip", ".env"));
  });

  it("resolves relative rootDir to absolute path", () => {
    const result = resolveWorktreeEnvFilePath("./relative-dir");
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ============================================================================
// isLinkedGitWorktreeCheckout — filesystem checks
// ============================================================================

describe("isLinkedGitWorktreeCheckout", () => {
  it("returns false when .git does not exist", () => {
    const dir = makeTempDir();
    expect(isLinkedGitWorktreeCheckout(dir)).toBe(false);
  });

  it("returns false when .git is a directory (normal repo checkout)", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    expect(isLinkedGitWorktreeCheckout(dir)).toBe(false);
  });

  it("returns false when .git is a file not starting with 'gitdir:'", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "some random content");
    expect(isLinkedGitWorktreeCheckout(dir)).toBe(false);
  });

  it("returns true when .git is a file starting with 'gitdir:'", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo/.git/worktrees/branch-name");
    expect(isLinkedGitWorktreeCheckout(dir)).toBe(true);
  });

  it("returns true when .git starts with 'gitdir:' with leading whitespace", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "  gitdir: /repo/.git/worktrees/branch-name");
    expect(isLinkedGitWorktreeCheckout(dir)).toBe(true);
  });
});

// ============================================================================
// bootstrapDevRunnerWorktreeEnv — non-worktree path
// ============================================================================

describe("bootstrapDevRunnerWorktreeEnv — not a worktree", () => {
  it("returns envPath=null and missingEnv=false when not a worktree checkout", () => {
    const dir = makeTempDir();
    // No .git file → not a worktree
    const result = bootstrapDevRunnerWorktreeEnv(dir, {});
    expect(result).toEqual({ envPath: null, missingEnv: false });
  });

  it("does not modify the env when not a worktree", () => {
    const dir = makeTempDir();
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(Object.keys(env)).toHaveLength(0);
  });
});

// ============================================================================
// bootstrapDevRunnerWorktreeEnv — worktree without .env
// ============================================================================

describe("bootstrapDevRunnerWorktreeEnv — worktree, missing .env", () => {
  it("returns missingEnv=true when worktree has no .env file", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo/.git/worktrees/test");
    const result = bootstrapDevRunnerWorktreeEnv(dir, {});
    expect(result.missingEnv).toBe(true);
  });

  it("returns the expected envPath when .env is absent", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo/.git/worktrees/test");
    const result = bootstrapDevRunnerWorktreeEnv(dir, {});
    if (result.envPath) {
      expect(result.envPath).toBe(path.resolve(dir, ".paperclip", ".env"));
    }
  });
});

// ============================================================================
// bootstrapDevRunnerWorktreeEnv — worktree with .env (env loading + parsing)
// ============================================================================

describe("bootstrapDevRunnerWorktreeEnv — worktree, .env present", () => {
  it("returns missingEnv=false when worktree has a .env file", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo/.git/worktrees/test");
    writeFile(path.join(dir, ".paperclip", ".env"), "FOO=bar");
    const result = bootstrapDevRunnerWorktreeEnv(dir, {});
    expect(result.missingEnv).toBe(false);
  });

  it("loads plain KEY=value entries into env", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "MY_VAR=hello");
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["MY_VAR"]).toBe("hello");
  });

  it("strips double quotes from quoted values", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), 'QUOTED="hello world"');
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["QUOTED"]).toBe("hello world");
  });

  it("strips single quotes from quoted values", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "SINGLE='my value'");
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["SINGLE"]).toBe("my value");
  });

  it("ignores comment lines starting with #", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "# This is a comment\nREAL_VAR=real");
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["REAL_VAR"]).toBe("real");
    expect(env["# This is a comment"]).toBeUndefined();
  });

  it("strips inline comments from values", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "KEY=value # inline comment");
    const env: NodeJS.ProcessEnv = {};
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["KEY"]).toBe("value");
  });

  it("does not overwrite an existing non-empty env var", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "EXISTING=from_file");
    const env: NodeJS.ProcessEnv = { EXISTING: "from_host" };
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["EXISTING"]).toBe("from_host");
  });

  it("overwrites an existing empty-string env var", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, ".git"), "gitdir: /repo");
    writeFile(path.join(dir, ".paperclip", ".env"), "BLANK_VAR=from_file");
    const env: NodeJS.ProcessEnv = { BLANK_VAR: "" };
    bootstrapDevRunnerWorktreeEnv(dir, env);
    expect(env["BLANK_VAR"]).toBe("from_file");
  });
});
