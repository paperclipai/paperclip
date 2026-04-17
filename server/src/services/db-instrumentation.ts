/**
 * Lightweight database instrumentation for critical path queries.
 *
 * Wraps Drizzle query execution with timing, creates a server-side OTel span,
 * and emits `db.query.completed` plugin events. Bypasses the activity log to
 * avoid recursive DB writes — events go directly to the plugin event bus.
 *
 * Usage:
 *   const rows = await instrumentQuery(
 *     { operation: "select", table: "issues", description: "checkout lookup" },
 *     () => db.select().from(issues).where(eq(issues.id, id)),
 *   );
 */

import { randomUUID } from "node:crypto";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { extractTraceContext } from "./trace-context.js";
import { logger } from "../middleware/logger.js";

const TRACER_NAME = "paperclip-server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let _eventBus: PluginEventBus | null = null;

/** Wire the plugin event bus for DB query events. */
export function setDbInstrumentationEventBus(bus: PluginEventBus): void {
  _eventBus = bus;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryDescriptor {
  /** SQL operation: select, insert, update, delete */
  operation: string;
  /** Primary table being queried */
  table: string;
  /** Human-readable description of the query purpose */
  description?: string;
  /** Originating company ID (for event routing) */
  companyId?: string;
  /** Agent ID that triggered this query (if known) */
  agentId?: string;
  /** Run ID that triggered this query (if known) */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Core instrumentation
// ---------------------------------------------------------------------------

/**
 * Execute a database query with timing, tracing, and event emission.
 *
 * Creates a short-lived OTel span (`db.query`) as a child of the active
 * context, then emits a `db.query.completed` plugin event with duration,
 * table, operation, and row count.
 */
export async function instrumentQuery<T>(
  descriptor: QueryDescriptor,
  queryFn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const spanName = `db.${descriptor.operation} ${descriptor.table}`;

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": descriptor.operation,
        "db.sql.table": descriptor.table,
        ...(descriptor.description
          ? { "db.query.summary": descriptor.description }
          : {}),
      },
    },
    async (span) => {
      const startMs = performance.now();
      try {
        const result = await queryFn();
        const durationMs = Math.round(performance.now() - startMs);

        const rowCount = Array.isArray(result) ? result.length : undefined;

        span.setAttributes({
          "db.query.duration_ms": durationMs,
          ...(rowCount !== undefined ? { "db.response.rows": rowCount } : {}),
        });

        // Fire-and-forget event emission
        emitDbQueryEvent(descriptor, durationMs, rowCount);

        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - startMs);
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(err),
        });

        emitDbQueryEvent(descriptor, durationMs, undefined, String(err));

        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Event emission (fire-and-forget, never throws)
// ---------------------------------------------------------------------------

function emitDbQueryEvent(
  descriptor: QueryDescriptor,
  durationMs: number,
  rowCount: number | undefined,
  error?: string,
): void {
  if (!_eventBus) return;

  const traceContext = extractTraceContext();

  const event: PluginEvent = {
    eventId: randomUUID(),
    eventType: "db.query.completed" as PluginEvent["eventType"],
    occurredAt: new Date().toISOString(),
    actorId: descriptor.agentId ?? "system",
    actorType: descriptor.agentId ? "agent" : "system",
    entityId: descriptor.table,
    entityType: "db_table",
    companyId: descriptor.companyId ?? "",
    payload: {
      operation: descriptor.operation,
      table: descriptor.table,
      description: descriptor.description ?? null,
      durationMs,
      rowCount: rowCount ?? null,
      error: error ?? null,
      agentId: descriptor.agentId ?? null,
      runId: descriptor.runId ?? null,
    },
    ...(traceContext ? { traceContext } : {}),
  };

  void _eventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error: err } of errors) {
      logger.warn(
        { pluginId, eventType: event.eventType, err },
        "plugin event handler failed for db.query.completed",
      );
    }
  }).catch(() => {});
}
