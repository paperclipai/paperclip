import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Copy genuine SDK package/dist bytes into the owned scaffold workspace. The
 * public CLI can then use its workspace SDK route without packing the archive. */
export async function mirrorPreviewSdk(source: string, ownedRoot: string) {
  const root = await realpath(ownedRoot), sourceRoot = await realpath(source);
  if (sourceRoot === root || root.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(root + path.sep))
    throw new Error("SDK mirror requires a separately owned output root");
  const sdkPath = path.join(root, "packages/plugins/sdk");
  await mkdir(sdkPath, { recursive: true });
  const files: Array<{ path: string; sha256: string; byteSize: number }> = [];
  let totalBytes = 0;
  async function copy(relative: string): Promise<void> {
    const sourcePath = path.join(sourceRoot, relative), targetPath = path.join(sdkPath, relative);
    const stat = await lstat(sourcePath);
    if (stat.isSymbolicLink()) throw new Error("SDK mirror rejects symbolic links");
    if (stat.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      for (const name of (await readdir(sourcePath)).sort()) await copy(path.join(relative, name));
      return;
    }
    if (!stat.isFile() || files.length >= 512 || stat.size > 4_194_304 || totalBytes + stat.size > 33_554_432)
      throw new Error("SDK mirror exceeds its bounded public package/dist inventory");
    const bytes = await readFile(sourcePath);
    await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
    const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
    const sha256 = hash(bytes);
    if (hash(await readFile(targetPath)) !== sha256) throw new Error("SDK mirror byte custody mismatch");
    totalBytes += bytes.length;
    files.push({ path: relative, sha256, byteSize: bytes.length });
  }
  await copy("package.json");
  const manifest = JSON.parse(await readFile(path.join(sdkPath, "package.json"), "utf8"));
  if (manifest.name !== "@paperclipai/plugin-sdk" || manifest.exports?.["."]?.import !== "./dist/index.js")
    throw new Error("SDK mirror is not the actual public plugin SDK package");
  await copy("dist");
  if (!files.some(file => file.path === path.join("dist", "index.js"))) throw new Error("SDK mirror has no real compiled entrypoint");
  return { sdkPath, files, archiveWrites: false as const, packageBuilds: 0 as const, packagePacks: 0 as const };
}
