/**
 * In-memory registry of currently-dispatching tool invocations, keyed by
 * `(pluginDbId, runId)`. This is the host's authoritative source-of-truth
 * for "who is the dispatching agent for this in-flight tool call".
 *
 * PLA-574: A plugin worker is NOT trusted to assert dispatching-agent identity.
 * When the host hands a tool call to a worker, it first registers the agent's
 * runContext here. When the worker calls back via `artifacts.fetch`, the host
 * looks up the entry by `(pluginDbId, runId)` and uses the **registered**
 * runContext — never the values from the worker — to authorize.
 *
 * Entries are removed in the `finally` of the dispatch path. A TTL sweep is
 * provided as a safety net for orphans (e.g. worker crash mid-call); the
 * default TTL is intentionally generous (5 minutes) because rate-limiting
 * provides the abuse cap, and the registry only protects against forged
 * runIds, not slow tools.
 */

export interface RegisteredRunContext {
  /** UUID of the dispatching agent (server-validated). */
  agentId: string;
  /** UUID of the dispatching agent's company (server-validated). */
  companyId: string;
  /** UUID of the dispatching agent's run. */
  runId: string;
  /** UUID of the dispatching agent's project. */
  projectId: string;
  /** Tool the worker was asked to execute (for audit-log context). */
  toolName: string;
  /** Wall-clock when the entry was added (for TTL sweep). */
  registeredAt: number;
}

export interface PluginRunContextRegistry {
  register(pluginDbId: string, ctx: RegisteredRunContext): void;
  get(pluginDbId: string, runId: string): RegisteredRunContext | null;
  deregister(pluginDbId: string, runId: string): void;
  /** Test/diagnostic. Returns the number of live entries. */
  size(): number;
  /** Stops the sweep timer (for test teardown). */
  dispose(): void;
}

export interface CreateRegistryOptions {
  /** Override the entry TTL in ms. Default: 5 minutes. */
  ttlMs?: number;
  /** Override the sweep interval in ms. Default: 60s. */
  sweepIntervalMs?: number;
  /** Inject a clock for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_SWEEP_MS = 60 * 1_000;

export function createPluginRunContextRegistry(
  opts: CreateRegistryOptions = {},
): PluginRunContextRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, RegisteredRunContext>();

  const compositeKey = (pluginDbId: string, runId: string) =>
    `${pluginDbId}:${runId}`;

  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [key, value] of entries) {
      if (value.registeredAt < cutoff) {
        entries.delete(key);
      }
    }
  };

  const timer = setInterval(sweep, sweepMs);
  // Don't keep the process alive just for the sweep timer.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return {
    register(pluginDbId, ctx) {
      entries.set(compositeKey(pluginDbId, ctx.runId), ctx);
    },
    get(pluginDbId, runId) {
      const entry = entries.get(compositeKey(pluginDbId, runId));
      if (!entry) return null;
      // Guard against orphaned entries that survived past TTL between sweeps.
      if (entry.registeredAt < now() - ttlMs) {
        entries.delete(compositeKey(pluginDbId, runId));
        return null;
      }
      return entry;
    },
    deregister(pluginDbId, runId) {
      entries.delete(compositeKey(pluginDbId, runId));
    },
    size() {
      return entries.size;
    },
    dispose() {
      clearInterval(timer);
      entries.clear();
    },
  };
}
