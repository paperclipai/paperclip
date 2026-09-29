import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, lstat, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { digestNativeHarnessBackupDirectory } from "./native-harness-tree.js";

// Independent retained-format oracle, deliberately only used on small files.
async function retainedDigest(root: string) {
  const hash = createHash("sha256"); let bytes = 0;
  async function visit(directory: string, relative: string) {
    const entries = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
    if (!entries.length) hash.update(`directory:${relative}\0`);
    for (const name of entries) {
      const path = join(directory, name), entry = relative ? `${relative}/${name}` : name, metadata = await lstat(path);
      if (metadata.isDirectory()) { hash.update(`directory:${entry}:${metadata.mode & 0o777}\0`); await visit(path, entry); }
      else if (metadata.isSymbolicLink()) hash.update(`symlink:${entry}:${await readlink(path)}\0`);
      else { const body = await readFile(path); bytes += body.length; hash.update(`file:${entry}:${metadata.mode & 0o777}:${body.length}\0`).update(body); }
    }
  }
  await visit(root, ""); return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

it("preserves retained backup digests across multiple external-sort merge levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-tree-test-"));
  try {
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "line\nquote\".json"), "content");
    await symlink("absent-target", join(root, "link"));
    // More than 32 full 128-name pages. No in-memory array may contain the
    // whole directory while computing the production digest.
    for (let batch = 0; batch < 33; batch++) await Promise.all(Array.from({ length: 128 }, (_, index) =>
      writeFile(join(root, `receipt-${(batch * 128 + index).toString().padStart(6, "0")}`), "x")));
    const expected = await retainedDigest(root);
    expect(await digestNativeHarnessBackupDirectory(root)).toEqual(expected);
    await writeFile(join(root, "receipt-000000"), "y");
    expect((await digestNativeHarnessBackupDirectory(root)).sha256).not.toBe(expected.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it("streams a large file while the event loop remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-tree-large-"));
  const path = join(root, "history"), file = await open(path, "wx", 0o600);
  const chunk = Buffer.alloc(64 * 1024, "a"), repeats = 2048;
  try {
    for (let index = 0; index < repeats; index++) await file.writeFile(chunk);
    await file.close();
    const hash = createHash("sha256").update(`file:history:384:${chunk.length * repeats}\0`);
    for (let index = 0; index < repeats; index++) hash.update(chunk);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      expect(await digestNativeHarnessBackupDirectory(root)).toEqual({ sha256: `sha256:${hash.digest("hex")}`, bytes: chunk.length * repeats });
      expect(ticks).toBeGreaterThan(1);
    } finally { clearInterval(timer); }
  } finally { await file.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("refuses a root symlink instead of following it into unrelated history", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-tree-link-"));
  try {
    await mkdir(join(root, "real")); await symlink(join(root, "real"), join(root, "link"));
    await expect(digestNativeHarnessBackupDirectory(join(root, "link"))).rejects.toThrow("unsafe_directory");
  } finally { await rm(root, { recursive: true, force: true }); }
});
