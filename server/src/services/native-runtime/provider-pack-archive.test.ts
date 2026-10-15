import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readProviderPackArchive, stageProviderPackArchive } from "./provider-pack-archive.js";
// @ts-expect-error Build-time script has no TypeScript declaration.
import { createProviderPackArchive, createProviderPackLayers } from "../../../../scripts/create-provider-pack-archive.mjs";

const exec = promisify(execFile);
const hasZstd = spawnSync("zstd", ["--version"]).status === 0;
const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-archive-"));
  roots.push(root);
  const pack = path.join(root, "pack");
  await fs.mkdir(path.join(pack, "bin"), { recursive: true });
  await fs.writeFile(path.join(pack, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest }));
  await fs.writeFile(path.join(pack, "bin", "tool"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
  await fs.symlink("bin/tool", path.join(pack, "tool"));
  await createProviderPackArchive(pack);
  const archive = (await readProviderPackArchive(pack, digest))!;
  if ("kind" in archive) throw Error("Expected historical single archive");
  return { root, pack, archive };
}

const tar = await Promise.all(["gtar", "tar"].map(async name => {
  try { const { stdout } = await exec(name, ["--version"]); return stdout.includes("GNU tar") ? name : null; }
  catch { return null; }
})).then(names => names.find(Boolean));

async function runner(root: string, corrupt = false) {
  const bin = path.join(root, "commands");
  await fs.mkdir(bin);
  const resolved = (await exec("sh", ["-c", 'command -v "$1"', "sh", tar!])).stdout.trim();
  await fs.symlink(resolved, path.join(bin, "tar"));
  const syncIn = vi.fn<NonNullable<CommandManagedRuntimeRunner["syncIn"]>>(async operations => {
    for (const operation of operations) for (const file of operation.files) {
      expect(file.kind).toBe("file");
      await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
      await fs.copyFile(file.sourcePath, file.targetPath);
      if (corrupt) await fs.appendFile(file.targetPath, "corrupted in transit");
    }
    return { operations: await Promise.all(operations.map(async operation => ({ operationId: operation.operationId, filesTransferred: operation.files.length,
      bytesTransferred: (await Promise.all(operation.files.map(async file => (await fs.stat(file.sourcePath)).size))).reduce((sum, size) => sum + size, 0) }))) };
  });
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
    try {
      const result = await exec(input.command, input.args ?? [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: 1, signal: null, pid: null, startedAt: null, timedOut: false, stdout: "", stderr: String(error) };
    }
  });
  return { syncIn, execute };
}

it("keeps historical/source packs without an archive on the existing path", async () => {
  expect(await readProviderPackArchive("/does-not-exist/provider-pack", digest)).toBeNull();
});

async function layeredFixture() {
  const { root, pack } = await fixture();
  await fs.writeFile(path.join(pack, "bin", "large"), Buffer.alloc(1024 * 1024, 42), { mode: 0o755 });
  const receipt = await createProviderPackLayers(pack);
  const archive = (await readProviderPackArchive(pack, digest))!;
  if (!("kind" in archive)) throw Error("Expected layered archive");
  return { root, pack, receipt, archive };
}

it.skipIf(!tar || !hasZstd)("reuses only byte-matched image files, keeps modes, and never shares writable hardlinks", async () => {
  const { root, pack, archive } = await layeredFixture();
  const remote = await runner(root);
  const targetPath = path.join(root, "fresh");
  expect(await stageProviderPackArchive({ archive, runner: remote, targetPath, reuseRoots: [pack] })).toBe(true);
  expect(remote.syncIn.mock.calls[0]![0][0]!.files).toHaveLength(1);
  expect((await remote.syncIn.mock.results[0]!.value).operations[0]!.bytesTransferred).toBe(archive.overlay.bytes);
  const original = path.join(pack, "bin/large"), copied = path.join(targetPath, "bin/large");
  expect(await fs.readFile(copied)).toEqual(await fs.readFile(original));
  expect((await fs.stat(copied)).mode & 0o777).toBe(0o755);
  expect((await fs.stat(copied)).ino).not.toBe((await fs.stat(original)).ino);
  await fs.writeFile(copied, "changed");
  expect((await fs.stat(original)).size).toBe(1024 * 1024);
  expect(await fs.readlink(path.join(targetPath, "tool"))).toBe("bin/tool");
});

it.skipIf(!tar || !hasZstd).each(["missing", "wrong-digest", "symlink", "ancestor-symlink"])("transfers a large layer when the image file is %s", async reason => {
  const { root, pack, archive } = await layeredFixture();
  const remote = await runner(root);
  const old = path.join(root, "old");
  await fs.cp(pack, old, { recursive: true });
  const large = path.join(old, "bin/large");
  if (reason === "missing") await fs.unlink(large);
  if (reason === "wrong-digest") await fs.writeFile(large, Buffer.alloc(1024 * 1024, 43));
  if (reason === "symlink") { await fs.unlink(large); await fs.symlink(path.join(pack, "bin/large"), large); }
  if (reason === "ancestor-symlink") { await fs.rm(path.join(old, "bin"), { recursive: true }); await fs.symlink(path.join(pack, "bin"), path.join(old, "bin")); }
  const targetPath = path.join(root, "fresh");
  expect(await stageProviderPackArchive({ archive, runner: remote, targetPath, reuseRoots: [old] })).toBe(true);
  expect((await remote.syncIn.mock.results[0]!.value).operations[0]!.bytesTransferred).toBe(archive.overlay.bytes + archive.files[0]!.archive.bytes);
  expect(await fs.readFile(path.join(targetPath, "bin/large"))).toEqual(await fs.readFile(path.join(pack, "bin/large")));
});

it.each(["traversal", "duplicate", "ancestor", "mode", "digest", "layer-symlink"])("rejects invalid layer metadata or bytes: %s", async reason => {
  const { pack, receipt } = await layeredFixture();
  if (reason === "traversal") receipt.files[0].path = "../outside";
  if (reason === "duplicate") receipt.files.push(receipt.files[0]);
  if (reason === "ancestor") receipt.files.push({ ...receipt.files[0], path: "bin" });
  if (reason === "mode") receipt.files[0].mode = 0o4755;
  if (reason === "digest") receipt.overlay.sha256 = "0".repeat(64);
  if (reason === "layer-symlink") {
    const overlay = `${pack}.archives/overlay.tar.zst`;
    await fs.rename(overlay, `${overlay}.original`); await fs.symlink(`${overlay}.original`, overlay);
  }
  await fs.writeFile(`${pack}.archive.json`, JSON.stringify(receipt));
  await expect(readProviderPackArchive(pack, digest)).rejects.toThrow();
});

it.skipIf(!tar || !hasZstd)("rejects a corrupt missing layer before transfer and a corrupt upload before extraction", async () => {
  const { root, pack, archive } = await layeredFixture();
  const remote = await runner(root, true);
  const targetPath = path.join(root, "fresh");
  await expect(stageProviderPackArchive({ archive, runner: remote, targetPath })).rejects.toThrow("runner_remote_provider_archive_extract_failed");
  expect(await fs.readdir(targetPath)).toEqual([]);
  expect((await fs.readdir(root)).some(name => name.includes(".upload-"))).toBe(false);
  await fs.appendFile(`${pack}.archives/0.tar.zst`, "corrupt");
  remote.syncIn.mockClear();
  await expect(stageProviderPackArchive({ archive, runner: remote, targetPath: `${targetPath}-2` })).rejects.toThrow("runner_remote_provider_archive_invalid");
  expect(remote.syncIn).not.toHaveBeenCalled();
});

it.skipIf(!tar || !hasZstd)("does not follow a layered target symlink or accept invalid reuse receipts", async () => {
  const { root, archive } = await layeredFixture();
  const remote = await runner(root);
  const targetPath = path.join(root, "target"), other = path.join(root, "other");
  await fs.mkdir(other); await fs.symlink(other, targetPath);
  await expect(stageProviderPackArchive({ archive, runner: remote, targetPath })).rejects.toThrow("runner_remote_provider_archive_reuse_failed");
  expect(await fs.readdir(other)).toEqual([]);
  remote.execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "[999999]", stderr: "", signal: null, pid: null, startedAt: null });
  await expect(stageProviderPackArchive({ archive, runner: remote, targetPath: `${targetPath}-2` })).rejects.toThrow("runner_remote_provider_archive_reuse_failed");
  expect(remote.syncIn).not.toHaveBeenCalled();
});

it.each(["identity", "bytes", "sha256", "json", "symlink"])("rejects invalid archive %s", async failure => {
  const { pack } = await fixture();
  const receiptPath = `${pack}.archive.json`;
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (failure === "identity") receipt.providerPackDigest = `sha256:${"b".repeat(64)}`;
  if (failure === "bytes") receipt.bytes++;
  if (failure === "sha256") receipt.sha256 = "c".repeat(64);
  await fs.writeFile(receiptPath, failure === "json" ? "{" : JSON.stringify(receipt));
  if (failure === "symlink") {
    await fs.rename(`${pack}.tar.zst`, `${pack}.original`);
    await fs.symlink(`${pack}.original`, `${pack}.tar.zst`);
  }
  await expect(readProviderPackArchive(pack, digest)).rejects.toThrow();
});

it.skipIf(!tar || !hasZstd)("uploads build-time bytes to fresh targets, preserving files, modes and symlinks", async () => {
  const { root, archive } = await fixture();
  const remote = await runner(root);
  for (const name of ["first ' ; #", "follow-up"]) {
    const targetPath = path.join(root, name);
    await stageProviderPackArchive({ archive, runner: remote, targetPath });
    expect(await fs.readFile(path.join(targetPath, "bin/tool"), "utf8")).toBe("#!/bin/sh\necho fixture\n");
    expect((await fs.stat(path.join(targetPath, "bin/tool"))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o700);
    expect(await fs.readlink(path.join(targetPath, "tool"))).toBe("bin/tool");
  }
  expect((await fs.readdir(root)).some(name => name.includes(".upload-"))).toBe(false);
  expect(remote.syncIn).toHaveBeenCalledTimes(2);
});

it.skipIf(!tar || !hasZstd)("rejects corrupt transferred bytes before extracting and cleans scratch", async () => {
  const { root, archive } = await fixture();
  const targetPath = path.join(root, "target");
  await expect(stageProviderPackArchive({ archive, runner: await runner(root, true), targetPath }))
    .rejects.toThrow("runner_remote_provider_archive_extract_failed");
  expect(await fs.readdir(root)).not.toContain("target");
  expect((await fs.readdir(root)).some(name => name.includes(".upload-"))).toBe(false);
});

it.skipIf(!tar || !hasZstd)("does not follow a remote target symlink", async () => {
  const { root, archive } = await fixture();
  const targetPath = path.join(root, "target");
  const other = path.join(root, "other");
  await fs.mkdir(other); await fs.symlink(other, targetPath);
  await expect(stageProviderPackArchive({ archive, runner: await runner(root), targetPath }))
    .rejects.toThrow("runner_remote_provider_archive_extract_failed");
  expect(await fs.readdir(other)).toEqual([]);
});

it.skipIf(!tar || !hasZstd)("rejects malformed tar even with a matching transport digest", async () => {
  const { root, archive } = await fixture();
  await fs.writeFile(archive.sourcePath, "invalid tar");
  archive.sha256 = createHash("sha256").update("invalid tar").digest("hex");
  await expect(stageProviderPackArchive({ archive, runner: await runner(root), targetPath: path.join(root, "target") }))
    .rejects.toThrow("runner_remote_provider_archive_extract_failed");
  expect((await fs.readdir(root)).some(name => name.includes(".upload-"))).toBe(false);
});

it("keeps the directory fallback when the remote has no zstd", async () => {
  const { archive } = await fixture();
  const remote = { syncIn: vi.fn(), execute: vi.fn().mockResolvedValue({ exitCode: 127, timedOut: false }) };
  expect(await stageProviderPackArchive({ archive, runner: remote, targetPath: "/unused" })).toBe(false);
  expect(remote.syncIn).not.toHaveBeenCalled();
});
