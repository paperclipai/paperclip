#!/usr/bin/env node
import { chmod, lstat, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { antigravityCliDistribution, materializePinnedAntigravityCliDistribution, verifyAntigravityCliDistribution } from "./materialize-antigravity-cli-distribution.mjs";

/** Beside the registry-server runtime (`runtimes/antigravity`), never inside it. */
export function antigravityCliRuntimeCachePath(closureSha256, platform = process.platform, architecture = process.arch, home = homedir()) {
  if (!/^[a-f0-9]{64}$/.test(closureSha256) || !["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(architecture) || !isAbsolute(home)) throw new Error("Invalid Antigravity CLI runtime cache identity");
  return resolve(home, ".paperclip/runtimes/antigravity-cli", `${platform}-${architecture}`, closureSha256);
}

function assertPublishedProvisioner(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash || !/\/dist\/(?:vendor\/paperclip-runner\/)?cli\/provision-antigravity-cli\.(?:cjs|js)$/.test(fileURLToPath(url))) {
    throw new Error("Antigravity CLI setup requires a published provisioner");
  }
}

/**
 * Explicit public installation; never invoked by an npm lifecycle hook.
 * A verified installation is kept. One that no longer verifies is retired and
 * replaced from a fresh verified download, so a re-run always repairs it.
 */
export async function provisionAntigravityCliRuntime(options = {}) {
  assertPublishedProvisioner(options.moduleUrl ?? import.meta.url);
  const distribution = await antigravityCliDistribution(options.platform, options.architecture);
  const destination = antigravityCliRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture, options.home);
  const installed = await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  let status = "installed";
  if (installed) {
    if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Antigravity CLI runtime assets must be a real directory");
    try {
      await verifyAntigravityCliDistribution(destination, distribution);
      return { ...distribution, destination, executable: join(destination, distribution.executable), status: "verified" };
    } catch {
      const retired = join(dirname(destination), `.retired-${process.pid}-${Date.now()}`);
      await rename(destination, retired);
      await chmod(retired, 0o700);
      await rm(retired, { recursive: true, force: true });
      status = "replaced";
    }
  }
  await materializePinnedAntigravityCliDistribution({ destination, platform: distribution.platform, architecture: distribution.architecture, archivePath: options.archivePath, fetch: options.fetch });
  return { ...distribution, destination, executable: join(destination, distribution.executable), status };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  provisionAntigravityCliRuntime().then(result => {
    console.log(`${result.status === "verified" ? "Verified" : "Installed and verified"} Google Antigravity CLI ${result.version} (build ${result.build}, ${result.platform}-${result.architecture})`);
    console.log(`Runtime: ${result.destination}. Run setup as the same OS user that runs Paperclip.`);
    console.log("The Antigravity CLI route is experimental; it is used only when the route is enabled.");
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
