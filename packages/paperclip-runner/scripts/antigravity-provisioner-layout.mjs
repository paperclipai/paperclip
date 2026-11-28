import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function antigravityRuntimeCachePath(closureSha256, platform = process.platform, architecture = process.arch, home = homedir()) {
  if (!/^[a-f0-9]{64}$/.test(closureSha256) || !["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(architecture) || !isAbsolute(home)) throw new Error("Invalid Antigravity runtime cache identity");
  return resolve(home, ".paperclip/runtimes/antigravity", `${platform}-${architecture}`, closureSha256);
}

export function antigravityProvisionerPackageRoot(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Antigravity setup requires a published provisioner");
  const path = fileURLToPath(url);
  if (/\/dist\/vendor\/paperclip-runner\/cli\/provision-antigravity\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "..");
  if (/\/dist\/cli\/provision-antigravity\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "../..");
  throw new Error("Antigravity setup requires a published provisioner");
}

export function antigravityProvisionerDestination(moduleUrl, distribution, home) {
  antigravityProvisionerPackageRoot(moduleUrl);
  return antigravityRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture, home);
}

/**
 * The CLI route's cache, beside `runtimes/antigravity`. Like the launch
 * resolvers, it refuses a linked or non-directory component from
 * `~/.paperclip` down, so setup never installs where a launch cannot resolve.
 */
export function antigravityCliRuntimeCachePath(closureSha256, platform = process.platform, architecture = process.arch, home = homedir()) {
  if (!/^[a-f0-9]{64}$/.test(closureSha256) || !["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(architecture) || !isAbsolute(home) || home.includes("\0")) throw new Error("Invalid Antigravity CLI runtime cache identity");
  let directory = home;
  for (const part of [".paperclip", "runtimes", "antigravity-cli", `${platform}-${architecture}`, closureSha256]) {
    directory = join(directory, part);
    let stat;
    try { stat = lstatSync(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`The Antigravity CLI runtime cache must contain real directories, not links: ${directory}. Nothing was installed.`);
  }
  return directory;
}
