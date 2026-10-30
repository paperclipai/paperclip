import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import type { ResolvedBundledPlugin } from "./bundled-plugins.js";
import { assertDistributionManifestCapabilities } from "./distribution-plugin-catalog.js";

export type BundledPluginRegistration = Pick<PluginRecord, "pluginKey" | "packageName" | "version" | "manifestJson">;

export interface BundledPluginPackageIdentity {
  kind: "bundled_image";
  catalogKey: string;
  pluginKey: string;
  packageName: string;
  version: string;
  digest?: string;
}

export type BundledPluginPackageInspection =
  | { compatible: true; identity: BundledPluginPackageIdentity }
  | { compatible: false; pluginKey: string; code: "incompatible_bundled_package" | "missing_manifest_evidence"; reason: string };

function containedEntrypoint(root: string, declared: unknown, directory: boolean): string {
  const relative = typeof declared === "string" ? declared.replace(/^\.\//, "").replace(/\/$/, "") : "";
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes("\\") || relative.split("/").length > 32 || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Bundled plugin entrypoint must stay inside its package");
  }
  const target = fs.realpathSync(path.join(root, relative));
  const resolvedRelative = path.relative(root, target);
  if (!resolvedRelative || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error("Bundled plugin entrypoint escapes its package");
  }
  const stat = fs.statSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Bundled plugin entrypoint is not prebuilt");
  return relative;
}

export function createBundledPluginPackageResolver(installs: readonly ResolvedBundledPlugin[]) {
  const byKey = new Map(installs.map((install) => [install.pluginKey, install]));

  function read(install: ResolvedBundledPlugin) {
    const root = fs.realpathSync(install.localPath);
    if (root !== path.resolve(install.localPath)) throw new Error("Bundled plugin package root changed after catalog resolution");
    containedEntrypoint(root, "package.json", false);
    const metadataPath = path.join(root, "package.json");
    if (fs.statSync(metadataPath).size > 128 * 1024) throw new Error("Bundled plugin package metadata exceeds verification limits");
    const pkg = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string" || !pkg.paperclipPlugin) {
      throw new Error("Bundled plugin package identity or entrypoints are missing");
    }
    if (install.distribution && pkg.version !== install.distribution.version) throw new Error("Bundled plugin package version does not match the catalog");
    const manifest = containedEntrypoint(root, pkg.paperclipPlugin.manifest, false);
    const worker = containedEntrypoint(root, pkg.paperclipPlugin.worker, false);
    const ui = pkg.paperclipPlugin.ui === undefined ? undefined : containedEntrypoint(root, pkg.paperclipPlugin.ui, true);
    if (install.distribution && (worker !== install.distribution.entrypoints.worker || ui !== install.distribution.entrypoints.ui)) {
      throw new Error("Bundled plugin entrypoints do not match the verified package");
    }
    return { root, pkg, manifest, worker, ui };
  }

  function assertManifest(install: ResolvedBundledPlugin, manifest: PaperclipPluginManifestV1, previousManifest?: PaperclipPluginManifestV1) {
    const bundle = read(install);
    if (manifest.id !== install.pluginKey || manifest.version !== bundle.pkg.version) throw new Error("Bundled plugin manifest identity/version does not match the image");
    const worker = containedEntrypoint(bundle.root, manifest.entrypoints.worker, false);
    const ui = manifest.entrypoints.ui === undefined ? undefined : containedEntrypoint(bundle.root, manifest.entrypoints.ui, true);
    if (worker !== bundle.worker || ui !== bundle.ui) throw new Error("Bundled plugin manifest entrypoints do not match the image");
    assertDistributionManifestCapabilities(manifest);
    if (previousManifest) {
      const approved = new Set(previousManifest.capabilities);
      if (manifest.capabilities.some((capability) => !approved.has(capability))) throw new Error("Bundled plugin capabilities require approval");
    }
    return bundle;
  }

  function resolve(plugin: BundledPluginRegistration): string {
    const install = byKey.get(plugin.pluginKey);
    if (!install) throw new Error(`Bundled plugin is absent or not selected in this deployment: ${plugin.pluginKey}`);
    const bundle = assertManifest(install, plugin.manifestJson);
    if (plugin.packageName !== bundle.pkg.name || plugin.version !== bundle.pkg.version) throw new Error("Bundled plugin registration identity/version does not match the image");
    return bundle.root;
  }

  return {
    resolve,
    inspect(plugin: BundledPluginRegistration, verifiedManifest?: PaperclipPluginManifestV1): BundledPluginPackageInspection {
      try {
        resolve(plugin);
        const install = byKey.get(plugin.pluginKey)!;
        if (!verifiedManifest) return { compatible: false, pluginKey: plugin.pluginKey, code: "missing_manifest_evidence", reason: "Image manifest evidence is required" };
        assertManifest(install, verifiedManifest);
        if (!isDeepStrictEqual(verifiedManifest, plugin.manifestJson)) throw new Error("Approved plugin manifest does not match the image");
        return { compatible: true, identity: {
          kind: "bundled_image", catalogKey: install.key, pluginKey: plugin.pluginKey,
          packageName: plugin.packageName, version: plugin.version,
          ...(install.distribution ? { digest: install.distribution.digest } : {}),
        } };
      } catch (error) {
        return { compatible: false, pluginKey: plugin.pluginKey, code: "incompatible_bundled_package", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    assertActivation(input: { pluginKey?: string; packageRoot: string; manifest?: PaperclipPluginManifestV1; previousManifest?: PaperclipPluginManifestV1 }) {
      const install = input.pluginKey ? byKey.get(input.pluginKey) : installs.find((candidate) => candidate.localPath === input.packageRoot);
      if (!install || path.resolve(input.packageRoot) !== install.localPath) throw new Error("Bundled plugin is absent or not selected in this deployment");
      read(install);
      if (input.manifest) assertManifest(install, input.manifest, input.previousManifest);
    },
  };
}
