import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginRepositoryProviderDeclaration,
} from "@paperclipai/shared";
import { normalizeRepositoryProviderHost, normalizeRepositoryProviderKey } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { PluginLifecycleManager } from "../plugin-lifecycle.js";
import { pluginRegistryService } from "../plugin-registry.js";
import { repositoryProviderRegistry } from "../repository-connections.js";
import {
  createPluginRepositoryProviderConnector,
  missingRepositoryProviderMethods,
  type RepositoryProviderWorkerHost,
} from "./plugin-connector.js";
import { listAvailableRepositoryProviders, type RepositoryProviderAvailability } from "./registry.js";

/**
 * Binds plugin-contributed repository providers to the plugin lifecycle.
 *
 * This is the deny-by-default gate for the whole seam. A connector is
 * registered only when *all* of the following hold, and it is torn down the
 * moment any of them stops holding:
 *
 * 1. the plugin is `ready` (installed, enabled, not errored);
 * 2. its manifest declares `repository.providers.register`;
 * 3. its manifest declares the exact provider + host identity;
 * 4. its worker process is running.
 *
 * Nothing here trusts the plugin to deregister itself: every registration is
 * tagged `plugin:<pluginId>` and the lifecycle handlers drop the whole tag on
 * stop, disable, and unload. A crashed worker therefore stops being an
 * available provider rather than lingering as a connector that always throws.
 */

/** The plugin facts registration depends on. Kept narrow so tests can fake it. */
export interface RepositoryProviderPluginRecord {
  id: string;
  pluginKey: string;
  status: string;
  manifestJson: PaperclipPluginManifestV1;
}

export interface RepositoryProviderPluginSource {
  getById(pluginId: string): Promise<RepositoryProviderPluginRecord | null>;
  listReady(): Promise<RepositoryProviderPluginRecord[]>;
}

export interface PluginRepositoryProviderRegistrarOptions {
  /** Database used to build the default plugin source. Required unless `plugins` is given. */
  db?: Db;
  lifecycle: Pick<PluginLifecycleManager, "on" | "off">;
  workerManager: RepositoryProviderWorkerHost;
  plugins?: RepositoryProviderPluginSource;
  registry?: Pick<
    typeof repositoryProviderRegistry,
    "register" | "unregisterOwner" | "list"
  >;
}

function databasePluginSource(db: Db): RepositoryProviderPluginSource {
  const registry = pluginRegistryService(db);
  return {
    getById: (pluginId) => registry.getById(pluginId) as Promise<RepositoryProviderPluginRecord | null>,
    listReady: () => registry.listByStatus("ready") as Promise<RepositoryProviderPluginRecord[]>,
  };
}

export interface PluginRepositoryProviderRegistrar {
  /** Wire lifecycle listeners and register providers for already-ready plugins. */
  start(): Promise<void>;
  /** Re-evaluate one plugin (register or tear down as its state dictates). */
  syncPlugin(pluginId: string): Promise<number>;
  /** Drop every registration owned by a plugin. Returns how many were removed. */
  unregisterPlugin(pluginId: string): number;
  /** Providers a company may currently connect, for core UI capability display. */
  listAvailableProviders(companyId: string): RepositoryProviderAvailability[];
  /** Remove lifecycle listeners and every registration this registrar made. */
  stop(): void;
}

export function pluginRepositoryProviderOwnerKey(pluginId: string) {
  return `plugin:${pluginId}`;
}

/**
 * Declarations a plugin is allowed to serve, after capability and shape checks.
 * Returns an empty list — never a partial one — when the plugin is not
 * authorized, so a missing capability can never register "just the safe parts".
 */
export function authorizedRepositoryProviderDeclarations(
  manifest: PaperclipPluginManifestV1 | null | undefined,
): PluginRepositoryProviderDeclaration[] {
  if (!manifest) return [];
  if (!manifest.capabilities?.includes("repository.providers.register")) return [];
  const declarations = manifest.repositoryProviders ?? [];
  if (declarations.length === 0) return [];

  const seen = new Set<string>();
  const authorized: PluginRepositoryProviderDeclaration[] = [];
  for (const declaration of declarations) {
    const provider = normalizeRepositoryProviderKey(declaration?.providerKey);
    const host = normalizeRepositoryProviderHost(declaration?.host);
    // A wildcard host would let one extension answer for every enterprise
    // install, including hosts core already serves. Identity must be concrete.
    if (!provider || !host || host === "*") continue;
    const identity = `${provider}@${host}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    authorized.push({ ...declaration, providerKey: provider, host });
  }
  return authorized;
}

export function createPluginRepositoryProviderRegistrar(
  options: PluginRepositoryProviderRegistrarOptions,
): PluginRepositoryProviderRegistrar {
  const log = logger.child({ service: "repository-provider-registrar" });
  const registry = options.registry ?? repositoryProviderRegistry;
  if (!options.plugins && !options.db) {
    throw new Error("createPluginRepositoryProviderRegistrar requires either a db or a plugin source");
  }
  const plugins = options.plugins ?? databasePluginSource(options.db!);
  const ownedIdentities = new Map<string, string[]>();

  function unregisterPlugin(pluginId: string): number {
    const removed = registry.unregisterOwner(pluginRepositoryProviderOwnerKey(pluginId));
    ownedIdentities.delete(pluginId);
    return removed;
  }

  async function syncPlugin(pluginId: string): Promise<number> {
    // Always tear down first: re-registering after a config change or worker
    // restart must not leave a stale connector bound to a dead worker.
    unregisterPlugin(pluginId);

    const plugin = await plugins.getById(pluginId);
    if (!plugin || plugin.status !== "ready") return 0;
    if (!options.workerManager.isRunning(pluginId)) return 0;

    const declarations = authorizedRepositoryProviderDeclarations(plugin.manifestJson);
    if (declarations.length === 0) return 0;

    const missingMethods = missingRepositoryProviderMethods(options.workerManager, pluginId);
    if (missingMethods.length > 0) {
      log.warn(
        { pluginId, pluginKey: plugin.pluginKey, missingMethods },
        "repository provider registration refused: worker does not implement the full connector",
      );
      return 0;
    }

    const ownerKey = pluginRepositoryProviderOwnerKey(pluginId);
    const identities: string[] = [];
    for (const declaration of declarations) {
      const identity = `${declaration.providerKey}@${declaration.host}`;
      try {
        const connector = createPluginRepositoryProviderConnector({
          pluginId,
          pluginKey: plugin.pluginKey,
          declaration,
          workerManager: options.workerManager,
        });
        registry.register(connector, {
          host: declaration.host,
          ownerKey,
          descriptor: {
            displayName: declaration.displayName,
            description: declaration.description ?? null,
            source: "plugin",
            pluginKey: plugin.pluginKey,
            supportsDiscovery: declaration.supportsDiscovery !== false,
            supportsCloneCredentials: declaration.supportsCloneCredentials !== false,
            documentationUrl: declaration.documentationUrl ?? null,
          },
        });
        identities.push(identity);
      } catch (err) {
        // A rejected identity (bad host, already owned by core) must not stop
        // the plugin's other declarations, and must not be silently invisible.
        log.warn({ err, pluginId, pluginKey: plugin.pluginKey, identity }, "repository provider registration refused");
      }
    }
    ownedIdentities.set(pluginId, identities);
    if (identities.length > 0) {
      log.info({ pluginId, pluginKey: plugin.pluginKey, identities }, "registered plugin repository providers");
    }
    return identities.length;
  }

  const onWorkerStarted = ({ pluginId }: { pluginId: string }) => {
    void syncPlugin(pluginId).catch((err) => {
      log.error({ err, pluginId }, "failed to register plugin repository providers");
    });
  };
  const onTeardown = ({ pluginId }: { pluginId: string }) => {
    const removed = unregisterPlugin(pluginId);
    if (removed > 0) log.info({ pluginId, removed }, "unregistered plugin repository providers");
  };

  return {
    async start() {
      options.lifecycle.on("plugin.worker_started", onWorkerStarted);
      options.lifecycle.on("plugin.enabled", onWorkerStarted);
      options.lifecycle.on("plugin.worker_stopped", onTeardown);
      options.lifecycle.on("plugin.disabled", onTeardown);
      options.lifecycle.on("plugin.unloaded", onTeardown);
      options.lifecycle.on("plugin.error", onTeardown);

      // Catch plugins whose workers started before this registrar was wired.
      for (const plugin of await plugins.listReady()) {
        await syncPlugin(plugin.id);
      }
    },

    syncPlugin,
    unregisterPlugin,

    listAvailableProviders(companyId: string) {
      return listAvailableRepositoryProviders(companyId, registry);
    },

    stop() {
      options.lifecycle.off("plugin.worker_started", onWorkerStarted);
      options.lifecycle.off("plugin.enabled", onWorkerStarted);
      options.lifecycle.off("plugin.worker_stopped", onTeardown);
      options.lifecycle.off("plugin.disabled", onTeardown);
      options.lifecycle.off("plugin.unloaded", onTeardown);
      options.lifecycle.off("plugin.error", onTeardown);
      for (const pluginId of [...ownedIdentities.keys()]) {
        unregisterPlugin(pluginId);
      }
    },
  };
}
