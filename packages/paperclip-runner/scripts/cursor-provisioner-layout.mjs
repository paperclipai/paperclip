import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cursorRuntimeCachePath } from "../src/drivers/acpx/cursor-runtime-cache.ts";

/** Recognize the provisioner in either supported published package layout. */
export function cursorProvisionerPackageRoot(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Cursor setup requires a published provisioner");
  const path = fileURLToPath(url);
  if (/\/dist\/vendor\/paperclip-runner\/cli\/provision-cursor\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "..");
  if (/\/dist\/cli\/provision-cursor\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "../..");
  throw new Error("Cursor setup requires a published provisioner");
}

/** Validate the installed entrypoint, then install for the OS user running setup. */
export function cursorProvisionerDestination(moduleUrl, distribution, home) {
  cursorProvisionerPackageRoot(moduleUrl);
  return cursorRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture, home);
}
