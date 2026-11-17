import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { verifyFileManifest } from "./file-manifest-cache.js";

it("verifies an executable file on the current filesystem and rejects changed content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-manifest-"));
  try {
    const file = path.join(root, "run.sh");
    const content = "echo ok\n";
    await fs.writeFile(file, content, { mode: 0o555 });
    const manifest = [{ path: "run.sh", size: Buffer.byteLength(content), executable: true,
      sha256: createHash("sha256").update(content).digest("hex") }];
    expect(await verifyFileManifest(root, manifest)).toBe(true);
    await fs.chmod(file, 0o666);
    await fs.writeFile(file, "echo no\n");
    expect(await verifyFileManifest(root, manifest)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("verifies a freshly materialized package with many files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-many-files-"));
  try {
    const content = "skill content\n";
    const manifest = Array.from({ length: 240 }, (_, i) => ({ path: `file-${i}.md`, size: Buffer.byteLength(content),
      executable: false, sha256: createHash("sha256").update(content).digest("hex") }));
    for (const file of manifest) await fs.writeFile(path.join(root, file.path), content, { mode: 0o444 });
    expect(await verifyFileManifest(root, manifest)).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects a same-length edit with its original mtime restored, even after a warm verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-manifest-edit-"));
  try {
    const target = path.join(root, "SKILL.md");
    await fs.writeFile(target, "original");
    const original = await fs.stat(target);
    const manifest = [{ path: "SKILL.md", size: 8, executable: false,
      sha256: createHash("sha256").update("original").digest("hex") }];
    expect(await verifyFileManifest(root, manifest)).toBe(true);
    expect(await verifyFileManifest(root, manifest)).toBe(true);
    await fs.writeFile(target, "modified");
    await fs.utimes(target, original.atime, original.mtime);
    expect(await verifyFileManifest(root, manifest)).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("rejects missing and extra files after successful verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-manifest-tree-"));
  try {
    const target = path.join(root, "SKILL.md");
    await fs.writeFile(target, "skill");
    const manifest = [{ path: "SKILL.md", size: 5, executable: false,
      sha256: createHash("sha256").update("skill").digest("hex") }];
    expect(await verifyFileManifest(root, manifest)).toBe(true);
    await fs.writeFile(path.join(root, "extra.md"), "extra");
    expect(await verifyFileManifest(root, manifest)).toBe(false);
    await fs.rm(path.join(root, "extra.md"));
    await fs.rm(target);
    expect(await verifyFileManifest(root, manifest)).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
