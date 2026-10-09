import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The execution account owns setup state; provider HOME overrides have no authority. */
export function hermesRuntimeCachePath(closureSha256: string, platform: string, architecture: string, home = userInfo().homedir): string {
  if (!/^[a-f0-9]{64}$/.test(closureSha256) || !["darwin-arm64", "linux-x64"].includes(`${platform}-${architecture}`)
    || !isAbsolute(home) || resolve(home) !== home || home.includes("\0")) throw new Error("Invalid Hermes runtime cache identity");
  let directory = home;
  for (const part of [".paperclip", "runtimes", "hermes", `${platform}-${architecture}`, closureSha256]) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Hermes runtime cache must contain real directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return directory;
}

/** An invalid package asset fails admission; only absence allows the account cache. */
export function resolveHermesDistributionRoot(packageAssetsRoot: string, closureSha256: string, platform: string, architecture: string, home?: string): string {
  const packaged = join(packageAssetsRoot, `${platform}-${architecture}`);
  try {
    const stat = lstatSync(packaged);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Hermes packaged runtime must be a real directory");
    return packaged;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return hermesRuntimeCachePath(closureSha256, platform, architecture, home);
}
