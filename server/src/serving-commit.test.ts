import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { __resetServingCommitCacheForTests, resolveServingCommit } from "./serving-commit.js";

const insideRepo = path.dirname(fileURLToPath(import.meta.url)); // server/src, inside the checkout

afterEach(() => {
  __resetServingCommitCacheForTests();
});

describe("resolveServingCommit", () => {
  it("reports the checkout's HEAD as a 40-char sha and a branch", () => {
    __resetServingCommitCacheForTests();
    const commit = resolveServingCommit(insideRepo, 1_000);
    expect(commit).not.toBeNull();
    expect(commit?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof commit?.branch).toBe("string");
    expect(commit?.branch.length).toBeGreaterThan(0);
  });

  it("returns null outside a git checkout", () => {
    __resetServingCommitCacheForTests();
    const notARepo = mkdtempSync(path.join(os.tmpdir(), "pc-serving-commit-"));
    expect(resolveServingCommit(notARepo, 1_000)).toBeNull();
  });

  it("caches within the TTL and re-reads after it expires", () => {
    __resetServingCommitCacheForTests();
    const notARepo = mkdtempSync(path.join(os.tmpdir(), "pc-serving-commit-"));

    const fromRepo = resolveServingCommit(insideRepo, 1_000);
    expect(fromRepo).not.toBeNull();

    // Within the 5s TTL the cached repo value is returned even for a non-git cwd.
    expect(resolveServingCommit(notARepo, 2_000)).toEqual(fromRepo);

    // Past the TTL it re-reads, and the non-git cwd now resolves to null.
    expect(resolveServingCommit(notARepo, 1_000 + 6_000)).toBeNull();
  });
});
