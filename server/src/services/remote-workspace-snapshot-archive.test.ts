import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRemoteWorkspaceDirectory, remoteWorkspaceArchiveScript, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";

const archiveIo = vi.hoisted(() => ({ afterChmod: undefined as ((target: string, mode: number) => void) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async chmod(target: string, mode: number) {
    await actual.chmod(target, mode); archiveIo.afterChmod?.(target, mode);
  } };
});

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot", GIT_COMMITTER_NAME: "Snapshot", GIT_AUTHOR_EMAIL: "snapshot@example.test", GIT_COMMITTER_EMAIL: "snapshot@example.test" };
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env })).stdout.trim();
describe("portable remote workspace archives", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-archive-test-")); });
  afterEach(async () => { archiveIo.afterChmod = undefined; await fs.rm(root, { recursive: true, force: true }); });
  async function source() { const cwd = path.join(root, "source"); await fs.mkdir(cwd); return cwd; }
  async function capture(cwd: string) { const archivePath = path.join(root, "snapshot.pcws"); return { archivePath, ...await captureRemoteWorkspaceDirectory({ cwd, archivePath }) }; }
  async function restore(snapshot: Awaited<ReturnType<typeof capture>>) {
    const targetDir = path.join(root, "restored");
    await restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir, expectedManifestDigest: snapshot.manifestDigest });
    return targetDir;
  }
  async function sourceBytes(directory: string): Promise<string> {
    const entries: unknown[] = [];
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name), stat = await fs.lstat(target);
      entries.push([name, stat.mode & 0o777, stat.isDirectory() ? await sourceBytes(target)
        : stat.isSymbolicLink() ? await fs.readlink(target) : createHash("sha256").update(await fs.readFile(target)).digest("hex")]);
    }
    return JSON.stringify(entries);
  }
  it("restores binary files, empty entries, executable modes and confined symlinks without its source", async () => {
    const cwd = await source();
    await fs.mkdir(path.join(cwd, "empty")); await fs.writeFile(path.join(cwd, "empty-file"), "");
    const bytes = Buffer.from([0, 255, 1, 128]); await fs.writeFile(path.join(cwd, "data.bin"), bytes);
    await fs.writeFile(path.join(cwd, "run"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.symlink("data.bin", path.join(cwd, "link"));
    const snapshot = await capture(cwd); await fs.rm(cwd, { recursive: true });
    const restored = await restore(snapshot);
    expect(await fs.readFile(path.join(restored, "data.bin"))).toEqual(bytes);
    expect(await fs.readFile(path.join(restored, "empty-file"))).toHaveLength(0);
    expect(await fs.readdir(path.join(restored, "empty"))).toEqual([]);
    expect((await fs.stat(path.join(restored, "run"))).mode & 0o777).toBe(0o755);
    expect(await fs.readlink(path.join(restored, "link"))).toBe("data.bin");
  });
  it("round trips an empty workspace", async () => {
    const snapshot = await capture(await source()); const restored = await restore(snapshot);
    expect(await fs.readdir(restored)).toEqual([]);
  });
  it("rejects a Files entry limit before extraction while ordinary restores keep their full contents", async () => {
    const cwd = await source(); await fs.writeFile(path.join(cwd, "first.txt"), "first\n"); await fs.writeFile(path.join(cwd, "second.txt"), "second\n");
    const snapshot = await capture(cwd), targetDir = path.join(root, "limited");
    await expect(restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir,
      expectedManifestDigest: snapshot.manifestDigest, maxEntries: 1 })).rejects.toThrow("remote_workspace_archive_entry_limit");
    await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter(name => name.startsWith(".workspace-restore-"))).toEqual([]);
    const restored = await restore(snapshot);
    expect(await fs.readFile(path.join(restored, "first.txt"), "utf8")).toBe("first\n");
    expect(await fs.readFile(path.join(restored, "second.txt"), "utf8")).toBe("second\n");
  });
  it("checks a Files manifest byte cap before allocating or reading its body", async () => {
    const archivePath = path.join(root, "oversized-manifest.pcws"), targetDir = path.join(root, "limited-manifest");
    const length = Buffer.alloc(4); length.writeUInt32BE(1024);
    await fs.writeFile(archivePath, Buffer.concat([Buffer.from("PCWS1\n"), length]));
    await expect(restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: "a".repeat(64), maxManifestBytes: 16 }))
      .rejects.toThrow("remote_workspace_archive_manifest_too_large");
    await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter(name => name.startsWith(".workspace-restore-"))).toEqual([]);
    await expect(restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: "a".repeat(64) }))
      .rejects.toThrow("remote_workspace_archive_truncated");
  });
  it("does not publish an empty archive when restoration was already canceled", async () => {
    const snapshot = await capture(await source()), targetDir = path.join(root, "canceled");
    const controller = new AbortController(), reason = new Error("restore canceled"); controller.abort(reason);
    await expect(restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir,
      expectedManifestDigest: snapshot.manifestDigest, signal: controller.signal })).rejects.toBe(reason);
    await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter(name => name.startsWith(".workspace-restore-"))).toEqual([]);
  });
  it("removes private staging after cancellation during read-only directory mode restoration", async () => {
    const cwd = await source(), directory = path.join(cwd, "readonly"); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "saved.txt"), "saved content"); await fs.chmod(directory, 0o555);
    const snapshot = await capture(cwd), targetDir = path.join(root, "interrupted");
    const controller = new AbortController(), reason = new Error("restore canceled while applying modes");
    let appliedReadOnlyModes = 0;
    archiveIo.afterChmod = (target, mode) => {
      if (target.includes(".workspace-restore-") && mode === 0o555) { appliedReadOnlyModes++; controller.abort(reason); }
    };
    try {
      await expect(restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir,
        expectedManifestDigest: snapshot.manifestDigest, signal: controller.signal })).rejects.toBe(reason);
      expect(appliedReadOnlyModes).toBe(1);
      await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(root)).filter(name => name.startsWith(".workspace-restore-"))).toEqual([]);
    } finally { archiveIo.afterChmod = undefined; await fs.chmod(directory, 0o700); }
  });
  it("preserves read-only directory modes without making capture scratch unremovable", async () => {
    const cwd = await source(), directory = path.join(cwd, "readonly"); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "file"), "retained\n"); await fs.chmod(directory, 0o555);
    let restored: string | undefined;
    try {
      restored = await restore(await capture(cwd));
      expect((await fs.stat(path.join(restored, "readonly"))).mode & 0o777).toBe(0o555);
      expect(await fs.readFile(path.join(restored, "readonly", "file"), "utf8")).toBe("retained\n");
    } finally { await fs.chmod(directory, 0o700); if (restored) await fs.chmod(path.join(restored, "readonly"), 0o700); }
  });
  it.each(["ordinary", "linked", "borrowed"])("restores %s Git with staged/unstaged/unpushed data after all sources disappear", async kind => {
    const base = await source(); await git(base, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(base, "work.txt"), "base\n"); await git(base, "add", "."); await git(base, "commit", "-qm", "base");
    let cwd = base;
    if (kind === "linked") { cwd = path.join(root, "linked"); await git(base, "worktree", "add", "-q", "-b", "feature", cwd); }
    if (kind === "borrowed") { cwd = path.join(root, "borrowed"); await git(root, "clone", "-q", "--shared", base, cwd); }
    await fs.writeFile(path.join(cwd, "work.txt"), "unpushed\n"); await git(cwd, "commit", "-qam", "unpushed");
    const head = await git(cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(cwd, "work.txt"), "staged\n"); await git(cwd, "add", "work.txt");
    await fs.writeFile(path.join(cwd, "work.txt"), "unstaged\n"); await fs.writeFile(path.join(cwd, "untracked"), "work\n");
    const snapshot = await capture(cwd); await fs.rm(base, { recursive: true, force: true }); if (cwd !== base) await fs.rm(cwd, { recursive: true });
    const restored = await restore(snapshot);
    expect(await git(restored, "rev-parse", "HEAD")).toBe(head);
    expect(await git(restored, "show", ":work.txt")).toBe("staged");
    expect(await fs.readFile(path.join(restored, "work.txt"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(restored, "untracked"), "utf8")).toBe("work\n");
    expect((await fs.lstat(path.join(restored, ".git"))).isDirectory()).toBe(true);
    await expect(fs.access(path.join(restored, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
    await git(restored, "fsck", "--full", "--no-dangling");
  });
  it.each(["rebase-merge", "rebase-apply", "linked-rebase", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
    "rejects a real unfinished %s operation without changing its source or publishing an archive", async operation => {
      let cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(cwd, "work.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
      await git(cwd, "checkout", "-qb", "feature");
      await fs.writeFile(path.join(cwd, "work.txt"), "feature\n"); await git(cwd, "commit", "-qam", "feature change");
      const first = await git(cwd, "rev-parse", "HEAD");
      await fs.writeFile(path.join(cwd, "later.txt"), "remaining sequence step\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "later change");
      const second = await git(cwd, "rev-parse", "HEAD");
      await git(cwd, "checkout", "-q", "main");
      await fs.writeFile(path.join(cwd, "work.txt"), "main\n"); await git(cwd, "commit", "-qam", "main change");
      let command: string[];
      if (operation === "linked-rebase") {
        const linked = path.join(root, "linked"); await git(cwd, "worktree", "add", "-q", linked, "feature"); cwd = linked;
      }
      if (operation.includes("rebase")) {
        await git(cwd, "checkout", "-q", "feature");
        command = ["rebase", operation === "rebase-apply" ? "--apply" : "--merge", "main"];
      } else if (operation === "sequencer") command = ["cherry-pick", first, second];
      else if (operation === "CHERRY_PICK_HEAD") command = ["cherry-pick", first];
      else if (operation === "REVERT_HEAD") command = ["revert", "--no-edit", first];
      else command = ["merge", "--no-edit", "feature"];
      await expect(git(cwd, ...command)).rejects.toThrow();
      const gitDir = await git(cwd, "rev-parse", "--absolute-git-dir");
      const stateName = operation === "linked-rebase" ? "rebase-merge" : operation;
      await fs.access(path.join(gitDir, stateName));
      const before = await git(cwd, "status", "--porcelain=v2");
      const index = await fs.readFile(path.join(gitDir, "index"));
      const work = await fs.readFile(path.join(cwd, "work.txt"));
      const state = (await fs.readdir(gitDir)).sort();
      const bytes = await sourceBytes(cwd), administration = await sourceBytes(gitDir);
      await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_git_operation_in_progress");
      expect(await sourceBytes(cwd)).toBe(bytes);
      expect(await sourceBytes(gitDir)).toBe(administration);
      expect(await git(cwd, "status", "--porcelain=v2")).toBe(before);
      expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(index);
      expect(await fs.readFile(path.join(cwd, "work.txt"))).toEqual(work);
      expect((await fs.readdir(gitDir)).sort()).toEqual(state);
      await fs.access(path.join(gitDir, stateName));
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
      if (operation === "sequencer") {
        const helper = path.join(root, "helper.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
        await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")], { env }))
          .rejects.toMatchObject({ stderr: expect.stringContaining("remote_workspace_archive_git_operation_in_progress") });
        await expect(fs.access(path.join(root, "remote.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await sourceBytes(cwd)).toBe(bytes);
      }
      const abort = operation.includes("rebase") ? "rebase" : operation === "MERGE_HEAD" ? "merge"
        : operation === "REVERT_HEAD" ? "revert" : "cherry-pick";
      await git(cwd, abort, "--abort");
      const head = await git(cwd, "rev-parse", "HEAD"), status = await git(cwd, "status", "--porcelain=v2");
      const restored = await restore(await capture(cwd));
      expect(await git(restored, "rev-parse", "HEAD")).toBe(head);
      expect(await git(restored, "status", "--porcelain=v2")).toBe(status);
    },
  );
  it("rejects an unfinished bisect without discarding its portable selection history", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    for (const value of ["base", "middle", "bad"]) {
      await fs.writeFile(path.join(cwd, "work.txt"), `${value}\n`); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", value);
    }
    await git(cwd, "bisect", "start", "HEAD", "HEAD~2");
    const bytes = await sourceBytes(cwd);
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_git_operation_in_progress");
    expect(await sourceBytes(cwd)).toBe(bytes);
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an external symlink before creating an archive", async () => {
    const cwd = await source(); await fs.symlink("../outside", path.join(cwd, "unsafe"));
    await expect(capture(cwd)).rejects.toThrow("unsafe_symlink");
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves shallow repository boundaries and a nested managed checkout", async () => {
    const base = await source(); await git(base, "init", "-q", "-b", "main");
    for (const value of ["one", "two"]) {
      await fs.writeFile(path.join(base, "file"), value); await git(base, "add", "."); await git(base, "commit", "-qm", value);
    }
    const cwd = path.join(root, "task"), checkouts = path.join(cwd, ".paperclip-repositories"); await fs.mkdir(checkouts, { recursive: true });
    const repository = path.join(checkouts, "repo");
    await git(root, "clone", "-q", "--depth=1", `file://${base}`, repository);
    const snapshot = await capture(cwd); await fs.rm(base, { recursive: true }); await fs.rm(cwd, { recursive: true });
    const restored = path.join(await restore(snapshot), ".paperclip-repositories", "repo");
    expect(await git(restored, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await git(restored, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await fs.readFile(path.join(restored, "file"), "utf8")).toBe("two");
  });
  it("produces the same saved contents for repeated captures of an unchanged Git clone", async () => {
    const base = await source(); await git(base, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(base, "file"), "stable\n"); await git(base, "add", "."); await git(base, "commit", "-qm", "base");
    const cwd = path.join(root, "clone"); await git(root, "clone", "-q", base, cwd);
    const first = await captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "first.pcws") });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const second = await captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "second.pcws") });
    expect(second.manifestDigest).toBe(first.manifestDigest); expect(second.sha256).toBe(first.sha256);
  });
  it("preserves portable secondary remotes and tracking settings without local paths or executable configuration", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "file"), "portable tracking\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    const head = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "remote", "add", "origin", "https://github.com/synthetic/work.git");
    await git(cwd, "remote", "add", "upstream", "ssh://git@example.invalid/team/base.git");
    await git(cwd, "config", "--add", "remote.upstream.url", "https://backup.example.invalid/team/base.git");
    await git(cwd, "config", "remote.upstream.pushurl", "git@example.invalid:team/publish.git");
    await git(cwd, "update-ref", "refs/remotes/upstream/main", head);
    await git(cwd, "config", "branch.main.remote", "upstream");
    await git(cwd, "config", "branch.main.merge", "refs/heads/main");
    await git(cwd, "config", "branch.main.rebase", "true");
    await git(cwd, "config", "user.name", "Synthetic repository author");
    await git(cwd, "config", "user.email", "repository-author@example.invalid");
    await git(cwd, "remote", "add", "local-cache", path.join(root, "old-host-cache.git"));
    await git(cwd, "config", "branch.cache.remote", "local-cache");
    await git(cwd, "config", "branch.cache.merge", "refs/heads/main");
    for (const [key, value] of [["core.hooksPath", path.join(root, "old-host-hooks")], ["core.worktree", cwd],
      ["filter.synthetic.smudge", "echo SYNTHETIC_SENSITIVE"], ["credential.helper", "echo SYNTHETIC_SENSITIVE"],
      ["include.path", path.join(root, "old-host-gitconfig")]]) await git(cwd, "config", key!, value!);
    const snapshot = await capture(cwd); await fs.rm(cwd, { recursive: true });
    const restored = await restore(snapshot);
    expect(await git(restored, "remote")).toBe("origin\nupstream");
    expect(await git(restored, "config", "--get-all", "remote.upstream.url")).toBe("ssh://git@example.invalid/team/base.git\nhttps://backup.example.invalid/team/base.git");
    expect(await git(restored, "remote", "get-url", "--push", "upstream")).toBe("git@example.invalid:team/publish.git");
    expect(await git(restored, "config", "remote.upstream.fetch")).toBe("+refs/heads/*:refs/remotes/upstream/*");
    expect(await git(restored, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).toBe("upstream/main");
    expect(await git(restored, "config", "branch.main.rebase")).toBe("true");
    const configuration = await fs.readFile(path.join(restored, ".git", "config"), "utf8");
    expect(configuration).not.toContain(root); expect(configuration).not.toContain("SYNTHETIC_SENSITIVE");
    expect(configuration).not.toContain("local-cache"); expect(configuration).not.toContain('branch "cache"');
    await fs.writeFile(path.join(restored, "next-file"), "later work\n"); await git(restored, "add", "next-file");
    await execute("git", ["-C", restored, "-c", `core.hooksPath=${os.devNull}`, "-c", "commit.gpgsign=false", "commit", "-qm", "restored workspace continues"], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_COUNT: "0" },
    });
    expect(await git(restored, "log", "-1", "--format=%an <%ae>")).toBe("Synthetic repository author <repository-author@example.invalid>");
    await git(restored, "fsck", "--full", "--no-dangling");
  });
  it.each(["https://synthetic-token@github.com/team/repo.git", "https://github.com/team/repo.git?access_token=SYNTHETIC_ONLY"])(
    "rejects credentials in any saved remote URL: %s", async remoteUrl => {
      const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(cwd, "file"), "source\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
      await git(cwd, "remote", "add", "upstream", remoteUrl);
      await expect(capture(cwd)).rejects.toThrow("credential_in_git_remote");
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("omits reinstallable dependencies while preserving deliberately tracked files", async () => {
    const cwd = await source(); await fs.writeFile(path.join(cwd, "package.json"), "{}\n");
    await fs.mkdir(path.join(cwd, "node_modules")); await fs.writeFile(path.join(cwd, "node_modules", "dependency"), "reinstall\n");
    const first = await captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "dependencies.pcws") });
    const targetDir = path.join(root, "without-dependencies");
    await restoreRemoteWorkspaceArchive({ archivePath: path.join(root, "dependencies.pcws"), targetDir, expectedManifestDigest: first.manifestDigest });
    await expect(fs.access(path.join(targetDir, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await git(cwd, "init", "-q", "-b", "main"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "deliberately tracked dependency");
    const second = await captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "tracked.pcws") });
    const trackedTarget = path.join(root, "with-tracked-dependencies");
    await restoreRemoteWorkspaceArchive({ archivePath: path.join(root, "tracked.pcws"), targetDir: trackedTarget, expectedManifestDigest: second.manifestDigest });
    expect(await fs.readFile(path.join(trackedTarget, "node_modules", "dependency"), "utf8")).toBe("reinstall\n");
  });
  it("rejects a symlink source root", async () => {
    const cwd = await source(), linked = path.join(root, "linked-source"); await fs.symlink(cwd, linked);
    await expect(capture(linked)).rejects.toThrow("source_invalid");
  });
  it("rejects path traversal before creating a restored directory", async () => {
    const manifest = { schema: "paperclip.remote-workspace-archive.v1", entries: [{ path: "../escape", type: "file", mode: 0o600,
      size: 0, sha256: createHash("sha256").digest("hex") }] };
    const bytes = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const archivePath = path.join(root, "unsafe.pcws"), targetDir = path.join(root, "target");
    await fs.writeFile(archivePath, Buffer.concat([Buffer.from("PCWS1\n"), length, bytes]));
    await expect(restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: createHash("sha256").update(bytes).digest("hex") })).rejects.toThrow("invalid_entry");
    await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a corrupt file without publishing a partial restored directory", async () => {
    const cwd = await source(); await fs.writeFile(path.join(cwd, "file"), "saved"); const snapshot = await capture(cwd);
    const file = await fs.open(snapshot.archivePath, "r+"); try { const size = (await file.stat()).size; await file.write(Buffer.from("X"), 0, 1, size - 1); } finally { await file.close(); }
    await expect(restore(snapshot)).rejects.toThrow("file_hash_mismatch");
    await expect(fs.access(path.join(root, "restored"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("executes the generated helper in a separate Node process", async () => {
    const cwd = await source(); await fs.writeFile(path.join(cwd, "file"), "remote helper\n");
    await git(cwd, "init", "-q", "-b", "main"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    await git(cwd, "remote", "add", "upstream", "https://example.invalid/team/base.git");
    await git(cwd, "config", "branch.main.remote", "upstream"); await git(cwd, "config", "branch.main.merge", "refs/heads/main");
    const script = path.join(root, "helper.cjs"), archivePath = path.join(root, "remote.pcws"), target = path.join(root, "remote-restored");
    await fs.writeFile(script, remoteWorkspaceArchiveScript());
    const receipt = JSON.parse((await execute(process.execPath, [script, "capture", cwd, archivePath])).stdout);
    await fs.rm(cwd, { recursive: true });
    await execute(process.execPath, [script, "restore", archivePath, target, receipt.manifestDigest]);
    expect(await fs.readFile(path.join(target, "file"), "utf8")).toBe("remote helper\n");
    expect(await git(target, "remote", "get-url", "upstream")).toBe("https://example.invalid/team/base.git");
    expect(await git(target, "config", "branch.main.remote")).toBe("upstream");
  });
});
