import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

type LifecycleLike = Pick<PluginLifecycleManager, "on" | "off">;

export interface PluginWorkerRuntimeEvent {
  type: "plugin.worker.crashed" | "plugin.worker.restarted";
  pluginId: string;
}

export interface PluginHostServiceCleanupController {
  handleWorkerEvent(event: PluginWorkerRuntimeEvent): void;
  disposeAll(): void;
  teardown(): void;
}

export function createPluginHostServiceCleanup(
  lifecycle: LifecycleLike,
  disposers: Map<string, () => void>,
): PluginHostServiceCleanupController {
  const runDispose = (pluginId: string, remove = false) => {
    const dispose = disposers.get(pluginId);
    if (!dispose) return;
    dispose();
    if (remove) {
      disposers.delete(pluginId);
    }
  };

  const handleWorkerStopped = ({ pluginId }: { pluginId: string }) => {
    runDispose(pluginId);
  };

  const handlePluginUnloaded = ({ pluginId }: { pluginId: string }) => {
    runDispose(pluginId, true);
  };

  lifecycle.on("plugin.worker_stopped", handleWorkerStopped);
  lifecycle.on("plugin.unloaded", handlePluginUnloaded);

  return {
    handleWorkerEvent(event) {
      if (event.type === "plugin.worker.crashed") {
        runDispose(event.pluginId);
      }
    },

    disposeAll() {
      for (const dispose of disposers.values()) {
        dispose();
      }
      disposers.clear();
    },

    teardown() {
      lifecycle.off("plugin.worker_stopped", handleWorkerStopped);
      lifecycle.off("plugin.unloaded", handlePluginUnloaded);
    },
  };
}
