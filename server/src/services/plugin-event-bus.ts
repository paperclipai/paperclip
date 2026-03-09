/**
 * PluginEventBus — typed in-process event bus for the Paperclip plugin system.
 *
 * Responsibilities:
 * - Deliver core domain events to subscribing plugin workers (server-side).
 * - Apply `EventFilter` server-side so filtered-out events never reach the handler.
 * - Namespace plugin-emitted events as `plugin.<pluginId>.<eventName>`.
 * - Guard the core namespace: plugins may not emit events with the `plugin.` prefix.
 * - Isolate subscriptions per plugin — a plugin cannot enumerate or interfere with
 *   another plugin's subscriptions.
 * - Support wildcard subscriptions via prefix matching (e.g. `plugin.acme.linear.*`).
 *
 * The bus operates in-process. In the full out-of-process architecture the host
 * calls `bus.emit()` after receiving events from the DB/queue layer, and the bus
 * forwards to handlers that proxy the call to the relevant worker process via IPC.
 * That IPC layer is separate; this module only handles routing and filtering.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 * @see PLUGIN_SPEC.md §16.1 — Event Filtering
 * @see PLUGIN_SPEC.md §16.2 — Plugin-to-Plugin Events
 */

import type { PluginEventType } from "@paperclipai/shared";
import type { PluginEvent, EventFilter } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A registered subscription record stored per plugin.
 */
interface Subscription {
  /** The event name or prefix pattern this subscription matches. */
  eventPattern: string;
  /** Optional server-side filter applied before delivery. */
  filter: EventFilter | null;
  /** Async handler to invoke when a matching event passes the filter. */
  handler: (event: PluginEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the event type matches the subscription pattern.
 *
 * Matching rules:
 * - Exact match: `"issue.created"` matches `"issue.created"`.
 * - Wildcard suffix: `"plugin.acme.*"` matches any event type that starts with
 *   `"plugin.acme."`. The wildcard `*` is only supported as a trailing token.
 *
 * No full glob syntax is supported — only trailing `*` after a `.` separator.
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === eventType) return true;

  // Trailing wildcard: "plugin.foo.*" → prefix is "plugin.foo."
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // remove the trailing "*", keep the "."
    return eventType.startsWith(prefix);
  }

  return false;
}

/**
 * Returns true if the event passes all fields of the filter.
 * A `null` or empty filter object passes all events.
 *
 * **Resolution strategy per field:**
 *
 * - `projectId` — checked against `event.entityId` when `entityType === "project"`,
 *   otherwise against `payload.projectId`. This covers both direct project events
 *   (e.g. `project.created`) and secondary events that embed a project reference in
 *   their payload (e.g. `issue.created` with `payload.projectId`).
 *
 * - `companyId` — always resolved from `payload.companyId`. Core domain events that
 *   belong to a company embed the company ID in their payload.
 *
 * - `agentId` — checked against `event.entityId` when `entityType === "agent"`,
 *   otherwise against `payload.agentId`. Covers both direct agent lifecycle events
 *   (e.g. `agent.created`) and run-level events with `payload.agentId` (e.g.
 *   `agent.run.started`).
 *
 * Multiple filter fields are ANDed — all specified fields must match.
 */
function passesFilter(event: PluginEvent, filter: EventFilter | null): boolean {
  if (!filter) return true;

  const payload = event.payload as Record<string, unknown> | null;

  if (filter.projectId !== undefined) {
    const projectId = event.entityType === "project"
      ? event.entityId
      : payload?.projectId;
    if (projectId !== filter.projectId) return false;
  }

  if (filter.companyId !== undefined) {
    const companyId = payload?.companyId;
    if (companyId !== filter.companyId) return false;
  }

  if (filter.agentId !== undefined) {
    const agentId = event.entityType === "agent"
      ? event.entityId
      : payload?.agentId;
    if (agentId !== filter.agentId) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Event bus factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new `PluginEventBus` instance.
 *
 * A single bus instance should be shared across the server process. Each
 * plugin interacts with the bus through a scoped handle obtained via
 * {@link PluginEventBus.forPlugin}.
 *
 * @example
 * ```ts
 * const bus = createPluginEventBus();
 *
 * // Give the Linear plugin a scoped handle
 * const linearBus = bus.forPlugin("acme.linear");
 *
 * // Subscribe from the plugin's perspective
 * linearBus.subscribe("issue.created", async (event) => {
 *   // handle event
 * });
 *
 * // Emit a core domain event (called by the host, not the plugin)
 * await bus.emit({
 *   eventId: "evt-1",
 *   eventType: "issue.created",
 *   occurredAt: new Date().toISOString(),
 *   entityId: "iss-1",
 *   entityType: "issue",
 *   payload: { title: "Fix login bug", projectId: "proj-1" },
 * });
 * ```
 */
export function createPluginEventBus(): PluginEventBus {
  // Subscription registry: pluginId → list of subscriptions
  const registry = new Map<string, Subscription[]>();

  /**
   * Retrieve or create the subscription list for a plugin.
   */
  function subsFor(pluginId: string): Subscription[] {
    let subs = registry.get(pluginId);
    if (!subs) {
      subs = [];
      registry.set(pluginId, subs);
    }
    return subs;
  }

  /**
   * Emit an event envelope to all matching subscribers across all plugins.
   *
   * Subscribers are called concurrently (Promise.all). Each handler's errors
   * are caught individually and collected in the returned `errors` array so a
   * single misbehaving plugin cannot interrupt delivery to other plugins.
   */
  async function emit(event: PluginEvent): Promise<PluginEventBusEmitResult> {
    const errors: Array<{ pluginId: string; error: unknown }> = [];
    const promises: Promise<void>[] = [];

    for (const [pluginId, subs] of registry) {
      for (const sub of subs) {
        if (!matchesPattern(event.eventType, sub.eventPattern)) continue;
        if (!passesFilter(event, sub.filter)) continue;

        // Use Promise.resolve().then() so that synchronous throws from handlers
        // are also caught inside the promise chain. Calling
        // Promise.resolve(syncThrowingFn()) does NOT catch sync throws — the
        // throw escapes before Promise.resolve() can wrap it. Using .then()
        // ensures the call is deferred into the microtask queue where all
        // exceptions become rejections. Each .catch() swallows the rejection
        // and records it — the promise always resolves, so Promise.all never rejects.
        promises.push(
          Promise.resolve().then(() => sub.handler(event)).catch((error: unknown) => {
            errors.push({ pluginId, error });
          }),
        );
      }
    }

    await Promise.all(promises);
    return { errors };
  }

  /**
   * Remove all subscriptions for a plugin (e.g. on worker shutdown or uninstall).
   */
  function clearPlugin(pluginId: string): void {
    registry.delete(pluginId);
  }

  /**
   * Return a scoped handle for a specific plugin. The handle exposes only the
   * plugin's own subscription list and enforces the plugin namespace on `emit`.
   */
  function forPlugin(pluginId: string): ScopedPluginEventBus {
    return {
      /**
       * Subscribe to a core domain event or a plugin-namespaced event.
       *
       * For wildcard subscriptions use a trailing `.*` pattern, e.g.
       * `"plugin.acme.linear.*"`.
       *
       * Requires the `events.subscribe` capability (capability enforcement is
       * done by the host layer before calling this method).
       */
      subscribe(
        eventPattern: PluginEventType | `plugin.${string}`,
        fnOrFilter: EventFilter | ((event: PluginEvent) => Promise<void>),
        maybeFn?: (event: PluginEvent) => Promise<void>,
      ): void {
        let filter: EventFilter | null = null;
        let handler: (event: PluginEvent) => Promise<void>;

        if (typeof fnOrFilter === "function") {
          handler = fnOrFilter;
        } else {
          filter = fnOrFilter;
          if (!maybeFn) throw new Error("Handler function is required when a filter is provided");
          handler = maybeFn;
        }

        subsFor(pluginId).push({ eventPattern, filter, handler });
      },

      /**
       * Emit a plugin-namespaced event. The event type is automatically
       * prefixed with `plugin.<pluginId>.` so:
       * - `emit("sync-done", payload)` becomes `"plugin.acme.linear.sync-done"`.
       *
       * Requires the `events.emit` capability (enforced by the host layer).
       *
       * @throws {Error} if `name` already contains the `plugin.` prefix
       *   (prevents cross-namespace spoofing).
       */
      async emit(name: string, companyId: string, payload: unknown): Promise<PluginEventBusEmitResult> {
        if (!name || name.trim() === "") {
          throw new Error(`Plugin "${pluginId}" must provide a non-empty event name.`);
        }

        if (!companyId || companyId.trim() === "") {
          throw new Error(`Plugin "${pluginId}" must provide a companyId when emitting events.`);
        }

        if (name.startsWith("plugin.")) {
          throw new Error(
            `Plugin "${pluginId}" must not include the "plugin." prefix when emitting events. ` +
            `Emit the bare event name (e.g. "sync-done") and the bus will namespace it automatically.`,
          );
        }

        const eventType = `plugin.${pluginId}.${name}` as const;
        const event: PluginEvent = {
          eventId: crypto.randomUUID(),
          eventType,
          companyId,
          occurredAt: new Date().toISOString(),
          actorType: "plugin",
          actorId: pluginId,
          payload,
        };

        return emit(event);
      },

      /** Remove all subscriptions registered by this plugin. */
      clear(): void {
        clearPlugin(pluginId);
      },
    };
  }

  return {
    emit,
    forPlugin,
    clearPlugin,
    /** Expose subscription count for a plugin (useful for tests and diagnostics). */
    subscriptionCount(pluginId?: string): number {
      if (pluginId !== undefined) {
        return registry.get(pluginId)?.length ?? 0;
      }
      let total = 0;
      for (const subs of registry.values()) total += subs.length;
      return total;
    },
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned from `emit()`. Handler errors are collected and returned
 * rather than thrown so a single misbehaving plugin cannot block delivery to
 * other plugins.
 */
export interface PluginEventBusEmitResult {
  /** Errors thrown by individual handlers, keyed by the plugin that failed. */
  errors: Array<{ pluginId: string; error: unknown }>;
}

/**
 * The full event bus — held by the host process.
 *
 * Call `forPlugin(id)` to obtain a `ScopedPluginEventBus` for each plugin worker.
 */
export interface PluginEventBus {
  /**
   * Emit a typed domain event to all matching subscribers.
   *
   * Called by the host when a domain event occurs (e.g. from the DB layer or
   * message queue). All registered subscriptions across all plugins are checked.
   */
  emit(event: PluginEvent): Promise<PluginEventBusEmitResult>;

  /**
   * Get a scoped handle for a specific plugin worker.
   *
   * The scoped handle isolates the plugin's subscriptions and enforces the
   * plugin namespace on outbound events.
   */
  forPlugin(pluginId: string): ScopedPluginEventBus;

  /**
   * Remove all subscriptions for a plugin (called on worker shutdown/uninstall).
   */
  clearPlugin(pluginId: string): void;

  /**
   * Return the total number of active subscriptions, or the count for a
   * specific plugin if `pluginId` is provided.
   */
  subscriptionCount(pluginId?: string): number;
}

/**
 * A plugin-scoped view of the event bus. Handed to the plugin worker (or its
 * host-side proxy) during initialisation.
 *
 * Plugins use this to:
 * 1. Subscribe to domain events (with optional server-side filter).
 * 2. Emit plugin-namespaced events for other plugins to consume.
 *
 * Note: `subscribe` overloads mirror the `PluginEventsClient.on()` interface
 * from the SDK. `emit` intentionally returns `PluginEventBusEmitResult` rather
 * than `void` so the host layer can inspect handler errors; the SDK-facing
 * `PluginEventsClient.emit()` wraps this and returns `void`.
 */
export interface ScopedPluginEventBus {
  /**
   * Subscribe to a core domain event or a plugin-namespaced event.
   *
   * **Pattern syntax:**
   * - Exact match: `"issue.created"` — receives only that event type.
   * - Wildcard suffix: `"plugin.acme.linear.*"` — receives all events emitted by
   *   the `acme.linear` plugin. The `*` is supported only as a trailing token after
   *   a `.` separator; no other glob syntax is supported.
   * - Top-level plugin wildcard: `"plugin.*"` — receives all plugin-emitted events
   *   regardless of which plugin emitted them.
   *
   * Wildcards apply only to the `plugin.*` namespace. Core domain events must be
   * subscribed to by exact name (e.g. `"issue.created"`, not `"issue.*"`).
   *
   * An optional `EventFilter` can be passed as the second argument to perform
   * server-side pre-filtering; filtered-out events are never delivered to the handler.
   */
  subscribe(
    eventPattern: PluginEventType | `plugin.${string}`,
    fn: (event: PluginEvent) => Promise<void>,
  ): void;
  subscribe(
    eventPattern: PluginEventType | `plugin.${string}`,
    filter: EventFilter,
    fn: (event: PluginEvent) => Promise<void>,
  ): void;

  /**
   * Emit a plugin-namespaced event. The bus automatically prepends
   * `plugin.<pluginId>.` to the `name`, so passing `"sync-done"` from plugin
   * `"acme.linear"` produces the event type `"plugin.acme.linear.sync-done"`.
   *
   * @param name  Bare event name (e.g. `"sync-done"`). Must be non-empty and
   *   must not include the `plugin.` prefix — the bus adds that automatically.
   * @param companyId  UUID of the company this event belongs to.
   * @param payload  Arbitrary JSON-serializable data to attach to the event.
   *
   * @throws {Error} if `name` is empty or whitespace-only.
   * @throws {Error} if `name` starts with `"plugin."` (namespace spoofing guard).
   */
  emit(name: string, companyId: string, payload: unknown): Promise<PluginEventBusEmitResult>;

  /**
   * Remove all subscriptions registered by this plugin.
   */
  clear(): void;
}
