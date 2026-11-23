import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
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
