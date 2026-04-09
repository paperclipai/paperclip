/**
 * Activity event handlers — agent work pattern and tool usage telemetry.
 *
 * Handles activity.logged events to produce:
 *   - Child spans for tool invocations (with duration, input summary, result status)
 *   - Span events for non-tool activities (lightweight, avoids span explosion)
 *   - Activity count metrics by action and entity type
 *   - Structured logs for activity audit trail
 *   - gen_ai.tool.name / gen_ai.tool.call.id attributes following OTel semantic conventions
 */

import { SpanKind, SpanStatusCode, trace, context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map activity actions to gen_ai.tool.name when applicable. */
function resolveToolName(action: string, entityType: string): string | null {
  if (entityType === "tool" || action.startsWith("tool.")) {
    return action.replace(/^tool\./, "");
  }
  // Map known entity types that represent tool invocations
  if (entityType === "file" || entityType === "api_call") {
    return `${entityType}.${action}`;
  }
  return null;
}

/** Determine if this activity represents a tool invocation that warrants a child span. */
function isToolActivity(action: string, entityType: string): boolean {
  return resolveToolName(action, entityType) !== null;
}

/** Extract duration from event details if available (milliseconds). */
function extractDurationMs(details: Record<string, unknown> | null): number | null {
  if (!details) return null;
  const d = details.durationMs ?? details.duration_ms ?? details.duration;
  if (typeof d === "number" && d >= 0) return d;
  return null;
}

/** Extract a compact input summary from event details. */
function extractInputSummary(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const input = details.input ?? details.inputSummary ?? details.input_summary ?? details.args;
  if (typeof input === "string") return input.slice(0, 256);
  if (input != null) {
    try {
      return JSON.stringify(input).slice(0, 256);
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract result status from event details. */
function extractResultStatus(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const s = details.resultStatus ?? details.result_status ?? details.status ?? details.result;
  if (typeof s === "string") return s;
  return null;
}

function emitLog(
  ctx: TelemetryContext,
  severityText: string,
  severityNumber: SeverityNumber,
  body: string,
  attributes: Record<string, string | number | undefined>,
): void {
  const cleanAttrs: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  if (ctx.otelLogger) {
    const activeCtx = context.active();
    const spanCtx = trace.getSpanContext(activeCtx);
    ctx.otelLogger.emit({
      severityText,
      severityNumber,
      body,
      attributes: cleanAttrs,
      ...(spanCtx ? { context: activeCtx } : {}),
    });
  }

  ctx.logger.info(body, cleanAttrs);
}

// ---------------------------------------------------------------------------
// activity.logged — metrics: activity count by action and entity type
// ---------------------------------------------------------------------------

export async function handleActivityMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const action = String(p.action ?? event.eventType ?? "unknown");
  const entityType = String(p.entityType ?? "unknown");
  const actorType = String(p.actorType ?? "unknown");
  const agentId = String(p.agentId ?? p.actorId ?? "");
  const companyId = String(p.companyId ?? event.companyId ?? "");

  const activityCounter = ctx.meter.createCounter(
    METRIC_NAMES.activityCount,
    { description: "Count of agent activity events by action and entity type" },
  );
  activityCounter.add(1, {
    action,
    entity_type: entityType,
    actor_type: actorType,
    agent_id: agentId,
    company_id: companyId,
  });

  // Track activity patterns by actor type (no actor_id to avoid cardinality explosion)
  const actorCounter = ctx.meter.createCounter(
    METRIC_NAMES.activityActorCount,
    { description: "Count of activity events by actor type" },
  );
  actorCounter.add(1, {
    actor_type: actorType,
    company_id: companyId,
  });
}

// ---------------------------------------------------------------------------
// activity.logged — traces: child spans for tools, span events for the rest
// ---------------------------------------------------------------------------

export async function handleActivityTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  const agentId = String(p.agentId ?? p.actorId ?? "");
  const agentName = String(p.agentName ?? "");
  const action = String(p.action ?? "unknown");
  const entityType = String(p.entityType ?? "unknown");
  const entityId = String(p.entityId ?? "");
  const companyId = String(p.companyId ?? event.companyId ?? "");
  const details = (p.details as Record<string, unknown> | null) ?? null;

  const toolName = resolveToolName(action, entityType);
  const isTool = isToolActivity(action, entityType);

  // Try to find the active run span for this activity
  const parentSpan = runId ? ctx.activeRunSpans.get(runId) : undefined;

  // Fallback: restore from plugin state if not in memory
  let parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined;

  if (!parentCtx && runId) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as { traceId: string; spanId: string; traceFlags: number };
      parentCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Tool invocations → proper child spans with duration
  // -----------------------------------------------------------------------
  if (isTool && (parentSpan || parentCtx)) {
    const tracer = agentId
      ? ctx.getTracerForAgent(agentId, agentName)
      : ctx.tracer;

    const durationMs = extractDurationMs(details);
    const inputSummary = extractInputSummary(details);
    const resultStatus = extractResultStatus(details);
    const toolCallId = details?.toolCallId ?? details?.tool_call_id ?? entityId;

    const spanAttrs: Record<string, string | number | boolean> = {
      "gen_ai.tool.name": toolName!,
      "gen_ai.operation.name": "tool_call",
      "paperclip.activity.action": action,
      "paperclip.activity.entity_type": entityType,
      "paperclip.activity.entity_id": entityId,
      "paperclip.agent.id": agentId,
      "paperclip.agent.name": agentName,
      "paperclip.company.id": companyId,
      "paperclip.run.id": runId,
    };

    if (toolCallId) {
      spanAttrs["gen_ai.tool.call.id"] = String(toolCallId);
    }
    if (inputSummary) {
      spanAttrs["gen_ai.tool.call.input"] = inputSummary;
    }
    if (resultStatus) {
      spanAttrs["gen_ai.tool.call.result_status"] = resultStatus;
    }
    if (durationMs !== null) {
      spanAttrs["paperclip.tool.duration_ms"] = durationMs;
    }

    // Compute start time: if we have duration, backdate the start
    const endTimeMs = Date.now();
    const startTimeMs = durationMs !== null ? endTimeMs - durationMs : endTimeMs;

    const spanContext = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : parentCtx!;

    const span = tracer.startSpan(
      toolName!,
      {
        kind: SpanKind.INTERNAL,
        attributes: spanAttrs,
        startTime: startTimeMs,
      },
      spanContext,
    );

    // Set span status based on result
    if (resultStatus === "error" || resultStatus === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: resultStatus });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end(endTimeMs);
    return;
  }

  // -----------------------------------------------------------------------
  // Non-tool activities with an in-memory parent → lightweight span events
  // -----------------------------------------------------------------------
  if (parentSpan && !isTool) {
    parentSpan.addEvent("activity.logged", {
      "paperclip.activity.action": action,
      "paperclip.activity.entity_type": entityType,
      "paperclip.activity.entity_id": entityId,
      "paperclip.agent.id": agentId,
      "paperclip.company.id": companyId,
    });
    return;
  }

  // -----------------------------------------------------------------------
  // Fallback: standalone span (no parent context available)
  // -----------------------------------------------------------------------
  const tracer = agentId
    ? ctx.getTracerForAgent(agentId, agentName)
    : ctx.tracer;

  const spanAttrs: Record<string, string | number | boolean> = {
    "paperclip.activity.action": action,
    "paperclip.activity.entity_type": entityType,
    "paperclip.activity.entity_id": entityId,
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.company.id": companyId,
    ...(runId ? { "paperclip.run.id": runId } : {}),
    ...(toolName
      ? { "gen_ai.tool.name": toolName, "gen_ai.operation.name": "tool_call" }
      : {}),
  };

  // For tool activities without parent context, still create a richer span
  if (isTool && toolName) {
    const durationMs = extractDurationMs(details);
    const inputSummary = extractInputSummary(details);
    const resultStatus = extractResultStatus(details);
    const toolCallId = details?.toolCallId ?? details?.tool_call_id ?? entityId;

    if (toolCallId) spanAttrs["gen_ai.tool.call.id"] = String(toolCallId);
    if (inputSummary) spanAttrs["gen_ai.tool.call.input"] = inputSummary;
    if (resultStatus) spanAttrs["gen_ai.tool.call.result_status"] = resultStatus;
    if (durationMs !== null) spanAttrs["paperclip.tool.duration_ms"] = durationMs;

    const endTimeMs = Date.now();
    const startTimeMs = durationMs !== null ? endTimeMs - durationMs : endTimeMs;

    const span = tracer.startSpan(toolName, {
      kind: SpanKind.INTERNAL,
      attributes: spanAttrs,
      startTime: startTimeMs,
    });

    if (resultStatus === "error" || resultStatus === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: resultStatus });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end(endTimeMs);
  } else {
    const span = tracer.startSpan(`activity ${action}`, {
      kind: SpanKind.INTERNAL,
      attributes: spanAttrs,
    });
    span.end();
  }
}

// ---------------------------------------------------------------------------
// activity.logged — logs: structured log for audit trail
// ---------------------------------------------------------------------------

export async function handleActivityLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const action = String(p.action ?? "unknown");
  const entityType = String(p.entityType ?? "unknown");
  const entityId = String(p.entityId ?? "");
  const actorType = String(p.actorType ?? "unknown");
  const actorId = String(p.actorId ?? "");
  const agentId = String(p.agentId ?? "");
  const message = String(p.message ?? `${actorType} ${actorId}: ${action} on ${entityType} ${entityId}`);

  emitLog(
    ctx,
    "INFO",
    SeverityNumber.INFO,
    message,
    {
      "paperclip.event.type": "activity.logged",
      "paperclip.activity.action": action,
      "paperclip.activity.entity_type": entityType,
      "paperclip.activity.entity_id": entityId,
      "paperclip.actor.type": actorType,
      "paperclip.actor.id": actorId,
      "paperclip.agent.id": agentId,
      "paperclip.run.id": p.runId ? String(p.runId) : undefined,
      "paperclip.company.id": String(p.companyId ?? event.companyId ?? ""),
    },
  );
}
