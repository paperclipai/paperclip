import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRemoteWorkspaceDirectory, readRemoteWorkspaceArchiveDirectories, remoteWorkspaceArchiveScript, remoteWorkspaceCaptureFailureMessage, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";

const archiveIo = vi.hoisted(() => ({
  afterChmod: undefined as ((target: string, mode: number) => void) | undefined,
  beforeOpen: undefined as ((target: string) => Promise<void>) | undefined,
  afterOpen: undefined as ((target: string) => Promise<void>) | undefined,
  afterClose: undefined as ((target: string) => void) | undefined,
  captures: [] as string[],
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async open(...args: Parameters<typeof actual.open>) {
    await archiveIo.beforeOpen?.(String(args[0]));
    const handle = await actual.open(...args), close = handle.close.bind(handle);
    let closed = false;
    handle.close = async () => {
      try { await close(); } finally { if (!closed) { closed = true; archiveIo.afterClose?.(String(args[0])); } }
    };
    await archiveIo.afterOpen?.(String(args[0]));
    return handle;
  }, async mkdtemp(...args: Parameters<typeof actual.mkdtemp>) {
    const directory = await actual.mkdtemp(...args);
    if (String(args[0]).includes("pc-workspace-capture-")) archiveIo.captures.push(String(directory));
    return directory;
  }, async chmod(target: string, mode: number) {
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
  afterEach(async () => {
    archiveIo.afterChmod = undefined; archiveIo.beforeOpen = undefined; archiveIo.afterOpen = undefined;
    archiveIo.afterClose = undefined; archiveIo.captures = [];
    await fs.rm(root, { recursive: true, force: true });
  });
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
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function parallelSource() {
    const cwd = await source();
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await fs.mkdir(path.join(cwd, name));
      await fs.writeFile(path.join(cwd, name, "file"), name.repeat(1024));
    }
    return fs.realpath(cwd);
  }
  it.each(["normal", "reordered"])("bounds stable reads with %s opens and preserves out-of-order bytes", async opening => {
    const cwd = await parallelSource(), blocked = new Map<string, ReturnType<typeof deferred>>();
    const admitFirst = deferred();
    archiveIo.beforeOpen = async target => {
      if (opening === "reordered" && target === path.join(cwd, "a", "file")) await admitFirst.promise;
    };
    let gating = true, active = 0, maximum = 0;
    const closed: string[] = [];
    archiveIo.afterOpen = async target => {
      if (!target.startsWith(`${cwd}${path.sep}`)) return;
      maximum = Math.max(maximum, ++active);
      if (gating) { const gate = deferred(); blocked.set(target, gate); if (blocked.size === 3) admitFirst.resolve(); await gate.promise; }
    };
    archiveIo.afterClose = target => {
      if (target.startsWith(`${cwd}${path.sep}`)) { active--; closed.push(target); }
    };
    const capturing = capture(cwd);
    try {
      await expect.poll(() => blocked.size).toBe(4);
      expect(active).toBe(4);
      blocked.get(path.join(cwd, "d", "file"))!.resolve();
      await expect.poll(() => blocked.size).toBe(5);
      expect(closed[0]).toBe(path.join(cwd, "d", "file"));
      expect(maximum).toBe(4);
    } finally {
      gating = false;
      admitFirst.resolve();
      for (const gate of blocked.values()) gate.resolve();
      await capturing;
    }
    const snapshot = await capturing;
    expect(active).toBe(0); expect(maximum).toBe(4);
    archiveIo.afterOpen = undefined; archiveIo.afterClose = undefined;
    const helper = path.join(root, "helper.cjs"), archivePath = path.join(root, "serialized.pcws");
    await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    const serialized = JSON.parse((await execute(process.execPath, [helper, "capture", cwd, archivePath])).stdout);
    expect(serialized).toMatchObject({ manifestDigest: snapshot.manifestDigest, sha256: snapshot.sha256 });
    expect(await fs.readFile(archivePath)).toEqual(await fs.readFile(snapshot.archivePath));
  });
  it.each([
    { kind: "cancel", opening: "normal" }, { kind: "replace", opening: "normal" },
    { kind: "cancel", opening: "reordered" }, { kind: "replace", opening: "reordered" },
  ])("drains every parallel stable read after $kind with $opening opens", async ({ kind, opening }) => {
    const cwd = await parallelSource(), blocked = new Map<string, ReturnType<typeof deferred>>();
    const admitFirst = deferred(), firstClosed = deferred(), first = path.join(cwd, "a", "file");
    archiveIo.beforeOpen = async target => {
      if (opening === "reordered" && target === first) await admitFirst.promise;
    };
    const controller = new AbortController(), reason = new Error("capture cancelled");
    let gating = true, active = 0, settled = false;
    archiveIo.afterOpen = async target => {
      if (!target.startsWith(`${cwd}${path.sep}`)) return;
      active++;
      if (gating) { const gate = deferred(); blocked.set(target, gate); if (blocked.size === 3) admitFirst.resolve(); await gate.promise; }
    };
    archiveIo.afterClose = target => {
      if (target.startsWith(`${cwd}${path.sep}`)) active--;
      if (target === first) firstClosed.resolve();
    };
    const capturing = captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "snapshot.pcws"), signal: controller.signal })
      .then(() => { settled = true; return null; }, error => { settled = true; return error as Error; });
    try {
      await expect.poll(() => blocked.size).toBe(4);
      if (kind === "cancel") controller.abort(reason);
      else {
        await fs.unlink(path.join(cwd, "a", "file"));
        await fs.writeFile(path.join(cwd, "a", "file"), "replacement");
      }
      blocked.get(first)!.resolve();
      await firstClosed.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const name of ["b", "c"]) blocked.get(path.join(cwd, name, "file"))!.resolve();
      await expect.poll(() => active).toBe(1);
      expect(settled).toBe(false);
    } finally {
      gating = false;
      admitFirst.resolve();
      for (const gate of blocked.values()) gate.resolve();
      await capturing;
    }
    const error = await capturing;
    if (kind === "cancel") expect(error === reason || error?.cause === reason).toBe(true);
    else expect(error?.message).toBe("remote_workspace_archive_changed");
    expect(active).toBe(0);
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of archiveIo.captures) await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reads captured directory coverage and rejects a different manifest digest", async () => {
    const cwd = await source();
    await fs.mkdir(path.join(cwd, "checkout"));
    await fs.writeFile(path.join(cwd, "checkout", "file.txt"), "saved");
    const snapshot = await capture(cwd);
    expect(await readRemoteWorkspaceArchiveDirectories(snapshot.archivePath, snapshot.manifestDigest))
      .toEqual(new Set(["checkout"]));
    await expect(readRemoteWorkspaceArchiveDirectories(snapshot.archivePath, "0".repeat(64)))
      .rejects.toThrow("manifest_mismatch");
  });

  it("rejects oversized coverage manifests before reading their body", async () => {
    const archivePath = path.join(root, "oversized.pcws"), header = Buffer.alloc(10);
    header.write("PCWS1\n"); header.writeUInt32BE(64 * 1024 * 1024 + 1, 6);
    await fs.writeFile(archivePath, header);
    await expect(readRemoteWorkspaceArchiveDirectories(archivePath, "0".repeat(64)))
      .rejects.toThrow("manifest_too_large");
  });

  it("keeps every serialized capture validation reason in the closed diagnostic contract", () => {
    const script = remoteWorkspaceArchiveScript(), start = script.indexOf("const archive = ");
    const restore = script.indexOf("if (!input.targetDir", start);
    expect(start).toBeGreaterThan(-1); expect(restore).toBeGreaterThan(start);
    const reasons = new Set([...script.slice(start, restore).matchAll(/\bfail\(([^)]*)\)/gu)]
      .map(call => JSON.parse(call[1]!) as string));
    expect(reasons.size).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(typeof reason).toBe("string");
      const message = `remote_workspace_archive_${reason}`;
      expect(remoteWorkspaceCaptureFailureMessage({ message }), reason).toBe(message);
    }
  });
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
  it.skipIf(process.platform === "win32").each(["local", "serialized"])("preserves files beside a transient socket in %s capture", async mode => {
    const cwd = await source(), socketPath = path.join(cwd, "s");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      await fs.writeFile(path.join(cwd, "saved.txt"), "uncommitted work\n");
      let snapshot: Awaited<ReturnType<typeof capture>>;
      if (mode === "serialized") {
        const helper = path.join(root, "helper.cjs"), archivePath = path.join(root, "remote.pcws");
        await fs.writeFile(helper, remoteWorkspaceArchiveScript());
        snapshot = { archivePath, ...JSON.parse((await execute(process.execPath, [helper, "capture", cwd, archivePath])).stdout) };
      } else snapshot = await capture(cwd);
      expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
      const restored = await restore(snapshot);
      expect(await fs.readFile(path.join(restored, "saved.txt"), "utf8")).toBe("uncommitted work\n");
      expect(await fs.readdir(restored)).toEqual(["saved.txt"]);
      const archive = await fs.readFile(snapshot.archivePath), start = Buffer.from("PCWS1\n").length;
      const length = archive.readUInt32BE(start);
      expect(JSON.parse(archive.subarray(start + 4, start + 4 + length).toString()).excluded).toContain("s");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it.skipIf(process.platform === "win32")("keeps named pipes outside the portable archive contract", async () => {
    const cwd = await source(), pipe = path.join(cwd, "pipe");
    await execute("mkfifo", [pipe]);
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_unsupported_entry");
    expect((await fs.lstat(pipe)).isFIFO()).toBe(true);
  });
  it.skipIf(process.platform === "win32")("retains a file that replaces a socket during capture", async () => {
    const cwd = await source(), socketPath = path.join(cwd, "s"), server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      archiveIo.beforeOpen = async target => {
        if (target !== path.join(root, "snapshot.pcws")) return;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.writeFile(socketPath, "new work\n");
      };
      await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_changed");
      expect(await fs.readFile(socketPath, "utf8")).toBe("new work\n");
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("captures with room for one archive and bounded metadata without another copy of working files", async () => {
    const cwd = await source(), payload = Buffer.alloc(4 * 1024 * 1024, 123);
    await fs.writeFile(path.join(cwd, "work.bin"), payload);
    const archivePath = path.join(root, "snapshot.pcws");
    async function bytes(directory: string): Promise<number> {
      let total = 0;
      for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name), stat = await fs.lstat(file);
        total += stat.isDirectory() ? await bytes(file) : stat.size;
      }
      return total;
    }
    archiveIo.beforeOpen = async target => {
      if (target !== archivePath) return;
      let staged = 0;
      for (const directory of archiveIo.captures) staged += await bytes(directory);
      if (staged + payload.length > payload.length + 128 * 1024) {
        throw Object.assign(new Error("No space left for the archive"), { code: "ENOSPC" });
      }
    };
    const snapshot = await capture(cwd);
    archiveIo.beforeOpen = undefined;
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(await fs.readFile(path.join(await restore(snapshot), "work.bin")))).toBe(digest(payload));
    expect(digest(await fs.readFile(path.join(cwd, "work.bin")))).toBe(digest(payload));
  });
  it.each(["content", "symlink", "added-file"])("rejects a concurrent %s change and removes its incomplete archive", async change => {
    const cwd = await source(), file = path.join(cwd, "work.txt"), archivePath = path.join(root, "snapshot.pcws");
    await fs.writeFile(file, "original\n");
    const outside = path.join(root, "outside.txt"); await fs.writeFile(outside, "must stay outside\n");
    archiveIo.beforeOpen = async target => {
      if (target !== archivePath) return;
      archiveIo.beforeOpen = undefined;
      if (change === "content") await fs.writeFile(file, "changed\n");
      if (change === "added-file") await fs.writeFile(path.join(cwd, "new.txt"), "new file\n");
      if (change === "symlink") { await fs.unlink(file); await fs.symlink(outside, file); }
    };
    await expect(capture(cwd)).rejects.toThrow();
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(outside, "utf8")).toBe("must stay outside\n");
    for (const directory of archiveIo.captures) await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans a cancelled capture without deleting a pre-existing archive", async () => {
    const cwd = await source(), archivePath = path.join(root, "snapshot.pcws");
    await fs.writeFile(path.join(cwd, "file"), "retained\n");
    const controller = new AbortController(), reason = new Error("capture cancelled");
    archiveIo.beforeOpen = async target => { if (target === archivePath) controller.abort(reason); };
    await expect(captureRemoteWorkspaceDirectory({ cwd, archivePath, signal: controller.signal })).rejects.toBe(reason);
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    archiveIo.beforeOpen = undefined;
    await fs.writeFile(archivePath, "existing archive\n");
    await expect(capture(cwd)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(archivePath, "utf8")).toBe("existing archive\n");
    expect(await fs.readFile(path.join(cwd, "file"), "utf8")).toBe("retained\n");
  });
  it("rejects Git reference changes during archive output and keeps the new reference", async () => {
    const cwd = await source(), archivePath = path.join(root, "snapshot.pcws");
    await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "file"), "retained\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    const head = await git(cwd, "rev-parse", "HEAD");
    archiveIo.beforeOpen = async target => {
      if (target !== archivePath) return;
      archiveIo.beforeOpen = undefined;
      await git(cwd, "update-ref", "refs/heads/later-work", head);
    };
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_changed");
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(cwd, "rev-parse", "refs/heads/later-work")).toBe(head);
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
  it.each(["ordinary", "linked", "borrowed", "shallow", "sha256"].flatMap(kind =>
    ["local", "serialized"].map(mode => ({ kind, mode }))))(
    "preserves an inactive rebase bookmark and its unreferenced commit in $mode $kind capture", async ({ kind, mode }) => {
      const base = await source();
      await git(base, "init", "-q", "-b", "main", ...(kind === "sha256" ? ["--object-format=sha256"] : []));
      await fs.writeFile(path.join(base, "work.txt"), "base\n"); await git(base, "add", "."); await git(base, "commit", "-qm", "base");
      const bookmark = async (repo: string) => {
        await git(repo, "checkout", "-qb", "old-rebase-tip");
        await fs.writeFile(path.join(repo, "bookmark.txt"), "preserved rebase commit\n");
        await git(repo, "add", "."); await git(repo, "commit", "-qm", "old rebase tip");
        const commit = await git(repo, "rev-parse", "HEAD");
        await git(repo, "checkout", "-q", "main"); await git(repo, "branch", "-D", "old-rebase-tip");
        return commit;
      };
      let marker = await bookmark(base), cwd = base;
      if (kind === "linked") {
        cwd = path.join(root, "linked"); await git(base, "worktree", "add", "-qb", "selected", cwd);
      } else if (kind === "borrowed" || kind === "shallow") {
        cwd = path.join(root, "selected");
        await git(root, "clone", "-q", ...(kind === "borrowed" ? ["--shared", base] : ["--depth=1", `file://${base}`]), cwd);
        if (kind === "shallow") marker = await bookmark(cwd);
      }
      await git(cwd, "update-ref", "REBASE_HEAD", marker);
      await fs.writeFile(path.join(cwd, "work.txt"), "staged\n"); await git(cwd, "add", "work.txt");
      await fs.writeFile(path.join(cwd, "work.txt"), "unstaged\n");
      const head = await git(cwd, "rev-parse", "HEAD"), status = await git(cwd, "status", "--porcelain=v2");
      const gitDir = await git(cwd, "rev-parse", "--absolute-git-dir");
      const bytes = await sourceBytes(cwd), administration = await sourceBytes(gitDir);
      let snapshot: Awaited<ReturnType<typeof capture>>;
      if (mode === "serialized") {
        const helper = path.join(root, "helper.cjs"), archivePath = path.join(root, "snapshot.pcws");
        await fs.writeFile(helper, remoteWorkspaceArchiveScript());
        const result = await execute(process.execPath, [helper, "capture", cwd, archivePath], { env });
        snapshot = { archivePath, ...JSON.parse(result.stdout) };
      } else snapshot = await capture(cwd);
      expect(await sourceBytes(cwd)).toBe(bytes); expect(await sourceBytes(gitDir)).toBe(administration);
      await fs.rm(base, { recursive: true, force: true });
      if (cwd !== base) await fs.rm(cwd, { recursive: true, force: true });
      const restored = await restore(snapshot);
      expect(await git(restored, "rev-parse", "HEAD")).toBe(head);
      expect(await git(restored, "status", "--porcelain=v2")).toBe(status);
      expect(await git(restored, "rev-parse", "REBASE_HEAD")).toBe(marker);
      expect(await git(restored, "show", "REBASE_HEAD:bookmark.txt")).toBe("preserved rebase commit");
      expect(await git(restored, "show", ":work.txt")).toBe("staged");
      expect(await fs.readFile(path.join(restored, "work.txt"), "utf8")).toBe("unstaged\n");
      await expect(fs.access(path.join(restored, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
      await git(restored, "fsck", "--full", "--no-dangling");
    },
  );
  it.each(["ordinary", "linked", "borrowed", "shallow", "partial", "sha256"].flatMap(kind => ["local", "serialized"].map(mode => ({ kind, mode }))))(
    "resumes and aborts a resolved pending merge after $mode $kind sources disappear", async ({ kind, mode }) => {
      const base = await source(); await git(base, "init", "-q", "-b", "main", ...(kind === "sha256" ? ["--object-format=sha256"] : []));
      await fs.writeFile(path.join(base, "work.txt"), "base\n"); await git(base, "add", "."); await git(base, "commit", "-qm", "base");
      await git(base, "checkout", "-qb", "feature");
      await fs.writeFile(path.join(base, "work.txt"), "feature\n"); await git(base, "commit", "-qam", "feature");
      const feature = await git(base, "rev-parse", "HEAD");
      await git(base, "checkout", "-q", "main");
      await fs.writeFile(path.join(base, "work.txt"), "main\n"); await git(base, "commit", "-qam", "main");
      const original = await git(base, "rev-parse", "HEAD");
      let cwd = base;
      if (kind === "linked") { cwd = path.join(root, "linked"); await git(base, "worktree", "add", "-qb", "selected", cwd); }
      if (kind === "borrowed") { cwd = path.join(root, "borrowed"); await git(root, "clone", "-q", "--shared", base, cwd); }
      if (kind === "shallow" || kind === "partial") {
        cwd = path.join(root, "selected");
        if (kind === "partial") await git(base, "config", "uploadpack.allowFilter", "true");
        await git(root, "clone", "-q", "--no-single-branch", ...(kind === "shallow" ? ["--depth=2"] : ["--filter=blob:none"]), `file://${base}`, cwd);
        if (kind === "shallow") expect(await git(cwd, "rev-parse", "--is-shallow-repository")).toBe("true");
        if (kind === "partial") {
          expect(await git(cwd, "config", "remote.origin.promisor")).toBe("true");
          await expect(git(cwd, "merge", "--no-ff", "--no-commit", feature)).rejects.toThrow();
          await git(cwd, "merge", "--abort");
          await git(cwd, "config", "remote.origin.url", "https://example.invalid/workspace.git");
        }
      }
      await expect(git(cwd, "merge", "--no-ff", "--no-commit", feature)).rejects.toThrow();
      await fs.writeFile(path.join(cwd, "work.txt"), "resolved\n"); await git(cwd, "add", "work.txt");
      await fs.writeFile(path.join(cwd, "work.txt"), "later unstaged work\n");
      await fs.writeFile(path.join(cwd, "untracked.txt"), "untracked work\n");
      expect(await git(cwd, "ls-files", "--unmerged")).toBe("");
      for (const row of (await git(cwd, "for-each-ref", "--format=%(objectname) %(refname)")).split("\n")) {
        const [object, ref] = row.split(" "); if (object === feature) await git(cwd, "update-ref", "-d", ref!);
      }
      const gitDir = await git(cwd, "rev-parse", "--absolute-git-dir");
      const names = ["MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "ORIG_HEAD", "AUTO_MERGE"];
      const metadata = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(gitDir, name))] as const)));
      const autoMerge = await git(cwd, "rev-parse", "AUTO_MERGE");
      const status = await git(cwd, "status", "--porcelain=v2"), bytes = await sourceBytes(cwd), administration = await sourceBytes(gitDir);
      let snapshot: Awaited<ReturnType<typeof capture>>;
      if (mode === "serialized") {
        const helper = path.join(root, "helper.cjs"), archivePath = path.join(root, "snapshot.pcws");
        await fs.writeFile(helper, remoteWorkspaceArchiveScript());
        snapshot = { archivePath, ...JSON.parse((await execute(process.execPath, [helper, "capture", cwd, archivePath], { env })).stdout) };
      } else snapshot = await capture(cwd);
      expect(await sourceBytes(cwd)).toBe(bytes); expect(await sourceBytes(gitDir)).toBe(administration);
      await fs.rm(base, { recursive: true, force: true }); if (cwd !== base) await fs.rm(cwd, { recursive: true, force: true });
      const restored = await restore(snapshot);
      expect(await git(restored, "status", "--porcelain=v2")).toBe(status);
      for (const [name, content] of metadata) expect(await fs.readFile(path.join(restored, ".git", name))).toEqual(content);
      expect(await git(restored, "cat-file", "-t", autoMerge)).toBe("tree");
      expect(await git(restored, "show", ":work.txt")).toBe("resolved");
      expect(await fs.readFile(path.join(restored, "work.txt"), "utf8")).toBe("later unstaged work\n");
      await expect(fs.access(path.join(restored, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
      await git(restored, "-c", "core.editor=true", "merge", "--continue");
      expect(await git(restored, "rev-parse", "HEAD^1")).toBe(original); expect(await git(restored, "rev-parse", "HEAD^2")).toBe(feature);
      expect(await git(restored, "show", "HEAD:work.txt")).toBe("resolved");
      expect(await fs.readFile(path.join(restored, "work.txt"), "utf8")).toBe("later unstaged work\n");
      const abortTarget = path.join(root, "abort-target");
      await restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir: abortTarget, expectedManifestDigest: snapshot.manifestDigest });
      const abortClean = abortTarget;
      await expect(git(abortClean, "merge", "--abort")).rejects.toThrow();
      await git(abortClean, "restore", "--worktree", "--", "work.txt");
      await git(abortClean, "merge", "--abort");
      expect(await git(abortClean, "rev-parse", "HEAD")).toBe(original); expect(await fs.readFile(path.join(abortClean, "work.txt"), "utf8")).toBe("main\n");
      expect(await fs.readFile(path.join(abortClean, "untracked.txt"), "utf8")).toBe("untracked work\n");
    },
  );
  async function pendingMerge() {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "base.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    await git(cwd, "checkout", "-qb", "feature");
    await fs.writeFile(path.join(cwd, "feature.txt"), "feature\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "feature");
    await git(cwd, "checkout", "-q", "main"); await git(cwd, "merge", "--no-commit", "--no-ff", "feature");
    return cwd;
  }
  it.each(["invalid_head", "missing_commit", "invalid_mode", "missing_original", "symlink_message", "rerere", "mixed_rebase", "autostash", "invalid_auto"])(
    "rejects a pending merge with %s metadata without changing its source", async kind => {
      const cwd = await pendingMerge(), gitDir = path.join(cwd, ".git");
      if (kind === "invalid_head" || kind === "missing_commit") await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), kind === "invalid_head" ? "invalid\n" : `${"a".repeat(40)}\n`);
      if (kind === "invalid_mode") await fs.writeFile(path.join(gitDir, "MERGE_MODE"), "unknown");
      if (kind === "missing_original") await fs.rm(path.join(gitDir, "ORIG_HEAD"));
      if (kind === "symlink_message") { await fs.rm(path.join(gitDir, "MERGE_MSG")); await fs.symlink("HEAD", path.join(gitDir, "MERGE_MSG")); }
      if (kind === "rerere") await fs.writeFile(path.join(gitDir, "MERGE_RR"), "");
      if (kind === "mixed_rebase") await fs.writeFile(path.join(gitDir, "REBASE_HEAD"), `${await git(cwd, "rev-parse", "HEAD")}\n`);
      if (kind === "autostash") await fs.writeFile(path.join(gitDir, "MERGE_AUTOSTASH"), `${await git(cwd, "rev-parse", "HEAD")}\n`);
      if (kind === "invalid_auto") await fs.writeFile(path.join(gitDir, "AUTO_MERGE"), `${await git(cwd, "rev-parse", "HEAD")}\n`);
      const bytes = await sourceBytes(cwd);
      await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_git_operation_in_progress");
      expect(await sourceBytes(cwd)).toBe(bytes);
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(["MERGE_MODE", "AUTO_MERGE"])("refuses a linked %s even without a pending merge", async name => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "work.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    await fs.symlink("HEAD", path.join(cwd, ".git", name));
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_unsafe_git_link");
    expect(await fs.readlink(path.join(cwd, ".git", name))).toBe("HEAD");
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["MERGE_MODE", "MERGE_MSG"])("rejects %s changed after capture", async name => {
    const cwd = await pendingMerge(), archivePath = path.join(root, "snapshot.pcws");
    archiveIo.beforeOpen = async target => { if (target === archivePath) await fs.writeFile(path.join(cwd, ".git", name), name === "MERGE_MODE" ? "" : "changed message\n"); };
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_changed");
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["invalid", "missing_commit", "symlink", "directory", "unmerged"])(
    "rejects an unsafe inactive rebase bookmark with %s state", async kind => {
      const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(cwd, "work.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
      const marker = path.join(cwd, ".git", "REBASE_HEAD"), head = await git(cwd, "rev-parse", "HEAD");
      if (kind === "symlink") await fs.symlink("HEAD", marker);
      else if (kind === "directory") await fs.mkdir(marker);
      else await fs.writeFile(marker, `${kind === "invalid" ? "not-a-commit" : kind === "missing_commit" ? "a".repeat(40) : head}\n`);
      if (kind === "unmerged") {
        const object = await git(cwd, "rev-parse", "HEAD:work.txt");
        await git(cwd, "update-index", "--force-remove", "work.txt");
        const command = execFile("git", ["-C", cwd, "update-index", "--index-info"], { env });
        command.stdin!.end(`100644 ${object} 1\twork.txt\n100644 ${object} 2\twork.txt\n`);
        await new Promise<void>((resolve, reject) => { command.once("error", reject); command.once("exit", code => code === 0 ? resolve() : reject(new Error("index fixture failed"))); });
      }
      const bytes = await sourceBytes(cwd);
      await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_git_operation_in_progress");
      expect(await sourceBytes(cwd)).toBe(bytes);
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("rejects a bookmark changed after the normalized repository was captured", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, "work.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "base");
    const first = await git(cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(cwd, "work.txt"), "next\n"); await git(cwd, "commit", "-qam", "next");
    const second = await git(cwd, "rev-parse", "HEAD"), marker = path.join(cwd, ".git", "REBASE_HEAD");
    await fs.writeFile(marker, `${first}\n`);
    const archivePath = path.join(root, "snapshot.pcws");
    archiveIo.beforeOpen = async target => { if (target === archivePath) await fs.writeFile(marker, `${second}\n`); };
    await expect(capture(cwd)).rejects.toThrow("remote_workspace_archive_changed");
    expect(await fs.readFile(marker, "utf8")).toBe(`${second}\n`);
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
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
  it("rejects a damaged Git entry with a closed reason instead of a raw command error", async () => {
    const cwd = await source(); await fs.mkdir(path.join(cwd, ".git"));
    await fs.writeFile(path.join(cwd, "work.txt"), "unsaved\n");
    const bytes = await sourceBytes(cwd);
    const failure = await capture(cwd).then(() => null, (error: Error) => error);
    expect(failure?.message).toBe("remote_workspace_archive_invalid_git_repository");
    expect(remoteWorkspaceCaptureFailureMessage(failure)).toBe("remote_workspace_archive_invalid_git_repository");
    expect(await sourceBytes(cwd)).toBe(bytes);
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")], { env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_invalid_git_repository" });
  });
  it("rejects a damaged Git entry before checking whether node_modules is tracked", async () => {
    const cwd = await source(); await fs.mkdir(path.join(cwd, ".git"));
    await fs.writeFile(path.join(cwd, "package.json"), "{}\n");
    await fs.mkdir(path.join(cwd, "node_modules", "dependency"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "dependency", "index.js"), "module.exports = 1;\n");
    await expect(capture(cwd)).rejects.toThrow(/^remote_workspace_archive_invalid_git_repository$/u);
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")], { env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_invalid_git_repository" });
  });
  it("keeps a full-disk Git failure distinct from a damaged Git entry", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    const bin = path.join(root, "full-disk-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nprintf '%s' 'No space left on device' >&2\nexit 2\n", { mode: 0o700 });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")],
      { env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace" });
  });
  it("keeps a failing Git program distinct from a damaged Git entry", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    const bin = path.join(root, "failing-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nprintf '%s' 'fatal: SYNTHETIC_PRIVATE_GIT_PATH' >&2\nexit 128\n", { mode: 0o700 });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")],
      { env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_failed: exit=128 program=git" });
  });
  it("recognizes a damaged Git entry whatever wording the installed Git uses", async () => {
    const cwd = await source(); await fs.writeFile(path.join(cwd, ".git"), "gitdir: missing\n");
    const real = path.join(await git(cwd, "--exec-path"), "git");
    const bin = path.join(root, "reworded-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --show-toplevel "*) printf '%s' 'fatal: SYNTHETIC_REWORDED_REJECTION' >&2; exit 128;; esac\nexec '${real}' "$@"\n`, { mode: 0o700 });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")],
      { env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_invalid_git_repository" });
  });
  it("keeps a refused read of a valid repository distinct from a damaged Git entry", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    const real = path.join(await git(cwd, "--exec-path"), "git");
    const bin = path.join(root, "dubious-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --show-toplevel "*) printf '%s' 'fatal: detected dubious ownership in repository' >&2; exit 128;; esac\nexec '${real}' "$@"\n`, { mode: 0o700 });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")],
      { env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_failed: exit=128 program=git" });
  });
  it("names a repository with an empty HEAD as a damaged Git entry", async () => {
    const cwd = await source(); await git(cwd, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(cwd, ".git", "HEAD"), "");
    await expect(capture(cwd)).rejects.toThrow(/^remote_workspace_archive_invalid_git_repository$/u);
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32")("does not wait on a named pipe while checking a rejected Git entry", async () => {
    const cwd = await source(), gitDir = path.join(cwd, ".git");
    await fs.mkdir(path.join(gitDir, "objects"), { recursive: true }); await fs.mkdir(path.join(gitDir, "refs"));
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await execute("mkfifo", [path.join(gitDir, "commondir")]);
    const bin = path.join(root, "rejecting-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nprintf '%s' 'fatal: SYNTHETIC_REJECTION' >&2\nexit 128\n", { mode: 0o700 });
    const helper = path.join(root, "archive.cjs"); await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, path.join(root, "remote.pcws")],
      { env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, timeout: 4000 }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_invalid_git_repository" });
  });
  it.each([["an empty directory", "directory"], ["a gitfile for a removed worktree", "gitfile"]])(
    "does not save an enclosing repository's state for %s",
    async (_name, kind) => {
      const parent = await source(); await git(parent, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(parent, "tracked.txt"), "parent\n"); await git(parent, "add", "."); await git(parent, "commit", "-qm", "parent");
      const cwd = path.join(parent, ".paperclip", "worktrees", "task"); await fs.mkdir(cwd, { recursive: true });
      if (kind === "directory") await fs.mkdir(path.join(cwd, ".git"));
      else await fs.writeFile(path.join(cwd, ".git"), `gitdir: ${path.join(parent, ".git", "worktrees", "task")}\n`);
      const status = await git(parent, "status", "--porcelain=v2", "--untracked-files=all"), head = await git(parent, "rev-parse", "HEAD");
      await expect(capture(cwd)).rejects.toThrow(/^remote_workspace_archive_invalid_git_repository$/u);
      await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(parent, "status", "--porcelain=v2", "--untracked-files=all")).toBe(status);
      expect(await git(parent, "rev-parse", "HEAD")).toBe(head);
    },
  );
  it("rejects an external symlink before creating an archive", async () => {
    const cwd = await source(); await fs.symlink("../outside", path.join(cwd, "unsafe"));
    await expect(capture(cwd)).rejects.toThrow("unsafe_symlink");
    await expect(fs.access(path.join(root, "snapshot.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("redacts a real missing-source error in the serialized capture helper", async () => {
    const helper = path.join(root, "archive.cjs"), archivePath = path.join(root, "snapshot.pcws");
    await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", path.join(root, "SYNTHETIC_PRIVATE_MISSING_SOURCE"), archivePath], { env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_fs_enoent" });
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("redacts a real exclusive-write error without replacing a preexisting archive", async () => {
    const cwd = await source(), helper = path.join(root, "archive.cjs"), archivePath = path.join(root, "SYNTHETIC_PRIVATE_ARCHIVE.pcws");
    await fs.writeFile(path.join(cwd, "saved.txt"), "retained source bytes\n");
    await fs.writeFile(archivePath, "preexisting archive bytes\n");
    await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", cwd, archivePath], { env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_fs_eexist" });
    expect(await fs.readFile(archivePath, "utf8")).toBe("preexisting archive bytes\n");
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("retained source bytes\n");
  });
  it("names only the code of an unrecognized real filesystem error in the serialized capture helper", async () => {
    const helper = path.join(root, "archive.cjs"), archivePath = path.join(root, "snapshot.pcws");
    await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    await expect(execute(process.execPath, [helper, "capture", path.join(root, "SYNTHETIC_PRIVATE_NAME".repeat(20)), archivePath], { env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "remote_workspace_archive_failed: code=ENAMETOOLONG syscall=lstat" });
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
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
