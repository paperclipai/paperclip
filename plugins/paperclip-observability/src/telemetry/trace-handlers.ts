/**
 * Trace event handlers — span lifecycle management.
 *
 * Each handler creates, updates, or ends OTel spans in response to Paperclip
 * domain events. Span references are stored in TelemetryContext maps and
 * persisted to plugin state for cross-restart resilience.
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { mapProvider } from "../provider-map.js";

// ---------------------------------------------------------------------------
// agent.run.started — create root run span
// ---------------------------------------------------------------------------

export async function handleRunStartedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");

  const span = ctx.tracer.startSpan("paperclip.heartbeat.run", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "paperclip.agent.id": String(p.agentId ?? ""),
      "paperclip.run.id": runId,
      "paperclip.company.id": String(p.companyId ?? ""),
      "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
      "paperclip.run.trigger_detail": String(p.triggerDetail ?? ""),
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": String(p.agentId ?? ""),
      "gen_ai.agent.name": String(p.agentName ?? ""),
    },
  });

  if (runId) {
    ctx.activeRunSpans.set(runId, span);

    await ctx.state
      .set(
        { scopeKind: "instance", stateKey: `span:run:${runId}` },
        {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          traceFlags: span.spanContext().traceFlags,
          startTime: Date.now(),
        },
      )
      .catch(() => {});
  } else {
    span.end();
  }
}

// ---------------------------------------------------------------------------
// agent.run.finished — end root run span with OK
// ---------------------------------------------------------------------------

export async function handleRunFinishedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    if (p.exitCode != null) {
      span.setAttribute("paperclip.run.exit_code", Number(p.exitCode));
    }
    if (p.durationMs != null) {
      span.setAttribute("paperclip.run.duration_ms", Number(p.durationMs));
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// agent.run.failed — end root run span with ERROR
// ---------------------------------------------------------------------------

export async function handleRunFailedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    const errorMsg = String(p.error ?? "unknown");
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
    span.setAttribute("error.type", String(p.errorCode ?? "run_failed"));
    if (p.exitCode != null) {
      span.setAttribute("paperclip.run.exit_code", Number(p.exitCode));
    }
    if (p.stderrExcerpt) {
      span.setAttribute(
        "paperclip.run.stderr_excerpt",
        String(p.stderrExcerpt),
      );
    }
    span.recordException(new Error(errorMsg));
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// agent.run.cancelled — end root run span
// ---------------------------------------------------------------------------

export async function handleRunCancelledTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    span.setStatus({ code: SpanStatusCode.OK, message: "cancelled" });
    span.setAttribute("paperclip.run.cancelled", true);
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// cost_event.created — LLM child span
// ---------------------------------------------------------------------------

export async function handleCostTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const provider = mapProvider(String(p.provider ?? ""));
  const model = String(p.model ?? "unknown");
  const spanName = `chat ${model}`;

  const llmSpanAttrs = {
    "paperclip.agent.id": String(p.agentId ?? ""),
    "paperclip.company.id": String(p.companyId ?? ""),
    "paperclip.cost.cents": Number(p.costCents ?? 0),
    "paperclip.billing.type": String(p.billingType ?? ""),
    "paperclip.billing.biller": String(p.biller ?? ""),
    "gen_ai.operation.name": "chat" as const,
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": model,
    "gen_ai.usage.input_tokens": Number(p.inputTokens ?? 0),
    "gen_ai.usage.output_tokens": Number(p.outputTokens ?? 0),
    "gen_ai.usage.cache_read.input_tokens": Number(
      p.cachedInputTokens ?? 0,
    ),
  };

  // If this cost event belongs to an active run, create as a child span.
  const heartbeatRunId = String(p.heartbeatRunId ?? "");
  let parentSpan = heartbeatRunId
    ? ctx.activeRunSpans.get(heartbeatRunId)
    : undefined;

  let parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined;

  // Fallback: restore parent context from plugin state if not in memory
  if (!parentCtx && heartbeatRunId) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:run:${heartbeatRunId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as {
        traceId: string;
        spanId: string;
        traceFlags: number;
      };
      const restoredSpanCtx = {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      };
      parentCtx = trace.setSpanContext(context.active(), restoredSpanCtx);
    }
  }

  const span = parentCtx
    ? ctx.tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: llmSpanAttrs },
        parentCtx,
      )
    : ctx.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: llmSpanAttrs,
      });

  span.end();
}

// ---------------------------------------------------------------------------
// issue.updated — issue lifecycle spans
// ---------------------------------------------------------------------------

export async function handleIssueUpdatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = String(p.status ?? "unknown");
  const previousStatus = String(p.previousStatus ?? "");
  const issueId = String(p.id ?? "");

  // Start span when issue transitions to in_progress
  if (status === "in_progress" && previousStatus !== "in_progress" && issueId) {
    const span = ctx.tracer.startSpan("paperclip.issue.execution", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.issue.id": issueId,
        "paperclip.issue.identifier": String(p.identifier ?? ""),
        "paperclip.issue.title": String(p.title ?? ""),
        "gen_ai.agent.id": String(p.assigneeAgentId ?? ""),
        "paperclip.project.id": String(p.projectId ?? ""),
        "paperclip.goal.id": String(p.goalId ?? ""),
        "paperclip.issue.priority": String(p.priority ?? "medium"),
      },
    });

    ctx.activeIssueSpans.set(issueId, span);

    await ctx.state
      .set(
        { scopeKind: "issue", scopeId: issueId, stateKey: "execution-span" },
        {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          traceFlags: span.spanContext().traceFlags,
          startTime: Date.now(),
        },
      )
      .catch(() => {});
  }

  // End span when issue transitions to done or cancelled
  if ((status === "done" || status === "cancelled") && issueId) {
    let span = ctx.activeIssueSpans.get(issueId);

    // Fallback: restore from plugin state if not in memory
    if (!span) {
      const stored = await ctx.state
        .get({
          scopeKind: "issue",
          scopeId: issueId,
          stateKey: "execution-span",
        })
        .catch(() => null);
      if (
        stored &&
        typeof stored === "object" &&
        "traceId" in (stored as Record<string, unknown>)
      ) {
        const s = stored as {
          traceId: string;
          spanId: string;
          traceFlags: number;
          startTime: number;
        };
        const restoredCtx = trace.setSpanContext(context.active(), {
          traceId: s.traceId,
          spanId: s.spanId,
          traceFlags: s.traceFlags ?? 1,
          isRemote: true,
        });
        span = ctx.tracer.startSpan(
          "paperclip.issue.execution.end",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "paperclip.issue.id": issueId,
              "paperclip.issue.identifier": String(p.identifier ?? ""),
              "paperclip.issue.status": status,
            },
          },
          restoredCtx,
        );
      }
    }

    if (span) {
      span.setAttribute("paperclip.issue.status", status);
      if (status === "done") {
        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({ code: SpanStatusCode.UNSET });
        span.setAttribute("paperclip.issue.cancelled", true);
      }
      span.end();
      ctx.activeIssueSpans.delete(issueId);
    }

    await ctx.state
      .delete({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: "execution-span",
      })
      .catch(() => {});
  }
}
