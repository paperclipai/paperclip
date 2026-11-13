import { mkdtemp, mkdir, open, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { afterEach, expect, it } from "vitest";
import { captureNativeHarnessArchive, restoreNativeHarnessArchive, MAX_NATIVE_HARNESS_BYTES,
  MAX_NATIVE_HARNESS_ENTRIES, MAX_NATIVE_HARNESS_OBJECT_BYTES, MAX_NATIVE_HARNESS_PATH_BYTES,
  nativeHarnessArchiveSizeLimit } from "./native-harness-backup-archive.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "native-backup-archive-test-")); roots.push(root); return root; }
async function maliciousArchive(root: string, headers: Array<tar.Headers>) {
  const archive = tar.pack(), file = join(root, "malicious.tar");
  const written = pipeline(archive, createWriteStream(file));
  for (const header of headers) archive.entry(header, Buffer.alloc(0));
  archive.finalize(); await written; return file;
}
it("reserves the full entry budget using real maximum-path PAX encoding", async () => {
  const root = await fixture(), name = "a/".repeat(MAX_NATIVE_HARNESS_PATH_BYTES / 2 - 1) + "aa";
  const file = await maliciousArchive(root, [{ name, type: "symlink", linkname: "b".repeat(MAX_NATIVE_HARNESS_PATH_BYTES) }]);
  // One real encoded record gives the repeated-entry size without creating a
  // gigabyte fixture. Each hypothetical entry includes its own PAX records.
  const entryBytes = (await stat(file)).size - 1024;
  const denseArchiveBytes = entryBytes * MAX_NATIVE_HARNESS_ENTRIES + 1024;
  const bound = nativeHarnessArchiveSizeLimit(0);
  expect(denseArchiveBytes).toBeGreaterThan(MAX_NATIVE_HARNESS_OBJECT_BYTES - MAX_NATIVE_HARNESS_BYTES);
  expect(denseArchiveBytes).toBeLessThanOrEqual(bound);
  expect(denseArchiveBytes).toBeGreaterThan(bound * 0.9);
  expect(nativeHarnessArchiveSizeLimit(MAX_NATIVE_HARNESS_BYTES)).toBe(MAX_NATIVE_HARNESS_OBJECT_BYTES);
});
it("captures at the exact archive byte limit and refuses one byte beyond it", async () => {
  const root = await fixture(), source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "manifest.json"), "{}"); await writeFile(join(source, "state"), "retained provider bytes");
  const original = join(root, "original"); await captureNativeHarnessArchive(source, original);
  const bytes = (await stat(original)).size, exact = join(root, "exact");
  await captureNativeHarnessArchive(source, exact, undefined, bytes);
  expect((await stat(exact)).size).toBe(bytes);
  await restoreNativeHarnessArchive(exact, join(root, "restored-exact"));
  expect(await readFile(join(root, "restored-exact", "state"), "utf8")).toBe("retained provider bytes");
  const exceeded = join(root, "exceeded");
  await expect(captureNativeHarnessArchive(source, exceeded, undefined, bytes - 1)).rejects.toThrow("native_harness_archive_invalid");
  expect((await stat(exceeded)).size).toBeLessThan(bytes);
});
it.each([
  { name: "../escaped", type: "file" as const },
  { name: "/absolute", type: "file" as const },
  { name: "link", type: "symlink" as const, linkname: "../outside" },
  { name: "device", type: "character-device" as const },
  { name: "parent/child", type: "file" as const },
])("rejects unsafe archive entry $name", async header => {
  const root = await fixture(), file = await maliciousArchive(root, [header]);
  await expect(restoreNativeHarnessArchive(file, join(root, "destination"))).rejects.toThrow("native_harness_archive_invalid");
  await expect(stat(join(root, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects duplicate paths instead of overwriting a restored file", async () => {
  const root = await fixture(), file = await maliciousArchive(root, [{ name: "manifest.json", type: "file" }, { name: "manifest.json", type: "file" }]);
  await expect(restoreNativeHarnessArchive(file, join(root, "destination"))).rejects.toThrow("native_harness_archive_invalid");
});
it("refuses a source symlink without reading its target", async () => {
  const root = await fixture(), outside = join(root, "outside");
  await writeFile(outside, "private external file");
  const { mkdir } = await import("node:fs/promises"); const source = join(root, "source"); await mkdir(source);
  await symlink(outside, join(source, "linked"));
  await expect(captureNativeHarnessArchive(source, join(root, "archive"))).rejects.toThrow("native_harness_archive_invalid");
  expect(await readFile(outside, "utf8")).toBe("private external file");
});
it("honors cancellation before walking the checkpoint tree", async () => {
  const root = await fixture();
  await expect(captureNativeHarnessArchive(root, join(root, "archive"), AbortSignal.abort(new Error("test cancelled"))))
    .rejects.toThrow();
});

it("preserves contained provider links", async () => {
  const root = await fixture(), source = join(root, "source"), target = join(root, "restored");
  await mkdir(join(source, "provider", ".bin"), { recursive: true });
  await writeFile(join(source, "manifest.json"), "{}");
  await writeFile(join(source, "provider", "tool.js"), "provider state");
  await symlink("../tool.js", join(source, "provider", ".bin", "tool"));
  const archive = join(root, "archive");
  await captureNativeHarnessArchive(source, archive);
  await restoreNativeHarnessArchive(archive, target);
  expect(await readlink(join(target, "provider", ".bin", "tool"))).toBe("../tool.js");
  expect(await readFile(join(target, "provider", ".bin", "tool"), "utf8")).toBe("provider state");
});
it("rejects writes beneath a symlink even when its target is contained", async () => {
  const root = await fixture(), file = await maliciousArchive(root, [
    { name: "manifest.json", type: "file" }, { name: "directory", type: "directory" },
    { name: "link", type: "symlink", linkname: "directory" }, { name: "link/child", type: "file" },
  ]);
  await expect(restoreNativeHarnessArchive(file, join(root, "destination"))).rejects.toThrow("native_harness_archive_invalid");
});
it("rejects indirect symlink targets instead of allowing chained traversal", async () => {
  const root = await fixture(), file = await maliciousArchive(root, [
    { name: "manifest.json", type: "file" }, { name: "first", type: "symlink", linkname: "second/child" },
    { name: "second", type: "symlink", linkname: "elsewhere" },
  ]);
  await expect(restoreNativeHarnessArchive(file, join(root, "destination"))).rejects.toThrow("native_harness_archive_invalid");
});
it("rejects oversized source files before streaming their payload", async () => {
  const root = await fixture(), source = join(root, "source"); await mkdir(source);
  const handle = await open(join(source, "oversized"), "wx");
  await handle.truncate(MAX_NATIVE_HARNESS_BYTES + 1); await handle.close();
  await expect(captureNativeHarnessArchive(source, join(root, "archive"))).rejects.toThrow("native_harness_archive_invalid");
  expect((await stat(join(root, "archive"))).size).toBeLessThan(1024);
});
