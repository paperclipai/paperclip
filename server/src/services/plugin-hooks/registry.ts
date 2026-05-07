/**
 * Plugin hook registry — collects manifest-declared and worker-registered
 * hooks, indexes them by kind, sorts by priority, and prunes them when a
 * plugin is unloaded/disabled.
 *
 * Phase 1b only — no call-site wiring inside the core (see MYO-63).
 */

import type {
  PluginHookEntry,
  PluginHookHandlerMap,
  PluginHookKind,
  PluginHookManifestEntry,
  WhenPredicate,
} from "./types.js";

/**
 * Plugin lifecycle events the registry reacts to. Kept as a structural
 * subset of the real `PluginLifecycleEvents` type so the registry does not
 * import the heavier `plugin-lifecycle` module (and stays test-friendly).
 */
export interface PluginLifecycleSubset {
  on(
    event: "plugin.disabled" | "plugin.unloaded" | "plugin.error",
    listener: (payload: { pluginId: string }) => void,
  ): void;
  off?(
    event: "plugin.disabled" | "plugin.unloaded" | "plugin.error",
    listener: (payload: { pluginId: string }) => void,
  ): void;
}

/**
 * Resolver that decides whether a plugin's hooks are eligible for a given
 * company. Defaults to "always allowed". The default lookup is a per-company
 * read against `pluginCompanySettings`, which call-sites inject in MYO-63.
 */
export type PluginEnabledForCompanyFn = (
  pluginId: string,
  companyId: string,
) => boolean | Promise<boolean>;

/**
 * Per-company feature flag for the entire hook system. Default `true`.
 * Wired up to the operator-facing setting in MYO-63.
 */
export type HooksEnabledForCompanyFn = (companyId: string) => boolean | Promise<boolean>;

export interface PluginHookRegistryOptions {
  /** When false the registry is a no-op (used as a hard kill switch). */
  enabled?: boolean;
  isPluginEnabledForCompany?: PluginEnabledForCompanyFn;
  isHooksEnabledForCompany?: HooksEnabledForCompanyFn;
}

const DEFAULT_PRIORITY = 100;

const ALWAYS_ENABLED: PluginEnabledForCompanyFn = () => true;
const ALWAYS_ALLOWED: HooksEnabledForCompanyFn = () => true;

export interface PluginHookRegistry {
  /** Returns whether the registry is globally enabled (kill-switch off). */
  readonly isEnabled: boolean;

  /**
   * Register a single hook handler. Used by the worker bridge once a plugin
   * worker reports its hook implementations, and by tests to stub plugins.
   */
  register<K extends PluginHookKind>(entry: {
    kind: K;
    pluginId: string;
    pluginKey: string;
    priority?: number;
    when?: WhenPredicate | null;
    handler: PluginHookHandlerMap[K];
  }): void;

  /**
   * Register all hooks declared in a plugin manifest. Returns the list of
   * accepted entries (handler-bound). Manifest-only declarations cannot
   * actually run without a paired `register({ kind, handler })` call from
   * the worker bridge — we accept them here only for metadata indexing,
   * never as standalone executables.
   */
  registerManifestEntries(args: {
    pluginId: string;
    pluginKey: string;
    declarations: ManifestHookDeclarations;
    handlers: Partial<PluginHookHandlerMap>;
  }): PluginHookEntry[];

  /**
   * Remove all hook entries belonging to a plugin. Idempotent.
   */
  unregisterPlugin(pluginId: string): void;

  /**
   * Subscribe to lifecycle events and remove hooks on disable/unload/error.
   * Safe to call multiple times — listeners deduplicate.
   */
  attachLifecycle(lifecycle: PluginLifecycleSubset): void;

  /**
   * List entries for a kind. Filtered by company eligibility and the hook
   * feature flag. Sorted by priority ascending, then plugin id ascending.
   */
  list<K extends PluginHookKind>(
    kind: K,
    args: { companyId: string },
  ): Promise<readonly PluginHookEntry<K>[]>;

  /**
   * Synchronous `list` variant — useful for benchmarks and call-sites that
   * accept a pre-resolved company allow-list. Skips the eligibility resolver
   * (the caller is asserting the company is allowed).
   */
  listUnfiltered<K extends PluginHookKind>(kind: K): readonly PluginHookEntry<K>[];

  /**
   * Total number of registered hooks across all kinds and plugins. Used by
   * call-sites to bail out early before `list()` walks the maps.
   */
  size(): number;

  /** Reset the registry. Disposes of any lifecycle subscriptions. */
  reset(): void;
}

export interface ManifestHookDeclarations {
  wakePayloadTransformer?: PluginHookManifestEntry;
  skillResolverTransformer?: PluginHookManifestEntry;
}

interface RegistryEntry<K extends PluginHookKind> extends PluginHookEntry<K> {
  /** Insertion sequence — used as a deterministic tie-breaker. */
  readonly seq: number;
}

export function createPluginHookRegistry(
  options: PluginHookRegistryOptions = {},
): PluginHookRegistry {
  const enabled = options.enabled !== false;
  const isPluginEnabledForCompany = options.isPluginEnabledForCompany ?? ALWAYS_ENABLED;
  const isHooksEnabledForCompany = options.isHooksEnabledForCompany ?? ALWAYS_ALLOWED;

  const entries: { [K in PluginHookKind]: RegistryEntry<K>[] } = {
    wakePayloadTransformer: [],
    skillResolverTransformer: [],
  };

  /**
   * Cache of eligibility resolutions per (companyId, pluginId) for the
   * lifetime of a single `list()` call. Prevents N×M DB reads when a
   * call-site invokes the registry repeatedly inside the same heartbeat.
   * Keyed by `companyId:pluginId` because the eligibility may legitimately
   * change across companies.
   */

  const lifecycleSubscriptions = new Set<PluginLifecycleSubset>();
  const lifecycleListeners = new WeakMap<
    PluginLifecycleSubset,
    (payload: { pluginId: string }) => void
  >();

  let seqCounter = 0;

  function pushEntry<K extends PluginHookKind>(
    kind: K,
    entry: Omit<RegistryEntry<K>, "seq">,
  ): RegistryEntry<K> {
    const stored = { ...entry, seq: seqCounter++ } as RegistryEntry<K>;
    const list = entries[kind] as RegistryEntry<K>[];
    // Insertion-sort: keep the array sorted by priority then seq.
    let i = list.length - 1;
    while (i >= 0 && comparePriority(stored, list[i]!) < 0) {
      i -= 1;
    }
    list.splice(i + 1, 0, stored);
    return stored;
  }

  function register<K extends PluginHookKind>(args: {
    kind: K;
    pluginId: string;
    pluginKey: string;
    priority?: number;
    when?: WhenPredicate | null;
    handler: PluginHookHandlerMap[K];
  }): void {
    if (!enabled) return;
    if (!args.pluginId || !args.pluginKey || typeof args.handler !== "function") {
      throw new TypeError("register: pluginId, pluginKey and handler are required");
    }
    pushEntry(args.kind, {
      kind: args.kind,
      pluginId: args.pluginId,
      pluginKey: args.pluginKey,
      priority: normalisePriority(args.priority),
      when: args.when ?? null,
      handler: args.handler,
    } as Omit<RegistryEntry<K>, "seq">);
  }

  function registerManifestEntries(args: {
    pluginId: string;
    pluginKey: string;
    declarations: ManifestHookDeclarations;
    handlers: Partial<PluginHookHandlerMap>;
  }): PluginHookEntry[] {
    if (!enabled) return [];
    const accepted: PluginHookEntry[] = [];
    for (const kind of HOOK_KINDS) {
      const declaration = args.declarations[kind];
      const handler = args.handlers[kind];
      if (!declaration || typeof handler !== "function") continue;
      register({
        kind,
        pluginId: args.pluginId,
        pluginKey: args.pluginKey,
        priority: declaration.priority,
        when: declaration.when ?? null,
        handler: handler as PluginHookHandlerMap[typeof kind],
      });
      accepted.push({
        kind,
        pluginId: args.pluginId,
        pluginKey: args.pluginKey,
        priority: normalisePriority(declaration.priority),
        when: declaration.when ?? null,
        handler: handler as PluginHookHandlerMap[typeof kind],
      });
    }
    return accepted;
  }

  function unregisterPlugin(pluginId: string): void {
    if (!enabled) return;
    for (const kind of HOOK_KINDS) {
      const list = entries[kind];
      let write = 0;
      for (let read = 0; read < list.length; read += 1) {
        const entry = list[read]!;
        if (entry.pluginId !== pluginId) {
          if (write !== read) list[write] = entry;
          write += 1;
        }
      }
      list.length = write;
    }
  }

  function attachLifecycle(lifecycle: PluginLifecycleSubset): void {
    if (!enabled) return;
    if (lifecycleSubscriptions.has(lifecycle)) return;
    const handler = (payload: { pluginId: string }) => {
      if (typeof payload?.pluginId === "string") unregisterPlugin(payload.pluginId);
    };
    lifecycle.on("plugin.disabled", handler);
    lifecycle.on("plugin.unloaded", handler);
    lifecycle.on("plugin.error", handler);
    lifecycleSubscriptions.add(lifecycle);
    lifecycleListeners.set(lifecycle, handler);
  }

  async function list<K extends PluginHookKind>(
    kind: K,
    args: { companyId: string },
  ): Promise<readonly PluginHookEntry<K>[]> {
    if (!enabled) return EMPTY;
    const candidates = entries[kind] as RegistryEntry<K>[];
    if (candidates.length === 0) return EMPTY;
    const flagOk = await isHooksEnabledForCompany(args.companyId);
    if (!flagOk) return EMPTY;

    const eligibilityCache = new Map<string, Promise<boolean>>();
    const resolved = await Promise.all(
      candidates.map((entry) => {
        const cacheKey = entry.pluginId;
        let pending = eligibilityCache.get(cacheKey);
        if (!pending) {
          pending = Promise.resolve(isPluginEnabledForCompany(entry.pluginId, args.companyId));
          eligibilityCache.set(cacheKey, pending);
        }
        return pending.then((ok) => (ok ? entry : null));
      }),
    );
    const out = resolved.filter((entry): entry is RegistryEntry<K> => entry !== null);
    return out as readonly PluginHookEntry<K>[];
  }

  function listUnfiltered<K extends PluginHookKind>(
    kind: K,
  ): readonly PluginHookEntry<K>[] {
    if (!enabled) return EMPTY;
    return entries[kind] as readonly PluginHookEntry<K>[];
  }

  function size(): number {
    let total = 0;
    for (const kind of HOOK_KINDS) total += entries[kind].length;
    return total;
  }

  function reset(): void {
    for (const kind of HOOK_KINDS) entries[kind].length = 0;
    for (const lifecycle of lifecycleSubscriptions) {
      const listener = lifecycleListeners.get(lifecycle);
      if (listener && typeof lifecycle.off === "function") {
        lifecycle.off("plugin.disabled", listener);
        lifecycle.off("plugin.unloaded", listener);
        lifecycle.off("plugin.error", listener);
      }
    }
    lifecycleSubscriptions.clear();
  }

  return {
    isEnabled: enabled,
    register,
    registerManifestEntries,
    unregisterPlugin,
    attachLifecycle,
    list,
    listUnfiltered,
    size,
    reset,
  };
}

const HOOK_KINDS = ["wakePayloadTransformer", "skillResolverTransformer"] as const;

const EMPTY: readonly never[] = Object.freeze([]);

function normalisePriority(p: number | undefined): number {
  if (typeof p !== "number" || !Number.isFinite(p)) return DEFAULT_PRIORITY;
  return p;
}

function comparePriority(a: { priority: number; seq: number }, b: { priority: number; seq: number }): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.seq - b.seq;
}
