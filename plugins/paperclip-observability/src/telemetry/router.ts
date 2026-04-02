/**
 * Event telemetry router — dispatches Paperclip domain events to typed handlers.
 *
 * Each handler is a pure-ish async function focused on one telemetry concern
 * (metrics, traces, or logs). The router calls all registered handlers for a
 * given event type via Promise.allSettled so a single handler failure never
 * blocks the others.
 */

import type { Meter, Tracer, Span } from "@opentelemetry/api";
import type {
  PluginEvent,
  PluginStateClient,
  PluginLogger,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// TelemetryContext — passed to every handler
// ---------------------------------------------------------------------------

export interface TelemetryContext {
  meter: Meter;
  tracer: Tracer;
  state: PluginStateClient;
  logger: PluginLogger;

  /** Active run spans — keyed by runId, kept open until run.finished/failed/cancelled. */
  activeRunSpans: Map<string, Span>;

  /** Active issue lifecycle spans — keyed by issueId. */
  activeIssueSpans: Map<string, Span>;
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type EventHandler = (
  event: PluginEvent,
  ctx: TelemetryContext,
) => Promise<void>;

// ---------------------------------------------------------------------------
// EventTelemetryRouter
// ---------------------------------------------------------------------------

export class EventTelemetryRouter {
  private handlers = new Map<string, EventHandler[]>();

  /** Register a handler for a specific event type. */
  register(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(eventType, [handler]);
    }
  }

  /** Dispatch an event to all matching handlers via Promise.allSettled. */
  async dispatch(event: PluginEvent, ctx: TelemetryContext): Promise<void> {
    const list = this.handlers.get(event.eventType);
    if (!list || list.length === 0) return;

    const results = await Promise.allSettled(
      list.map((handler) => handler(event, ctx)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        ctx.logger.error("Telemetry handler failed", {
          eventType: event.eventType,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  }
}
