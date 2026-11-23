#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityProvisionerDestination } from "./antigravity-provisioner-layout.mjs";
import { antigravityDistribution, materializePinnedAntigravityDistribution, verifyAntigravityDistribution } from "./materialize-antigravity-distribution.mjs";

/** Explicit public installation; never invoked by an npm lifecycle hook. */
export async function provisionAntigravityRuntime(options = {}) {
  const distribution = await antigravityDistribution(options.platform, options.architecture);
  const destination = antigravityProvisionerDestination(options.moduleUrl ?? import.meta.url, distribution, options.home);
  const installed = await lstat(destination).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (installed) {
    if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Antigravity runtime assets must be a real directory");
    await verifyAntigravityDistribution(destination, distribution);
  } else {
    await materializePinnedAntigravityDistribution({ destination, platform: distribution.platform, architecture: distribution.architecture, archivePath: options.archivePath });
  }
  return { ...distribution, destination, executable: resolve(destination, distribution.executable) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  provisionAntigravityRuntime().then(result => {
    console.log(`Verified Google Antigravity ${result.version} (${result.platform}-${result.architecture}), ${result.patchVersion}`);
    console.log(`Runtime: ${result.destination}. Run setup as the same OS user that runs Paperclip.`);
    console.log("Native Runner execution remains pending acceptance in this build.");
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
