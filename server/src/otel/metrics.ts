/**
 * OpenTelemetry metric definitions for Paperclip server.
 *
 * Uses the OTel Metrics API so counters/histograms are no-ops when no
 * MeterProvider is registered (i.e. when tracing-only or OTel is off).
 * All metrics use the `paperclip_` prefix for easy identification.
 */
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("paperclip-server");

// --- HTTP metrics ---

export const httpRequestsTotal = meter.createCounter("paperclip_http_requests_total", {
  description: "Total number of HTTP requests",
});

export const httpRequestDuration = meter.createHistogram("paperclip_http_request_duration_seconds", {
  description: "HTTP request duration in seconds",
  unit: "s",
});

// --- Heartbeat metrics ---

export const heartbeatActive = meter.createUpDownCounter("paperclip_heartbeat_active", {
  description: "Number of currently active heartbeat executions",
});

export const heartbeatDuration = meter.createHistogram("paperclip_heartbeat_duration_seconds", {
  description: "Heartbeat execution duration in seconds",
  unit: "s",
});

export const heartbeatRunsTotal = meter.createCounter("paperclip_heartbeat_runs_total", {
  description: "Total number of heartbeat runs by outcome",
});

// --- Plugin tool call metrics ---

export const toolCallsTotal = meter.createCounter("paperclip_tool_calls_total", {
  description: "Total number of plugin tool calls",
});

export const toolCallDuration = meter.createHistogram("paperclip_tool_call_duration_seconds", {
  description: "Plugin tool call duration in seconds",
  unit: "s",
});

// --- LLM / adapter metrics ---

export const llmCallsTotal = meter.createCounter("paperclip_llm_calls_total", {
  description: "Total number of LLM adapter invocations",
});

export const llmTokensTotal = meter.createCounter("paperclip_llm_tokens_total", {
  description: "Total LLM tokens consumed",
});

export const costCentsTotal = meter.createCounter("paperclip_cost_cents_total", {
  description: "Total cost in cents across all providers",
});
