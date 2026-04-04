/**
 * Prometheus metrics for the Paperclip server.
 *
 * Enabled when PAPERCLIP_METRICS_ENABLED=true (or PAPERCLIP_OTEL_ENDPOINT is set).
 * Exposes a /metrics endpoint for Prometheus scraping.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({ service: "paperclip-server" });

/** Collect Node.js default process metrics (memory, CPU, event loop lag, etc.) */
collectDefaultMetrics({ register: metricsRegistry });

/** Total heartbeat runs, labelled by agent_id and final status */
export const heartbeatRunsTotal = new Counter({
  name: "paperclip_heartbeat_runs_total",
  help: "Total number of heartbeat runs that have completed or failed",
  labelNames: ["agent_id", "status"],
  registers: [metricsRegistry],
});

/** Heartbeat run wall-clock duration in seconds */
export const heartbeatDurationSeconds = new Histogram({
  name: "paperclip_heartbeat_duration_seconds",
  help: "Heartbeat run duration in seconds",
  labelNames: ["agent_id"],
  buckets: [5, 15, 30, 60, 120, 300, 600, 900, 1800],
  registers: [metricsRegistry],
});

/** Currently active (running/queued) heartbeat runs */
export const heartbeatRunsActive = new Gauge({
  name: "paperclip_heartbeat_runs_active",
  help: "Number of currently active (running or queued) heartbeat runs",
  registers: [metricsRegistry],
});

/** Stalled runs: active for > 15 minutes without completing */
export const heartbeatRunsStalled = new Gauge({
  name: "paperclip_heartbeat_runs_stalled",
  help: "Number of runs active for more than 15 minutes (stalled threshold)",
  registers: [metricsRegistry],
});

/** Total tokens consumed, labelled by agent_id, model, and token_type (input/output) */
export const tokensUsedTotal = new Counter({
  name: "paperclip_tokens_used_total",
  help: "Total LLM tokens consumed",
  labelNames: ["agent_id", "model", "token_type"],
  registers: [metricsRegistry],
});

/** HTTP request count, labelled by method, route, and status_code */
export const httpRequestsTotal = new Counter({
  name: "paperclip_http_requests_total",
  help: "Total HTTP requests handled",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

/** HTTP request duration histogram */
export const httpRequestDurationSeconds = new Histogram({
  name: "paperclip_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

/** Budget utilization per agent (percentage 0–100) */
export const agentBudgetUsedPercent = new Gauge({
  name: "paperclip_agent_budget_used_percent",
  help: "Agent monthly budget utilization percentage",
  labelNames: ["agent_id"],
  registers: [metricsRegistry],
});

export function isMetricsEnabled(): boolean {
  return (
    process.env.PAPERCLIP_METRICS_ENABLED === "true" ||
    Boolean(process.env.PAPERCLIP_OTEL_ENDPOINT)
  );
}
