/**
 * PluginLifecycleManager — state-machine controller for plugin status
 * transitions and worker process coordination.
 *
 * Each plugin moves through a well-defined state machine:
 *
 * ```
 *   installed ──→ ready ──→ error
 *       │            │         │
 *       │            ↓         │
 *       │     upgrade_pending  │
 *       │            │         │
 *       ↓            ↓         ↓
 *              uninstalled
 * ```
 *
 * The lifecycle manager:
 *
 * 1. **Validates transitions** — Only transitions defined in
 *    `VALID_TRANSITIONS` are allowed; invalid transitions throw.
 *
 * 2. **Coordinates workers** — When a plugin moves to `ready`, its
 *    worker process is started. When it moves out of `ready`, the
 *    worker is stopped gracefully.
 *
 * 3. **Emits events** — `plugin.loaded`, `plugin.enabled`,
 *    `plugin.disabled`, `plugin.unloaded`, `plugin.status_changed`
 *    events are emitted so that other services (job coordinator,
 *    tool dispatcher, event bus) can react accordingly.
 *
 * 4. **Persists state** — Status changes are written to the database
 *    through the plugin registry service.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 */
import { EventEmitter } from "node:events";
import type { Db } from "@paperclipai/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginLoader, type PluginLoader } from "./plugin-loader.js";
import type { PluginWorkerManager, WorkerStartOptions } from "./plugin-worker-manager.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the plugin lifecycle.
 *
 *   installed → ready       (initial load succeeds)
 *   installed → error       (initial load fails)
 *   installed → uninstalled (abort installation)
 *
 *   ready → error           (runtime failure or operator disable*)
 *   ready → upgrade_pending (upgrade with new capabilities)
 *   ready → uninstalled     (uninstall)
 *
 *   error → ready           (retry / recovery / operator re-enable)
 *   error → uninstalled     (give up and uninstall)
 *
 *   upgrade_pending → ready       (operator approves new capabilities)
 *   upgrade_pending → error       (upgrade worker fails)
 *   upgrade_pending → uninstalled (reject upgrade and uninstall)
 *
 *   uninstalled → installed (reinstall)
 *
 * (*) Operator disable is modeled as ready → error with a
 *     "disabled_by_operator" sentinel in lastError. Use
 *     isDisabledByOperator() to distinguish from genuine errors.
 */
const VALID_TRANSITIONS: Record<string, readonly PluginStatus[]> = {
  installed: ["ready", "error", "uninstalled"],
  ready: ["ready", "error", "upgrade_pending", "uninstalled"],
  error: ["ready", "uninstalled"],
  upgrade_pending: ["ready", "error", "uninstalled"],
  uninstalled: ["installed"], // reinstall
};

/**
 * Check whether a transition from `from` → `to` is valid.
 */
function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the PluginLifecycleManager.
 * Consumers can subscribe to these for routing-table updates, UI refresh
 * notifications, and observability.
 */
export interface PluginLifecycleEvents {
  /** Emitted after a plugin is loaded (installed → ready). */
  "plugin.loaded": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin transitions to ready (enabled). */
  "plugin.enabled": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin is disabled (ready → error or explicit disable). */
  "plugin.disabled": { pluginId: string; pluginKey: string; reason?: string };
  /** Emitted after a plugin is unloaded (any → uninstalled). */
  "plugin.unloaded": { pluginId: string; pluginKey: string; removeData: boolean };
  /** Emitted on any status change. */
  "plugin.status_changed": {
    pluginId: string;
    pluginKey: string;
    previousStatus: PluginStatus;
    newStatus: PluginStatus;
  };
  /** Emitted when a plugin enters an error state. */
  "plugin.error": { pluginId: string; pluginKey: string; error: string };
  /** Emitted when a plugin enters upgrade_pending. */
  "plugin.upgrade_pending": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been started. */
  "plugin.worker_started": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been stopped. */
  "plugin.worker_stopped": { pluginId: string; pluginKey: string };
}

type LifecycleEventName = keyof PluginLifecycleEvents;
type LifecycleEventPayload<K extends LifecycleEventName> = PluginLifecycleEvents[K];

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

export interface PluginLifecycleManager {
  /**
   * Load a newly installed plugin – transitions `installed` → `ready`.
   *
   * This is called after the registry has persisted the initial install record.
   * The caller should have already spawned the worker and performed health
   * checks before calling this.  If the worker fails, call `markError` instead.
   */
  load(pluginId: string): Promise<PluginRecord>;

  /**
   * Enable a plugin that is in `error` or `upgrade_pending` state.
   * Transitions → `ready`.
   */
  enable(pluginId: string): Promise<PluginRecord>;

  /**
   * Disable a running plugin.
   * Transitions `ready` → stores as `error` with a "disabled by operator" reason.
   *
   * Note: The PLUGIN_STATUSES constant does not include a dedicated "disabled"
   * status.  We model operator-initiated disable as `error` with a sentinel
   * lastError value so the existing DB schema is reused.  Future iterations
   * may add a first-class "disabled" status.
   */
  disable(pluginId: string, reason?: string): Promise<PluginRecord>;

  /**
   * Unload (uninstall) a plugin from any active state.
   * Transitions → `uninstalled`.
   *
   * When `removeData` is true, the plugin row and cascaded config are
   * hard-deleted.  Otherwise a soft-delete sets status to `uninstalled`.
   */
  unload(pluginId: string, removeData?: boolean): Promise<PluginRecord | null>;

  /**
   * Mark a plugin as errored (e.g. worker crash, health-check failure).
   * Transitions → `error`.
   */
  markError(pluginId: string, error: string): Promise<PluginRecord>;

  /**
   * Mark a plugin as requiring upgrade approval.
   * Transitions `ready` → `upgrade_pending`.
   */
  markUpgradePending(pluginId: string): Promise<PluginRecord>;

  /**
   * Upgrade a plugin to a newer version.
   * This is a placeholder that handles the lifecycle state transition.
   * The actual package installation is handled by plugin-loader.
   *
   * If the upgrade adds new capabilities, transitions to `upgrade_pending`.
   * Otherwise, transitions to `ready` directly.
   */
  upgrade(pluginId: string, version?: string): Promise<PluginRecord>;

  /**
   * Start the worker process for a plugin that is already in `ready` state.
   *
   * This is used by the server startup orchestration to start workers for
   * plugins that were persisted as `ready`. It requires a `PluginWorkerManager`
   * to have been provided at construction time.
   *
   * @param pluginId - The UUID of the plugin to start
   * @param options  - Worker start options (entrypoint path, config, etc.)
   * @throws if no worker manager is configured or the plugin is not ready
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<void>;

  /**
   * Stop the worker process for a plugin without changing lifecycle state.
   *
   * This is used during server shutdown to gracefully stop all workers.
   * It does not transition the plugin state — plugins remain in their
   * current status so they can be restarted on next server boot.
   *
   * @param pluginId - The UUID of the plugin to stop
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Restart the worker process for a running plugin.
   *
   * Stops and re-starts the worker process. The plugin remains in `ready`
   * state throughout. This is typically called after a config change.
   *
   * @param pluginId - The UUID of the plugin to restart
   * @throws if no worker manager is configured or the plugin is not ready
   */
  restartWorker(pluginId: string): Promise<void>;

  /**
   * Get the current lifecycle state for a plugin.
   */
  getStatus(pluginId: string): Promise<PluginStatus | null>;

  /**
   * Check whether a transition is allowed from the plugin's current state.
   */
  canTransition(pluginId: string, to: PluginStatus): Promise<boolean>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Subscribe to a lifecycle event once.
   */
  once<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Disabled-by-operator sentinel
// ---------------------------------------------------------------------------

const DISABLED_BY_OPERATOR_PREFIX = "disabled_by_operator";

function buildDisabledError(reason?: string): string {
  return reason
    ? `${DISABLED_BY_OPERATOR_PREFIX}: ${reason}`
    : DISABLED_BY_OPERATOR_PREFIX;
}

export function isDisabledByOperator(lastError: string | null): boolean {
  return lastError?.startsWith(DISABLED_BY_OPERATOR_PREFIX) ?? false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
export interface PluginLifecycleManagerOptions {
  /** Plugin loader instance. Falls back to the default if omitted. */
  loader?: PluginLoader;

  /**
   * Worker process manager. When provided, lifecycle transitions that bring
   * a plugin online (load, enable, upgrade-to-ready) will start the worker
   * process, and transitions that take a plugin offline (disable, unload,
   * markError) will stop it.
   *
   * When omitted the lifecycle manager operates in state-only mode — the
   * caller is responsible for managing worker processes externally.
   */
  workerManager?: PluginWorkerManager;
}

/**
 * Create a PluginLifecycleManager.
 *
 * This service orchestrates plugin state transitions on top of the
 * `pluginRegistryService` (which handles raw DB persistence).  It enforces
 * the lifecycle state machine, emits events for downstream consumers
 * (routing tables, UI, observability), and manages worker processes via
 * the `PluginWorkerManager` when one is provided.
 *
 * Usage:
 * ```ts
 * const lifecycle = pluginLifecycleManager(db, {
 *   workerManager: createPluginWorkerManager(),
 * });
 * lifecycle.on("plugin.enabled", ({ pluginId }) => { ... });
 * await lifecycle.load(pluginId);
 * ```
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugins.status` column
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLifecycleManager(
  db: Db,
  options?: PluginLoader | PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  // Support the legacy signature: pluginLifecycleManager(db, loader)
  // as well as the new options object form.
  let loaderArg: PluginLoader | undefined;
  let workerManager: PluginWorkerManager | undefined;

  if (options && typeof options === "object" && "discoverAll" in options) {
    // Legacy: second arg is a PluginLoader directly
    loaderArg = options as PluginLoader;
  } else if (options && typeof options === "object") {
    const opts = options as PluginLifecycleManagerOptions;
    loaderArg = opts.loader;
    workerManager = opts.workerManager;
  }

  const registry = pluginRegistryService(db);
  const pluginLoaderInstance = loaderArg ?? pluginLoader(db);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100); // plugins may have many listeners; 100 is a safe upper bound

  const log = logger.child({ service: "plugin-lifecycle" });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin as PluginRecord;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw badRequest(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin?: PluginRecord,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? await requirePlugin(pluginId);
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated) throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated as PluginRecord;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    // Emit the generic status_changed event
    emitter.emit("plugin.status_changed", {
      pluginId,
      pluginKey: result.pluginKey,
      previousStatus,
      newStatus: to,
    });

    return result;
  }

  function emitDomain(
    event: LifecycleEventName,
    payload: PluginLifecycleEvents[LifecycleEventName],
  ): void {
    emitter.emit(event, payload);
  }

  // -----------------------------------------------------------------------
  // Worker management helpers
  // -----------------------------------------------------------------------

  /**
   * Stop the worker for a plugin if one is running.
   * This is a best-effort operation — if no worker manager is configured
   * or no worker is running, it silently succeeds.
   */
  async function stopWorkerIfRunning(
    pluginId: string,
    pluginKey: string,
  ): Promise<void> {
    if (!workerManager) return;
    if (!workerManager.isRunning(pluginId) && !workerManager.getWorker(pluginId)) return;

    try {
      await workerManager.stopWorker(pluginId);
      log.info({ pluginId, pluginKey }, "plugin lifecycle: worker stopped");
      emitDomain("plugin.worker_stopped", { pluginId, pluginKey });
    } catch (err) {
      log.warn(
        { pluginId, pluginKey, err: err instanceof Error ? err.message : String(err) },
        "plugin lifecycle: failed to stop worker (best-effort)",
      );
    }
  }

  async function activateReadyPlugin(pluginId: string): Promise<void> {
    const supportsRuntimeActivation =
      typeof pluginLoaderInstance.hasRuntimeServices === "function"
      && typeof pluginLoaderInstance.loadSingle === "function";
    if (!supportsRuntimeActivation || !pluginLoaderInstance.hasRuntimeServices()) {
      return;
    }

    const loadResult = await pluginLoaderInstance.loadSingle(pluginId);
    if (!loadResult.success) {
      throw new Error(
        loadResult.error
        ?? `Failed to activate plugin ${loadResult.plugin.pluginKey}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // -- load -------------------------------------------------------------
    /**
     * load — Transitions a plugin to 'ready' status and starts its worker.
     *
     * This method is called after a plugin has been successfully installed and
     * validated. It marks the plugin as ready in the database and immediately
     * triggers the plugin loader to start the worker process.
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns The updated plugin record.
     */
    async load(pluginId: string): Promise<PluginRecord> {
      const result = await transition(pluginId, "ready");
      await activateReadyPlugin(pluginId);

      emitDomain("plugin.loaded", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- enable -----------------------------------------------------------
    /**
     * enable — Re-enables a plugin that was previously in an error or upgrade state.
     *
     * Similar to load(), this method transitions the plugin to 'ready' and starts
     * its worker, but it specifically targets plugins that are currently disabled.
     *
     * @param pluginId - The UUID of the plugin to enable.
     * @returns The updated plugin record.
     */
    async enable(pluginId: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Only allow enabling from error or upgrade_pending states
      if (plugin.status !== "error" && plugin.status !== "upgrade_pending") {
        throw badRequest(
          `Cannot enable plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'error' or 'upgrade_pending' status to be enabled.`,
        );
      }

      const result = await transition(pluginId, "ready", null, plugin);
      await activateReadyPlugin(pluginId);
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- disable ----------------------------------------------------------
    async disable(pluginId: string, reason?: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Only allow disabling from ready state
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot disable plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status to be disabled.`,
        );
      }

      // Stop the worker before transitioning state
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);

      const errorMsg = buildDisabledError(reason);
      const result = await transition(pluginId, "error", errorMsg, plugin);
      emitDomain("plugin.disabled", {
        pluginId,
        pluginKey: result.pluginKey,
        reason,
      });
      return result;
    },

    // -- unload -----------------------------------------------------------
    async unload(
      pluginId: string,
      removeData = false,
    ): Promise<PluginRecord | null> {
      const plugin = await requirePlugin(pluginId);

      // If already uninstalled and removeData, hard-delete
      if (plugin.status === "uninstalled") {
        if (removeData) {
          const deleted = await registry.uninstall(pluginId, true);
          log.info(
            { pluginId, pluginKey: plugin.pluginKey },
            "plugin lifecycle: hard-deleted already-uninstalled plugin",
          );
          emitDomain("plugin.unloaded", {
            pluginId,
            pluginKey: plugin.pluginKey,
            removeData: true,
          });
          return deleted as PluginRecord | null;
        }
        throw badRequest(
          `Plugin ${plugin.pluginKey} is already uninstalled. ` +
            `Use removeData=true to permanently delete it.`,
        );
      }

      // Stop the worker before uninstalling
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);

      // Perform the uninstall via registry (handles soft/hard delete)
      const result = await registry.uninstall(pluginId, removeData);

      log.info(
        { pluginId, pluginKey: plugin.pluginKey, removeData },
        `plugin lifecycle: ${plugin.status} → uninstalled${removeData ? " (hard delete)" : ""}`,
      );

      emitter.emit("plugin.status_changed", {
        pluginId,
        pluginKey: plugin.pluginKey,
        previousStatus: plugin.status,
        newStatus: "uninstalled" as PluginStatus,
      });

      emitDomain("plugin.unloaded", {
        pluginId,
        pluginKey: plugin.pluginKey,
        removeData,
      });

      return result as PluginRecord | null;
    },

    // -- markError --------------------------------------------------------
    async markError(pluginId: string, error: string): Promise<PluginRecord> {
      // Stop the worker — the plugin is in an error state and should not
      // continue running. The worker manager's auto-restart is disabled
      // because we are intentionally taking the plugin offline.
      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "error", error, plugin);
      emitDomain("plugin.error", {
        pluginId,
        pluginKey: result.pluginKey,
        error,
      });
      return result;
    },

    // -- markUpgradePending -----------------------------------------------
    async markUpgradePending(pluginId: string): Promise<PluginRecord> {
      // Stop the worker while waiting for operator approval of new capabilities
      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "upgrade_pending", null, plugin);
      emitDomain("plugin.upgrade_pending", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- upgrade ----------------------------------------------------------
    /**
     * Upgrade a plugin to a newer version by performing a package update and
     * managing the lifecycle state transition.
     *
     * Following PLUGIN_SPEC.md §25.3, the upgrade process:
     * 1. Stops the current worker process (if running).
     * 2. Fetches and validates the new plugin package via the `PluginLoader`.
     * 3. Compares the capabilities declared in the new manifest against the old one.
     * 4. If new capabilities are added, transitions the plugin to `upgrade_pending`
     *    to await operator approval (worker stays stopped).
     * 5. If no new capabilities are added, transitions the plugin back to `ready`
     *    with the updated version and manifest metadata.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param version - Optional target version specifier.
     * @returns The updated `PluginRecord`.
     * @throws {BadRequest} If the plugin is not in a ready or upgrade_pending state.
     */
    async upgrade(pluginId: string, version?: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Can only upgrade plugins that are ready or already in upgrade_pending
      if (plugin.status !== "ready" && plugin.status !== "upgrade_pending") {
        throw badRequest(
          `Cannot upgrade plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' or 'upgrade_pending' status to be upgraded.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey, targetVersion: version },
        "plugin lifecycle: upgrade requested",
      );

      // Stop the current worker before upgrading on disk
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);

      // 1. Download and validate new package via loader
      const { oldManifest, newManifest, discovered } =
        await pluginLoaderInstance.upgradePlugin(pluginId, { version });

      log.info(
        {
          pluginId,
          pluginKey: plugin.pluginKey,
          oldVersion: oldManifest.version,
          newVersion: newManifest.version,
        },
        "plugin lifecycle: package upgraded on disk",
      );

      // 2. Compare capabilities
      const addedCaps = newManifest.capabilities.filter(
        (cap) => !oldManifest.capabilities.includes(cap),
      );

      // 3. Transition state
      if (addedCaps.length > 0) {
        // New capabilities require operator approval — worker stays stopped
        log.info(
          { pluginId, pluginKey: plugin.pluginKey, addedCaps },
          "plugin lifecycle: new capabilities detected, transitioning to upgrade_pending",
        );
        // Skip the inner stopWorkerIfRunning since we already stopped above
        const result = await transition(pluginId, "upgrade_pending", null, plugin);
        emitDomain("plugin.upgrade_pending", {
          pluginId,
          pluginKey: result.pluginKey,
        });
        return result;
      } else {
        const result = await transition(pluginId, "ready", null, {
          ...plugin,
          version: discovered.version,
          manifestJson: newManifest,
        } as PluginRecord);
        await activateReadyPlugin(pluginId);

        emitDomain("plugin.loaded", {
          pluginId,
          pluginKey: result.pluginKey,
        });
        emitDomain("plugin.enabled", {
          pluginId,
          pluginKey: result.pluginKey,
        });

        return result;
      }
    },

    // -- startWorker ------------------------------------------------------
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot start worker: no PluginWorkerManager is configured. " +
            "Provide a workerManager option when constructing the lifecycle manager.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot start worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: starting worker",
      );

      await workerManager.startWorker(pluginId, options);
      emitDomain("plugin.worker_started", {
        pluginId,
        pluginKey: plugin.pluginKey,
      });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker started",
      );
    },

    // -- stopWorker -------------------------------------------------------
    async stopWorker(pluginId: string): Promise<void> {
      if (!workerManager) return; // No worker manager — nothing to stop

      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);
    },

    // -- restartWorker ----------------------------------------------------
    async restartWorker(pluginId: string): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot restart worker: no PluginWorkerManager is configured.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot restart worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      const handle = workerManager.getWorker(pluginId);
      if (!handle) {
        throw badRequest(
          `Cannot restart worker for plugin "${plugin.pluginKey}": no worker is running.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: restarting worker",
      );

      await handle.restart();

      emitDomain("plugin.worker_stopped", { pluginId, pluginKey: plugin.pluginKey });
      emitDomain("plugin.worker_started", { pluginId, pluginKey: plugin.pluginKey });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker restarted",
      );
    },

    // -- getStatus --------------------------------------------------------
    async getStatus(pluginId: string): Promise<PluginStatus | null> {
      const plugin = await registry.getById(pluginId);
      return plugin?.status ?? null;
    },

    // -- canTransition ----------------------------------------------------
    async canTransition(pluginId: string, to: PluginStatus): Promise<boolean> {
      const plugin = await registry.getById(pluginId);
      if (!plugin) return false;
      return isValidTransition(plugin.status, to);
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },

    once(event, listener) {
      emitter.once(event, listener);
    },
  };
}
