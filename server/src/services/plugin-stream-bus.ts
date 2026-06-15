/**
 * In-memory pub/sub bus for plugin SSE streams.
 *
 * Workers emit stream events via JSON-RPC notifications. The bus fans out
 * each event to all connected SSE clients that match the (pluginId, channel,
 * companyId) tuple.
 *
 * @see PLUGIN_SPEC.md §19.8 — Real-Time Streaming
 */

/** Valid SSE event types for plugin streams. */
export type StreamEventType = "message" | "open" | "close" | "error";

export type StreamSubscriber = (event: unknown, eventType: StreamEventType) => void;

/**
 * Composite key for stream subscriptions: pluginId:channel:companyId
 */
function streamKey(pluginId: string, channel: string, companyId: string): string {
  return `${pluginId}:${channel}:${companyId}`;
}

export interface PluginStreamBus {
  /**
   * Subscribe to stream events for a specific (pluginId, channel, companyId).
   * Returns an unsubscribe function.
   */
  subscribe(
    pluginId: string,
    channel: string,
    companyId: string,
    listener: StreamSubscriber,
  ): () => void;

  /**
   * Publish an event to all subscribers of (pluginId, channel, companyId).
   * Called by the worker manager when it receives a stream notification.
   */
  publish(
    pluginId: string,
    channel: string,
    companyId: string,
    event: unknown,
    eventType?: StreamEventType,
  ): void;
}

/**
 * Map a worker stream notification (`streams.open` / `streams.emit` /
 * `streams.close`, as forwarded by the worker manager) onto a bus publish.
 * Drops notifications missing a channel or companyId. Shared so every caller
 * that wires the manager's stream handler maps event types identically.
 */
export function publishWorkerStreamNotification(
  bus: PluginStreamBus,
  pluginId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const channel = typeof params.channel === "string" ? params.channel : "";
  const companyId = typeof params.companyId === "string" ? params.companyId : "";
  if (!channel || !companyId) return;
  const eventType: StreamEventType =
    method === "streams.open" ? "open" : method === "streams.close" ? "close" : "message";
  bus.publish(pluginId, channel, companyId, (params as { event?: unknown }).event ?? null, eventType);
}

/**
 * Create a new PluginStreamBus instance.
 */
export function createPluginStreamBus(): PluginStreamBus {
  const subscribers = new Map<string, Set<StreamSubscriber>>();

  return {
    subscribe(pluginId, channel, companyId, listener) {
      const key = streamKey(pluginId, channel, companyId);
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(listener);

      return () => {
        set!.delete(listener);
        if (set!.size === 0) {
          subscribers.delete(key);
        }
      };
    },

    publish(pluginId, channel, companyId, event, eventType: StreamEventType = "message") {
      const key = streamKey(pluginId, channel, companyId);
      const set = subscribers.get(key);
      if (!set) return;
      for (const listener of set) {
        listener(event, eventType);
      }
    },
  };
}
