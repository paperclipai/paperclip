/**
 * Database query event handlers — metrics and traces for DB operations.
 *
 * Handles `db.query.completed` events emitted by the server's DB
 * instrumentation layer. Records duration histograms and creates trace spans
 * nested under the active agent run span with OTel database semantic
 * conventions (db.system, db.operation, db.name, db.sql.table).
 */

import { SpanKind, SpanStatusCode, trace, context } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { parentCtxFromServerTrace } from "./trace-utils.js";
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// db.query.completed — metrics handler (duration histogram)
// ---------------------------------------------------------------------------

export async function handleDbQueryMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const operation = String(p.operation ?? "unknown");
  const table = String(p.table ?? "unknown");
  const durationMs = Number(p.durationMs ?? 0);
  const description = p.description ? String(p.description) : undefined;
  const error = p.error ? String(p.error) : undefined;

  const durationHist = ctx.meter.createHistogram(
    METRIC_NAMES.dbQueryDuration,
    {
      description: "Duration of database queries in milliseconds",
      unit: "ms",
    },
  );
  durationHist.record(durationMs, {
    db_operation: operation,
    db_table: table,
    ...(description ? { db_query: description } : {}),
    status: error ? "error" : "ok",
  });

  if (error) {
    const errorCounter = ctx.meter.createCounter(METRIC_NAMES.dbQueryErrors, {
      description: "Count of failed database queries",
    });
    errorCounter.add(1, {
      db_operation: operation,
      db_table: table,
    });
  }
}

// ---------------------------------------------------------------------------
// db.query.completed — trace handler (DB spans under agent run spans)
// ---------------------------------------------------------------------------

export async function handleDbQueryTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const operation = String(p.operation ?? "unknown");
  const table = String(p.table ?? "unknown");
  const durationMs = Number(p.durationMs ?? 0);
  const description = p.description ? String(p.description) : undefined;
  const error = p.error ? String(p.error) : undefined;
  const dbName = String(p.dbName ?? "paperclip");
  const rowCount = p.rowCount != null ? Number(p.rowCount) : undefined;
  const runId = p.runId ? String(p.runId) : undefined;
  const agentId = p.agentId ? String(p.agentId) : undefined;

  const spanName = `db.${operation} ${table}`;

  // OTel database semantic convention attributes (stable + v1.25+ forward compat)
  const spanAttrs: Record<string, string | number | boolean> = {
    "db.system": "postgresql",
    "db.name": dbName,
    "db.operation": operation,
    "db.sql.table": table,
    // New semconv (v1.25+)
    "db.system.name": "postgresql",
    "db.namespace": dbName,
    "db.operation.name": operation,
    "db.collection.name": table,
    "db.query.duration_ms": durationMs,
    ...(description ? { "db.query.summary": description } : {}),
    ...(rowCount !== undefined ? { "db.response.rows": rowCount } : {}),
    ...(agentId ? { "paperclip.agent.id": agentId } : {}),
    ...(runId ? { "paperclip.run.id": runId } : {}),
    status: error ? "error" : "ok",
  };

  // Resolve parent context: prefer the active run span so DB operations
  // appear as children of the agent's heartbeat run in the trace tree.
  let parentCtx: ReturnType<typeof context.active> | undefined;

  if (runId) {
    const runSpan = ctx.activeRunSpans.get(runId);
    if (runSpan) {
      parentCtx = trace.setSpan(context.active(), runSpan);
    } else {
      // Fallback: ended run span context (DB events may arrive after run.finished)
      const ended = ctx.endedRunSpanContexts.get(runId);
      if (ended) {
        parentCtx = trace.setSpanContext(context.active(), {
          traceId: ended.traceId,
          spanId: ended.spanId,
          traceFlags: ended.traceFlags,
          isRemote: true,
        });
      }
    }
  }

  // Fallback: use server-propagated trace context
  if (!parentCtx) {
    parentCtx = parentCtxFromServerTrace(event);
  }

  // Backdate the span for accurate timing
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - Math.max(1, durationMs);

  const span = parentCtx
    ? ctx.tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: spanAttrs, startTime: startTimeMs },
        parentCtx,
      )
    : ctx.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: spanAttrs,
        startTime: startTimeMs,
      });

  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.recordException(new Error(error));
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end(endTimeMs);
}
