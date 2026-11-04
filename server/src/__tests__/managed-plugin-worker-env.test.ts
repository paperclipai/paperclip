import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_CATALOG_ROOT_ENV_VAR } from "../services/bundled-plugins.js";
import { distributionBundleDigest } from "../services/distribution-plugin-catalog.js";
import { MANAGED_CONFIG_ENV_KEY } from "../services/managed-config.js";
import { managedPluginWorkerEnvGrant } from "../services/managed-plugin-worker-env.js";

describe("managedPluginWorkerEnvGrant", () => {
  const pluginKey = "paperclip.daytona-sandbox-provider";
  let root: string;
  let packagePath: string;
  const env = (keys: string[] = ["daytona"], workerEnv: Record<string, string[]> = { daytona: ["PROVIDER_ORIGIN"] }) => ({
    [BUNDLED_CATALOG_ROOT_ENV_VAR]: root,
    [MANAGED_CONFIG_ENV_KEY]: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "1", features: {}, plugins: { autoInstall: keys, workerEnv } }),
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "managed-worker-env-"));
    packagePath = path.join(root, "sandbox-providers/daytona");
    await mkdir(packagePath, { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("grants variables to the plugin at its catalog path", () => {
    expect(managedPluginWorkerEnvGrant({ pluginKey, packagePath }, env())).toEqual(["PROVIDER_ORIGIN"]);
  });

  it("grants nothing on a self-hosted instance or without a grant", () => {
    expect(managedPluginWorkerEnvGrant({ pluginKey, packagePath }, { [BUNDLED_CATALOG_ROOT_ENV_VAR]: root })).toEqual([]);
    const { [MANAGED_CONFIG_ENV_KEY]: _unused, ...selfHosted } = env();
    expect(managedPluginWorkerEnvGrant({ pluginKey, packagePath }, selfHosted)).toEqual([]);
  });

  it("grants nothing to another install with the same plugin key", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "managed-worker-env-other-"));
    try {
      expect(managedPluginWorkerEnvGrant({ pluginKey, packagePath: elsewhere }, env())).toEqual([]);
      expect(managedPluginWorkerEnvGrant({ pluginKey, packagePath: null }, env())).toEqual([]);
    } finally { await rm(elsewhere, { recursive: true, force: true }); }
  });

  it("grants nothing to another plugin at the catalog path", () => {
    expect(managedPluginWorkerEnvGrant({ pluginKey: "example.other", packagePath }, env())).toEqual([]);
  });

  it("grants variables to a digest-verified distribution plugin", async () => {
    const directory = path.join(root, "distribution/example-extension");
    await mkdir(path.join(directory, "dist"), { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.0.0", paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" } }));
    await writeFile(path.join(directory, "dist/manifest.js"), "export default {};");
    await writeFile(path.join(directory, "dist/worker.js"), "export {};");
    await writeFile(path.join(root, "distribution/catalog.json"), JSON.stringify({ schemaVersion: 1, plugins: [{
      key: "example-extension", pluginKey: "example.extension", version: "1.0.0", directory: "example-extension", digest: distributionBundleDigest(directory),
    }] }));
    const distribution = env(["example-extension"], { "example-extension": ["PROVIDER_ORIGIN"] });
    expect(managedPluginWorkerEnvGrant({ pluginKey: "example.extension", packagePath: directory }, distribution)).toEqual(["PROVIDER_ORIGIN"]);
  });
});
