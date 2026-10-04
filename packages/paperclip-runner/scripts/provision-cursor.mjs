#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { cursorProvisionerPackageRoot } from "./cursor-provisioner-layout.mjs";
import { cursorDistribution, materializePinnedCursorDistribution, verifyCursorDistribution } from "./materialize-cursor-distribution.mjs";

/** Explicit public installation; never invoked by an npm lifecycle hook. */
export async function provisionCursorRuntime() {
  const distribution = await cursorDistribution();
  const packageRoot = cursorProvisionerPackageRoot(import.meta.url);
  const destination = join(packageRoot, "provider-assets", "cursor", `${distribution.platform}-${distribution.architecture}`);
  const installed = await lstat(destination).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (installed) {
    if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Cursor runtime assets must be a real directory");
    await verifyCursorDistribution(destination, distribution);
  } else {
    await materializePinnedCursorDistribution({ destination });
  }
  console.log(`Verified Cursor ${distribution.version} (${distribution.platform}-${distribution.architecture}), ${distribution.patchVersion}`);
}

provisionCursorRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
