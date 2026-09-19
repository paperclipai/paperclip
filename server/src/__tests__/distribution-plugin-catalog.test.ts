import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { distributionBundleDigest, distributionPluginActivationGuard, readDistributionPluginCatalog } from "../services/distribution-plugin-catalog.js";
import { BUNDLED_PLUGIN_CATALOG, resolveBundledPluginInstalls } from "../services/bundled-plugins.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "distribution-plugin-"))); roots.push(root);
  const localPath = path.join(root, "distribution", "acme.widget");
  mkdirSync(path.join(localPath, "dist", "ui"), { recursive: true });
  writeFileSync(path.join(localPath, "package.json"), JSON.stringify({ name: "@acme/plugin-widget", version: "1.0.0", paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" } }));
  writeFileSync(path.join(localPath, "dist", "manifest.js"), "export default {};");
  writeFileSync(path.join(localPath, "dist", "worker.js"), "export default {};");
  const entry = { key: "acme.widget", pluginKey: "acme.widget", version: "1.0.0", directory: "acme.widget", digest: distributionBundleDigest(localPath) };
  const save = (plugins: unknown[] = [entry]) => writeFileSync(path.join(root, "distribution", "catalog.json"), JSON.stringify({ schemaVersion: 1, plugins }));
  save(); return { root, localPath, entry, save };
}
describe("image-owned plugin catalogs", () => {
  it("preserves images without a distribution catalog", () => {
    expect(readDistributionPluginCatalog("/nonexistent/catalog", BUNDLED_PLUGIN_CATALOG)).toEqual([]);
  });
  it("resolves selected private bundles alongside built-ins after verifying their bytes", () => {
    const { root, localPath } = fixture();
    const installs = resolveBundledPluginInstalls(["daytona", "acme.widget"], { catalogRoot: root, env: {}, enforceCatalogRoot: true });
    expect(installs.map(({ key }) => key)).toEqual(["daytona", "acme.widget"]);
    expect(installs[1]?.localPath).toBe(localPath);
  });
  it("rejects tampered bundle bytes before importing manifest code", () => {
    const { root, localPath } = fixture();
    writeFileSync(path.join(localPath, "dist", "manifest.js"), "throw new Error('must never execute');");
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow(/digest mismatch/);
  });
  it("rejects duplicate keys, plugin identities and built-in replacement", () => {
    const { root, entry, save } = fixture();
    for (const plugins of [[entry, entry], [{ ...entry, key: "daytona" }], [{ ...entry, pluginKey: "paperclip.daytona-sandbox-provider" }]]) {
      save(plugins);
      expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow(/Duplicate or built-in/);
    }
  });
  it("rejects traversal, symlinked artifacts and unbuilt entrypoints", () => {
    const { root, entry, localPath, save } = fixture();
    save([{ ...entry, directory: "../elsewhere" }]);
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow();
    save(); symlinkSync(os.tmpdir(), path.join(localPath, "outside"));
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow(/symlinks/);
    rmSync(path.join(localPath, "outside")); rmSync(path.join(localPath, "dist", "worker.js"));
    save([{ ...entry, digest: distributionBundleDigest(localPath) }]);
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow();
  });
  it("blocks a persisted plugin after deselection/removal while preserving ordinary plugins", () => {
    const { root, localPath } = fixture();
    const entries = readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG);
    const input = { pluginKey: "acme.widget", packageRoot: localPath };
    expect(() => distributionPluginActivationGuard(root, entries, ["acme.widget"])(input)).not.toThrow();
    expect(() => distributionPluginActivationGuard(root, entries, ["acme.widget"])({ packageRoot: localPath })).not.toThrow();
    expect(() => distributionPluginActivationGuard(root, entries, [])({ packageRoot: localPath })).toThrow(/not selected/);
    expect(() => distributionPluginActivationGuard(root, entries, [])(input)).toThrow(/not selected/);
    expect(() => distributionPluginActivationGuard(root, [], [])(input)).toThrow(/absent/);
    expect(() => distributionPluginActivationGuard(root, [], [])({ ...input, packageRoot: path.join(root, "node_modules/acme"), installedPackagePath: localPath })).toThrow(/absent/);
    expect(() => distributionPluginActivationGuard(root, [], [])({ pluginKey: "ordinary.plugin", packageRoot: path.join(root, "ordinary") })).not.toThrow();
  });
  it("rejects dangling catalog symlinks instead of treating them as absent", () => {
    const { root } = fixture();
    const file = path.join(root, "distribution", "catalog.json");
    rmSync(file); symlinkSync(path.join(root, "missing"), file);
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow(/Invalid distribution catalog/);
  });
  it("requires catalog identity and version before activating imported manifests", () => {
    const { root, localPath } = fixture();
    const entries = readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG);
    const guard = distributionPluginActivationGuard(root, entries, ["acme.widget"]);
    for (const manifest of [{ id: "other.plugin", version: "1.0.0" }, { id: "acme.widget", version: "2.0.0" }]) {
      expect(() => guard({ pluginKey: "acme.widget", packageRoot: localPath, manifest: manifest as PaperclipPluginManifestV1 })).toThrow(/identity\/version/);
    }
  });

  it("binds runtime worker and UI entrypoints to the digest-verified package declarations", () => {
    const { root, localPath } = fixture();
    const entries = readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG);
    const guard = distributionPluginActivationGuard(root, entries, ["acme.widget"]);
    const manifest = { id: "acme.widget", version: "1.0.0", capabilities: [], entrypoints: { worker: "dist/worker.js", ui: "./dist/ui" } } as unknown as PaperclipPluginManifestV1;
    expect(() => guard({ packageRoot: localPath, manifest })).not.toThrow();
    for (const name of ["worker", "ui"] as const) {
      for (const value of ["/outside/worker.js", "../outside", "dist/../worker.js", "C:/outside", "dist\\worker.js", "dist/other", "", undefined]) {
        const invalid = { ...manifest, entrypoints: { ...manifest.entrypoints, [name]: value } } as PaperclipPluginManifestV1;
        expect(() => guard({ packageRoot: localPath, manifest: invalid })).toThrow(/entrypoint/);
      }
    }
  });

  it("accepts worker-only bundles but rejects a UI path absent from verified metadata", () => {
    const { root, localPath, entry, save } = fixture();
    writeFileSync(path.join(localPath, "package.json"), JSON.stringify({ version: "1.0.0", paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" } }));
    save([{ ...entry, digest: distributionBundleDigest(localPath) }]);
    const guard = distributionPluginActivationGuard(root, readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG), null);
    const manifest = { id: "acme.widget", version: "1.0.0", capabilities: [], entrypoints: { worker: "./dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    expect(() => guard({ packageRoot: localPath, manifest })).not.toThrow();
    manifest.entrypoints.ui = "./dist/ui";
    expect(() => guard({ packageRoot: localPath, manifest })).toThrow(/verified package/);
  });

  it("rejects inconsistent capabilities and unapproved runtime refreshes", () => {
    const { root, localPath } = fixture();
    const guard = distributionPluginActivationGuard(root, readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG), null);
    const previousManifest = { id: "acme.widget", version: "1.0.0", capabilities: [], entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" } } as unknown as PaperclipPluginManifestV1;
    const manifest = { ...previousManifest, capabilities: ["issues.read" as const] };
    expect(() => guard({ packageRoot: localPath, manifest, previousManifest })).toThrow(/require approval/);
    expect(() => guard({ packageRoot: localPath, manifest, previousManifest: manifest })).not.toThrow();
    previousManifest.ui = { slots: [{ type: "appShellOverlay", id: "overlay", displayName: "Overlay", exportName: "Overlay" }] };
    expect(() => guard({ packageRoot: localPath, manifest: previousManifest })).toThrow(/missing required capabilities: ui.action.register/);
  });
});
