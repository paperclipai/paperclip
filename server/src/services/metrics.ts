/**
 * Paperclip runner Prometheus metrics.
 *
 * Exposes agent-state and LLM-call-failure metrics for scraping by Prometheus.
 * The /metrics HTTP endpoint is mounted outside the authenticated API router in app.ts
 * so that the Prometheus scraper can reach it without credentials.
 */
import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: "paperclip_node_" });

/**
 * Current state of each agent.
 * Values: 0 = idle/unknown, 1 = in_progress, 2 = degraded, 3 = error
 */
export const agentStateGauge = new Gauge({
  name: "paperclip_agent_state",
  help: "Current operational state of a Paperclip agent (0=idle, 1=in_progress, 2=degraded, 3=error)",
  labelNames: ["agent_id", "state"] as const,
  registers: [metricsRegistry],
});

/**
 * Total LLM call failures observed by the runner, broken down by agent and HTTP status code.
 */
export const llmCallFailuresCounter = new Counter({
  name: "paperclip_llm_call_failures_total",
  help: "Total number of LLM API call failures observed by the Paperclip runner",
  labelNames: ["agent_id", "status_code"] as const,
  registers: [metricsRegistry],
});

/**
 * Total rate-limit retry attempts emitted by the claude-local adapter backoff loop.
 */
export const llmRateLimitRetriesCounter = new Counter({
  name: "paperclip_llm_ratelimit_retries_total",
  help: "Total number of rate-limit retry attempts by the claude-local adapter",
  labelNames: ["agent_id"] as const,
  registers: [metricsRegistry],
});

/**
 * Duration (seconds) a heartbeat run spent in the rate-limit backoff retry loop.
 * Observe this when a run finally exits (success or budget exhaustion) after ≥1 retries.
 */
export const rateLimitRetryDurationHistogram = new Histogram({
  name: "paperclip_llm_ratelimit_retry_duration_seconds",
  help: "Duration spent in rate-limit retry backoff per heartbeat run",
  labelNames: ["agent_id"] as const,
  buckets: [5, 15, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});
