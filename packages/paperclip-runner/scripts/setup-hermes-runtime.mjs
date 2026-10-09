#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HERMES_CLOSURES } from "../src/drivers/acpx/hermes-distributions.ts";
import { verifyHermesRuntimeFiles } from "../src/drivers/acpx/hermes-setup-integrity.ts";
import { hermesProvisionerDestination, hermesProvisionerLayout } from "./hermes-provisioner-layout.mjs";
import { materializePinnedHermesDistribution } from "./provision-hermes.mjs";

/** Public opt-in only: npm installation and agent execution never invoke setup. */
export async function provisionHermesRuntime() {
  if (process.argv.length !== 2) throw new Error("Hermes runtime setup accepts no destination or credential arguments");
  const layout = hermesProvisionerLayout(import.meta.url);
  const platform = `${process.platform}-${process.arch}`;
  const closureSha256 = HERMES_CLOSURES[platform];
  if (!closureSha256) throw new Error(`Hermes has no reviewed distribution for ${platform}`);
  const destination = hermesProvisionerDestination(import.meta.url, closureSha256, process.platform, process.arch);
  const installed = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (installed) {
    if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Hermes runtime assets must be a real directory");
    await verifyHermesRuntimeFiles(destination, closureSha256);
  } else {
    await materializePinnedHermesDistribution({ destination, provider: layout.provider, materializer: layout.materializer, verify: verifyHermesRuntimeFiles });
  }
  const version = JSON.parse(await readFile(join(layout.provider, "version.json"), "utf8"));
  console.log(`Verified Hermes ${version.release} (${platform}), Python ${version.python}`);
  console.log(`Runtime: ${destination}. Run setup as the same OS user that runs Paperclip.`);
}

provisionHermesRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
