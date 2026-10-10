import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

/** OS-account storage, independent of npm ownership and provider HOME/XDG overrides. */
export function cursorRuntimeCachePath(closureSha256: string, platform: string, architecture: string, home = userInfo().homedir): string {
  if (!/^[a-f0-9]{64}$/.test(closureSha256) || !["darwin-arm64", "darwin-x64", "linux-x64"].includes(`${platform}-${architecture}`)
    || !isAbsolute(home) || home.includes("\0")) throw new Error("Invalid Cursor runtime cache identity");
  let directory = home;
  for (const part of [".paperclip", "runtimes", "cursor", `${platform}-${architecture}`, closureSha256]) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cursor runtime cache must contain real directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return directory;
}

/** Keep image-owned assets authoritative; only absent assets use the user's cache. */
export function resolveCursorDistributionRoot(packageAssetsRoot: string, closureSha256: string, platform: string, architecture: string): string {
  const packaged = join(packageAssetsRoot, `${platform}-${architecture}`);
  try {
    const stat = lstatSync(packaged);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cursor packaged runtime must be a real directory");
    return packaged;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return cursorRuntimeCachePath(closureSha256, platform, architecture);
}
