import path from "node:path";
import fs from "node:fs";

/**
 * Bundled plugin auto-provisioning.
 *
 * Managed-cloud instances receive a `plugins.autoInstall` key list through
 * `PAPERCLIP_MANAGED_CONFIG` (parsed fail-closed at startup — see
 * `managed-config.ts`). Each key maps to a plugin bundled into
 * the release image under the bundled catalog root. Nobody "installs" on a
 * managed instance: the control plane provisions, tenants use.
 *
 * Two distinct failure postures, deliberately split:
 *
 * 1. **Resolution (this file, `resolveBundledPluginInstalls`) fails to
 *    start.** An unknown key or a path that escapes the bundled catalog
 *    root is a configuration/security violation — a positive allowlist,
 *    not a lookup. Throwing here happens
 *    synchronously inside `createApp`, before the server listens, so a bad
 *    document refuses to start rather than silently widening what code can
 *    be loaded into the host.
 *
 * 2. **Installation (`ensureBundledPlugins`) is fail-safe.**
 *    Missing bundle on disk, install error, load error: caught, logged,
 *    and swallowed per entry so the server ALWAYS finishes booting. A
 *    degraded boot (one provider unavailable) is strictly preferable to a
 *    crash loop across a fleet.
 *
 * Removal of a key from `autoInstall` stops future installs but never
 * auto-uninstalls: there is intentionally no uninstall
 * path anywhere in this module.
 */

/** Default location of the bundled plugin catalog inside the release image. */
export const DEFAULT_BUNDLED_CATALOG_ROOT = "/app/packages/plugins";

/**
 * Env var that relocates the bundled catalog root (dev images, tests).
 */
export const BUNDLED_CATALOG_ROOT_ENV_VAR = "PAPERCLIP_BUNDLED_PLUGIN_ROOT";

export interface BundledPluginCatalogEntry {
  /** Key the managed config's `plugins.autoInstall` list uses. */
  key: string;
  /** Manifest id / registry `pluginKey` the bundle installs as. */
  pluginKey: string;
  /** Bundle location relative to the bundled catalog root. */
  relativePath: string;
  /**
   * Legacy absolute-path override honored for compatibility (the kubernetes
   * bundle predates the catalog). Overrides are still subject to catalog
   * containment when enforcement is on.
   */
  pathOverrideEnvVar?: string;
}

/**
 * The positive allowlist of plugins the control plane may auto-provision.
 * Keys outside this table can never be installed through this path,
 * regardless of what the managed config document says.
 */
export const BUNDLED_PLUGIN_CATALOG: readonly BundledPluginCatalogEntry[] = [
  {
    key: "cloudflare",
    pluginKey: "paperclip.cloudflare-sandbox-provider",
    relativePath: "sandbox-providers/cloudflare",
  },
  {
    key: "daytona",
    pluginKey: "paperclip.daytona-sandbox-provider",
    relativePath: "sandbox-providers/daytona",
  },
  {
    key: "e2b",
    pluginKey: "paperclip.e2b-sandbox-provider",
    relativePath: "sandbox-providers/e2b",
  },
  {
    key: "exe-dev",
    pluginKey: "paperclip.exe-dev-sandbox-provider",
    relativePath: "sandbox-providers/exe-dev",
  },
  {
    key: "kubernetes",
    pluginKey: "paperclip.kubernetes-sandbox-provider",
    relativePath: "sandbox-providers/kubernetes",
    pathOverrideEnvVar: "PAPERCLIP_KUBERNETES_PLUGIN_PATH",
  },
  {
    key: "modal",
    pluginKey: "paperclip.modal-sandbox-provider",
    relativePath: "sandbox-providers/modal",
  },
  {
    key: "novita",
    pluginKey: "paperclip.novita-sandbox-provider",
    relativePath: "sandbox-providers/novita",
  },
];

/**
 * Keys ensured on a self-hosted instance (no managed config present).
 * Exactly the pre-refactor behavior: the kubernetes sandbox provider is
 * auto-installed when its bundle is present, nothing else.
 */
export const SELF_HOSTED_AUTO_INSTALL_KEYS: readonly string[] = ["kubernetes"];

export function resolveBundledCatalogRoot(
  env: Record<string, string | undefined>,
): string {
  const override = env[BUNDLED_CATALOG_ROOT_ENV_VAR]?.trim();
  return override ? override : DEFAULT_BUNDLED_CATALOG_ROOT;
}

export interface ResolvedBundledPlugin {
  key: string;
  pluginKey: string;
  /** Absolute path handed to `loader.installPlugin({ localPath })`. */
  localPath: string;
}

/**
 * Canonicalize a path for containment comparison. Symlinks are resolved
 * when the path exists so a link inside the catalog cannot point install
 * resolution at a directory outside it; nonexistent paths fall back to a
 * lexical resolve (`..` segments still collapse).
 */
function canonicalize(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve auto-install keys to concrete bundle paths.
 *
 * Throws — and the instance must refuse to start — when a key is not in
 * the bundled catalog, or when `enforceCatalogRoot` is set and the
 * resolved path escapes the catalog root. Callers pass
 * `enforceCatalogRoot: true` for managed (control-plane-driven) key lists
 * and `false` for the self-hosted built-in list, where the legacy
 * kubernetes path override may point anywhere (unchanged behavior).
 */
export function resolveBundledPluginInstalls(
  keys: readonly string[],
  opts: {
    catalogRoot: string;
    env: Record<string, string | undefined>;
    enforceCatalogRoot: boolean;
  },
): ResolvedBundledPlugin[] {
  const resolved: ResolvedBundledPlugin[] = [];
  const seen = new Set<string>();
  const canonicalRoot = canonicalize(opts.catalogRoot);
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = BUNDLED_PLUGIN_CATALOG.find((candidate) => candidate.key === key);
    if (!entry) {
      const known = BUNDLED_PLUGIN_CATALOG.map((candidate) => candidate.key).join(", ");
      throw new Error(
        `bundled plugin auto-install key "${key}" is not in the bundled catalog (known keys: ${known}); refusing to start`,
      );
    }
    const override = entry.pathOverrideEnvVar
      ? opts.env[entry.pathOverrideEnvVar]?.trim()
      : undefined;
    const localPath = override
      ? path.resolve(override)
      : path.resolve(opts.catalogRoot, entry.relativePath);
    if (opts.enforceCatalogRoot && !isInsideRoot(canonicalize(localPath), canonicalRoot)) {
      throw new Error(
        `bundled plugin "${key}" resolves to "${localPath}", outside the bundled catalog root "${opts.catalogRoot}"; refusing to start`,
      );
    }
    resolved.push({ key: entry.key, pluginKey: entry.pluginKey, localPath });
  }
  return resolved;
}

interface RegistryPluginRow {
  id: string;
  pluginKey: string;
  status: string;
}

export interface BundledPluginProvisionerDeps {
  registry: {
    getByKey(pluginKey: string): Promise<RegistryPluginRow | null>;
  };
  loader: {
    installPlugin(options: { localPath: string }): Promise<{
      manifest: { id: string } | null;
    }>;
  };
  lifecycle: {
    load(pluginId: string): Promise<unknown>;
  };
  logger: {
    info(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
  /** Overridable for tests; defaults to checking `dist/manifest.js`. */
  bundleManifestExists?: (localPath: string) => boolean;
}

function defaultBundleManifestExists(localPath: string): boolean {
  return fs.existsSync(path.join(localPath, "dist", "manifest.js"));
}

/**
 * Ensure each resolved bundled plugin is installed and loaded.
 *
 * Same mechanism the kubernetes bundle has always used: in-process
 * `loader.installPlugin({ localPath })` at boot — no HTTP, no user, no
 * role. Fully fail-safe per entry: any disk/install/load
 * failure is caught, logged, and swallowed so boot always completes.
 *
 * Skip semantics:
 * - A plugin present in any non-uninstalled state is skipped, so an
 *   operator-disabled plugin is not silently re-enabled on reboot.
 * - A soft-uninstalled plugin is reinstalled only when
 *   `reinstallUninstalled` is set (managed mode, where the control plane
 *   owns provisioning). Self-hosted keeps the pre-refactor behavior of
 *   leaving an operator's uninstall alone.
 */
export async function ensureBundledPlugins(
  installs: readonly ResolvedBundledPlugin[],
  deps: BundledPluginProvisionerDeps,
  opts: { reinstallUninstalled: boolean },
): Promise<void> {
  const bundleManifestExists = deps.bundleManifestExists ?? defaultBundleManifestExists;
  for (const install of installs) {
    try {
      const existing = await deps.registry.getByKey(install.pluginKey);
      if (existing && (existing.status !== "uninstalled" || !opts.reinstallUninstalled)) {
        deps.logger.info(
          { pluginKey: install.pluginKey, status: existing.status },
          "bundled plugin already present; skipping auto-install",
        );
        continue;
      }
      // Skip silently when the bundle is absent (e.g. local dev or an image
      // built without the plugin). Not an error condition.
      if (!bundleManifestExists(install.localPath)) {
        deps.logger.info(
          { pluginKey: install.pluginKey, pluginPath: install.localPath },
          "bundled plugin bundle not present; skipping auto-install",
        );
        continue;
      }
      deps.logger.info(
        { pluginKey: install.pluginKey, pluginPath: install.localPath },
        "auto-installing bundled plugin",
      );
      const discovered = await deps.loader.installPlugin({ localPath: install.localPath });
      if (!discovered.manifest) {
        deps.logger.error(
          { pluginKey: install.pluginKey },
          "bundled plugin installed but manifest is missing",
        );
        continue;
      }
      // Transition installed -> ready. Whether this also starts the worker
      // depends on the injected lifecycle manager: one built with a
      // runtime-capable loader activates here; the boot-time manager in
      // app.ts is not, so at startup this only records `ready` and the
      // worker is started exactly once by the subsequent loader.loadAll().
      const installed = await deps.registry.getByKey(discovered.manifest.id);
      if (installed) {
        await deps.lifecycle.load(installed.id);
        deps.logger.info(
          { pluginId: installed.id, pluginKey: installed.pluginKey },
          "bundled plugin auto-installed and loaded",
        );
      } else {
        deps.logger.error(
          { pluginKey: install.pluginKey },
          "bundled plugin installed but not found in registry",
        );
      }
    } catch (err) {
      deps.logger.error(
        { err, pluginKey: install.pluginKey },
        "Failed to auto-install bundled plugin; continuing boot (degraded: plugin unavailable)",
      );
    }
  }
}
