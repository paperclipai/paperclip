import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function resolveInstalledProviderAuthority(moduleUrl: string, signal?: AbortSignal): Promise<{ root: string; manifest: string } | undefined> {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:") return undefined;
  const modulePath = fileURLToPath(url);
  const suffix = "/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js";
  if (!modulePath.endsWith(suffix)) return undefined;
  const root = modulePath.slice(0, -suffix.length);
  signal?.throwIfAborted();
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) {
    throw new Error("Installed ACPX server authority must be a canonical package directory");
  }
  for (const relative of ["", "dist", "dist/vendor", "dist/vendor/paperclip-runner", "dist/vendor/paperclip-runner/drivers", "dist/vendor/paperclip-runner/drivers/acpx"]) {
    const path = join(root, relative);
    const metadata = await lstat(path);
    signal?.throwIfAborted();
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error("Installed ACPX server authority escapes its package layout");
    }
  }
  const moduleMetadata = await lstat(modulePath);
  if (!moduleMetadata.isFile() || moduleMetadata.isSymbolicLink() || await realpath(modulePath) !== modulePath) {
    throw new Error("Installed ACPX verifier must remain in its package layout");
  }
  const manifest = join(root, "package.json");
  const handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 256n * 1024n) {
      throw new Error("Installed ACPX server manifest must be a bounded regular file");
    }
    const bytes = await handle.readFile();
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(manifest, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()
      || bytes.length !== Number(before.size) || await realpath(manifest) !== manifest) {
      throw new Error("Installed ACPX server manifest changed during admission");
    }
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "name") || value.name !== "@paperclipai/server") {
      throw new Error("Installed ACPX verifier requires the owning server package");
    }
  } finally {
    await handle.close();
  }
  return { root, manifest };
}
