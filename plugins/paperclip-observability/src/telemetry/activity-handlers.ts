/**
 * Activity event handlers — agent work pattern and tool usage telemetry.
 *
 * Handles activity.logged events to produce:
 *   - Span events as children of active run spans (trace correlation)
 *   - Activity count metrics by action and entity type
 *   - Structured logs for activity audit trail
 *   - gen_ai.tool.name attributes following OTel semantic conventions
 */

import { SpanKind, trace, context } from "@opentelemetry/api";
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

  // Track unique actor activity patterns
  const actorCounter = ctx.meter.createCounter(
    METRIC_NAMES.activityActorCount,
    { description: "Count of activity events by actor" },
  );
  actorCounter.add(1, {
    actor_type: actorType,
    actor_id: String(p.actorId ?? ""),
    company_id: companyId,
  });
}

// ---------------------------------------------------------------------------
// activity.logged — traces: span events as children of active run spans
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

  // Try to find the active run span for this activity
  let parentSpan = runId ? ctx.activeRunSpans.get(runId) : undefined;

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

  // If we have a parent run context, add a span event to it for correlation.
  // Otherwise create a standalone span.
  if (parentSpan) {
    // Add as a span event on the active run span (lightweight, preserves trace tree)
    const toolName = resolveToolName(action, entityType);
    parentSpan.addEvent("activity.logged", {
      "paperclip.activity.action": action,
      "paperclip.activity.entity_type": entityType,
      "paperclip.activity.entity_id": entityId,
      "paperclip.agent.id": agentId,
      "paperclip.company.id": companyId,
      ...(toolName ? { "gen_ai.tool.name": toolName } : {}),
    });
    return;
  }

  // Create a child span when we have restored parent context, or a root span otherwise
  const tracer = agentId
    ? ctx.getTracerForAgent(agentId, agentName)
    : ctx.tracer;

  const toolName = resolveToolName(action, entityType);

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

  const span = parentCtx
    ? tracer.startSpan(
        `activity ${action}`,
        { kind: SpanKind.INTERNAL, attributes: spanAttrs },
        parentCtx,
      )
    : tracer.startSpan(`activity ${action}`, {
        kind: SpanKind.INTERNAL,
        attributes: spanAttrs,
      });

  span.end();
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
