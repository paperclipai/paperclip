/**
 * Plugin-scoped SSE stream bus.
 *
 * Thin adapter over the generic StreamBus primitive (stream-bus.ts).
 * Preserves the original public API for the plugin system — callers
 * don't need to know about the underlying primitive.
 *
 * Workers emit stream events via JSON-RPC notifications. The bus fans
 * out each event to all connected SSE clients matching the
 * (pluginId, channel, companyId) tuple.
 *
 * @see PLUGIN_SPEC.md §19.8 — Real-Time Streaming
 * @see stream-bus.ts — generic primitive
 */

import { createStreamBus, type StreamBus } from "./stream-bus.js";

/** Valid SSE event types for plugin streams. */
export type StreamEventType = "message" | "open" | "close" | "error";

export type StreamSubscriber = (event: unknown, eventType: StreamEventType) => void;

const PLUGIN_TOPIC = "plugin";

/**
 * Composite key for plugin stream subscriptions.
 * Using ":" as the in-topic delimiter — pluginId/channel/companyId do
 * not contain colons in practice.
 */
function pluginKey(pluginId: string, channel: string, companyId: string): string {
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
 * Create a new PluginStreamBus.
 *
 * If a shared StreamBus instance is passed, the plugin bus delegates to
 * it — which lets the Phase 4 room/agent buses share the same underlying
 * primitive. If omitted, a fresh StreamBus is created for backward
 * compatibility with existing call sites that construct a standalone bus.
 */
export function createPluginStreamBus(
  base: StreamBus = createStreamBus(),
): PluginStreamBus {
  return {
    subscribe(pluginId, channel, companyId, listener) {
      return base.subscribe(
        PLUGIN_TOPIC,
        pluginKey(pluginId, channel, companyId),
        (event, meta) => listener(event, meta.type),
      );
    },

    publish(pluginId, channel, companyId, event, eventType = "message") {
      base.publish(
        PLUGIN_TOPIC,
        pluginKey(pluginId, channel, companyId),
        event,
        eventType,
      );
    },
  };
}
