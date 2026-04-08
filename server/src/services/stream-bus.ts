/**
 * Generic in-memory pub/sub primitive.
 *
 * Keyed by (topic, key) pairs. Topic is a namespace ("plugin", "room",
 * "agent", ...), key scopes within the topic (e.g. pluginId:channel:companyId
 * for plugins, roomId for rooms, agentId for agents).
 *
 * Used by:
 *   - plugin-stream-bus.ts (topic = "plugin")
 *   - room-stream-bus.ts / agent-stream-bus.ts (Phase 4)
 *
 * Single-process only. For multi-process fanout, replace the subscribers
 * Map with a pg_notify or Redis pub/sub backend WITHOUT changing this API.
 *
 * @see docs/cos-v2/phase4-cli-design.md §7
 */

/** Lifecycle + content event types published on the bus. */
export type StreamBusEventType = "message" | "open" | "close" | "error";

export type StreamBusListener<E = unknown> = (
  event: E,
  meta: { type: StreamBusEventType },
) => void;

export interface StreamBus {
  /**
   * Subscribe to events on (topic, key). Returns an unsubscribe function.
   *
   * Multiple subscribers can listen to the same (topic, key). Each
   * published event is delivered to every live listener synchronously.
   */
  subscribe<E = unknown>(
    topic: string,
    key: string,
    listener: StreamBusListener<E>,
  ): () => void;

  /**
   * Publish an event to all subscribers of (topic, key).
   *
   * No-op if the (topic, key) pair has no subscribers. Listener errors
   * are swallowed — a misbehaving listener cannot break fanout to others.
   */
  publish<E = unknown>(
    topic: string,
    key: string,
    event: E,
    type?: StreamBusEventType,
  ): void;

  /** Observability: per-(topic, key) subscriber count. */
  stats(): Array<{ topic: string; key: string; count: number }>;

  /** Test helper: drop all subscribers. */
  clear(): void;
}

/**
 * Compose (topic, key) into a single Map key using a NUL byte separator
 * (0x00 can never appear in either arg because both are user-provided
 * identifiers drawn from [a-zA-Z0-9:_-]).
 */
function composeKey(topic: string, key: string): string {
  return `${topic}\u0000${key}`;
}

function splitKey(composite: string): { topic: string; key: string } {
  const sep = composite.indexOf("\u0000");
  return {
    topic: composite.slice(0, sep),
    key: composite.slice(sep + 1),
  };
}

export function createStreamBus(): StreamBus {
  const subscribers = new Map<string, Set<StreamBusListener>>();

  return {
    subscribe(topic, key, listener) {
      const composite = composeKey(topic, key);
      let set = subscribers.get(composite);
      if (!set) {
        set = new Set();
        subscribers.set(composite, set);
      }
      set.add(listener as StreamBusListener);

      return () => {
        const existing = subscribers.get(composite);
        if (!existing) return;
        existing.delete(listener as StreamBusListener);
        if (existing.size === 0) {
          subscribers.delete(composite);
        }
      };
    },

    publish(topic, key, event, type = "message") {
      const composite = composeKey(topic, key);
      const set = subscribers.get(composite);
      if (!set || set.size === 0) return;
      // Snapshot the listener set so that unsubscribe-during-iteration
      // doesn't skip listeners or iterate stale references.
      const snapshot = Array.from(set);
      for (const listener of snapshot) {
        try {
          listener(event, { type });
        } catch {
          // Swallow — one bad subscriber must not affect fanout to others.
          // (Logging is a domain concern; primitive stays silent.)
        }
      }
    },

    stats() {
      const out: Array<{ topic: string; key: string; count: number }> = [];
      for (const [composite, set] of subscribers) {
        const { topic, key } = splitKey(composite);
        out.push({ topic, key, count: set.size });
      }
      return out;
    },

    clear() {
      subscribers.clear();
    },
  };
}
