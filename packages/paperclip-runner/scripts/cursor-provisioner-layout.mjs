import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Both public server vendoring and the standalone runner own their assets. */
export function cursorProvisionerPackageRoot(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Cursor setup requires a published provisioner");
  const path = fileURLToPath(url);
  if (/\/dist\/vendor\/paperclip-runner\/cli\/provision-cursor\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "..");
  if (/\/dist\/cli\/provision-cursor\.(?:cjs|js)$/.test(path)) return resolve(dirname(path), "../..");
  throw new Error("Cursor setup requires a published provisioner");
}
