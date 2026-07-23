/**
 * Shared trace context utilities for telemetry handlers.
 */

import { trace, context, type Context } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Resolve a parent OTel context from the server-propagated trace context
 * in a plugin event payload. Returns undefined when no valid trace context
 * is present.
 *
 * This replaces duplicated inline blocks that extracted event.traceContext
 * into a remote SpanContext across trace-handlers, activity-handlers, and
 * session-handlers.
 */
export function parentCtxFromServerTrace(event: PluginEvent): Context | undefined {
  const tc = event.traceContext;
  if (!tc?.traceId || !tc?.spanId) return undefined;

  return trace.setSpanContext(context.active(), {
    traceId: tc.traceId,
    spanId: tc.spanId,
    traceFlags: tc.traceFlags ?? 1,
    isRemote: true,
  });
}
