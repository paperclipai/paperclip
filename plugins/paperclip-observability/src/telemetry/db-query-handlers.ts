/**
 * Database query event handlers — metrics for DB operations.
 *
 * Handles `db.query.completed` events emitted by the server's DB
 * instrumentation layer. Records duration histograms for database call latency.
 *
 * Note: Trace spans are created server-side by `instrumentQuery` with accurate
 * start/end timing. The plugin only handles metrics to avoid duplicate spans.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
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
