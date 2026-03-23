/**
 * PluginLoader — discovery, installation, and runtime activation of plugins.
 *
 * This service is the entry point for the plugin system's I/O boundary:
 *
 * 1. **Discovery** — Scans the local plugin directory
 *    (`~/.paperclip/plugins/`) and `node_modules` for packages matching
 *    the `paperclip-plugin-*` naming convention. Aggregates results with
 *    path-based deduplication.
 *
 * 2. **Installation** — `installPlugin()` downloads from npm (or reads a
 *    local path), validates the manifest, checks capability consistency,
 *    and persists the install record.
 *
 * 3. **Runtime activation** — `activatePlugin()` wires up a loaded plugin
 *    with all runtime services: resolves its entrypoint, builds
 *    capability-gated host handlers, spawns a worker process, syncs job
 *    declarations, registers event subscriptions, and discovers tools.
 *
 * 4. **Shutdown** — `shutdownAll()` gracefully stops all active workers
 *    and unregisters runtime hooks.
 *
 * @see PLUGIN_SPEC.md §8 — Plugin Discovery
 * @see PLUGIN_SPEC.md §10 — Package Contract
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginLauncherDeclaration,
  PluginRecord,
  PluginUiSlotDeclaration,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager, WorkerStartOptions, WorkerToHostHandlers } from "./plugin-worker-manager.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Naming convention for npm-published Paperclip plugins.
 * Packages matching this pattern are considered Paperclip plugins.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export const NPM_PLUGIN_PACKAGE_PREFIX = "paperclip-plugin-";

/**
 * Default local plugin directory.  The loader scans this directory for
 * locally-installed plugin packages.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export const DEFAULT_LOCAL_PLUGIN_DIR = path.join(
  os.homedir(),
  ".paperclip",
  "plugins",
);

const DEV_TSX_LOADER_PATH = path.resolve(__dirname, "../../../cli/node_modules/tsx/dist/loader.mjs");

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

/**
 * A plugin package found during discovery from any source.
 */
export interface DiscoveredPlugin {
  /** Absolute path to the root of the npm package directory. */
  packagePath: string;
  /** The npm package name as declared in package.json. */
  packageName: string;
  /** Semver version from package.json. */
  version: string;
  /** Source that found this package. */
  source: PluginSource;
  /** The parsed and validated manifest if available, null if discovery-only. */
  manifest: PaperclipPluginManifestV1 | null;
}

/**
 * Sources from which plugins can be discovered.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export type PluginSource =
  | "local-filesystem"  // ~/.paperclip/plugins/ local directory
  | "npm"               // npm packages matching paperclip-plugin-* convention
  | "registry";         // future: remote plugin registry URL

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

/**
 * Result of a discovery scan.
 */
export interface PluginDiscoveryResult {
  /** Plugins successfully discovered and validated. */
  discovered: DiscoveredPlugin[];
  /** Packages found but with validation errors. */
  errors: Array<{ packagePath: string; packageName: string; error: string }>;
  /** Source(s) that were scanned. */
  sources: PluginSource[];
}

function getDeclaredPageRoutePaths(manifest: PaperclipPluginManifestV1): string[] {
  return (manifest.ui?.slots ?? [])
    .filter((slot): slot is PluginUiSlotDeclaration => slot.type === "page" && typeof slot.routePath === "string" && slot.routePath.length > 0)
    .map((slot) => slot.routePath!);
}

// ---------------------------------------------------------------------------
// Loader options
// ---------------------------------------------------------------------------

/**
 * Options for the plugin loader service.
 */
export interface PluginLoaderOptions {
  /**
   * Path to the local plugin directory to scan.
   * Defaults to ~/.paperclip/plugins/
   */
  localPluginDir?: string;

  /**
   * Whether to scan the local filesystem directory for plugins.
   * Defaults to true.
   */
  enableLocalFilesystem?: boolean;

  /**
   * Whether to discover installed npm packages matching the paperclip-plugin-*
   * naming convention.
   * Defaults to true.
   */
  enableNpmDiscovery?: boolean;

  /**
   * Future: URL of the remote plugin registry to query.
   * When set, the loader will also fetch available plugins from this endpoint.
   * Registry support is not yet implemented; this field is reserved.
   */
  registryUrl?: string;
}

// ---------------------------------------------------------------------------
// Install options
// ---------------------------------------------------------------------------

/**
 * Options for installing a single plugin package.
 */
export interface PluginInstallOptions {
  /**
   * npm package name to install (e.g. "paperclip-plugin-linear" or "@acme/plugin-linear").
   * Either packageName or localPath must be set.
   */
  packageName?: string;

  /**
   * Absolute or relative path to a local plugin directory for development installs.
   * When set, the plugin is loaded from this path without npm install.
   * Either packageName or localPath must be set.
   */
  localPath?: string;

  /**
   * Version specifier passed to npm install (e.g. "^1.2.0", "latest").
   * Ignored when localPath is set.
   */
  version?: string;

  /**
   * Plugin install directory where packages are managed.
   * Defaults to the localPluginDir configured on the service.
   */
  installDir?: string;
}

// ---------------------------------------------------------------------------
// Runtime options — services needed for initializing loaded plugins
// ---------------------------------------------------------------------------

/**
 * Runtime services passed to the loader for plugin initialization.
 *
 * When these are provided, the loader can fully activate plugins (spawn
 * workers, register event subscriptions, sync jobs, register tools).
 * When omitted, the loader operates in discovery/install-only mode.
 *
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export interface PluginRuntimeServices {
  /** Worker process manager for spawning and managing plugin workers. */
  workerManager: PluginWorkerManager;
  /** Event bus for registering plugin event subscriptions. */
  eventBus: PluginEventBus;
  /** Job scheduler for registering plugin cron jobs. */
  jobScheduler: PluginJobScheduler;
  /** Job store for syncing manifest job declarations to the DB. */
  jobStore: PluginJobStore;
  /** Tool dispatcher for registering plugin-contributed agent tools. */
  toolDispatcher: PluginToolDispatcher;
  /** Lifecycle manager for state transitions and worker lifecycle events. */
  lifecycleManager: PluginLifecycleManager;
  /**
   * Factory that creates worker-to-host RPC handlers for a given plugin.
   *
   * The returned handlers service worker→host calls (e.g. state.get,
   * events.emit, config.get). Each plugin gets its own set of handlers
   * scoped to its capabilities and plugin ID.
   */
  buildHostHandlers: (pluginId: string, manifest: PaperclipPluginManifestV1) => WorkerToHostHandlers;
  /**
   * Host instance information passed to the worker during initialization.
   * Includes the instance ID and host version.
   */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

/**
 * Result of activating (loading) a single plugin at runtime.
 *
 * Contains the plugin record, activation status, and any error that
 * occurred during the process.
 */
export interface PluginLoadResult {
  /** The plugin record from the database. */
  plugin: PluginRecord;
  /** Whether the plugin was successfully activated. */
  success: boolean;
  /** Error message if activation failed. */
  error?: string;
  /** Which subsystems were registered during activation. */
  registered: {
    /** True if the worker process was started. */
    worker: boolean;
    /** Number of event subscriptions registered (from manifest event declarations). */
    eventSubscriptions: number;
    /** Number of job declarations synced to the database. */
    jobs: number;
    /** Number of webhook endpoints declared in manifest. */
    webhooks: number;
    /** Number of agent tools registered. */
    tools: number;
  };
}

/**
 * Result of activating all ready plugins at server startup.
 */
export interface PluginLoadAllResult {
  /** Total number of plugins that were attempted. */
  total: number;
  /** Number of plugins successfully activated. */
  succeeded: number;
  /** Number of plugins that failed to activate. */
  failed: number;
  /** Per-plugin results. */
  results: PluginLoadResult[];
}

/**
 * Normalized UI contribution metadata extracted from a plugin manifest.
 *
 * The host serves all plugin UI bundles from the manifest's `entrypoints.ui`
 * directory and currently expects the bundle entry module to be `index.js`.
 */
export interface PluginUiContributionMetadata {
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PluginLoader {
  /**
   * Discover all available plugins from configured sources.
   *
   * This performs a non-destructive scan of all enabled sources and returns
   * the discovered plugins with their parsed manifests.  No installs or DB
   * writes happen during discovery.
   *
   * @param npmSearchDirs - Optional override for node_modules directories to search.
   *   Passed through to discoverFromNpm. When omitted the defaults are used.
   *
   * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Scan the local filesystem plugin directory for installed plugin packages.
   *
   * Reads the plugin directory, attempts to load each subdirectory as an npm
   * package, and validates the plugin manifest.
   *
   * @param dir - Directory to scan (defaults to configured localPluginDir).
   */
  discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult>;

  /**
   * Discover Paperclip plugins installed as npm packages in the current
   * Node.js environment matching the "paperclip-plugin-*" naming convention.
   *
   * Looks for packages in node_modules that match the naming convention.
   *
   * @param searchDirs - node_modules directories to search (defaults to process cwd resolution).
   */
  discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Load and parse the plugin manifest from a package directory.
   *
   * Reads the package.json, finds the manifest entrypoint declared under
   * the "paperclipPlugin.manifest" key, loads the manifest module, and
   * validates it against the plugin manifest schema.
   *
   * Returns null if the package is not a Paperclip plugin.
   * Throws if the package is a Paperclip plugin but the manifest is invalid.
   *
   * @see PLUGIN_SPEC.md §10 — Package Contract
   */
  loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null>;

  /**
   * Install a plugin package and register it in the database.
   *
   * Follows the install process described in PLUGIN_SPEC.md §8.3:
   * 1. Resolve npm package / local path.
   * 2. Install into the plugin directory (npm install).
   * 3. Read and validate plugin manifest.
   * 4. Reject incompatible plugin API versions.
   * 5. Validate manifest capabilities.
   * 6. Persist install record in Postgres.
   * 7. Return the discovered plugin for the caller to use.
   *
   * Worker spawning and lifecycle management are handled by the caller
   * (pluginLifecycleManager and the server startup orchestration).
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  installPlugin(options: PluginInstallOptions): Promise<DiscoveredPlugin>;

  /**
   * Upgrade an already-installed plugin to a newer version.
   *
   * Similar to installPlugin, but:
   * 1. Requires the plugin to already exist in the database.
   * 2. Uses the existing packageName if not provided in options.
   * 3. Updates the existing plugin record instead of creating a new one.
   * 4. Returns the old and new manifests for capability comparison.
   *
   * @see PLUGIN_SPEC.md §25.3 — Upgrade Lifecycle
   */
  upgradePlugin(pluginId: string, options: Omit<PluginInstallOptions, "installDir">): Promise<{
    oldManifest: PaperclipPluginManifestV1;
    newManifest: PaperclipPluginManifestV1;
    discovered: DiscoveredPlugin;
  }>;

  /**
   * Check whether a plugin API version is supported by this host.
   */
  isSupportedApiVersion(apiVersion: number): boolean;

  /**
   * Remove runtime-managed on-disk install artifacts for a plugin.
   *
   * This only cleans files under the managed local plugin directory. Local-path
   * source checkouts outside that directory are intentionally left alone.
   */
  cleanupInstallArtifacts(plugin: PluginRecord): Promise<void>;

  /**
   * Get the local plugin directory this loader is configured to use.
   */
  getLocalPluginDir(): string;

  // -----------------------------------------------------------------------
  // Runtime initialization (requires PluginRuntimeServices)
  // -----------------------------------------------------------------------

  /**
   * Load and activate all plugins that are in `ready` status.
   *
   * This is the main server-startup orchestration method. For each plugin
   * that is persisted as `ready`, it:
   * 1. Resolves the worker entrypoint from the manifest.
   * 2. Spawns the worker process via the worker manager.
   * 3. Syncs job declarations from the manifest to the `plugin_jobs` table.
   * 4. Registers the plugin with the job scheduler.
   * 5. Registers event subscriptions declared in the manifest (scoped via the event bus).
   * 6. Registers agent tools from the manifest via the tool dispatcher.
   *
   * Plugins that fail to activate are marked as `error` in the database.
   * Activation failures are non-fatal — other plugins continue loading.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   * Throws if runtime services are not available.
   *
   * @returns Aggregated results for all attempted plugin loads.
   *
   * @see PLUGIN_SPEC.md §8.4 — Server-Start Plugin Loading
   * @see PLUGIN_SPEC.md §12 — Process Model
   */
  loadAll(): Promise<PluginLoadAllResult>;

  /**
   * Activate a single plugin that is in `installed` or `ready` status.
   *
   * Used after a fresh install (POST /api/plugins/install) or after
   * enabling a previously disabled plugin. Performs the same subsystem
   * registration as `loadAll()` but for a single plugin.
   *
   * If the plugin is in `installed` status, transitions it to `ready`
   * via the lifecycle manager before spawning the worker.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to activate
   * @returns The activation result for this plugin
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  loadSingle(pluginId: string): Promise<PluginLoadResult>;

  /**
   * Deactivate a single plugin — stop its worker and unregister all
   * subsystem registrations (events, jobs, tools).
   *
   * Used during plugin disable, uninstall, and before upgrade. Does NOT
   * change the plugin's status in the database — that is the caller's
   * responsibility (via the lifecycle manager).
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to deactivate
   * @param pluginKey - The plugin key (manifest ID) for scoped cleanup
   *
   * @see PLUGIN_SPEC.md §8.5 — Uninstall Process
   */
  unloadSingle(pluginId: string, pluginKey: string): Promise<void>;

  /**
   * Stop all managed plugin workers. Called during server shutdown.
   *
   * Stops the job scheduler and then stops all workers via the worker
   * manager. Does NOT change plugin statuses in the database — plugins
   * remain in `ready` so they are restarted on next boot.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   */
  shutdownAll(): Promise<void>;

  /**
   * Whether runtime services are available for plugin activation.
   */
  hasRuntimeServices(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a package name matches the Paperclip plugin naming convention.
 * Accepts both the "paperclip-plugin-" prefix and scoped "@scope/plugin-" packages.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export function isPluginPackageName(name: string): boolean {
  if (name.startsWith(NPM_PLUGIN_PACKAGE_PREFIX)) return true;
  // Also accept scoped packages like @acme/plugin-linear or @paperclipai/plugin-*
  if (name.includes("/")) {
    const localPart = name.split("/")[1] ?? "";
    return localPart.startsWith("plugin-");
  }
  return false;
}

/**
 * Read and parse a package.json from a directory path.
 * Returns null if no package.json exists.
 */
async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown> | null> {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const raw = await readFile(pkgPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the manifest entrypoint from a package.json and package root.
 *
 * The spec defines a "paperclipPlugin" key in package.json with a "manifest"
 * subkey pointing to the manifest module.  This helper resolves the path.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveManifestPath(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const paperclipPlugin = pkgJson["paperclipPlugin"];
  if (
    paperclipPlugin !== null &&
    typeof paperclipPlugin === "object" &&
    !Array.isArray(paperclipPlugin)
  ) {
    const manifestRelPath = (paperclipPlugin as Record<string, unknown>)[
      "manifest"
    ];
    if (typeof manifestRelPath === "string") {
      // NOTE: the resolved path is returned as-is even if the file does not yet
      // exist on disk (e.g. the package has not been built).  Callers MUST guard
      // with existsSync() before passing the path to loadManifestFromPath().
      return path.resolve(packageRoot, manifestRelPath);
    }
  }

  // Fallback: look for dist/manifest.js as a convention
  const conventionalPath = path.join(packageRoot, "dist", "manifest.js");
  if (existsSync(conventionalPath)) {
    return conventionalPath;
  }

  // Fallback: look for manifest.js at package root
  const rootManifestPath = path.join(packageRoot, "manifest.js");
  if (existsSync(rootManifestPath)) {
    return rootManifestPath;
  }

  return null;
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);
  }

  const coreOrder = (
    ["major", "minor", "patch"] as const
  ).map((key) => leftParsed[key] - rightParsed[key]).find((delta) => delta !== 0);
  if (coreOrder) {
    return coreOrder;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftId = leftParsed.prerelease[index];
    const rightId = rightParsed.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const diff = compareIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}

function getMinimumHostVersion(manifest: PaperclipPluginManifestV1): string | undefined {
  return manifest.minimumHostVersion ?? manifest.minimumPaperclipVersion;
}

/**
 * Extract UI contribution metadata from a manifest for route serialization.
 *
 * Returns `null` when the plugin does not declare any UI slots or launchers.
 * Launcher declarations are aggregated from both the legacy top-level
 * `launchers` field and the preferred `ui.launchers` field.
 */
export function getPluginUiContributionMetadata(
  manifest: PaperclipPluginManifestV1,
): PluginUiContributionMetadata | null {
  const slots = manifest.ui?.slots ?? [];
  const launchers = [
    ...(manifest.launchers ?? []),
    ...(manifest.ui?.launchers ?? []),
  ];

  if (slots.length === 0 && launchers.length === 0) {
    return null;
  }

  return {
    uiEntryFile: "index.js",
    slots,
    launchers,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginLoader service.
 *
 * The loader is responsible for plugin discovery, installation, and runtime
 * activation.  It reads plugin packages from the local filesystem and npm,
 * validates their manifests, registers them in the database, and — when
 * runtime services are provided — initialises worker processes, event
 * subscriptions, job schedules, webhook endpoints, and agent tools.
 *
 * Usage (discovery & install only):
 * ```ts
 * const loader = pluginLoader(db, { enableLocalFilesystem: true });
 *
 * // Discover all available plugins
 * const result = await loader.discoverAll();
 * for (const plugin of result.discovered) {
 *   console.log(plugin.packageName, plugin.manifest?.id);
 * }
 *
 * // Install a specific plugin
 * const discovered = await loader.installPlugin({
 *   packageName: "paperclip-plugin-linear",
 *   version: "^1.0.0",
 * });
 * ```
 *
 * Usage (full runtime activation at server startup):
 * ```ts
 * const loader = pluginLoader(db, loaderOpts, {
 *   workerManager,
 *   eventBus,
 *   jobScheduler,
 *   jobStore,
 *   toolDispatcher,
 *   lifecycleManager,
 *   buildHostHandlers: (pluginId, manifest) => ({ ... }),
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 * });
 *
 * // Load all ready plugins at startup
 * const loadResult = await loader.loadAll();
 * console.log(`Loaded ${loadResult.succeeded}/${loadResult.total} plugins`);
 *
 * // Load a single plugin after install
 * const singleResult = await loader.loadSingle(pluginId);
 *
 * // Shutdown all plugin workers on server exit
 * await loader.shutdownAll();
 * ```
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLoader(
  db: Db,
  options: PluginLoaderOptions = {},
  runtimeServices?: PluginRuntimeServices,
): PluginLoader {
  const {
    localPluginDir = DEFAULT_LOCAL_PLUGIN_DIR,
    enableLocalFilesystem = true,
    enableNpmDiscovery = true,
  } = options;

  const registry = pluginRegistryService(db);
  const manifestValidator = pluginManifestValidator();
  const capabilityValidator = pluginCapabilityValidator();
  const log = logger.child({ service: "plugin-loader" });
  const hostVersion = runtimeServices?.instanceInfo.hostVersion;

  async function assertPageRoutePathsAvailable(manifest: PaperclipPluginManifestV1): Promise<void> {
    const requestedRoutePaths = getDeclaredPageRoutePaths(manifest);
    if (requestedRoutePaths.length === 0) return;

    const uniqueRequested = new Set(requestedRoutePaths);
    if (uniqueRequested.size !== requestedRoutePaths.length) {
      throw new Error(`Plugin ${manifest.id} declares duplicate page routePath values`);
    }

    const installedPlugins = await registry.listInstalled();
    for (const plugin of installedPlugins) {
      if (plugin.pluginKey === manifest.id) continue;
      const installedManifest = plugin.manifestJson as PaperclipPluginManifestV1 | null;
      if (!installedManifest) continue;
      const installedRoutePaths = new Set(getDeclaredPageRoutePaths(installedManifest));
      const conflictingRoute = requestedRoutePaths.find((routePath) => installedRoutePaths.has(routePath));
      if (conflictingRoute) {
        throw new Error(
          `Plugin ${manifest.id} routePath "${conflictingRoute}" conflicts with installed plugin ${plugin.pluginKey}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a plugin from npm or local path, then parse and validate its manifest.
   *
   * This internal helper encapsulates the core plugin retrieval and validation
   * logic used by both install and upgrade operations. It handles:
   * 1. Resolving the package from npm or local filesystem.
   * 2. Installing the package via npm if necessary.
   * 3. Reading and parsing the plugin manifest.
   * 4. Validating API version compatibility.
   * 5. Validating manifest capabilities.
   *
   * @param installOptions - Options specifying the package to fetch.
   * @returns A `DiscoveredPlugin` object containing the validated manifest.
   */
  async function fetchAndValidate(
    installOptions: PluginInstallOptions,
  ): Promise<DiscoveredPlugin> {
    const { packageName, localPath, version, installDir } = installOptions;

    if (!packageName && !localPath) {
      throw new Error("Either packageName or localPath must be provided");
    }

    const targetInstallDir = installDir ?? localPluginDir;

    // Step 1 & 2: Resolve and install package
    let resolvedPackagePath: string;
    let resolvedPackageName: string;

    if (localPath) {
      // Local path install — validate the directory exists
      const absLocalPath = path.resolve(localPath);
      if (!existsSync(absLocalPath)) {
        throw new Error(`Local plugin path does not exist: ${absLocalPath}`);
      }
      resolvedPackagePath = absLocalPath;
      const pkgJson = await readPackageJson(absLocalPath);
      resolvedPackageName =
        typeof pkgJson?.["name"] === "string"
          ? pkgJson["name"]
          : path.basename(absLocalPath);

      log.info(
        { localPath: absLocalPath, packageName: resolvedPackageName },
        "plugin-loader: fetching plugin from local path",
      );
    } else {
      // npm install
      const spec = version ? `${packageName}@${version}` : packageName!;

      log.info(
        { spec, installDir: targetInstallDir },
        "plugin-loader: fetching plugin from npm",
      );

      try {
        // Use execFile (not exec) to avoid shell injection from package name/version.
        // --ignore-scripts prevents preinstall/install/postinstall hooks from
        // executing arbitrary code on the host before manifest validation.
        await execFileAsync(
          "npm",
          ["install", spec, "--prefix", targetInstallDir, "--save", "--ignore-scripts"],
          { timeout: 120_000 }, // 2 minute timeout for npm install
        );
      } catch (err) {
        throw new Error(`npm install failed for ${spec}: ${String(err)}`);
      }

      // Resolve the package path after installation
      const nodeModulesPath = path.join(targetInstallDir, "node_modules");
      resolvedPackageName = packageName!;

      // Handle scoped packages
      if (resolvedPackageName.startsWith("@")) {
        const [scope, name] = resolvedPackageName.split("/");
        resolvedPackagePath = path.join(nodeModulesPath, scope!, name!);
      } else {
        resolvedPackagePath = path.join(nodeModulesPath, resolvedPackageName);
      }

      if (!existsSync(resolvedPackagePath)) {
        throw new Error(
          `Package directory not found after installation: ${resolvedPackagePath}`,
        );
      }
    }

    // Step 3: Read and validate plugin manifest
    // Note: this.loadManifest (used via current context)
    const pkgJson = await readPackageJson(resolvedPackagePath);
    if (!pkgJson) throw new Error(`Missing package.json at ${resolvedPackagePath}`);

    const manifestPath = resolveManifestPath(resolvedPackagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      throw new Error(
        `Package ${resolvedPackageName} at ${resolvedPackagePath} does not appear to be a Paperclip plugin (no manifest found).`,
      );
    }

    const manifest = await loadManifestFromPath(manifestPath);

    // Step 4: Reject incompatible plugin API versions
    if (!manifestValidator.getSupportedVersions().includes(manifest.apiVersion)) {
      throw new Error(
        `Plugin ${manifest.id} declares apiVersion ${manifest.apiVersion} which is not supported by this host. ` +
          `Supported versions: ${manifestValidator.getSupportedVersions().join(", ")}`,
      );
    }

    // Step 5: Validate manifest capabilities are consistent
    const capResult = capabilityValidator.validateManifestCapabilities(manifest);
    if (!capResult.allowed) {
      throw new Error(
        `Plugin ${manifest.id} manifest has inconsistent capabilities. ` +
          `Missing required capabilities for declared features: ${capResult.missing.join(", ")}`,
      );
    }

    await assertPageRoutePathsAvailable(manifest);

    // Step 6: Reject plugins that require a newer host than the running server
    const minimumHostVersion = getMinimumHostVersion(manifest);
    if (minimumHostVersion && hostVersion) {
      if (compareSemver(hostVersion, minimumHostVersion) < 0) {
        throw new Error(
          `Plugin ${manifest.id} requires host version ${minimumHostVersion} or newer, ` +
            `but this server is running ${hostVersion}`,
        );
      }
    }

    // Use the version declared in the manifest (required field per the spec)
    const resolvedVersion = manifest.version;

    return {
      packagePath: resolvedPackagePath,
      packageName: resolvedPackageName,
      version: resolvedVersion,
      source: localPath ? "local-filesystem" : "npm",
      manifest,
    };
  }

  /**
   * Attempt to load and validate a plugin manifest from a resolved path.
   * Returns the manifest on success or throws with a descriptive error.
   */
  async function loadManifestFromPath(
    manifestPath: string,
  ): Promise<PaperclipPluginManifestV1> {
    let raw: unknown;

    try {
      // Dynamic import works for both .js (ESM) and .cjs (CJS) manifests
      const mod = await import(manifestPath) as Record<string, unknown>;
      // The manifest may be the default export or the module itself
      raw = mod["default"] ?? mod;
    } catch (err) {
      throw new Error(
        `Failed to load manifest module at ${manifestPath}: ${String(err)}`,
      );
    }

    return manifestValidator.parseOrThrow(raw);
  }

  /**
   * Build a DiscoveredPlugin from a resolved package directory, or null
   * if the package is not a Paperclip plugin.
   */
  async function buildDiscoveredPlugin(
    packagePath: string,
    source: PluginSource,
  ): Promise<DiscoveredPlugin | null> {
    const pkgJson = await readPackageJson(packagePath);
    if (!pkgJson) return null;

    const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
    const version = typeof pkgJson["version"] === "string" ? pkgJson["version"] : "0.0.0";

    // Determine if this is a plugin package at all
    const hasPaperclipPlugin = "paperclipPlugin" in pkgJson;
    const nameMatchesConvention = isPluginPackageName(packageName);

    if (!hasPaperclipPlugin && !nameMatchesConvention) {
      return null;
    }

    const manifestPath = resolveManifestPath(packagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      // Found a potential plugin package but no manifest entry point — treat
      // as a discovery-only result with no manifest
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest: null,
      };
    }

    try {
      const manifest = await loadManifestFromPath(manifestPath);
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest,
      };
    } catch (err) {
      // Rethrow with context — callers catch and route to the errors array
      throw new Error(
        `Plugin ${packageName}: ${String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    // -----------------------------------------------------------------------
    // discoverAll
    // -----------------------------------------------------------------------

    async discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult> {
      const allDiscovered: DiscoveredPlugin[] = [];
      const allErrors: Array<{ packagePath: string; packageName: string; error: string }> = [];
      const sources: PluginSource[] = [];

      if (enableLocalFilesystem) {
        sources.push("local-filesystem");
        const fsResult = await this.discoverFromLocalFilesystem();
        allDiscovered.push(...fsResult.discovered);
        allErrors.push(...fsResult.errors);
      }

      if (enableNpmDiscovery) {
        sources.push("npm");
        const npmResult = await this.discoverFromNpm(npmSearchDirs);
        // Deduplicate against already-discovered packages (same package path)
        const existingPaths = new Set(allDiscovered.map((d) => d.packagePath));
        for (const plugin of npmResult.discovered) {
          if (!existingPaths.has(plugin.packagePath)) {
            allDiscovered.push(plugin);
          }
        }
        allErrors.push(...npmResult.errors);
      }

      // Future: registry source (options.registryUrl)
      if (options.registryUrl) {
        sources.push("registry");
        log.warn(
          { registryUrl: options.registryUrl },
          "plugin-loader: remote registry discovery is not yet implemented",
        );
      }

      log.info(
        {
          discovered: allDiscovered.length,
          errors: allErrors.length,
          sources,
        },
        "plugin-loader: discovery complete",
      );

      return { discovered: allDiscovered, errors: allErrors, sources };
    },

    // -----------------------------------------------------------------------
    // discoverFromLocalFilesystem
    // -----------------------------------------------------------------------

    async discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult> {
      const scanDir = dir ?? localPluginDir;
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      if (!existsSync(scanDir)) {
        log.debug(
          { dir: scanDir },
          "plugin-loader: local plugin directory does not exist, skipping",
        );
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      let entries: string[];
      try {
        entries = await readdir(scanDir);
      } catch (err) {
        log.warn({ dir: scanDir, err }, "plugin-loader: failed to read local plugin directory");
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      for (const entry of entries) {
        const entryPath = path.join(scanDir, entry);

        // Check if entry is a directory
        let entryStat;
        try {
          entryStat = await stat(entryPath);
        } catch {
          continue;
        }
        if (!entryStat.isDirectory()) continue;

        // Handle scoped packages: @scope/plugin-name is a subdirectory
        if (entry.startsWith("@")) {
          let scopedEntries: string[];
          try {
            scopedEntries = await readdir(entryPath);
          } catch {
            continue;
          }
          for (const scopedEntry of scopedEntries) {
            const scopedPath = path.join(entryPath, scopedEntry);
            try {
              const scopedStat = await stat(scopedPath);
              if (!scopedStat.isDirectory()) continue;
              const plugin = await buildDiscoveredPlugin(scopedPath, "local-filesystem");
              if (plugin) discovered.push(plugin);
            } catch (err) {
              errors.push({
                packagePath: scopedPath,
                packageName: `${entry}/${scopedEntry}`,
                error: String(err),
              });
            }
          }
          continue;
        }

        try {
          const plugin = await buildDiscoveredPlugin(entryPath, "local-filesystem");
          if (plugin) discovered.push(plugin);
        } catch (err) {
          const pkgJson = await readPackageJson(entryPath);
          const packageName =
            typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
          errors.push({ packagePath: entryPath, packageName, error: String(err) });
        }
      }

      log.debug(
        { dir: scanDir, discovered: discovered.length, errors: errors.length },
        "plugin-loader: local filesystem scan complete",
      );

      return { discovered, errors, sources: ["local-filesystem"] };
    },

    // -----------------------------------------------------------------------
    // discoverFromNpm
    // -----------------------------------------------------------------------

    async discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult> {
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      // Determine the node_modules directories to search.
      // When searchDirs is undefined OR empty, fall back to the conventional
      // defaults (cwd/node_modules and localPluginDir/node_modules).
      // To search nowhere explicitly, pass a non-empty array of non-existent paths.
      const dirsToSearch: string[] = searchDirs && searchDirs.length > 0 ? searchDirs : [];

      if (dirsToSearch.length === 0) {
        // Default: search node_modules relative to the process working directory
        // and also the local plugin dir's node_modules
        const cwdNodeModules = path.join(process.cwd(), "node_modules");
        const localNodeModules = path.join(localPluginDir, "node_modules");

        if (existsSync(cwdNodeModules)) dirsToSearch.push(cwdNodeModules);
        if (existsSync(localNodeModules)) dirsToSearch.push(localNodeModules);
      }

      for (const nodeModulesDir of dirsToSearch) {
        if (!existsSync(nodeModulesDir)) continue;

        let entries: string[];
        try {
          entries = await readdir(nodeModulesDir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          const entryPath = path.join(nodeModulesDir, entry);

          // Handle scoped packages (@scope/*)
          if (entry.startsWith("@")) {
            let scopedEntries: string[];
            try {
              scopedEntries = await readdir(entryPath);
            } catch {
              continue;
            }
            for (const scopedEntry of scopedEntries) {
              const fullName = `${entry}/${scopedEntry}`;
              if (!isPluginPackageName(fullName)) continue;

              const scopedPath = path.join(entryPath, scopedEntry);
              try {
                const plugin = await buildDiscoveredPlugin(scopedPath, "npm");
                if (plugin) discovered.push(plugin);
              } catch (err) {
                errors.push({
                  packagePath: scopedPath,
                  packageName: fullName,
                  error: String(err),
                });
              }
            }
            continue;
          }

          // Non-scoped packages: check naming convention
          if (!isPluginPackageName(entry)) continue;

          let entryStat;
          try {
            entryStat = await stat(entryPath);
          } catch {
            continue;
          }
          if (!entryStat.isDirectory()) continue;

          try {
            const plugin = await buildDiscoveredPlugin(entryPath, "npm");
            if (plugin) discovered.push(plugin);
          } catch (err) {
            const pkgJson = await readPackageJson(entryPath);
            const packageName =
              typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
            errors.push({ packagePath: entryPath, packageName, error: String(err) });
          }
        }
      }

      log.debug(
        { searchDirs: dirsToSearch, discovered: discovered.length, errors: errors.length },
        "plugin-loader: npm discovery scan complete",
      );

      return { discovered, errors, sources: ["npm"] };
    },

    // -----------------------------------------------------------------------
    // loadManifest
    // -----------------------------------------------------------------------

    async loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null> {
      const pkgJson = await readPackageJson(packagePath);
      if (!pkgJson) return null;

      const hasPaperclipPlugin = "paperclipPlugin" in pkgJson;
      const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
      const nameMatchesConvention = isPluginPackageName(packageName);

      if (!hasPaperclipPlugin && !nameMatchesConvention) {
        return null;
      }

      const manifestPath = resolveManifestPath(packagePath, pkgJson);
      if (!manifestPath || !existsSync(manifestPath)) return null;

      return loadManifestFromPath(manifestPath);
    },

    // -----------------------------------------------------------------------
    // installPlugin
    // -----------------------------------------------------------------------

    async installPlugin(installOptions: PluginInstallOptions): Promise<DiscoveredPlugin> {
      const discovered = await fetchAndValidate(installOptions);

      // Step 6: Persist install record in Postgres (include packagePath for local installs so the worker can be resolved)
      await registry.install(
        {
          packageName: discovered.packageName,
          packagePath: discovered.source === "local-filesystem" ? discovered.packagePath : undefined,
        },
        discovered.manifest!,
      );

      log.info(
        {
          pluginId: discovered.manifest!.id,
          packageName: discovered.packageName,
          version: discovered.version,
          capabilities: discovered.manifest!.capabilities,
        },
        "plugin-loader: plugin installed successfully",
      );

      return discovered;
    },

    // -----------------------------------------------------------------------
    // upgradePlugin
    // -----------------------------------------------------------------------

    /**
     * Upgrade an already-installed plugin to a newer version.
     *
     * This method:
     * 1. Fetches and validates the new plugin package using `fetchAndValidate`.
     * 2. Ensures the new manifest ID matches the existing plugin ID for safety.
     * 3. Updates the plugin record in the registry with the new version and manifest.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param upgradeOptions - Options for the upgrade (packageName, localPath, version).
     * @returns The old and new manifests, along with the discovery metadata.
     * @throws {Error} If the plugin is not found or if the new manifest ID differs.
     */
    async upgradePlugin(
      pluginId: string,
      upgradeOptions: Omit<PluginInstallOptions, "installDir">,
    ): Promise<{
      oldManifest: PaperclipPluginManifestV1;
      newManifest: PaperclipPluginManifestV1;
      discovered: DiscoveredPlugin;
    }> {
      const plugin = (await registry.getById(pluginId)) as {
        id: string;
        packageName: string;
        packagePath: string | null;
        manifestJson: PaperclipPluginManifestV1;
      } | null;
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

      const oldManifest = plugin.manifestJson;
      const {
        packageName = plugin.packageName,
        // For local-path installs, fall back to the stored packagePath so
        // `upgradePlugin` can re-read the manifest from disk without needing
        // the caller to re-supply the path every time.
        localPath = plugin.packagePath ?? undefined,
        version,
      } = upgradeOptions;

      log.info(
        { pluginId, packageName, version, localPath },
        "plugin-loader: upgrading plugin",
      );

      // 1. Fetch/Install the new version
      const discovered = await fetchAndValidate({
        packageName,
        localPath,
        version,
        installDir: localPluginDir,
      });

      const newManifest = discovered.manifest!;

      // 2. Validate it's the same plugin ID
      if (newManifest.id !== oldManifest.id) {
        throw new Error(
          `Upgrade failed: new manifest ID '${newManifest.id}' does not match existing plugin ID '${oldManifest.id}'`,
        );
      }

      // 3. Detect capability escalation — new capabilities not in the old manifest
      const oldCaps = new Set(oldManifest.capabilities ?? []);
      const newCaps = newManifest.capabilities ?? [];
      const escalated = newCaps.filter((c) => !oldCaps.has(c));

      if (escalated.length > 0) {
        log.warn(
          { pluginId, escalated, oldVersion: oldManifest.version, newVersion: newManifest.version },
          "plugin-loader: upgrade introduces new capabilities — requires admin approval",
        );
        throw new Error(
          `Upgrade for "${pluginId}" introduces new capabilities that require approval: ${escalated.join(", ")}. ` +
            `The previous version declared [${[...oldCaps].join(", ")}]. ` +
            `Please review and approve the capability escalation before upgrading.`,
        );
      }

      // 4. Update the existing record
      await registry.update(pluginId, {
        packageName: discovered.packageName,
        version: discovered.version,
        manifest: newManifest,
      });

      return {
        oldManifest,
        newManifest,
        discovered,
      };
    },

    // -----------------------------------------------------------------------
    // isSupportedApiVersion
    // -----------------------------------------------------------------------

    isSupportedApiVersion(apiVersion: number): boolean {
      return manifestValidator.getSupportedVersions().includes(apiVersion);
    },

    // -----------------------------------------------------------------------
    // cleanupInstallArtifacts
    // -----------------------------------------------------------------------

    async cleanupInstallArtifacts(plugin: PluginRecord): Promise<void> {
      const managedTargets = new Set<string>();
      const managedNodeModulesDir = resolveManagedInstallPackageDir(localPluginDir, plugin.packageName);
      const directManagedDir = path.join(localPluginDir, plugin.packageName);

      managedTargets.add(managedNodeModulesDir);
      if (isPathInsideDir(directManagedDir, localPluginDir)) {
        managedTargets.add(directManagedDir);
      }
      if (plugin.packagePath && isPathInsideDir(plugin.packagePath, localPluginDir)) {
        managedTargets.add(path.resolve(plugin.packagePath));
      }

      const packageJsonPath = path.join(localPluginDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          await execFileAsync(
            "npm",
            ["uninstall", plugin.packageName, "--prefix", localPluginDir, "--ignore-scripts"],
            { timeout: 120_000 },
          );
        } catch (err) {
          log.warn(
            {
              pluginId: plugin.id,
              pluginKey: plugin.pluginKey,
              packageName: plugin.packageName,
              err: err instanceof Error ? err.message : String(err),
            },
            "plugin-loader: npm uninstall failed during cleanup, falling back to direct removal",
          );
        }
      }

      for (const target of managedTargets) {
        if (!existsSync(target)) continue;
        await rm(target, { recursive: true, force: true });
      }
    },

    // -----------------------------------------------------------------------
    // getLocalPluginDir
    // -----------------------------------------------------------------------

    getLocalPluginDir(): string {
      return localPluginDir;
    },

    // -----------------------------------------------------------------------
    // hasRuntimeServices
    // -----------------------------------------------------------------------

    hasRuntimeServices(): boolean {
      return runtimeServices !== undefined;
    },

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // loadAll
    // -----------------------------------------------------------------------

    /**
     * loadAll — Loads and activates all plugins that are currently in 'ready' status.
     *
     * This method is typically called during server startup. It fetches all ready
     * plugins from the registry and attempts to activate them in parallel using
     * Promise.allSettled. Failures in individual plugins do not prevent others from loading.
     *
     * @returns A promise that resolves with summary statistics of the load operation.
     */
    async loadAll(): Promise<PluginLoadAllResult> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadAll: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      log.info("plugin-loader: loading all ready plugins");

      // Fetch all plugins in ready status, ordered by installOrder
      const readyPlugins = (await registry.listByStatus("ready")) as PluginRecord[];

      if (readyPlugins.length === 0) {
        log.info("plugin-loader: no ready plugins to load");
        return { total: 0, succeeded: 0, failed: 0, results: [] };
      }

      log.info(
        { count: readyPlugins.length },
        "plugin-loader: found ready plugins to load",
      );

      // Load plugins in parallel
      const results = await Promise.allSettled(
        readyPlugins.map((plugin) => activatePlugin(plugin))
      );

      const loadResults = results.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return {
          plugin: readyPlugins[i]!,
          success: false,
          error: String(r.reason),
          registered: { worker: false, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      });

      const succeeded = loadResults.filter((r) => r.success).length;
      const failed = loadResults.filter((r) => !r.success).length;

      log.info(
        {
          total: readyPlugins.length,
          succeeded,
          failed,
        },
        "plugin-loader: loadAll complete",
      );

      return {
        total: readyPlugins.length,
        succeeded,
        failed,
        results: loadResults,
      };
    },

    // -----------------------------------------------------------------------
    // loadSingle
    // -----------------------------------------------------------------------

    /**
     * loadSingle — Loads and activates a single plugin by its ID.
     *
     * This method retrieves the plugin from the registry, ensures it's in a valid
     * state, and then calls activatePlugin to start its worker and register its
     * capabilities (tools, jobs, etc.).
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns A promise that resolves with the result of the activation.
     */
    async loadSingle(pluginId: string): Promise<PluginLoadResult> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadSingle: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      const plugin = (await registry.getById(pluginId)) as PluginRecord | null;
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }

      // If the plugin is in 'installed' status, transition it to 'ready' first.
      // lifecycleManager.load() transitions the status AND activates the plugin
      // via activateReadyPlugin() → loadSingle() (recursive call with 'ready'
      // status) → activatePlugin(). We must NOT call activatePlugin() again here,
      // as that would double-start the worker and duplicate registrations.
      if (plugin.status === "installed") {
        await runtimeServices.lifecycleManager.load(pluginId);
        const updated = (await registry.getById(pluginId)) as PluginRecord | null;
        if (!updated) throw new Error(`Plugin not found after status update: ${pluginId}`);
        return {
          plugin: updated,
          success: true,
          registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      }

      if (plugin.status !== "ready") {
        throw new Error(
          `Cannot load plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'installed' or 'ready' status.`,
        );
      }

      return activatePlugin(plugin);
    },

    // -----------------------------------------------------------------------
    // unloadSingle
    // -----------------------------------------------------------------------

    async unloadSingle(pluginId: string, pluginKey: string): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot unloadSingle: no PluginRuntimeServices provided.",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: unloading single plugin",
      );

      const {
        workerManager,
        eventBus,
        jobScheduler,
        toolDispatcher,
      } = runtimeServices;

      // 1. Unregister from job scheduler (cancels in-flight runs)
      try {
        await jobScheduler.unregisterPlugin(pluginId);
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to unregister from job scheduler (best-effort)",
        );
      }

      // 2. Clear event subscriptions
      eventBus.clearPlugin(pluginKey);

      // 3. Unregister agent tools
      toolDispatcher.unregisterPluginTools(pluginKey);

      // 4. Stop the worker process
      try {
        if (workerManager.isRunning(pluginId)) {
          await workerManager.stopWorker(pluginId);
        }
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to stop worker during unload (best-effort)",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: plugin unloaded successfully",
      );
    },

    // -----------------------------------------------------------------------
    // shutdownAll
    // -----------------------------------------------------------------------

    async shutdownAll(): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot shutdownAll: no PluginRuntimeServices provided.",
        );
      }

      log.info("plugin-loader: shutting down all plugins");

      const { workerManager, jobScheduler } = runtimeServices;

      // 1. Stop the job scheduler tick loop
      jobScheduler.stop();

      // 2. Stop all worker processes
      await workerManager.stopAll();

      log.info("plugin-loader: all plugins shut down");
    },
  };

  // -------------------------------------------------------------------------
  // Internal: activatePlugin — shared logic for loadAll and loadSingle
  // -------------------------------------------------------------------------

  /**
   * Activate a single plugin: spawn its worker, register event subscriptions,
   * sync jobs, register tools.
   *
   * This is the core orchestration logic shared by `loadAll()` and `loadSingle()`.
   * Failures are caught and reported in the result; the plugin is marked as
   * `error` in the database when activation fails.
   */
  async function activatePlugin(plugin: PluginRecord): Promise<PluginLoadResult> {
    const manifest = plugin.manifestJson;
    const pluginId = plugin.id;
    const pluginKey = plugin.pluginKey;

    const registered: PluginLoadResult["registered"] = {
      worker: false,
      eventSubscriptions: 0,
      jobs: 0,
      webhooks: 0,
      tools: 0,
    };

    // Guard: runtime services must exist (callers already checked)
    if (!runtimeServices) {
      return {
        plugin,
        success: false,
        error: "No runtime services available",
        registered,
      };
    }

    const {
      workerManager,
      eventBus,
      jobScheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager,
      buildHostHandlers,
      instanceInfo,
    } = runtimeServices;

    try {
      log.info(
        { pluginId, pluginKey, version: plugin.version },
        "plugin-loader: activating plugin",
      );

      // ------------------------------------------------------------------
      // 1. Resolve worker entrypoint
      // ------------------------------------------------------------------
      const workerEntrypoint = resolveWorkerEntrypoint(plugin, localPluginDir);

      // ------------------------------------------------------------------
      // 2. Build host handlers for this plugin
      // ------------------------------------------------------------------
      const hostHandlers = buildHostHandlers(pluginId, manifest);

      // ------------------------------------------------------------------
      // 3. Retrieve plugin config (if any)
      // ------------------------------------------------------------------
      let config: Record<string, unknown> = {};
      try {
        const configRow = await registry.getConfig(pluginId);
        if (configRow && typeof configRow === "object" && "configJson" in configRow) {
          config = (configRow as { configJson: Record<string, unknown> }).configJson ?? {};
        }
      } catch {
        // Config may not exist yet — use empty object
        log.debug({ pluginId }, "plugin-loader: no config found, using empty config");
      }

      // ------------------------------------------------------------------
      // 4. Spawn worker process
      // ------------------------------------------------------------------
      const workerOptions: WorkerStartOptions = {
        entrypointPath: workerEntrypoint,
        manifest,
        config,
        instanceInfo,
        apiVersion: manifest.apiVersion,
        hostHandlers,
        autoRestart: true,
      };

      // Repo-local plugin installs can resolve workspace TS sources at runtime
      // (for example @paperclipai/shared exports). Run those workers through
      // the tsx loader so first-party example plugins work in development.
      if (plugin.packagePath && existsSync(DEV_TSX_LOADER_PATH)) {
        workerOptions.execArgv = ["--import", DEV_TSX_LOADER_PATH];
      }

      await workerManager.startWorker(pluginId, workerOptions);
      registered.worker = true;

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: worker started",
      );

      // ------------------------------------------------------------------
      // 5. Sync job declarations and register with scheduler
      // ------------------------------------------------------------------
      const jobDeclarations = manifest.jobs ?? [];
      if (jobDeclarations.length > 0) {
        await jobStore.syncJobDeclarations(pluginId, jobDeclarations);
        await jobScheduler.registerPlugin(pluginId);
        registered.jobs = jobDeclarations.length;

        log.info(
          { pluginId, pluginKey, jobs: jobDeclarations.length },
          "plugin-loader: job declarations synced and plugin registered with scheduler",
        );
      }

      // ------------------------------------------------------------------
      // 6. Register event subscriptions
      //
      // Note: Event subscriptions are declared at runtime by the plugin
      // worker via the SDK's ctx.events.on() calls. The event bus manages
      // per-plugin subscription scoping. Here we ensure the event bus has
      // a scoped handle ready for this plugin — the actual subscriptions
      // are registered by the host handler layer when the worker calls
      // events.subscribe via RPC.
      //
      // The bus.forPlugin() call creates the scoped handle if needed;
      // any previous subscriptions for this plugin are preserved if the
      // worker is restarting.
      // ------------------------------------------------------------------
      const _scopedBus = eventBus.forPlugin(pluginKey);
      registered.eventSubscriptions = eventBus.subscriptionCount(pluginKey);

      log.debug(
        { pluginId, pluginKey },
        "plugin-loader: event bus scoped handle ready",
      );

      // ------------------------------------------------------------------
      // 7. Register webhook endpoints (manifest-declared)
      //
      // Webhooks are statically declared in the manifest. The actual
      // endpoint routing is handled by the plugin routes module which
      // checks the manifest for declared webhooks. No explicit
      // registration step is needed here — the manifest is persisted
      // in the DB and the route handler reads it at request time.
      //
      // We track the count for the result reporting.
      // ------------------------------------------------------------------
      const webhookDeclarations = manifest.webhooks ?? [];
      registered.webhooks = webhookDeclarations.length;

      if (webhookDeclarations.length > 0) {
        log.info(
          { pluginId, pluginKey, webhooks: webhookDeclarations.length },
          "plugin-loader: webhook endpoints declared in manifest",
        );
      }

      // ------------------------------------------------------------------
      // 8. Register agent tools
      // ------------------------------------------------------------------
      const toolDeclarations = manifest.tools ?? [];
      if (toolDeclarations.length > 0) {
        toolDispatcher.registerPluginTools(pluginKey, manifest);
        registered.tools = toolDeclarations.length;

        log.info(
          { pluginId, pluginKey, tools: toolDeclarations.length },
          "plugin-loader: agent tools registered",
        );
      }

      // ------------------------------------------------------------------
      // Done — plugin fully activated
      // ------------------------------------------------------------------
      log.info(
        {
          pluginId,
          pluginKey,
          version: plugin.version,
          registered,
        },
        "plugin-loader: plugin activated successfully",
      );

      return { plugin, success: true, registered };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error(
        { pluginId, pluginKey, err: errorMessage },
        "plugin-loader: failed to activate plugin",
      );

      // Mark the plugin as errored in the database so it is not retried
      // automatically on next startup without operator intervention.
      try {
        await lifecycleManager.markError(pluginId, `Activation failed: ${errorMessage}`);
      } catch (markErr) {
        log.error(
          {
            pluginId,
            err: markErr instanceof Error ? markErr.message : String(markErr),
          },
          "plugin-loader: failed to mark plugin as error after activation failure",
        );
      }

      return {
        plugin,
        success: false,
        error: errorMessage,
        registered,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a plugin's worker entrypoint from its manifest
 * and known install locations.
 *
 * The manifest `entrypoints.worker` field is relative to the package root.
 * We check the local plugin directory (where the package was installed) and
 * also the package directory if it was a local-path install.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveWorkerEntrypoint(
  plugin: PluginRecord & { packagePath?: string | null },
  localPluginDir: string,
): string {
  const manifest = plugin.manifestJson;
  const workerRelPath = manifest.entrypoints.worker;

  // For local-path installs we persist the resolved package path; use it first
  if (plugin.packagePath && existsSync(plugin.packagePath)) {
    const entrypoint = path.resolve(plugin.packagePath, workerRelPath);
    if (entrypoint.startsWith(path.resolve(plugin.packagePath)) && existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  // Try the local plugin directory (standard npm install location)
  const packageName = plugin.packageName;
  let packageDir: string;

  if (packageName.startsWith("@")) {
    // Scoped package: @scope/plugin-name → localPluginDir/node_modules/@scope/plugin-name
    const [scope, name] = packageName.split("/");
    packageDir = path.join(localPluginDir, "node_modules", scope!, name!);
  } else {
    packageDir = path.join(localPluginDir, "node_modules", packageName);
  }

  // Also check if the package exists directly under localPluginDir
  // (for direct local-path installs or symlinked packages)
  const directDir = path.join(localPluginDir, packageName);

  // Try in order: node_modules path, direct path
  for (const dir of [packageDir, directDir]) {
    const entrypoint = path.resolve(dir, workerRelPath);

    // Security: ensure entrypoint is actually inside the directory (prevent path traversal)
    if (!entrypoint.startsWith(path.resolve(dir))) {
      continue;
    }

    if (existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  // Fallback: try the worker path as-is (absolute or relative to cwd)
  // ONLY if it's already an absolute path and we trust the manifest (which we've already validated)
  if (path.isAbsolute(workerRelPath) && existsSync(workerRelPath)) {
    return workerRelPath;
  }

  throw new Error(
    `Worker entrypoint not found for plugin "${plugin.pluginKey}". ` +
      `Checked: ${path.resolve(packageDir, workerRelPath)}, ` +
      `${path.resolve(directDir, workerRelPath)}`,
  );
}

function resolveManagedInstallPackageDir(localPluginDir: string, packageName: string): string {
  if (packageName.startsWith("@")) {
    return path.join(localPluginDir, "node_modules", ...packageName.split("/"));
  }
  return path.join(localPluginDir, "node_modules", packageName);
}

function isPathInsideDir(candidatePath: string, parentDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentDir);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
