import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalPathGitWorkspaceInitialized, hasGitMetadata } from "../services/git-workspace-utils.ts";

const execFile = promisify(execFileCallback);

let originalGitConfigGlobal: string | undefined;
let gitConfigDir: string;

beforeAll(async () => {
  originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  gitConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-workspace-utils-config-"));
});

afterAll(async () => {
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  await fs.rm(gitConfigDir, { recursive: true, force: true });
});

let tempDir: string;

beforeEach(async () => {
  // Isolate `git config --global` writes from the real user gitconfig for every test.
  process.env.GIT_CONFIG_GLOBAL = path.join(gitConfigDir, `${Math.random().toString(36).slice(2)}.gitconfig`);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-workspace-utils-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("hasGitMetadata", () => {
  it("returns false for a plain folder with no .git entry", async () => {
    expect(await hasGitMetadata(tempDir)).toBe(false);
  });

  it("returns true once .git exists as a directory", async () => {
    await execFile("git", ["init"], { cwd: tempDir });
    expect(await hasGitMetadata(tempDir)).toBe(true);
  });

  it("returns false for a null/undefined/blank cwd", async () => {
    expect(await hasGitMetadata(null)).toBe(false);
    expect(await hasGitMetadata(undefined)).toBe(false);
    expect(await hasGitMetadata("   ")).toBe(false);
  });
});

describe("ensureLocalPathGitWorkspaceInitialized", () => {
  it("runs git init and registers safe.directory when no .git exists", async () => {
    const result = await ensureLocalPathGitWorkspaceInitialized(tempDir);
    expect(result).toEqual({ outcome: "initialized" });
    expect(await hasGitMetadata(tempDir)).toBe(true);

    const safeDirectories = await execFile("git", ["config", "--global", "--get-all", "safe.directory"]).then(
      (out) => out.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    );
    expect(safeDirectories).toContain(path.resolve(tempDir));
  });

  it("does not touch an existing .git directory", async () => {
    await execFile("git", ["init"], { cwd: tempDir });
    await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: tempDir });
    await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: tempDir });

    const result = await ensureLocalPathGitWorkspaceInitialized(tempDir);
    expect(result).toEqual({ outcome: "already_initialized" });

    // The pre-existing repo-local config (distinct from the global safe.directory list) is untouched.
    const email = await execFile("git", ["config", "user.email"], { cwd: tempDir }).then((out) => out.stdout.trim());
    expect(email).toBe("paperclip@example.com");
  });

  it("registers safe.directory for a pre-existing .git repo owned by another user", async () => {
    await execFile("git", ["init"], { cwd: tempDir });

    const result = await ensureLocalPathGitWorkspaceInitialized(tempDir);
    expect(result).toEqual({ outcome: "already_initialized" });

    const safeDirectories = await execFile("git", ["config", "--global", "--get-all", "safe.directory"]).then(
      (out) => out.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    );
    expect(safeDirectories).toContain(path.resolve(tempDir));
  });

  it("surfaces a safeDirectoryWarning instead of silently succeeding when safe.directory registration fails", async () => {
    // Point GIT_CONFIG_GLOBAL at a file inside a directory that does not exist, so
    // `git config --global --add` cannot create/lock the config file.
    process.env.GIT_CONFIG_GLOBAL = path.join(gitConfigDir, "does-not-exist", "nested.gitconfig");

    const result = await ensureLocalPathGitWorkspaceInitialized(tempDir);
    expect(result.outcome).toBe("initialized");
    expect(await hasGitMetadata(tempDir)).toBe(true);
    if (result.outcome !== "failed") {
      expect(result.safeDirectoryWarning).toBeTruthy();
    }
  });

  it("reports failure without throwing when no cwd is given", async () => {
    const result = await ensureLocalPathGitWorkspaceInitialized(null);
    expect(result.outcome).toBe("failed");
  });

  it("reports failure without throwing when git init cannot run in the target path", async () => {
    const missingPath = path.join(tempDir, "does-not-exist", "nested");
    const result = await ensureLocalPathGitWorkspaceInitialized(missingPath);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
