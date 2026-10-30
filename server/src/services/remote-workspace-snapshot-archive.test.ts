import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRemoteWorkspaceDirectory, remoteWorkspaceArchiveScript, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot", GIT_COMMITTER_NAME: "Snapshot", GIT_AUTHOR_EMAIL: "snapshot@example.test", GIT_COMMITTER_EMAIL: "snapshot@example.test" };
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env })).stdout.trim();
describe("portable remote workspace archives", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-archive-test-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function source() { const cwd = path.join(root, "source"); await fs.mkdir(cwd); return cwd; }
  async function capture(cwd: string) { const archivePath = path.join(root, "snapshot.pcws"); return { archivePath, ...await captureRemoteWorkspaceDirectory({ cwd, archivePath }) }; }
  async function restore(snapshot: Awaited<ReturnType<typeof capture>>) {
    const targetDir = path.join(root, "restored");
    await restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir, expectedManifestDigest: snapshot.manifestDigest });
    return targetDir;
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
    const script = path.join(root, "helper.cjs"), archivePath = path.join(root, "remote.pcws"), target = path.join(root, "remote-restored");
    await fs.writeFile(script, remoteWorkspaceArchiveScript());
    const receipt = JSON.parse((await execute(process.execPath, [script, "capture", cwd, archivePath])).stdout);
    await fs.rm(cwd, { recursive: true });
    await execute(process.execPath, [script, "restore", archivePath, target, receipt.manifestDigest]);
    expect(await fs.readFile(path.join(target, "file"), "utf8")).toBe("remote helper\n");
  });
});
