import { rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { createBundledPluginPackageResolver } from "../services/bundled-plugin-package.js";
import { BUNDLED_PLUGIN_CATALOG, resolveBundledPluginInstalls } from "../services/bundled-plugins.js";
import { readDistributionPluginCatalog } from "../services/distribution-plugin-catalog.js";

import boxd from "../../../packages/plugins/sandbox-providers/boxd/src/manifest.js";
import createos from "../../../packages/plugins/sandbox-providers/createos/src/manifest.js";
import cloudflare from "../../../packages/plugins/sandbox-providers/cloudflare/src/manifest.js";
import daytona from "../../../packages/plugins/sandbox-providers/daytona/src/manifest.js";
import e2b from "../../../packages/plugins/sandbox-providers/e2b/src/manifest.js";
import exe_dev from "../../../packages/plugins/sandbox-providers/exe-dev/src/manifest.js";
import kubernetes from "../../../packages/plugins/sandbox-providers/kubernetes/src/manifest.js";
import modal from "../../../packages/plugins/sandbox-providers/modal/src/manifest.js";
import novita from "../../../packages/plugins/sandbox-providers/novita/src/manifest.js";

const manifests = { boxd, createos, cloudflare, daytona, e2b, "exe-dev": exe_dev, kubernetes, modal, novita };
const roots: string[] = [];
function fixture() { const result = bundledImageFixture(); roots.push(result.root); return result; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bundled image package identity", () => {
  it("resolves independent image roots from the same registration without any previous path", () => {
    const first = fixture();
    const second = fixture();
    const registration = { ...first.registration, packagePath: "/lost/old/home/plugins/fixture" };
    expect(first.resolver.resolve(registration)).toBe(first.packageRoot);
    expect(second.resolver.resolve(registration)).toBe(second.packageRoot);
    expect(first.resolver.inspect(registration, first.manifest)).toEqual(second.resolver.inspect(registration, second.manifest));
    expect(registration.packagePath).toBe("/lost/old/home/plugins/fixture");
  });

  it("requires verified manifest evidence and blocks same-version manifest drift", () => {
    const { resolver, registration, manifest } = fixture();
    expect(resolver.inspect(registration)).toMatchObject({ compatible: false, code: "missing_manifest_evidence" });
    expect(resolver.inspect(registration, { ...manifest, description: "changed" })).toMatchObject({ compatible: false, code: "incompatible_bundled_package", reason: expect.stringContaining("Approved plugin manifest") });
    expect(resolver.inspect(registration, manifest)).toMatchObject({ compatible: true, identity: { kind: "bundled_image", catalogKey: "fixture", pluginKey: manifest.id, version: "1.0.0" } });
  });

  it("rejects mismatched package names, versions, identity and escaping entrypoints", () => {
    const { resolver, registration } = fixture();
    for (const update of [
      { packageName: "@other/plugin" }, { version: "2.0.0" }, { pluginKey: "other.plugin" },
      { manifestJson: { ...registration.manifestJson, version: "2.0.0" } },
      { manifestJson: { ...registration.manifestJson, entrypoints: { worker: "../worker.js" } } },
    ]) expect(() => resolver.resolve({ ...registration, ...update })).toThrow();
  });

  it("fails explicitly for missing or deselected bundles even when a stale npm package exists", () => {
    const { root, packageRoot, resolver, registration } = fixture();
    const fallback = path.join(root, "home", "node_modules", registration.packageName);
    mkdirSync(fallback, { recursive: true });
    writeFileSync(path.join(fallback, "worker.js"), "throw new Error('unsafe fallback');");
    rmSync(packageRoot, { recursive: true });
    expect(() => resolver.resolve(registration)).toThrow(/ENOENT/);
    expect(() => createBundledPluginPackageResolver([]).resolve(registration)).toThrow(/absent or not selected/);
  });

  it("rejects tampering before manifest import and symlink escapes before worker resolution", () => {
    const { root, packageRoot, registration, resolver } = fixture();
    writeFileSync(path.join(packageRoot, "dist", "manifest.js"), "throw new Error('must never import');");
    expect(() => readDistributionPluginCatalog(root, BUNDLED_PLUGIN_CATALOG)).toThrow(/digest mismatch/);
    rmSync(path.join(packageRoot, "dist", "worker.js"));
    symlinkSync(path.join(root, "distribution", "catalog.json"), path.join(packageRoot, "dist", "worker.js"));
    expect(() => resolver.resolve(registration)).toThrow(/escapes/);
  });

  it.each(BUNDLED_PLUGIN_CATALOG)("accepts the real shipped $key package and manifest contract", (entry) => {
    const manifest = manifests[entry.key as keyof typeof manifests];
    const pkg = JSON.parse(readFileSync(new URL(`../../../packages/plugins/${entry.relativePath}/package.json`, import.meta.url), "utf8"));
    const { root } = fixture();
    const packageRoot = path.join(root, entry.relativePath);
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(pkg));
    writeFileSync(path.join(packageRoot, "dist", "manifest.js"), `export default ${JSON.stringify(manifest)};`);
    writeFileSync(path.join(packageRoot, "dist", "worker.js"), "export default {};");
    const installs = resolveBundledPluginInstalls([entry.key], { catalogRoot: root, enforceCatalogRoot: true, distributionPlugins: [], env: {} });
    const resolver = createBundledPluginPackageResolver(installs);
    const registration = { pluginKey: entry.pluginKey, packageName: pkg.name, version: manifest.version, manifestJson: manifest };
    expect(pkg.version).toBe(manifest.version);
    expect(resolver.resolve(registration)).toBe(packageRoot);
    expect(resolver.inspect(registration, manifest)).toMatchObject({ compatible: true });
  });
});
