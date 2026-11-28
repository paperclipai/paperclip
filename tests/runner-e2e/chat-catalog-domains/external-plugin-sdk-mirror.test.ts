import { mkdtemp, mkdir, readFile, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { mirrorPreviewSdk } from "./external-plugin-sdk-mirror.js";

it("retains exact public SDK bytes in a separately owned scaffold workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sdk-custody-control-"));
  try {
    const source = path.join(root, "source"); await mkdir(path.join(source, "dist"), { recursive: true });
    const manifest = JSON.stringify({ name: "@paperclipai/plugin-sdk", exports: { ".": { import: "./dist/index.js" } } });
    await writeFile(path.join(source, "package.json"), manifest); await writeFile(path.join(source, "dist/index.js"), "export const publicSdk = true;\n");
    const owned = path.join(root, "owned"); await mkdir(owned);
    await expect(mirrorPreviewSdk(source, source)).rejects.toThrow("separately owned");
    const result = await mirrorPreviewSdk(source, owned);
    expect(result.sdkPath).toBe(path.join(await realpath(owned), "packages/plugins/sdk"));
    expect(result.archiveWrites).toBe(false); expect(result.packageBuilds).toBe(0); expect(result.packagePacks).toBe(0);
    for (const file of result.files) {
      const original = await readFile(path.join(source, file.path));
      expect(await readFile(path.join(result.sdkPath, file.path))).toEqual(original);
      expect(file.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    }
    await expect(mirrorPreviewSdk(source, owned)).rejects.toThrow();
    const other = path.join(root, "other"); await mkdir(other);
    await symlink(path.join(source, "package.json"), path.join(source, "dist/escape.js"));
    await expect(mirrorPreviewSdk(source, other)).rejects.toThrow("symbolic links");
  } finally { await rm(root, { recursive: true, force: true }); }
});
