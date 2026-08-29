import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearViteCaches,
  detectStaleInstall,
  markInstallFresh,
  resolveViteCachePaths,
} from "../../../scripts/dev-runner-install.ts";

const tempRoots: string[] = [];

function makeRepoRoot(): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-runner-install-"));
  tempRoots.push(repoRoot);
  return repoRoot;
}

function writeLockfile(repoRoot: string, mtime: Date): void {
  const lockfile = path.join(repoRoot, "pnpm-lock.yaml");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n", "utf8");
  utimesSync(lockfile, mtime, mtime);
}

function writeModulesManifest(repoRoot: string, mtime: Date): void {
  const manifest = path.join(repoRoot, "node_modules", ".modules.yaml");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, "hoistPattern:\n  - '*'\n", "utf8");
  utimesSync(manifest, mtime, mtime);
}

afterEach(() => {
  for (const repoRoot of tempRoots.splice(0)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("detectStaleInstall", () => {
  it("is fresh when there is no lockfile to compare against", () => {
    const repoRoot = makeRepoRoot();

    expect(detectStaleInstall(repoRoot)).toEqual({ stale: false, reason: null });
  });

  it("is stale when dependencies were never installed", () => {
    const repoRoot = makeRepoRoot();
    writeLockfile(repoRoot, new Date("2026-08-27T10:00:00Z"));

    const check = detectStaleInstall(repoRoot);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/never been installed/);
  });

  it("is stale when the lockfile is newer than the last install", () => {
    const repoRoot = makeRepoRoot();
    writeModulesManifest(repoRoot, new Date("2026-08-27T10:00:00Z"));
    writeLockfile(repoRoot, new Date("2026-08-27T11:00:00Z"));

    const check = detectStaleInstall(repoRoot);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/pnpm-lock\.yaml changed/);
  });

  it("is fresh when the last install is newer than the lockfile", () => {
    const repoRoot = makeRepoRoot();
    writeLockfile(repoRoot, new Date("2026-08-27T10:00:00Z"));
    writeModulesManifest(repoRoot, new Date("2026-08-27T11:00:00Z"));

    expect(detectStaleInstall(repoRoot)).toEqual({ stale: false, reason: null });
  });
});

describe("markInstallFresh", () => {
  it("bumps the manifest so a touched lockfile stops reading as stale", () => {
    const repoRoot = makeRepoRoot();
    writeModulesManifest(repoRoot, new Date("2026-08-27T10:00:00Z"));
    writeLockfile(repoRoot, new Date("2026-08-27T11:00:00Z"));
    expect(detectStaleInstall(repoRoot).stale).toBe(true);

    markInstallFresh(repoRoot, new Date("2026-08-27T12:00:00Z"));

    expect(detectStaleInstall(repoRoot)).toEqual({ stale: false, reason: null });
  });

  it("tolerates a missing manifest", () => {
    const repoRoot = makeRepoRoot();

    expect(() => markInstallFresh(repoRoot)).not.toThrow();
  });
});

describe("clearViteCaches", () => {
  it("removes existing optimizer caches and reports them", () => {
    const repoRoot = makeRepoRoot();
    const cachePaths = resolveViteCachePaths(repoRoot);
    for (const cachePath of cachePaths) {
      mkdirSync(path.join(cachePath, "deps"), { recursive: true });
      writeFileSync(path.join(cachePath, "deps", "_metadata.json"), "{}", "utf8");
    }

    const removed = clearViteCaches(repoRoot);

    expect(removed.sort()).toEqual([...cachePaths].sort());
    for (const cachePath of cachePaths) {
      expect(existsSync(cachePath)).toBe(false);
    }
  });

  it("is a no-op when no caches exist", () => {
    const repoRoot = makeRepoRoot();

    expect(clearViteCaches(repoRoot)).toEqual([]);
  });
});
