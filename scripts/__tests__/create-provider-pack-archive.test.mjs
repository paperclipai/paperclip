import assert from "node:assert/strict";
import { lutimes, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderPackLayers } from "../create-provider-pack-archive.mjs";

const DIGEST = `sha256:${"b".repeat(64)}`;
const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

async function makePack(rootDir) {
  const pack = path.join(rootDir, "provider-pack");
  const distDir = path.join(pack, "dist");
  const nodeModulesDir = path.join(pack, "node_modules");
  const pkgDir = path.join(nodeModulesDir, "pkg");
  await mkdir(distDir, { recursive: true });
  await mkdir(pkgDir, { recursive: true });

  const files = [
    [path.join(pack, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest: DIGEST })],
    [path.join(pkgDir, "dep-a.bin"), Buffer.alloc(1024 * 1024 + 17, 11)],
    [path.join(pkgDir, "dep-b.bin"), Buffer.alloc(1024 * 1024 + 29, 22)],
    [path.join(pkgDir, "dep-c.bin"), Buffer.alloc(1024 * 1024 + 41, 33)],
    [path.join(distDir, "runner.bin"), Buffer.alloc(1024 * 1024 + 53, 44)],
    [path.join(distDir, "small.js"), "export const ok = true;\n"],
  ];
  for (const [filePath, content] of files) {
    await writeFile(filePath, content);
    await utimes(filePath, FIXED_TIME, FIXED_TIME);
  }
  const linkPath = path.join(distDir, "link.js");
  await symlink("small.js", linkPath);
  await lutimes(linkPath, FIXED_TIME, FIXED_TIME);

  // Pin directory timestamps bottom-up after all children are written so tar
  // headers cannot differ across wall-clock second boundaries.
  for (const dirPath of [pkgDir, nodeModulesDir, distDir, pack]) {
    await utimes(dirPath, FIXED_TIME, FIXED_TIME);
  }
  return pack;
}

test("createProviderPackLayers produces identical receipts and archives across serial and parallel execution", async () => {
  const dirA = await mkdtemp(path.join(os.tmpdir(), "pack-archive-serial-"));
  const dirB = await mkdtemp(path.join(os.tmpdir(), "pack-archive-parallel-"));
  try {
    const packA = await makePack(dirA);
    const packB = await makePack(dirB);
    const serial = await createProviderPackLayers(packA, { concurrency: 1 });
    const parallel = await createProviderPackLayers(packB, { concurrency: 4 });

    assert.deepEqual(parallel, serial);
    // Dependencies stay ordered before dist/* so archive numbers remain stable.
    assert.deepEqual(
      parallel.files.map((file) => file.path),
      [
        "node_modules/pkg/dep-a.bin",
        "node_modules/pkg/dep-b.bin",
        "node_modules/pkg/dep-c.bin",
        "dist/runner.bin",
      ],
    );
    assert.equal(
      await readFile(`${packA}.archive.json`, "utf8"),
      await readFile(`${packB}.archive.json`, "utf8"),
    );
    for (const name of ["overlay.tar.zst", "0.tar.zst", "1.tar.zst", "2.tar.zst", "3.tar.zst"]) {
      const bytesA = await readFile(path.join(`${packA}.archives`, name));
      const bytesB = await readFile(path.join(`${packB}.archives`, name));
      assert.equal(bytesA.equals(bytesB), true, `${name} bytes must be identical`);
    }
  } finally {
    await Promise.all([
      rm(dirA, { recursive: true, force: true }),
      rm(dirB, { recursive: true, force: true }),
    ]);
  }
});
