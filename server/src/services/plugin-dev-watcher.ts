/**
 * PluginDevWatcher — watches local-path plugin directories for file changes
 * and triggers worker restarts so plugin authors get a fast rebuild-and-reload
 * cycle without manually restarting the server.
 *
 * Only plugins installed from a local path (i.e. those with a non-null
 * `packagePath` in the DB) are watched. File changes in the plugin's package
 * directory trigger a debounced worker restart via the lifecycle manager.
 *
 * @see PLUGIN_SPEC.md §27.2 — Local Development Workflow
 */
import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

const log = logger.child({ service: "plugin-dev-watcher" });

/** Debounce interval for file changes (ms). */
const DEBOUNCE_MS = 500;

export interface PluginDevWatcher {
  /** Start watching a local-path plugin directory. */
  watch(pluginId: string, packagePath: string): void;
  /** Stop watching a specific plugin. */
  unwatch(pluginId: string): void;
  /** Stop all watchers and clean up. */
  close(): void;
}

/**
 * Create a PluginDevWatcher that monitors local plugin directories and
 * restarts workers on file changes.
 */
export function createPluginDevWatcher(
  lifecycle: PluginLifecycleManager,
): PluginDevWatcher {
  const watchers = new Map<string, FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function watchPlugin(pluginId: string, packagePath: string): void {
    // Don't double-watch
    if (watchers.has(pluginId)) return;

    const absPath = path.resolve(packagePath);
    if (!existsSync(absPath)) {
      log.warn(
        { pluginId, packagePath: absPath },
        "plugin-dev-watcher: package path does not exist, skipping watch",
      );
      return;
    }

    try {
      const watcher = watch(absPath, { recursive: true }, (_event, filename) => {
        // Ignore node_modules and hidden files inside the plugin dir
        if (
          filename &&
          (filename.includes("node_modules") || filename.startsWith("."))
        ) {
          return;
        }

        // Debounce: multiple rapid file changes collapse into one restart
        const existing = debounceTimers.get(pluginId);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
          pluginId,
          setTimeout(() => {
            debounceTimers.delete(pluginId);
            log.info(
              { pluginId, changedFile: filename },
              "plugin-dev-watcher: file change detected, restarting worker",
            );

            lifecycle.restartWorker(pluginId).catch((err) => {
              log.warn(
                {
                  pluginId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "plugin-dev-watcher: failed to restart worker after file change",
              );
            });
          }, DEBOUNCE_MS),
        );
      });

      watchers.set(pluginId, watcher);
      log.info(
        { pluginId, packagePath: absPath },
        "plugin-dev-watcher: watching local plugin for changes",
      );
    } catch (err) {
      log.warn(
        {
          pluginId,
          packagePath: absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: failed to start file watcher",
      );
    }
  }

  function unwatchPlugin(pluginId: string): void {
    const watcher = watchers.get(pluginId);
    if (watcher) {
      watcher.close();
      watchers.delete(pluginId);
    }
    const timer = debounceTimers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(pluginId);
    }
  }

  function close(): void {
    for (const [pluginId] of watchers) {
      unwatchPlugin(pluginId);
    }
  }

  return {
    watch: watchPlugin,
    unwatch: unwatchPlugin,
    close,
  };
}
