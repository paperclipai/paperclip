import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServerVersion } from "../version.js";

const tempDirs: string[] = [];

function tempGitRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-version-"));
  tempDirs.push(root);
  mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  return root;
}

describe("resolveServerVersion", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers explicit runtime version metadata over package.json", () => {
    expect(
      resolveServerVersion({
        env: {
          PAPERCLIP_VERSION: "2026.612.0",
          PAPERCLIP_SOURCE_SHA: "ignored-sha",
        },
        repoRoot: "/missing",
        packageVersion: "0.3.1",
      }),
    ).toBe("2026.612.0");
  });

  it("uses the current git ref when no runtime version metadata is set", () => {
    const repoRoot = tempGitRepo();
    writeFileSync(path.join(repoRoot, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(
      path.join(repoRoot, ".git", "refs", "heads", "master"),
      "1413729a0b8f239ae0a469f1df13e4f43e8d82f1\n",
    );

    expect(
      resolveServerVersion({
        env: {},
        repoRoot,
        packageVersion: "0.3.1",
      }),
    ).toBe("1413729a0b8f239ae0a469f1df13e4f43e8d82f1");
  });

  it("uses detached HEAD commits when available", () => {
    const repoRoot = tempGitRepo();
    writeFileSync(
      path.join(repoRoot, ".git", "HEAD"),
      "c5d75a5e4186acb52e1065bf9a3eb27d7c35278d\n",
    );

    expect(resolveServerVersion({ env: {}, repoRoot, packageVersion: "0.3.1" })).toBe(
      "c5d75a5e4186acb52e1065bf9a3eb27d7c35278d",
    );
  });

  it("uses git metadata from linked worktree gitdir files", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-"));
    const gitDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-gitdir-"));
    tempDirs.push(repoRoot, gitDir);
    mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(
      path.join(gitDir, "refs", "heads", "feature"),
      "bf8d43310f9bc3b089cdb68f4374889f2ab7090e\n",
    );

    expect(resolveServerVersion({ env: {}, repoRoot, packageVersion: "0.3.1" })).toBe(
      "bf8d43310f9bc3b089cdb68f4374889f2ab7090e",
    );
  });

  it("uses packed refs when the current branch is not a loose ref", () => {
    const repoRoot = tempGitRepo();
    writeFileSync(path.join(repoRoot, ".git", "HEAD"), "ref: refs/heads/packed\n");
    writeFileSync(
      path.join(repoRoot, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
        "69a368ed5534b4d410aa38633051123ce3d0b66a refs/heads/packed\n",
    );

    expect(resolveServerVersion({ env: {}, repoRoot, packageVersion: "0.3.1" })).toBe(
      "69a368ed5534b4d410aa38633051123ce3d0b66a",
    );
  });

  it("falls back to the package version outside a git checkout", () => {
    expect(
      resolveServerVersion({
        env: {},
        repoRoot: "/missing",
        packageVersion: "0.3.1",
      }),
    ).toBe("0.3.1");
  });
});
