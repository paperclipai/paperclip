import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKTREE_GC_MIN_AGE_MS,
  findStaleWorktreeInstances,
  runWorktreeGc,
} from "./worktree-gc.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(repoCwd: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoCwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "gc-test@example.com"], {
    cwd: repoCwd,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "GC Test"], { cwd: repoCwd, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoCwd, stdio: "ignore" });
  fs.writeFileSync(path.join(repoCwd, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoCwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: repoCwd, stdio: "ignore" });
}

function makeInstanceDir(homeDir: string, instanceId: string): string {
  const instanceRoot = path.join(homeDir, "instances", instanceId);
  fs.mkdirSync(path.join(instanceRoot, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(instanceRoot, "data", "storage"), { recursive: true });
  return instanceRoot;
}

function backdate(targetPath: string, msInPast: number): void {
  const t = (Date.now() - msInPast) / 1000;
  fs.utimesSync(targetPath, t, t);
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findStaleWorktreeInstances", () => {
  let repoCwd: string;
  let homeDir: string;

  beforeEach(() => {
    repoCwd = createTempDir("paperclip-gc-repo-");
    cleanupDirs.push(repoCwd);
    homeDir = createTempDir("paperclip-gc-home-");
    cleanupDirs.push(homeDir);
    initRepo(repoCwd);
  });

  it("returns empty when no instances directory exists", () => {
    expect(findStaleWorktreeInstances({ repoCwd, homeDir })).toEqual([]);
  });

  it("flags an instance whose branch is gone", () => {
    const instanceRoot = makeInstanceDir(homeDir, "pap-552-merged-and-gone");
    backdate(instanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    const found = findStaleWorktreeInstances({ repoCwd, homeDir });
    expect(found).toHaveLength(1);
    expect(found[0]!.instanceId).toBe("pap-552-merged-and-gone");
    expect(found[0]!.reason).toBe("branch_missing");
  });

  it("preserves an instance whose branch still exists locally", () => {
    execFileSync("git", ["branch", "paperclip-pap-700-active"], { cwd: repoCwd, stdio: "ignore" });
    const instanceRoot = makeInstanceDir(homeDir, "pap-700-active");
    backdate(instanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    expect(findStaleWorktreeInstances({ repoCwd, homeDir })).toEqual([]);
  });

  it("preserves recent instances even when no branch exists yet", () => {
    makeInstanceDir(homeDir, "pap-just-created");
    const found = findStaleWorktreeInstances({
      repoCwd,
      homeDir,
      minAgeMs: 10 * 60 * 1000,
    });
    expect(found).toEqual([]);
  });

  it("matches branches with and without the paperclip- prefix", () => {
    execFileSync("git", ["branch", "pap-noprefix-active"], { cwd: repoCwd, stdio: "ignore" });
    const instanceRoot = makeInstanceDir(homeDir, "pap-noprefix-active");
    backdate(instanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    expect(findStaleWorktreeInstances({ repoCwd, homeDir })).toEqual([]);
  });
});

describe("runWorktreeGc", () => {
  let repoCwd: string;
  let homeDir: string;

  beforeEach(() => {
    repoCwd = createTempDir("paperclip-gc-repo-");
    cleanupDirs.push(repoCwd);
    homeDir = createTempDir("paperclip-gc-home-");
    cleanupDirs.push(homeDir);
    initRepo(repoCwd);
  });

  it("removes stale instance directories", () => {
    const staleInstanceRoot = makeInstanceDir(homeDir, "pap-stale-001");
    backdate(staleInstanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    const result = runWorktreeGc({ repoCwd, homeDir });
    expect(result.pruned).toEqual(["pap-stale-001"]);
    expect(fs.existsSync(staleInstanceRoot)).toBe(false);
  });

  it("dry-run does not delete anything", () => {
    const staleInstanceRoot = makeInstanceDir(homeDir, "pap-stale-002");
    backdate(staleInstanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    const result = runWorktreeGc({ repoCwd, homeDir, dryRun: true });
    expect(result.pruned).toEqual(["pap-stale-002"]);
    expect(fs.existsSync(staleInstanceRoot)).toBe(true);
  });

  it("skips pruning when a postmaster.pid exists for a live process", () => {
    const instanceRoot = makeInstanceDir(homeDir, "pap-stale-live-pg");
    const dbDir = path.join(instanceRoot, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, "postmaster.pid"), `${process.pid}\n`);
    backdate(instanceRoot, DEFAULT_WORKTREE_GC_MIN_AGE_MS + 60_000);

    const result = runWorktreeGc({ repoCwd, homeDir });
    expect(result.pruned).toEqual([]);
    expect(result.skipped).toEqual([
      { instanceId: "pap-stale-live-pg", reason: "postmaster_alive" },
    ]);
    expect(fs.existsSync(instanceRoot)).toBe(true);
  });
});
