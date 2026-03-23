/**
 * PluginJobCoordinator — bridges the plugin lifecycle manager with the
 * job scheduler and job store.
 *
 * This service listens to lifecycle events and performs the corresponding
 * scheduler and job store operations:
 *
 * - **plugin.loaded** → sync job declarations from manifest, then register
 *   the plugin with the scheduler (computes `nextRunAt` for active jobs).
 *
 * - **plugin.disabled / plugin.unloaded** → unregister the plugin from the
 *   scheduler (cancels in-flight runs, clears tracking state).
 *
 * ## Why a separate coordinator?
 *
 * The lifecycle manager, scheduler, and job store are independent services
 * with clean single-responsibility boundaries. The coordinator provides
 * the "glue" between them without adding coupling. This pattern is used
 * throughout Paperclip (e.g. heartbeat service coordinates timers + runs).
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-scheduler.ts — Scheduler service
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./plugin-lifecycle.ts — Plugin state machine
 */

import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobCoordinator.
 */
export interface PluginJobCoordinatorOptions {
  /** Drizzle database instance. */
  db: Db;
  /** The plugin lifecycle manager to listen to. */
  lifecycle: PluginLifecycleManager;
  /** The job scheduler to register/unregister plugins with. */
  scheduler: PluginJobScheduler;
  /** The job store for syncing declarations. */
  jobStore: PluginJobStore;
}

/**
 * The public interface of the job coordinator.
 */
export interface PluginJobCoordinator {
  /**
   * Start listening to lifecycle events.
   *
   * This wires up the `plugin.loaded`, `plugin.disabled`, and
   * `plugin.unloaded` event handlers.
   */
  start(): void;

  /**
   * Stop listening to lifecycle events.
   *
   * Removes all event subscriptions added by `start()`.
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a PluginJobCoordinator.
 *
 * @example
 * ```ts
 * const coordinator = createPluginJobCoordinator({
 *   db,
 *   lifecycle,
 *   scheduler,
 *   jobStore,
 * });
 *
 * // Start listening to lifecycle events
 * coordinator.start();
 *
 * // On server shutdown
 * coordinator.stop();
 * ```
 */
export function createPluginJobCoordinator(
  options: PluginJobCoordinatorOptions,
): PluginJobCoordinator {
  const { db, lifecycle, scheduler, jobStore } = options;
  const log = logger.child({ service: "plugin-job-coordinator" });
  const registry = pluginRegistryService(db);

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  /**
   * When a plugin is loaded (transitions to `ready`):
   * 1. Look up the manifest from the registry
   * 2. Sync job declarations from the manifest into the DB
   * 3. Register the plugin with the scheduler (computes nextRunAt)
   */
  async function onPluginLoaded(payload: { pluginId: string; pluginKey: string }): Promise<void> {
    const { pluginId, pluginKey } = payload;
    log.info({ pluginId, pluginKey }, "plugin loaded — syncing jobs and registering with scheduler");

    try {
      // Get the manifest from the registry
      const plugin = await registry.getById(pluginId);
      if (!plugin?.manifestJson) {
        log.warn({ pluginId, pluginKey }, "plugin loaded but no manifest found — skipping job sync");
        return;
      }

      // Sync job declarations from the manifest
      const manifest = plugin.manifestJson;
      const jobDeclarations = manifest.jobs ?? [];

      if (jobDeclarations.length > 0) {
        log.info(
          { pluginId, pluginKey, jobCount: jobDeclarations.length },
          "syncing job declarations from manifest",
        );
        await jobStore.syncJobDeclarations(pluginId, jobDeclarations);
      }

      // Register with the scheduler (computes nextRunAt for active jobs)
      await scheduler.registerPlugin(pluginId);
    } catch (err) {
      log.error(
        {
          pluginId,
          pluginKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to sync jobs or register plugin with scheduler",
      );
    }
  }

  /**
   * When a plugin is disabled (transitions to `error` with "disabled by
   * operator" or genuine error): unregister from the scheduler.
   */
  async function onPluginDisabled(payload: {
    pluginId: string;
    pluginKey: string;
    reason?: string;
  }): Promise<void> {
    const { pluginId, pluginKey, reason } = payload;
    log.info(
      { pluginId, pluginKey, reason },
      "plugin disabled — unregistering from scheduler",
    );

    try {
      await scheduler.unregisterPlugin(pluginId);
    } catch (err) {
      log.error(
        {
          pluginId,
          pluginKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to unregister plugin from scheduler",
      );
    }
  }

  /**
   * When a plugin is unloaded (uninstalled): unregister from the scheduler.
   */
  async function onPluginUnloaded(payload: {
    pluginId: string;
    pluginKey: string;
    removeData: boolean;
  }): Promise<void> {
    const { pluginId, pluginKey, removeData } = payload;
    log.info(
      { pluginId, pluginKey, removeData },
      "plugin unloaded — unregistering from scheduler",
    );

    try {
      await scheduler.unregisterPlugin(pluginId);

      // If data is being purged, also delete all job definitions and runs
      if (removeData) {
        log.info({ pluginId, pluginKey }, "purging job data for uninstalled plugin");
        await jobStore.deleteAllJobs(pluginId);
      }
    } catch (err) {
      log.error(
        {
          pluginId,
          pluginKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to unregister plugin from scheduler during unload",
      );
    }
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let attached = false;

  // We need stable references for on/off since the lifecycle manager
  // uses them for matching. We wrap the async handlers in sync wrappers
  // that fire-and-forget (swallowing unhandled rejections via the try/catch
  // inside each handler).
  const boundOnLoaded = (payload: { pluginId: string; pluginKey: string }) => {
    void onPluginLoaded(payload);
  };
  const boundOnDisabled = (payload: { pluginId: string; pluginKey: string; reason?: string }) => {
    void onPluginDisabled(payload);
  };
  const boundOnUnloaded = (payload: { pluginId: string; pluginKey: string; removeData: boolean }) => {
    void onPluginUnloaded(payload);
  };

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start(): void {
      if (attached) return;
      attached = true;

      lifecycle.on("plugin.loaded", boundOnLoaded);
      lifecycle.on("plugin.disabled", boundOnDisabled);
      lifecycle.on("plugin.unloaded", boundOnUnloaded);

      log.info("plugin job coordinator started — listening to lifecycle events");
    },

    stop(): void {
      if (!attached) return;
      attached = false;

      lifecycle.off("plugin.loaded", boundOnLoaded);
      lifecycle.off("plugin.disabled", boundOnDisabled);
      lifecycle.off("plugin.unloaded", boundOnUnloaded);

      log.info("plugin job coordinator stopped");
    },
  };
}
