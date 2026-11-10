import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { BUNDLED_PLUGIN_CATALOG, resolveBundledPluginInstalls } from "../../services/bundled-plugins.js";
import { distributionBundleDigest, readDistributionPluginCatalog } from "../../services/distribution-plugin-catalog.js";
import { derivePluginDatabaseNamespace } from "../../services/plugin-database.js";
import { createBundledPluginPackageResolver } from "../../services/bundled-plugin-package.js";

export function bundledImageFixture(manifestOverrides: Partial<PaperclipPluginManifestV1> = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bundled-image-")));
  const packageRoot = path.join(root, "distribution", "fixture");
  const manifest: PaperclipPluginManifestV1 = {
    id: "paperclip.image-fixture", apiVersion: 1, version: "1.0.0", displayName: "Image Fixture",
    description: "Image package relocation fixture", author: "Paperclip", categories: ["automation"], capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js", ui: "dist/ui" }, ...manifestOverrides,
  };
  mkdirSync(path.join(packageRoot, "dist", "ui"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@paperclipai/plugin-image-fixture", version: manifest.version, type: "module",
    paperclipPlugin: { manifest: "dist/manifest.js", ...manifest.entrypoints },
  }));
  writeFileSync(path.join(packageRoot, "dist", "manifest.js"), `export default ${JSON.stringify(manifest)};`);
  writeFileSync(path.join(packageRoot, "dist", "worker.js"), `import readline from "node:readline";
if (process.argv.includes("--source")) process.stdout.write(import.meta.url);
else {
  const configs = {};
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "initialize") result = { ok: true, supportedMethods: ["configChanged", "health"] };
    if (request.method === "configChanged") configs[request.params.companyId] = request.params.config;
    if (request.method === "health") result = { status: "ok", details: { source: import.meta.url, configs } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "shutdown") setImmediate(() => process.exit(0));
  });
}`);
  writeFileSync(path.join(packageRoot, "dist", "ui", "index.js"), "export const source = 'current-image';");
  if (manifest.database) {
    mkdirSync(path.join(packageRoot, manifest.database.migrationsDir), { recursive: true });
    writeFileSync(path.join(packageRoot, manifest.database.migrationsDir, "001_fixture.sql"), `CREATE TABLE ${derivePluginDatabaseNamespace(manifest.id)}.image_rows (id uuid PRIMARY KEY);`);
  }
  const entry = { key: "fixture", pluginKey: manifest.id, version: manifest.version, directory: "fixture", digest: distributionBundleDigest(packageRoot) };
  writeFileSync(path.join(root, "distribution", "catalog.json"), JSON.stringify({ schemaVersion: 1, plugins: [entry] }));
  const catalog = readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG);
  const installs = resolveBundledPluginInstalls(["fixture"], { catalogRoot: root, enforceCatalogRoot: true, env: {}, distributionPlugins: catalog });
  const resolver = createBundledPluginPackageResolver(installs);
  const registration = { pluginKey: manifest.id, packageName: "@paperclipai/plugin-image-fixture", version: manifest.version, manifestJson: manifest };
  return { root, packageRoot, manifest, catalog, installs, resolver, registration };
}
