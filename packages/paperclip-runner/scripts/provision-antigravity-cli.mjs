#!/usr/bin/env node
import { chmod, lstat, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { antigravityCliRuntimeCachePath } from "./antigravity-provisioner-layout.mjs";
import { ownedDirectory } from "./materialize-antigravity-distribution.mjs";
import { antigravityCliDistribution, materializePinnedAntigravityCliDistribution, verifyAntigravityCliDistribution } from "./materialize-antigravity-cli-distribution.mjs";

function assertPublishedProvisioner(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash || !/\/dist\/(?:vendor\/paperclip-runner\/)?cli\/provision-antigravity-cli\.(?:cjs|js)$/.test(fileURLToPath(url))) {
    throw new Error("Antigravity CLI setup requires a published provisioner");
  }
}

/**
 * Explicit public installation; never invoked by an npm lifecycle hook.
 * A verified installation is kept. One whose contents no longer verify is
 * replaced only after a fresh copy has been fully verified beside it, so no
 * failure leaves less than was installed. Filesystem-safety failures (an
 * unsafe parent or installation directory) stop setup and change nothing.
 */
export async function provisionAntigravityCliRuntime(options = {}) {
  assertPublishedProvisioner(options.moduleUrl ?? import.meta.url);
  const distribution = await antigravityCliDistribution(options.platform, options.architecture);
  const destination = antigravityCliRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture, options.home);
  const result = status => ({ ...distribution, destination, executable: join(destination, distribution.executable), status });
  const installed = await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const materialize = target => materializePinnedAntigravityCliDistribution({ destination: target, platform: distribution.platform, architecture: distribution.architecture, archivePath: options.archivePath, fetch: options.fetch });
  if (!installed) {
    await materialize(destination);
    return result("installed");
  }
  if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Antigravity CLI runtime assets must be a real directory");
  // Safety checks come first and are never treated as a repairable mismatch.
  const parent = await ownedDirectory(dirname(destination));
  const current = await ownedDirectory(destination, { privateRoot: true });
  try {
    await verifyAntigravityCliDistribution(destination, distribution);
    return result("verified");
  } catch { /* contents changed: replace below, after the new copy verifies */ }
  const replacement = `${destination}.replacement-${process.pid}-${Date.now()}`;
  await materialize(replacement);
  const retired = join(dirname(destination), `.retired-${process.pid}-${Date.now()}`);
  try {
    const parentNow = await ownedDirectory(dirname(destination));
    const currentNow = await lstat(destination);
    if (parentNow.stat.dev !== parent.stat.dev || parentNow.stat.ino !== parent.stat.ino || currentNow.dev !== current.stat.dev || currentNow.ino !== current.stat.ino) {
      throw new Error("The Antigravity CLI cache changed during setup; nothing was replaced");
    }
    await rename(destination, retired);
    try { await rename(replacement, destination); }
    catch (error) { await rename(retired, destination); throw error; }
  } catch (error) {
    await rm(replacement, { recursive: true, force: true });
    throw error;
  }
  await chmod(retired, 0o700).catch(() => undefined);
  await rm(retired, { recursive: true, force: true });
  return result("replaced");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  provisionAntigravityCliRuntime().then(result => {
    console.log(`${result.status === "verified" ? "Verified" : "Installed and verified"} Google Antigravity CLI ${result.version} (build ${result.build}, ${result.platform}-${result.architecture})`);
    console.log(`Runtime: ${result.destination}. Run setup as the same OS user that runs Paperclip.`);
    console.log("The Antigravity CLI route is experimental; it is used only when the route is enabled.");
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
