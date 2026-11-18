import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";

/** Discover only the OS-owned config needed by Node before JavaScript starts. */
export function codexNodeReadOnlyRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  const config = "/System/Library/OpenSSL/openssl.cnf";
  let descriptor: number | undefined;
  try {
    // Neither environment/config values nor redirected paths authorize reads.
    // Includes, providers and engines get no additional filesystem grants.
    if (realpathSync(config) !== config) return [];
    descriptor = openSync(config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) return [];
    return [config];
  } catch {
    // Missing or unsafe resources must not widen access to an enclosing root.
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
