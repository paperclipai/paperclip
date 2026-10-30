import { rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { createBundledPluginPackageResolver } from "../services/bundled-plugin-package.js";
import { BUNDLED_PLUGIN_CATALOG, resolveBundledPluginInstalls } from "../services/bundled-plugins.js";
import { readDistributionPluginCatalog } from "../services/distribution-plugin-catalog.js";

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

  it("applies the same identity and containment checks to managed built-in packages", () => {
    const { root, packageRoot, manifest, registration } = fixture();
    const installs = resolveBundledPluginInstalls(["kubernetes"], { catalogRoot: root, enforceCatalogRoot: true, distributionPlugins: [], env: {} });
    installs[0] = { ...installs[0]!, localPath: packageRoot, pluginKey: manifest.id };
    expect(createBundledPluginPackageResolver(installs).resolve(registration)).toBe(packageRoot);
    expect(() => createBundledPluginPackageResolver(installs).resolve({ ...registration, version: "2.0.0" })).toThrow(/identity\/version/);
  });
});
