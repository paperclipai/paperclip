import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderPackLayers } from "../create-provider-pack-archive.mjs";

const DIGEST = `sha256:${"b".repeat(64)}`;

async function makePack(rootDir) {
  const pack = path.join(rootDir, "provider-pack");
  await mkdir(path.join(pack, "dist"), { recursive: true });
  await mkdir(path.join(pack, "node_modules", "pkg"), { recursive: true });
  await writeFile(
    path.join(pack, "provider-pack.json"),
    JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest: DIGEST }),
  );
  await writeFile(path.join(pack, "node_modules", "pkg", "dep-a.bin"), Buffer.alloc(1024 * 1024 + 17, 11));
  await writeFile(path.join(pack, "node_modules", "pkg", "dep-b.bin"), Buffer.alloc(1024 * 1024 + 29, 22));
  await writeFile(path.join(pack, "node_modules", "pkg", "dep-c.bin"), Buffer.alloc(1024 * 1024 + 41, 33));
  await writeFile(path.join(pack, "dist", "runner.bin"), Buffer.alloc(1024 * 1024 + 53, 44));
  await writeFile(path.join(pack, "dist", "small.js"), "export const ok = true;\n");
  await symlink("small.js", path.join(pack, "dist", "link.js"));
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
