import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Runtime credentials may be group-readable, but never public or store-backed. */
export function readDeploymentCredential(file: string): string {
  try {
    if (!isAbsolute(file)) throw new Error();
    const resolved = realpathSync(file);
    if (resolved === "/nix/store" || resolved.startsWith("/nix/store/")) throw new Error();
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o007) !== 0 || stat.size > 1024 * 1024) throw new Error();
      const value = readFileSync(fd, "utf8");
      if (Buffer.byteLength(value) > 1024 * 1024 || !value.trim() || value.includes("\0")) throw new Error();
      return value;
    } finally {
      closeSync(fd);
    }
  } catch {
    // Do not include the path, file contents or filesystem/parser exceptions.
    throw new Error("Deployment credential is missing, invalid, oversized or publicly readable");
  }
}
