/**
 * Log event handlers — structured log emission via OTel Logs API.
 *
 * Each handler emits structured log records via the OTel Logger for export
 * to an OTLP collector. Logs include common Paperclip attributes for
 * correlation with metrics and traces.
 *
 * Falls back to the plugin logger when OTel logs are disabled.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { context, trace } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commonAttributes(
  event: PluginEvent,
): Record<string, string | undefined> {
  const p = event.payload as Record<string, unknown>;
  return {
    "paperclip.company.id": String(p.companyId ?? ""),
    "paperclip.event.type": event.eventType,
    "paperclip.actor.type": p.actorType ? String(p.actorType) : "agent",
    "paperclip.actor.id": String(p.agentId ?? p.actorId ?? ""),
    "paperclip.entity.type": entityType(event.eventType),
    "paperclip.entity.id": String(
      p.runId ?? p.id ?? p.issueId ?? p.approvalId ?? "",
    ),
  };
}

function entityType(eventType: string): string {
  if (eventType.startsWith("agent.run.")) return "run";
  if (eventType.startsWith("agent.session.")) return "session";
  if (eventType.startsWith("agent.")) return "agent";
  if (eventType.startsWith("issue.")) return "issue";
  if (eventType.startsWith("approval.")) return "approval";
  if (eventType.startsWith("cost_event.")) return "cost_event";
  return "unknown";
}

function emitLog(
  ctx: TelemetryContext,
  severityText: string,
  severityNumber: SeverityNumber,
  body: string,
  attributes: Record<string, string | number | undefined>,
): void {
  // Filter out undefined values
  const cleanAttrs: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  if (ctx.otelLogger) {
    // Include trace context for correlation when available
    const activeCtx = context.active();
    const spanCtx = trace.getSpanContext(activeCtx);

    ctx.otelLogger.emit({
      severityText,
      severityNumber,
      body,
      attributes: cleanAttrs,
      ...(spanCtx
        ? { context: activeCtx }
        : {}),
    });
  }

  // Also log via plugin logger for local visibility
  const logFn =
    severityNumber >= SeverityNumber.ERROR
      ? ctx.logger.error
      : severityNumber >= SeverityNumber.WARN
        ? ctx.logger.warn
        : ctx.logger.info;
  logFn.call(ctx.logger, body, cleanAttrs);
}

// ---------------------------------------------------------------------------
// agent.run.started — info log
// ---------------------------------------------------------------------------

export async function handleRunStartedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? "unknown");
  const runId = String(p.runId ?? "");

  emitLog(
    ctx,
    "INFO",
    SeverityNumber.INFO,
    `Agent ${agentName} started run ${runId}`,
    {
      ...commonAttributes(event),
      "paperclip.run.id": runId,
      "paperclip.agent.name": agentName,
      "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
      "paperclip.run.trigger_detail": String(p.triggerDetail ?? ""),
    },
  );
}

// ---------------------------------------------------------------------------
// agent.run.finished — info log
// ---------------------------------------------------------------------------

export async function handleRunFinishedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? "unknown");
  const durationMs = p.durationMs != null ? Number(p.durationMs) : undefined;

  emitLog(
    ctx,
    "INFO",
    SeverityNumber.INFO,
    `Agent ${agentName} completed run in ${durationMs ?? "?"}ms`,
    {
      ...commonAttributes(event),
      "paperclip.run.id": String(p.runId ?? ""),
      "paperclip.agent.name": agentName,
      "paperclip.run.duration_ms": durationMs,
      "paperclip.run.exit_code":
        p.exitCode != null ? Number(p.exitCode) : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// agent.run.failed — error log
// ---------------------------------------------------------------------------

export async function handleRunFailedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? "unknown");
  const error = String(p.error ?? "unknown");

  emitLog(
    ctx,
    "ERROR",
    SeverityNumber.ERROR,
    `Agent ${agentName} run failed: ${error}`,
    {
      ...commonAttributes(event),
      "paperclip.run.id": String(p.runId ?? ""),
      "paperclip.agent.name": agentName,
      "error.type": String(p.errorCode ?? "run_failed"),
      "paperclip.run.exit_code":
        p.exitCode != null ? Number(p.exitCode) : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// agent.status_changed — warn/info log
// ---------------------------------------------------------------------------

export async function handleAgentStatusChangedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = String(p.status ?? "unknown");
  const isError = status === "paused" || status === "error";

  emitLog(
    ctx,
    isError ? "WARN" : "INFO",
    isError ? SeverityNumber.WARN : SeverityNumber.INFO,
    `Agent status changed to ${status}`,
    {
      ...commonAttributes(event),
      "paperclip.agent.status": status,
      "paperclip.agent.previous_status": String(p.previousStatus ?? ""),
      "paperclip.agent.pause_reason": p.pauseReason
        ? String(p.pauseReason)
        : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// issue.created — info log
// ---------------------------------------------------------------------------

export async function handleIssueCreatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  emitLog(ctx, "INFO", SeverityNumber.INFO, "Issue created", {
    ...commonAttributes(event),
    "paperclip.issue.identifier": String(p.identifier ?? ""),
    "paperclip.issue.title": String(p.title ?? ""),
    "paperclip.project.id": String(p.projectId ?? ""),
    "paperclip.issue.priority": String(p.priority ?? "medium"),
  });
}

// ---------------------------------------------------------------------------
// issue.updated — info log for transitions
// ---------------------------------------------------------------------------

export async function handleIssueUpdatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  emitLog(ctx, "INFO", SeverityNumber.INFO, "Issue updated", {
    ...commonAttributes(event),
    "paperclip.issue.identifier": String(p.identifier ?? ""),
    "paperclip.issue.status": String(p.status ?? "unknown"),
    "paperclip.issue.previous_status": String(p.previousStatus ?? ""),
    "paperclip.project.id": String(p.projectId ?? ""),
  });
}

// ---------------------------------------------------------------------------
// approval.created — info log
// ---------------------------------------------------------------------------

export async function handleApprovalCreatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  emitLog(ctx, "INFO", SeverityNumber.INFO, "Approval created", {
    ...commonAttributes(event),
    "paperclip.approval.id": String(p.id ?? ""),
  });
}

// ---------------------------------------------------------------------------
// approval.decided — info log
// ---------------------------------------------------------------------------

export async function handleApprovalDecidedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  emitLog(
    ctx,
    "INFO",
    SeverityNumber.INFO,
    `Approval ${String(p.decision ?? "unknown")}`,
    {
      ...commonAttributes(event),
      "paperclip.approval.id": String(p.id ?? ""),
      "paperclip.approval.decision": String(p.decision ?? "unknown"),
    },
  );
}

// ---------------------------------------------------------------------------
// cost_event.created — info log
// ---------------------------------------------------------------------------

export async function handleCostEventLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const provider = String(p.provider ?? "unknown");
  const model = String(p.model ?? "unknown");
  const tokens =
    (Number(p.inputTokens ?? 0) || 0) + (Number(p.outputTokens ?? 0) || 0);
  const cost = Number(p.costCents ?? 0) / 100;

  emitLog(
    ctx,
    "INFO",
    SeverityNumber.INFO,
    `${provider}/${model}: ${tokens} tokens, $${cost.toFixed(4)}`,
    {
      ...commonAttributes(event),
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": model,
      "gen_ai.usage.input_tokens": Number(p.inputTokens ?? 0),
      "gen_ai.usage.output_tokens": Number(p.outputTokens ?? 0),
      "paperclip.cost.cents": Number(p.costCents ?? 0),
      "paperclip.billing.type": String(p.billingType ?? ""),
    },
  );
}
