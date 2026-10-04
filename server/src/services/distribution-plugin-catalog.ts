import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";

const segment = z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/);
export const distributionPluginCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  plugins: z.array(z.object({
    key: segment,
    pluginKey: segment,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/),
    directory: segment,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()).max(100),
}).strict();

export type DistributionPlugin = z.infer<typeof distributionPluginCatalogSchema>["plugins"][number] & {
  localPath: string;
  /** Normalized paths from the digest-verified package metadata. */
  entrypoints: { worker: string; ui?: string };
};

function bundleEntrypoint(declared: unknown): string {
  const relative = typeof declared === "string" ? declared.replace(/^\.\//, "").replace(/\/$/, "") : "";
  if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Distribution entrypoint must stay inside its bundle");
  }
  return relative;
}

export function assertDistributionManifestCapabilities(manifest: PaperclipPluginManifestV1): void {
  const result = pluginCapabilityValidator().validateManifestCapabilities(manifest);
  if (!result.allowed) {
    throw new Error(`Distribution manifest is missing required capabilities: ${result.missing.join(", ")}`);
  }
}

export function distributionPluginsRoot(catalogRoot: string): string {
  // Match canonical paths persisted by local-path installs (for example,
  // macOS /tmp -> /private/tmp), without permitting a symlinked catalog itself.
  try { return path.join(fs.realpathSync(catalogRoot), "distribution"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.resolve(catalogRoot, "distribution");
  }
}

/** Guard all activation paths, including persisted installs after a rollback. */
export function distributionPluginActivationGuard(
  catalogRoot: string,
  entries: readonly DistributionPlugin[],
  selectedKeys: readonly string[] | null,
) {
  const root = distributionPluginsRoot(catalogRoot);
  return (input: { pluginKey?: string; packageRoot: string; installedPackagePath?: string | null; manifest?: PaperclipPluginManifestV1; previousManifest?: PaperclipPluginManifestV1 }) => {
    let packageRoot: string;
    try { packageRoot = fs.realpathSync(input.packageRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      packageRoot = path.resolve(input.packageRoot);
    }
    const entry = entries.find((candidate) => input.pluginKey ? candidate.pluginKey === input.pluginKey : candidate.localPath === packageRoot);
    const relative = path.relative(root, packageRoot);
    const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    // A missing image directory can make package resolution fall back to npm.
    // Retain the persisted image-path provenance even when that directory no
    // longer exists; the resolved fallback is not an ordinary installation.
    const installedRelative = input.installedPackagePath ? path.relative(root, path.resolve(input.installedPackagePath)) : null;
    const installedInside = installedRelative !== null && (installedRelative === "" || (!installedRelative.startsWith("..") && !path.isAbsolute(installedRelative)));
    if (!inside && !installedInside && !entry) return;
    if (!entry || (selectedKeys !== null && !selectedKeys.includes(entry.key)) || packageRoot !== entry.localPath) {
      throw new Error("Distribution plugin is absent or not selected in this deployment");
    }
    if (input.manifest && (input.manifest.id !== entry.pluginKey || input.manifest.version !== entry.version)) {
      throw new Error("Distribution manifest does not match its catalog identity/version");
    }
    if (input.manifest) {
      assertDistributionManifestCapabilities(input.manifest);
      if (input.previousManifest) {
        const approved = new Set(input.previousManifest.capabilities);
        const added = input.manifest.capabilities.filter((capability) => !approved.has(capability));
        if (added.length) throw new Error(`Distribution plugin capabilities require approval: ${added.join(", ")}`);
      }
      const worker = bundleEntrypoint(input.manifest.entrypoints.worker);
      const ui = input.manifest.entrypoints.ui === undefined ? undefined : bundleEntrypoint(input.manifest.entrypoints.ui);
      if (worker !== entry.entrypoints.worker || ui !== entry.entrypoints.ui) {
        throw new Error("Distribution manifest entrypoints do not match the verified package");
      }
    }
  };
}

/** Same portable file inventory used by image builders: path, SHA-256, mode. */
export function distributionBundleDigest(root: string): string {
  const inventory: Array<[string, string, number]> = [];
  let bytesRead = 0;
  const hash = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  function walk(directory: string, relative = "") {
    if (relative.split("/").length > 32) throw new Error("Distribution bundle exceeds directory depth limit");
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Distribution bundles cannot contain symlinks");
      if (stat.isDirectory()) walk(file, relativePath);
      else if (stat.isFile()) {
        bytesRead += stat.size;
        if (bytesRead > 256 * 1024 * 1024 || inventory.length >= 10_000) throw new Error("Distribution bundle exceeds verification limits");
        inventory.push([relativePath, hash(fs.readFileSync(file)), stat.mode & 0o777]);
      } else throw new Error("Distribution bundles contain only regular files and directories");
    }
  }
  walk(root);
  if (!inventory.length) throw new Error("Distribution bundle is empty");
  return hash(JSON.stringify(inventory));
}

/**
 * Optional, image-owned extension catalog. No URLs, executable configuration,
 * runtime dependency installation, or replacement of a built-in entry.
 * Validate bytes before importing any manifest code.
 */
export function readDistributionPluginCatalog(
  catalogRoot: string,
  builtins: readonly { key: string; pluginKey: string }[],
): DistributionPlugin[] {
  const root = distributionPluginsRoot(catalogRoot);
  const file = path.join(root, "catalog.json");
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Distribution catalog root must be a regular directory, not a symlink");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Invalid distribution catalog file");
  const catalog = distributionPluginCatalogSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const keys = new Set(builtins.map((entry) => entry.key));
  const pluginKeys = new Set(builtins.map((entry) => entry.pluginKey));
  const directories = new Set<string>();
  return catalog.plugins.map((entry) => {
    if (keys.has(entry.key) || pluginKeys.has(entry.pluginKey) || directories.has(entry.directory)) {
      throw new Error("Duplicate or built-in distribution plugin identity");
    }
    keys.add(entry.key); pluginKeys.add(entry.pluginKey); directories.add(entry.directory);
    const localPath = path.join(root, entry.directory);
    const info = fs.lstatSync(localPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid distribution bundle directory");
    if (distributionBundleDigest(localPath) !== entry.digest) throw new Error(`Distribution bundle digest mismatch: ${entry.key}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf8"));
    if (pkg.version !== entry.version || !pkg.paperclipPlugin) throw new Error("Distribution package version or entrypoints missing");
    for (const name of ["manifest", "worker", "ui"] as const) {
      const declared = pkg.paperclipPlugin[name];
      if (name === "ui" && declared === undefined) continue;
      const relative = bundleEntrypoint(declared);
      const target = fs.statSync(path.join(localPath, relative));
      if (name === "ui" ? !target.isDirectory() : !target.isFile()) throw new Error("Distribution entrypoint is not prebuilt");
    }
    return { ...entry, localPath, entrypoints: {
      worker: bundleEntrypoint(pkg.paperclipPlugin.worker),
      ...(pkg.paperclipPlugin.ui === undefined ? {} : { ui: bundleEntrypoint(pkg.paperclipPlugin.ui) }),
    } };
  });
}
