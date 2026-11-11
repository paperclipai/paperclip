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
