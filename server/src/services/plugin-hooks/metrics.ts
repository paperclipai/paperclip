/**
 * Telemetry adapter for plugin-hook execution. Wraps the existing
 * `TelemetryClient.track()` event surface so the apply layer can emit
 * `paperclip_plugin_hook_*` style metrics without touching the underlying
 * client directly.
 *
 * Phase 1b deliberately routes through the existing event-based telemetry
 * (no new prom-style histogram). When/if the host gains a histogram surface
 * we replace this adapter without touching `apply.ts`.
 */

import type { PluginHookErrorReason, PluginHookKind, PluginHookSkipReason } from "./types.js";

export interface HookTelemetrySink {
  recordApplied(args: {
    hook: PluginHookKind;
    pluginId: string;
    pluginKey: string;
    durationMs: number;
  }): void;
  recordSkipped(args: {
    hook: PluginHookKind;
    pluginId: string;
    pluginKey: string;
    reason: PluginHookSkipReason;
  }): void;
  recordError(args: {
    hook: PluginHookKind;
    pluginId: string;
    pluginKey: string;
    reason: PluginHookErrorReason;
    durationMs: number;
  }): void;
}

/** Minimal subset of the shared `TelemetryClient` we depend on. */
export interface MinimalTelemetryClient {
  track(eventName: `plugin.${string}`, dimensions?: Record<string, string | number | boolean>): void;
}

/**
 * Default sink that forwards to the running telemetry client (if any). When
 * telemetry is disabled, every method is a no-op so the apply path stays
 * allocation-free.
 */
export function createTelemetrySink(client: MinimalTelemetryClient | null): HookTelemetrySink {
  if (!client) return NOOP_SINK;
  return {
    recordApplied({ hook, pluginId, pluginKey, durationMs }) {
      client.track("plugin.hook.applied", {
        hook,
        pluginId,
        pluginKey,
        durationMs: roundMicros(durationMs),
      });
    },
    recordSkipped({ hook, pluginId, pluginKey, reason }) {
      client.track("plugin.hook.skipped", {
        hook,
        pluginId,
        pluginKey,
        reason,
      });
    },
    recordError({ hook, pluginId, pluginKey, reason, durationMs }) {
      client.track("plugin.hook.error", {
        hook,
        pluginId,
        pluginKey,
        reason,
        durationMs: roundMicros(durationMs),
      });
    },
  };
}

function roundMicros(ms: number): number {
  // Cap precision at 0.001 ms so the dimension cardinality stays bounded for
  // downstream aggregation.
  return Math.round(ms * 1_000) / 1_000;
}

export const NOOP_SINK: HookTelemetrySink = Object.freeze({
  recordApplied() {},
  recordSkipped() {},
  recordError() {},
});
