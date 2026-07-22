import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetServingDriftCacheForTests,
  computeServingDrift,
  evaluateDrift,
  getCachedServingDrift,
  setCachedServingDrift,
} from "./serving-drift.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim();
}

function commit(dir: string, message: string): string {
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", message], { cwd: dir, stdio: "ignore", env: GIT_ENV });
  return git(["rev-parse", "HEAD"], dir);
}

const tmpRoots: string[] = [];

/** origin has commits A then B on master; serving is a clone, optionally reset to A (1 behind). */
function makeFixture(opts: { behind: boolean }): { serving: string; headA: string; headB: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "pc-drift-"));
  tmpRoots.push(root);
  const origin = path.join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "master", origin], { stdio: "ignore", env: GIT_ENV });
  const headA = commit(origin, "A");
  const headB = commit(origin, "B");
  const serving = path.join(root, "serving");
  execFileSync("git", ["clone", "-q", origin, serving], { stdio: "ignore", env: GIT_ENV });
  if (opts.behind) git(["reset", "--hard", "-q", headA], serving);
  return { serving, headA, headB };
}

afterEach(() => {
  __resetServingDriftCacheForTests();
  while (tmpRoots.length) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("evaluateDrift", () => {
  it("a level tree is not behind and not stale", () => {
    expect(evaluateDrift()).toEqual({ behindBy: 0, driftAgeMs: null, stale: false, graceMs: expect.any(Number) });
  });

  it("is stale when behind past the grace window", () => {
    const now = 10_000;
    const v = evaluateDrift({ behindBy: 2, oldestUndeployedAtMs: now - 1_000, now, graceMs: 500 });
    expect(v.behindBy).toBe(2);
    expect(v.driftAgeMs).toBe(1_000);
    expect(v.stale).toBe(true);
  });

  it("is behind-but-not-stale within the grace window", () => {
    const now = 10_000;
    const v = evaluateDrift({ behindBy: 2, oldestUndeployedAtMs: now - 100, now, graceMs: 500 });
    expect(v.driftAgeMs).toBe(100);
    expect(v.stale).toBe(false);
  });

  it("never pages when the drift age is unknown", () => {
    const v = evaluateDrift({ behindBy: 3, oldestUndeployedAtMs: null, now: 10_000, graceMs: 0 });
    expect(v.driftAgeMs).toBeNull();
    expect(v.stale).toBe(false);
  });

  it("honours a grace of 0 (alarm on any known drift)", () => {
    const now = 10_000;
    const v = evaluateDrift({ behindBy: 1, oldestUndeployedAtMs: now, now, graceMs: 0 });
    expect(v.driftAgeMs).toBe(0);
    expect(v.stale).toBe(true);
  });

  it("clamps a negative or non-finite behindBy to 0", () => {
    expect(evaluateDrift({ behindBy: -5 }).behindBy).toBe(0);
    expect(evaluateDrift({ behindBy: Number.NaN }).behindBy).toBe(0);
    expect(evaluateDrift({ behindBy: -5, oldestUndeployedAtMs: 0, now: 10_000, graceMs: 0 }).stale).toBe(false);
  });
});

describe("computeServingDrift", () => {
  it("reports a clean tree as up to date", async () => {
    const { serving, headB } = makeFixture({ behind: false });
    const drift = await computeServingDrift(serving, { fetch: true });
    expect(drift.available).toBe(true);
    expect(drift.head).toBe(headB);
    expect(drift.baseHead).toBe(headB);
    expect(drift.behindBy).toBe(0);
    expect(drift.stale).toBe(false);
  });

  it("counts undeployed commits and goes stale with grace 0", async () => {
    const { serving, headA, headB } = makeFixture({ behind: true });
    const drift = await computeServingDrift(serving, { fetch: true, graceMs: 0 });
    expect(drift.available).toBe(true);
    expect(drift.head).toBe(headA);
    expect(drift.baseHead).toBe(headB);
    expect(drift.behindBy).toBe(1);
    expect(drift.oldestUndeployedAtMs).not.toBeNull();
    expect(drift.stale).toBe(true);
  });

  it("stays behind-but-not-stale within a large grace window", async () => {
    const { serving } = makeFixture({ behind: true });
    const drift = await computeServingDrift(serving, { fetch: true, graceMs: 60 * 60 * 1000 });
    expect(drift.behindBy).toBe(1);
    expect(drift.stale).toBe(false);
  });

  it("detects drift without fetching, from the cached remote ref", async () => {
    const { serving, headB } = makeFixture({ behind: true });
    const drift = await computeServingDrift(serving, { fetch: false, graceMs: 0 });
    expect(drift.behindBy).toBe(1);
    expect(drift.baseHead).toBe(headB);
  });

  it("reports unavailable outside a git checkout instead of clean", async () => {
    const notARepo = mkdtempSync(path.join(os.tmpdir(), "pc-drift-notgit-"));
    tmpRoots.push(notARepo);
    const drift = await computeServingDrift(notARepo, { fetch: true });
    expect(drift.available).toBe(false);
    expect(drift.behindBy).toBe(0);
    expect(drift.stale).toBe(false);
  });
});

describe("serving drift cache", () => {
  it("is null until set, returns the stored value, and clears on reset", () => {
    __resetServingDriftCacheForTests();
    expect(getCachedServingDrift()).toBeNull();
    const value = { head: "a".repeat(40), branch: "master", behindBy: 2, stale: true, driftAgeMs: 100, checkedAtMs: 5 };
    setCachedServingDrift(value);
    expect(getCachedServingDrift()).toEqual(value);
    __resetServingDriftCacheForTests();
    expect(getCachedServingDrift()).toBeNull();
  });
});
