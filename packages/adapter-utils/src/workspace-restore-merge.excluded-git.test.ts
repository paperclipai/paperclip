import { promises as fsPromises } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldExcludePath } from "./exclude-patterns.js";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  captureDirectorySnapshot,
  disposeDirectorySnapshot,
  mergeDirectoryWithBaseline,
} from "./workspace-restore-merge.js";

describe("workspace restore merge with excluded git entries", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps restoring other entries when a scanned directory vanishes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const target = path.join(rootDir, "target"), source = path.join(rootDir, "source");
    await mkdir(path.join(target, "repo", ".git"), { recursive: true });
    await writeFile(path.join(target, "repo", ".git", "config"), "[core]\n");
    const baseline = await captureDirectorySnapshot(target, { exclude: [...GIT_ARCHIVE_EXCLUDES], diskBacked: true });
    try {
      await mkdir(source);
      await writeFile(path.join(source, "repo"), "replacement");
      await writeFile(path.join(source, "independent"), "applied");
      const readdirSpy = vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );
      try {
        await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target })).resolves.toBeUndefined();
      } finally { readdirSpy.mockRestore(); }
      expect(await readFile(path.join(target, "independent"), "utf8")).toBe("applied");
      expect(await readFile(path.join(target, "repo"), "utf8")).toBe("replacement");
    } finally { await disposeDirectorySnapshot(baseline); await rm(rootDir, { recursive: true, force: true }); }
  });

  it("fails the restore when the excluded-entry scan hits a permission error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const target = path.join(rootDir, "target"), source = path.join(rootDir, "source");
    await mkdir(path.join(target, "repo", ".git"), { recursive: true });
    await writeFile(path.join(target, "repo", ".git", "config"), "[core]\n");
    const baseline = await captureDirectorySnapshot(target, { exclude: [...GIT_ARCHIVE_EXCLUDES], diskBacked: true });
    try {
      await mkdir(source);
      await writeFile(path.join(source, "repo"), "replacement");
      const readdirSpy = vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      );
      try {
        await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }))
          .rejects.toMatchObject({ code: "EACCES" });
      } finally { readdirSpy.mockRestore(); }
    } finally { await disposeDirectorySnapshot(baseline); await rm(rootDir, { recursive: true, force: true }); }
  });

  it("excludes a nested clone's .git from the restore baseline", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-nested-git-")));
    try {
      await mkdir(path.join(root, "repo", ".git"), { recursive: true });
      await writeFile(path.join(root, "repo", ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
      await writeFile(path.join(root, "repo", "tracked.txt"), "host\n");
      const baseline = await captureDirectorySnapshot(root, { exclude: [...GIT_ARCHIVE_EXCLUDES] });
      try {
        const entries: string[] = [];
        for (const [entry] of baseline.entries as Iterable<[string, unknown]>) entries.push(entry);
        expect(entries).toContain("repo/tracked.txt");
        expect(entries.some((entry) => entry === "repo/.git" || entry.startsWith("repo/.git/"))).toBe(false);
        expect(shouldExcludePath("repo/.git/config", GIT_ARCHIVE_EXCLUDES)).toBe(true);
        expect(shouldExcludePath(".git/config", GIT_ARCHIVE_EXCLUDES)).toBe(true);
        expect(shouldExcludePath(".github/workflows/ci.yml", GIT_ARCHIVE_EXCLUDES)).toBe(false);
      } finally { await disposeDirectorySnapshot(baseline); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves excluded descendants when a non-strict restore replaces their parent with a file", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-excluded-replacement-")));
    const target = path.join(root, "target"), source = path.join(root, "source");
    await mkdir(path.join(target, "repo", ".git"), { recursive: true });
    await writeFile(path.join(target, "repo", ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    await writeFile(path.join(target, "repo", "tracked.txt"), "host\n");
    const baseline = await captureDirectorySnapshot(target, { exclude: [...GIT_ARCHIVE_EXCLUDES], diskBacked: true });
    try {
      await mkdir(source);
      await writeFile(path.join(source, "repo"), "replacement");
      await writeFile(path.join(source, "independent"), "applied");
      await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });
      expect((await lstat(path.join(target, "repo"))).isDirectory()).toBe(true);
      expect(await readFile(path.join(target, "repo", ".git", "config"), "utf8")).toContain("repositoryformatversion");
      expect(await readFile(path.join(target, "independent"), "utf8")).toBe("applied");
    } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("preserves excluded descendants when a non-strict restore replaces their parent with a symlink", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-excluded-replacement-link-")));
    const target = path.join(root, "target"), source = path.join(root, "source");
    await mkdir(path.join(target, "repo", ".git"), { recursive: true });
    await writeFile(path.join(target, "repo", ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    const baseline = await captureDirectorySnapshot(target, { exclude: [...GIT_ARCHIVE_EXCLUDES], diskBacked: true });
    try {
      await mkdir(source);
      await symlink(root, path.join(source, "repo"));
      await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });
      expect((await lstat(path.join(target, "repo"))).isDirectory()).toBe(true);
      expect(await readFile(path.join(target, "repo", ".git", "config"), "utf8")).toContain("repositoryformatversion");
    } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
  });
});
