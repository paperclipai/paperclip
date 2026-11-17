// PRIVATE UNRUN fixture composition through EXISTING image-owned bootstrap.
import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { distributionBundleDigest, readDistributionPluginCatalog } from "../../../services/distribution-plugin-catalog.js";
import { BUNDLED_PLUGIN_CATALOG } from "../../../services/bundled-plugins.js";
import { createPluginWorkerManager } from "../../../services/plugin-worker-manager.js";
import { LINUX_QUALIFICATION_PROVIDER } from "./normal-runtime-composition.js";

const pluginKey = "paperclip.dot-linux-qualification";
export async function prepareOwnedLinuxDistribution(input: {
  catalogRoot: string;
  prebuiltPackageRoot: string;
  expectedBundleDigest: string;
}) {
  // The prebuilt package is a separate OWN normal compiler output. Never copy
  // donor workspace compiled exports or install runtime dependencies here.
  const expected = path.join(input.catalogRoot, "distribution", LINUX_QUALIFICATION_PROVIDER);
  if (input.prebuiltPackageRoot !== expected || await realpath(expected) !== expected) throw new Error("owned_distribution_path_mismatch");
  const pkg = JSON.parse(await readFile(path.join(expected, "package.json"), "utf8"));
  if (pkg.version !== "0.0.1" || pkg.paperclipPlugin?.worker !== "./dist/worker.mjs"
      || pkg.paperclipPlugin?.manifest !== "./dist/qualification-manifest.js") throw new Error("owned_distribution_package_mismatch");
  const digest = distributionBundleDigest(expected);
  if (digest !== input.expectedBundleDigest) throw new Error("owned_distribution_output_drift");
  await mkdir(path.join(input.catalogRoot, "distribution"), { recursive: true, mode: 0o700 });
  const catalogBytes = JSON.stringify({ schemaVersion: 1, plugins: [{
    key: LINUX_QUALIFICATION_PROVIDER, pluginKey, version: "0.0.1", directory: LINUX_QUALIFICATION_PROVIDER, digest,
  }] });
  const catalogFile = path.join(input.catalogRoot, "distribution/catalog.json");
  try { await writeFile(catalogFile, catalogBytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await readFile(catalogFile, "utf8") !== catalogBytes) throw error;
  }
  const entries = readDistributionPluginCatalog(input.catalogRoot, BUNDLED_PLUGIN_CATALOG);
  if (entries.length !== 1 || entries[0]?.pluginKey !== pluginKey) throw new Error("owned_distribution_normal_validation_failed");
  const workerManager = createPluginWorkerManager();
  return {
    workerManager,
    appOptions: { pluginWorkerManager: workerManager, bundledPluginCatalogRoot: input.catalogRoot,
      managedPluginAutoInstall: [LINUX_QUALIFICATION_PROVIDER] },
  };
}

// In makeAppOwner, spread these appOptions into the original createApp options;
// await the SAME normal app.locals.bundledPluginsStartup before environment
// setup. Normal ensureBundledPlugins/lifecycle.load creates/starts the worker;
// no ready row, supportedMethods object, loaded module or grants are faked.
// heartbeatService(db,{pluginWorkerManager:workerManager}) uses the same normal
// sandbox runtime/lease owner. Reconstruct through the same bootstrap (catalog
// bytes unchanged), not an untracked alternate environment owner.
