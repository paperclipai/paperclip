import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeControllerSourceDigest } from "./native-controller-source-digest.js";

it("hashes a maximum-size source repeatedly with an original copy retained on a 512 MiB heap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-controller-digest-"));
  try {
    const file = join(root, "controller.json"), chunk = Buffer.alloc(1024 * 1024, "x");
    const expected = createHash("sha256"), handle = await open(file, "wx", 0o600);
    try { for (let index = 0; index < 256; index++) { await handle.write(chunk); expected.update(chunk); } }
    finally { await handle.close(); }
    const source = new URL("./native-controller-source-digest.ts", import.meta.url).href;
    const code = `import { readFile } from "node:fs/promises";
      import { nativeControllerSourceDigest } from ${JSON.stringify(source)};
      globalThis.retainedController = await readFile(${JSON.stringify(file)}, "utf8");
      const hashes = [];
      for (let index = 0; index < 3; index++) hashes.push(await nativeControllerSourceDigest(${JSON.stringify(file)}, 256 * 1024 * 1024));
      console.log(JSON.stringify({ hashes, retainedBytes: globalThis.retainedController.length }));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--max-old-space-size=512", "--import", import.meta.resolve("tsx/esm"),
      "--input-type=module", "--eval", code], { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 }));
    expect(result).toEqual({ hashes: Array(3).fill(expected.digest("hex")), retainedBytes: 256 * 1024 * 1024 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it("keeps private-file and size guards while hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-controller-digest-guards-"));
  try {
    const file = join(root, "controller"); await writeFile(file, "source", { mode: 0o600 });
    expect(await nativeControllerSourceDigest(join(root, "missing"), 10)).toBeUndefined();
    expect(await nativeControllerSourceDigest(file, 10)).toBe(createHash("sha256").update("source").digest("hex"));
    await expect(nativeControllerSourceDigest(file, 5)).rejects.toThrow("native_controller_migration_unsafe_source");
    await expect(nativeControllerSourceDigest(root, 10)).rejects.toThrow("native_controller_migration_unsafe_source");
    const alias = join(root, "alias"); await symlink(file, alias);
    await expect(nativeControllerSourceDigest(alias, 10)).rejects.toMatchObject({ code: "ELOOP" });
    await link(file, join(root, "hardlink"));
    await expect(nativeControllerSourceDigest(file, 10)).rejects.toThrow("native_controller_migration_unsafe_source");
  } finally { await rm(root, { recursive: true, force: true }); }
});
