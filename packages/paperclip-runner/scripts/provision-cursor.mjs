#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { cursorProvisionerDestination } from "./cursor-provisioner-layout.mjs";
import { cursorDistribution, materializePinnedCursorDistribution, verifyCursorDistribution } from "./materialize-cursor-distribution.mjs";

/** Explicit public installation; never invoked by an npm lifecycle hook. */
export async function provisionCursorRuntime() {
  const distribution = await cursorDistribution();
  const destination = cursorProvisionerDestination(import.meta.url, distribution);
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
  console.log(`Runtime: ${destination}. Run setup as the same OS user that runs Paperclip.`);
}

provisionCursorRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
