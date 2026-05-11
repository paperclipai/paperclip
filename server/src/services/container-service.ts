import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// ContainerEngineDriver — abstraction over docker/podman CLI
// ---------------------------------------------------------------------------

export interface ContainerEngineStartOpts {
  image: string;
  cmd?: string[];
  env?: Record<string, string>;
  memoryMb?: number;
  maxLifetimeSec?: number;
  labels?: Record<string, string>;
}

export interface ContainerEngineDetail {
  engineContainerId: string;
  image: string;
  status: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface ContainerEngineExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ContainerEngineDriver {
  start(opts: ContainerEngineStartOpts): Promise<{ engineContainerId: string }>;
  stop(engineContainerId: string): Promise<void>;
  kill(engineContainerId: string): Promise<void>;
  exec(engineContainerId: string, cmd: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<ContainerEngineExecResult>;
  list(opts?: { labelFilter?: Record<string, string> }): Promise<ContainerEngineDetail[]>;
  inspect(engineContainerId: string): Promise<ContainerEngineDetail | null>;
  onStartup(): Promise<void>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Container error
// ---------------------------------------------------------------------------

export type ContainerErrorCode =
  | "engine_disabled"
  | "engine_unavailable"
  | "not_owned"
  | "not_found"
  | "image_denied"
  | "pull_failed"
  | "quota_exceeded"
  | "exec_timeout"
  | "oom_killed"
  | "cleanup_failure";

export class ContainerError extends Error {
  readonly code: ContainerErrorCode;
  constructor(code: ContainerErrorCode, message: string) {
    super(message);
    this.name = "ContainerError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal registry entry
// ---------------------------------------------------------------------------

interface RegistryEntry {
  hostContainerId: string;
  engineContainerId: string;
  pluginId: string;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// ContainerService — host-managed business logic layer
// ---------------------------------------------------------------------------

export interface ContainerServiceOpts {
  driver: ContainerEngineDriver;
  concurrencyPerPlugin?: number;
  maxLifetimeSec?: number;
  memoryMbMax?: number;
}

export interface ContainerDetail {
  containerId: string;
  image: string;
  status: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface ContainerService {
  start(pluginId: string, opts: ContainerEngineStartOpts): Promise<{ containerId: string }>;
  stop(pluginId: string, containerId: string): Promise<void>;
  kill(pluginId: string, containerId: string): Promise<void>;
  exec(pluginId: string, containerId: string, cmd: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<ContainerEngineExecResult>;
  list(pluginId: string, opts: { status?: string }): Promise<ContainerDetail[]>;
  inspect(pluginId: string, containerId: string): Promise<ContainerDetail | null>;
  disposePlugin(pluginId: string): Promise<void>;
  onStartup(): Promise<void>;
  dispose(): Promise<void>;
}

export function createContainerService(opts: ContainerServiceOpts): ContainerService {
  const { driver, concurrencyPerPlugin = 10, maxLifetimeSec, memoryMbMax } = opts;

  // host UUID → registry entry
  const registry = new Map<string, RegistryEntry>();
  // pluginId → Set<hostContainerId>
  const pluginContainerIds = new Map<string, Set<string>>();

  function getPluginSet(pluginId: string): Set<string> {
    let set = pluginContainerIds.get(pluginId);
    if (!set) {
      set = new Set();
      pluginContainerIds.set(pluginId, set);
    }
    return set;
  }

  function assertOwnership(pluginId: string, containerId: string): RegistryEntry {
    const entry = registry.get(containerId);
    if (!entry) {
      // Container doesn't exist in our registry — return null-like (caller decides)
      throw new ContainerError("not_owned", `Container ${containerId} not found or not owned by plugin ${pluginId}`);
    }
    if (entry.pluginId !== pluginId) {
      throw new ContainerError("not_owned", `Container ${containerId} is not owned by plugin ${pluginId}`);
    }
    return entry;
  }

  function stripReservedLabels(labels?: Record<string, string>): Record<string, string> {
    if (!labels) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (!k.startsWith("paperclip.")) {
        out[k] = v;
      }
    }
    return out;
  }

  function registerEntry(pluginId: string, hostContainerId: string, engineContainerId: string, maxLifetimeSec?: number): void {
    const entry: RegistryEntry = { hostContainerId, engineContainerId, pluginId };
    if (maxLifetimeSec && maxLifetimeSec > 0) {
      entry.lifetimeTimer = setTimeout(async () => {
        try {
          await driver.kill(engineContainerId);
        } catch {
          // best-effort kill on lifetime expiry
        }
        registry.delete(hostContainerId);
        getPluginSet(pluginId).delete(hostContainerId);
      }, maxLifetimeSec * 1000);
      entry.lifetimeTimer.unref?.();
    }
    registry.set(hostContainerId, entry);
    getPluginSet(pluginId).add(hostContainerId);
  }

  function unregisterEntry(hostContainerId: string): void {
    const entry = registry.get(hostContainerId);
    if (!entry) return;
    if (entry.lifetimeTimer) clearTimeout(entry.lifetimeTimer);
    registry.delete(hostContainerId);
    getPluginSet(entry.pluginId).delete(hostContainerId);
  }

  return {
    async start(pluginId, opts) {
      const pluginSet = getPluginSet(pluginId);
      if (pluginSet.size >= concurrencyPerPlugin) {
        throw new ContainerError("quota_exceeded", `Plugin ${pluginId} has reached the container concurrency limit of ${concurrencyPerPlugin}`);
      }

      const safeLabels = stripReservedLabels(opts.labels);
      safeLabels["paperclip.plugin-id"] = pluginId;
      safeLabels["paperclip.managed"] = "true";

      // Clamp plugin-supplied memory to the operator maximum
      const memoryMb = memoryMbMax !== undefined
        ? Math.min(opts.memoryMb ?? memoryMbMax, memoryMbMax)
        : opts.memoryMb;

      // Always apply a bounded lifetime. Non-positive plugin value treated as "use service default".
      const resolvedLifetime = maxLifetimeSec !== undefined
        ? (opts.maxLifetimeSec !== undefined && opts.maxLifetimeSec > 0
            ? Math.min(opts.maxLifetimeSec, maxLifetimeSec)
            : maxLifetimeSec)
        : (opts.maxLifetimeSec !== undefined && opts.maxLifetimeSec > 0 ? opts.maxLifetimeSec : undefined);

      const { engineContainerId } = await driver.start({
        ...opts,
        labels: safeLabels,
        memoryMb,
      });

      const hostContainerId = randomUUID();
      registerEntry(pluginId, hostContainerId, engineContainerId, resolvedLifetime);
      return { containerId: hostContainerId };
    },

    async stop(pluginId, containerId) {
      const entry = assertOwnership(pluginId, containerId);
      await driver.stop(entry.engineContainerId);
      unregisterEntry(containerId);
    },

    async kill(pluginId, containerId) {
      const entry = assertOwnership(pluginId, containerId);
      await driver.kill(entry.engineContainerId);
      unregisterEntry(containerId);
    },

    async exec(pluginId, containerId, cmd, execOpts) {
      const entry = assertOwnership(pluginId, containerId);
      return driver.exec(entry.engineContainerId, cmd, execOpts);
    },

    async list(pluginId, listOpts) {
      const pluginSet = getPluginSet(pluginId);
      const results: ContainerDetail[] = [];
      for (const hostContainerId of pluginSet) {
        const entry = registry.get(hostContainerId);
        if (!entry) continue;
        const detail = await driver.inspect(entry.engineContainerId);
        if (!detail) continue;
        if (listOpts.status && detail.status !== listOpts.status) continue;
        results.push({
          containerId: hostContainerId,
          image: detail.image,
          status: detail.status,
          createdAt: detail.createdAt,
          labels: stripReservedLabels(detail.labels),
        });
      }
      return results;
    },

    async inspect(pluginId, containerId) {
      const entry = registry.get(containerId);
      if (!entry) return null;
      if (entry.pluginId !== pluginId) {
        throw new ContainerError("not_owned", `Container ${containerId} is not owned by plugin ${pluginId}`);
      }
      const detail = await driver.inspect(entry.engineContainerId);
      if (!detail) return null;
      return {
        containerId,
        image: detail.image,
        status: detail.status,
        createdAt: detail.createdAt,
        labels: stripReservedLabels(detail.labels),
      };
    },

    async disposePlugin(pluginId) {
      const pluginSet = getPluginSet(pluginId);
      const containerIds = Array.from(pluginSet);
      for (const hostContainerId of containerIds) {
        const entry = registry.get(hostContainerId);
        if (!entry) continue;
        try {
          await driver.kill(entry.engineContainerId);
        } catch {
          // best-effort cleanup
        }
        unregisterEntry(hostContainerId);
      }
    },

    async onStartup() {
      await driver.onStartup();
    },

    async dispose() {
      // Kill all containers across all plugins on shutdown
      const allEntries = Array.from(registry.values());
      for (const entry of allEntries) {
        if (entry.lifetimeTimer) clearTimeout(entry.lifetimeTimer);
        try {
          await driver.kill(entry.engineContainerId);
        } catch {
          // best-effort
        }
      }
      registry.clear();
      pluginContainerIds.clear();
      await driver.dispose();
    },
  };
}
