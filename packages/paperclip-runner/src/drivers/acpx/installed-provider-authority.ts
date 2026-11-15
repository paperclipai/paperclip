import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveInstalledProviderAuthority(moduleUrl: string): { root: string; manifest: string } | undefined {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:") return undefined;
  const modulePath = fileURLToPath(url);
  const suffix = "/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js";
  if (!modulePath.endsWith(suffix)) return undefined;
  const root = modulePath.slice(0, -suffix.length);
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) {
    throw new Error("Installed ACPX server authority must be a canonical package directory");
  }
  for (const relative of ["", "dist", "dist/vendor", "dist/vendor/paperclip-runner", "dist/vendor/paperclip-runner/drivers", "dist/vendor/paperclip-runner/drivers/acpx"]) {
    const path = join(root, relative);
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error("Installed ACPX server authority escapes its package layout");
    }
  }
  const moduleMetadata = lstatSync(modulePath);
  if (!moduleMetadata.isFile() || moduleMetadata.isSymbolicLink() || realpathSync(modulePath) !== modulePath) {
    throw new Error("Installed ACPX verifier must remain in its package layout");
  }
  const manifest = join(root, "package.json");
  const fd = openSync(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 256n * 1024n) {
      throw new Error("Installed ACPX server manifest must be a bounded regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(manifest, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()
      || bytes.length !== Number(before.size) || realpathSync(manifest) !== manifest) {
      throw new Error("Installed ACPX server manifest changed during admission");
    }
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "name") || value.name !== "@paperclipai/server") {
      throw new Error("Installed ACPX verifier requires the owning server package");
    }
  } finally {
    closeSync(fd);
  }
  return { root, manifest };
}
