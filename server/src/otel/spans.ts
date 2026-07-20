/**
 * Span helper wrappers for instrumenting Paperclip execution paths.
 *
 * Each function creates a named span, runs the provided callback within it,
 * records attributes, and properly handles errors. Uses the OTel API tracer
 * directly — spans are no-ops when no TracerProvider is registered (i.e.
 * when OTEL_EXPORTER_OTLP_ENDPOINT is unset).
 *
 * Works with the existing instrumentation.ts auto-instrumentation: custom
 * spans nest inside the auto-generated HTTP/Express spans.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import {
  heartbeatActive,
  heartbeatDuration,
  heartbeatRunsTotal,
  toolCallsTotal,
  toolCallDuration,
  llmCallsTotal,
  llmTokensTotal,
  costCentsTotal,
} from "./metrics.js";

const TRACER_NAME = "paperclip-server";

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Wrap the entire heartbeat executeRun() call in a root span.
 */
export async function withHeartbeatSpan<T>(
  attrs: {
    runId: string;
    agentId: string;
    agentName?: string;
    issueId?: string | null;
    companyId?: string;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan("heartbeat.execute", async (span) => {
    const startTime = performance.now();
    heartbeatActive.add(1);

    span.setAttributes({
      "heartbeat.run_id": attrs.runId,
      "heartbeat.agent_id": attrs.agentId,
      ...(attrs.agentName ? { "heartbeat.agent_name": attrs.agentName } : {}),
      ...(attrs.issueId ? { "heartbeat.issue_id": attrs.issueId } : {}),
      ...(attrs.companyId ? { "heartbeat.company_id": attrs.companyId } : {}),
    });

    let outcome = "succeeded";
    try {
      return await fn(span);
    } catch (err) {
      outcome = "failed";
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      const durationSec = (performance.now() - startTime) / 1000;
      heartbeatActive.add(-1);
      heartbeatDuration.record(durationSec, { status: outcome });
      heartbeatRunsTotal.add(1, { status: outcome });
      span.end();
    }
  });
}

/**
 * Create a child span for a sub-phase of heartbeat execution.
 */
export async function withHeartbeatChildSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap adapter.execute() in a span and record LLM metrics.
 */
export async function withAdapterSpan<T>(
  attrs: {
    adapterType: string;
    agentId: string;
    runId: string;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan("adapter.execute", async (span) => {
    span.setAttributes({
      "adapter.type": attrs.adapterType,
      "adapter.agent_id": attrs.agentId,
      "adapter.run_id": attrs.runId,
    });

    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Record LLM result metrics after adapter execution completes.
 * Call this inside the adapter span after getting the result.
 */
export function recordAdapterResult(
  span: Span,
  result: {
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
    billingType?: string | null;
  },
): void {
  const provider = result.provider ?? "unknown";
  const model = result.model ?? "unknown";

  span.setAttributes({
    "llm.provider": provider,
    "llm.model": model,
    ...(result.inputTokens != null ? { "llm.tokens.input": result.inputTokens } : {}),
    ...(result.outputTokens != null ? { "llm.tokens.output": result.outputTokens } : {}),
    ...(result.costUsd != null ? { "llm.cost_usd": result.costUsd } : {}),
  });

  llmCallsTotal.add(1, { provider, model });

  if (result.inputTokens != null && result.inputTokens > 0) {
    llmTokensTotal.add(result.inputTokens, { provider, model, type: "input" });
  }
  if (result.cachedInputTokens != null && result.cachedInputTokens > 0) {
    llmTokensTotal.add(result.cachedInputTokens, { provider, model, type: "cached_input" });
  }
  if (result.outputTokens != null && result.outputTokens > 0) {
    llmTokensTotal.add(result.outputTokens, { provider, model, type: "output" });
  }
  if (result.costUsd != null && result.costUsd > 0) {
    const costCents = Math.round(result.costUsd * 100);
    costCentsTotal.add(costCents, { provider, billing_type: result.billingType ?? "unknown" });
  }
}

/**
 * Wrap a plugin tool execution in a span.
 */
export async function withToolCallSpan<T>(
  attrs: {
    toolName: string;
    pluginId?: string;
    agentId?: string;
    runId?: string;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan("plugin.tool.execute", async (span) => {
    const startTime = performance.now();

    span.setAttributes({
      "tool.name": attrs.toolName,
      ...(attrs.pluginId ? { "tool.plugin_id": attrs.pluginId } : {}),
      ...(attrs.agentId ? { "tool.agent_id": attrs.agentId } : {}),
      ...(attrs.runId ? { "tool.run_id": attrs.runId } : {}),
    });

    let status = "success";
    try {
      return await fn(span);
    } catch (err) {
      status = "error";
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      const durationSec = (performance.now() - startTime) / 1000;
      toolCallsTotal.add(1, { tool: attrs.toolName, status });
      toolCallDuration.record(durationSec, { tool: attrs.toolName });
      span.end();
    }
  });
}

/**
 * Wrap an approval state transition in a span.
 */
export async function withApprovalSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap a cost event recording in a span.
 */
export async function withCostEventSpan<T>(
  attrs: {
    provider: string;
    model: string;
    costCents: number;
    billingType: string;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan("cost.record_event", async (span) => {
    span.setAttributes({
      "cost.provider": attrs.provider,
      "cost.model": attrs.model,
      "cost.cents": attrs.costCents,
      "cost.billing_type": attrs.billingType,
    });
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Get the current trace context for propagation to child processes.
 * Returns W3C Trace Context headers (traceparent, tracestate).
 */
export function getTraceContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    const traceFlags = spanContext.traceFlags.toString(16).padStart(2, "0");
    headers["traceparent"] = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
    if (spanContext.traceState) {
      headers["tracestate"] = spanContext.traceState.serialize();
    }
  }
  return headers;
}
