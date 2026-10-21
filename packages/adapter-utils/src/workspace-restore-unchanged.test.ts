import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureDirectorySnapshot, disposeDirectorySnapshot, mergeDirectoryWithBaseline, withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(diskBacked: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-unchanged-restore-"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  const target = path.join(root, "target"), source = path.join(root, "source");
  await fs.mkdir(target); await fs.mkdir(source);
  await fs.writeFile(path.join(target, "file"), "baseline");
  await fs.writeFile(path.join(source, "file"), "baseline");
  const baseline = await captureDirectorySnapshot(target, { diskBacked, exclude: ["cache"] });
  const incoming = await captureDirectorySnapshot(source, { diskBacked, exclude: ["cache"] });
  return { root, target, source, baseline, incoming };
}

it.each([
  { diskBacked: false, conflictPolicy: undefined }, { diskBacked: true, conflictPolicy: undefined },
  { diskBacked: false, conflictPolicy: "reject" as const }, { diskBacked: true, conflictPolicy: "reject" as const },
])("does not scan host files for an unchanged $diskBacked snapshot with $conflictPolicy and preserves both fenced hooks", async ({ diskBacked, conflictPolicy }) => {
  const f = await fixture(diskBacked);
  await fs.writeFile(path.join(f.target, "file"), "concurrent host edit");
  await fs.mkdir(path.join(f.target, "cache"));
  await fs.writeFile(path.join(f.target, "cache", "private"), "host only");
  const read = vi.spyOn(fs, "opendir");
  read.mockImplementation(async () => { throw new Error("Unexpected host scan"); });
  const callbacks: string[] = [];
  const hook = async (name: string) => {
    callbacks.push(name);
    await expect(withDirectoryMergeLock(f.target, async () => { throw new Error("Lock was released"); }, undefined, undefined, 20))
      .rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
  };
  try {
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: f.source, targetDir: f.target,
      snapshots: { source: f.incoming }, conflictPolicy, beforeApply: () => hook("before"), afterApply: () => hook("after") });
    expect(read).not.toHaveBeenCalled();
    expect(callbacks).toEqual(["before", "after"]);
    expect(await fs.readFile(path.join(f.target, "file"), "utf8")).toBe("concurrent host edit");
    expect(await fs.readFile(path.join(f.target, "cache", "private"), "utf8")).toBe("host only");
  } finally { await disposeDirectorySnapshot(f.incoming); await disposeDirectorySnapshot(f.baseline); }
});

it("skips the target scan when a captured full export is unchanged", async () => {
  const f = await fixture(false);
  const read = vi.spyOn(fs, "opendir");
  await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: f.source, targetDir: f.target, conflictPolicy: "reject" });
  expect(read.mock.calls.map(call => path.resolve(String(call[0])))).toEqual([path.resolve(f.source)]);
});

it.each(["before", "after"])("propagates %s-hook denial for an unchanged checkpoint", async denied => {
  const f = await fixture(true);
  const error = new Error("Authority revoked");
  const before = vi.fn(async () => { if (denied === "before") throw error; });
  const after = vi.fn(async () => { if (denied === "after") throw error; });
  try {
    await expect(mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: f.source, targetDir: f.target,
      snapshots: { source: f.incoming }, beforeApply: before, afterApply: after })).rejects.toBe(error);
    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledTimes(denied === "after" ? 1 : 0);
    expect(await fs.readFile(path.join(f.target, "file"), "utf8")).toBe("baseline");
    await withDirectoryMergeLock(f.target, async () => undefined);
  } finally { await disposeDirectorySnapshot(f.incoming); await disposeDirectorySnapshot(f.baseline); }
});

async function assertIncomingChange(change: string) {
  const f = await fixture(true);
  await disposeDirectorySnapshot(f.incoming);
  if (change === "hash") await fs.writeFile(path.join(f.source, "file"), "changed");
  if (change === "mode") await fs.chmod(path.join(f.source, "file"), 0o755);
  if (change === "kind") { await fs.rm(path.join(f.source, "file")); await fs.mkdir(path.join(f.source, "file")); }
  if (change === "rename") await fs.rename(path.join(f.source, "file"), path.join(f.source, "renamed"));
  if (change === "add") await fs.writeFile(path.join(f.source, "added"), "new");
  if (change === "delete") await fs.rm(path.join(f.source, "file"));
  const incoming = await captureDirectorySnapshot(f.source, { diskBacked: true, exclude: ["cache"] });
  const read = vi.spyOn(fs, "opendir");
  try {
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: f.source, targetDir: f.target,
      snapshots: { source: incoming }, conflictPolicy: "reject" });
    expect(read).toHaveBeenCalled();
    if (change === "hash") expect(await fs.readFile(path.join(f.target, "file"), "utf8")).toBe("changed");
    if (change === "mode") expect((await fs.stat(path.join(f.target, "file"))).mode & 0o777).toBe(0o755);
    if (change === "kind") expect((await fs.stat(path.join(f.target, "file"))).isDirectory()).toBe(true);
    if (change === "rename") expect(await fs.readFile(path.join(f.target, "renamed"), "utf8")).toBe("baseline");
    if (change === "add") expect(await fs.readFile(path.join(f.target, "added"), "utf8")).toBe("new");
    if (change === "delete") await expect(fs.stat(path.join(f.target, "file"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await disposeDirectorySnapshot(incoming); await disposeDirectorySnapshot(f.baseline); }
}

it.each(["hash", "kind", "rename", "add", "delete"])("does not skip an incoming %s change", assertIncomingChange);
it.skipIf(process.platform === "win32")("does not skip an incoming mode change", () => assertIncomingChange("mode"));

it.skipIf(process.platform === "win32")("does not skip a changed symlink target", async () => {
  const f = await fixture(false);
  await fs.rm(path.join(f.target, "file")); await fs.rm(path.join(f.source, "file"));
  await fs.symlink("old", path.join(f.target, "file")); await fs.symlink("new", path.join(f.source, "file"));
  const baseline = await captureDirectorySnapshot(f.target), incoming = await captureDirectorySnapshot(f.source);
  await mergeDirectoryWithBaseline({ baseline, sourceDir: f.source, targetDir: f.target, snapshots: { source: incoming }, conflictPolicy: "reject" });
  expect(await fs.readlink(path.join(f.target, "file"))).toBe("new");
});

it("still rejects concurrent edits to a changed incoming file", async () => {
  const f = await fixture(false);
  await fs.writeFile(path.join(f.source, "file"), "remote change");
  await fs.writeFile(path.join(f.target, "file"), "host change");
  const incoming = await captureDirectorySnapshot(f.source);
  await expect(mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: f.source, targetDir: f.target,
    snapshots: { source: incoming }, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["file"] });
  expect(await fs.readFile(path.join(f.target, "file"), "utf8")).toBe("host change");
});
