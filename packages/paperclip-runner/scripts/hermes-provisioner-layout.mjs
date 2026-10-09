import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hermesRuntimeCachePath } from "../src/drivers/acpx/hermes-runtime-cache.ts";

/** The public server carries the compiled runner, including its setup resources. */
export function hermesProvisionerLayout(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Hermes setup requires a published provisioner");
  const path = fileURLToPath(url);
  if (/\/dist\/vendor\/paperclip-runner\/cli\/provision-hermes\.(?:cjs|js)$/.test(path)) {
    const root = resolve(dirname(path), "..");
    return { root, provider: resolve(root, "providers/hermes"), materializer: resolve(root, "providers/hermes/materialize-hermes.py") };
  }
  if (/\/dist\/cli\/provision-hermes\.(?:cjs|js)$/.test(path)) {
    const root = resolve(dirname(path), "../..");
    return { root, provider: resolve(root, "dist/providers/hermes"), materializer: resolve(root, "dist/providers/hermes/materialize-hermes.py") };
  }
  throw new Error("Hermes setup requires a published provisioner");
}

export function hermesProvisionerDestination(moduleUrl, closureSha256, platform, architecture, home) {
  hermesProvisionerLayout(moduleUrl);
  return hermesRuntimeCachePath(closureSha256, platform, architecture, home);
}
