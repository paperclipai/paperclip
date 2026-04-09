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
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// agent.run.started — create run span (child of issue span when available)
// ---------------------------------------------------------------------------

export async function handleRunStartedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  const issueId = String(p.issueId ?? "");

  const agentId = String(p.agentId ?? "");
  const agentName = String(p.agentName ?? "");

  // Resolve business context from agentIssueMap (primary) or issueContextMap (fallback)
  let agentIssue = ctx.agentIssueMap.get(agentId);
  let resolvedIssueId = issueId || agentIssue?.issueId || "";
  let issueCtx = resolvedIssueId ? ctx.issueContextMap.get(resolvedIssueId) : undefined;
  let issueIdentifier = agentIssue?.issueIdentifier || issueCtx?.identifier || "";
  let issueTitle = issueCtx?.title || "";
  let projectId = agentIssue?.projectId || issueCtx?.projectId || "";
  let projectName = projectId ? (ctx.projectNameMap.get(projectId) ?? "") : "";

  // Fallback: when agentIssueMap is empty (issue was already in_progress before
  // this run started), query the agent's assigned issue to populate context.
  // The agent.run.started event may not include companyId, so look it up first.
  if (!agentIssue) {
    try {
      let companyId = event.companyId || "";
      if (!companyId) {
        const companies = await ctx.companies.list({ limit: 1, offset: 0 });
        if (companies.length > 0) companyId = companies[0].id;
      }
      if (companyId) {
        const issues = await ctx.issues.list({
          companyId,
          assigneeAgentId: agentId,
          status: "in_progress",
          limit: 1,
          offset: 0,
        });
        if (issues.length > 0) {
          const assigned = issues[0];
          agentIssue = {
            issueId: assigned.id,
            issueIdentifier: assigned.identifier || "",
            projectId: assigned.projectId || "",
          };
          ctx.agentIssueMap.set(agentId, agentIssue);
          if (!resolvedIssueId) resolvedIssueId = assigned.id;
          issueCtx = ctx.issueContextMap.get(resolvedIssueId);
          if (!issueIdentifier) issueIdentifier = assigned.identifier || "";
          if (!issueTitle) issueTitle = assigned.title || "";
          if (!projectId) projectId = assigned.projectId || "";
          if (!projectName && projectId) projectName = ctx.projectNameMap.get(projectId) || "";
        }
      }
    } catch {
      // Best-effort: continue without issue context
    }
  }

  // Track agent → runId mapping for delegation detection
  if (agentId && runId) {
    ctx.agentActiveRunId.set(agentId, runId);
  }

  const spanAttrs: Record<string, string | number | boolean> = {
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.run.id": runId,
    "paperclip.company.id": String(p.companyId ?? event.companyId ?? ""),
    "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
    "paperclip.run.trigger_detail": String(p.triggerDetail ?? ""),
    "paperclip.issue.id": resolvedIssueId,
    "paperclip.issue.identifier": issueIdentifier,
    "paperclip.issue.title": issueTitle,
    "paperclip.project.id": projectId,
    "paperclip.project.name": projectName,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.id": agentId,
    "gen_ai.agent.name": agentName,
  };

  // Use per-agent tracer so this agent gets its own service.name
  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // --- Cross-agent delegation linking ---
  // Check if a prior agent run delegated work to this agent on this issue
  // (or on a parent issue for subtask delegation).
  let parentCtx: ReturnType<typeof context.active> | undefined = undefined;

  if (resolvedIssueId && agentId) {
    parentCtx = await resolveDelegationParent(ctx, resolvedIssueId, agentId);
    if (parentCtx) {
      spanAttrs["paperclip.delegation.linked"] = true;
    }
  }

  // Fall back to issue execution span for same-trace context
  if (!parentCtx && resolvedIssueId) {
    parentCtx = resolveParentContext(ctx, resolvedIssueId);

    // Fallback: restore from plugin state
    if (!parentCtx) {
      const stored = await ctx.state
        .get({ scopeKind: "issue", scopeId: resolvedIssueId, stateKey: "execution-span" })
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

    // Last resort: create the issue span now if it was never created
    // (e.g. issue was already in_progress before this plugin instance started)
    if (!parentCtx && issueIdentifier) {
      const issueSpan = tracer.startSpan("paperclip.issue.execution", {
        kind: SpanKind.INTERNAL,
        attributes: {
          "paperclip.issue.id": resolvedIssueId,
          "paperclip.issue.identifier": issueIdentifier,
          "paperclip.issue.title": issueTitle,
          "paperclip.project.id": projectId,
          "paperclip.project.name": projectName,
          "gen_ai.agent.id": agentId,
          "gen_ai.agent.name": agentName,
        },
      });
      ctx.activeIssueSpans.set(resolvedIssueId, issueSpan);
      parentCtx = trace.setSpan(context.active(), issueSpan);
    }
  }

  const span = parentCtx
    ? tracer.startSpan(
        "paperclip.heartbeat.run",
        { kind: SpanKind.INTERNAL, attributes: spanAttrs },
        parentCtx,
      )
    : tracer.startSpan("paperclip.heartbeat.run", {
        kind: SpanKind.INTERNAL,
        attributes: spanAttrs,
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

/**
 * Resolve a parent OTel context from an active issue span.
 * Returns undefined when no in-memory span exists for the issue.
 */
function resolveParentContext(
  ctx: TelemetryContext,
  issueId: string,
) {
  const issueSpan = ctx.activeIssueSpans.get(issueId);
  return issueSpan
    ? trace.setSpan(context.active(), issueSpan)
    : undefined;
}

// ---------------------------------------------------------------------------
// Cross-agent delegation — helpers
// ---------------------------------------------------------------------------

interface DelegationSource {
  traceId: string;
  spanId: string;
  traceFlags: number;
  agentId: string;
  runId: string;
}

/**
 * Check for a delegation context from a prior agent's run on this issue
 * (or a parent issue for subtask delegation).
 *
 * Returns a parent OTel context if delegation is detected, undefined otherwise.
 */
async function resolveDelegationParent(
  ctx: TelemetryContext,
  issueId: string,
  currentAgentId: string,
): Promise<ReturnType<typeof context.active> | undefined> {
  // 1. Check same-issue delegation: another agent completed a run on this issue
  const result = await checkDelegationSource(ctx, issueId, currentAgentId);
  if (result) return result;

  // 2. Check parent-issue delegation (subtask case): this issue's parent had
  //    a run by a different agent that created/assigned this subtask
  const issueCtx = ctx.issueContextMap.get(issueId);
  if (issueCtx?.parentId) {
    const parentResult = await checkDelegationSource(ctx, issueCtx.parentId, currentAgentId);
    if (parentResult) return parentResult;
  }

  return undefined;
}

/**
 * Look up a delegation source for a specific issue and verify it was from
 * a different agent. Returns parent context if found, undefined otherwise.
 */
async function checkDelegationSource(
  ctx: TelemetryContext,
  issueId: string,
  currentAgentId: string,
): Promise<ReturnType<typeof context.active> | undefined> {
  const stored = await ctx.state
    .get({ scopeKind: "issue", scopeId: issueId, stateKey: "delegation-source" })
    .catch(() => null);

  if (
    stored &&
    typeof stored === "object" &&
    "traceId" in (stored as Record<string, unknown>) &&
    "agentId" in (stored as Record<string, unknown>)
  ) {
    const s = stored as DelegationSource;
    // Only link if the delegation came from a *different* agent
    if (s.agentId && s.agentId !== currentAgentId && s.traceId && s.spanId) {
      return trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
    }
  }

  return undefined;
}

/**
 * Store the completed run's span context as a delegation source so that
 * the next agent run on this issue becomes a child span.
 */
/**
 * Clean up the agent → run mapping when a run ends.
 */
function cleanupAgentRunMapping(
  ctx: TelemetryContext,
  agentId: string,
  runId: string,
): void {
  if (!agentId) return;
  const mapped = ctx.agentActiveRunId.get(agentId);
  if (mapped === runId) {
    ctx.agentActiveRunId.delete(agentId);
  }
}

/**
 * Store the completed run's span context as a delegation source so that
 * the next agent run on this issue becomes a child span.
 */
async function storeDelegationSource(
  ctx: TelemetryContext,
  issueId: string,
  agentId: string,
  runId: string,
  spanTraceId: string,
  spanSpanId: string,
  spanTraceFlags: number,
): Promise<void> {
  if (!issueId || !agentId) return;

  const source: DelegationSource = {
    traceId: spanTraceId,
    spanId: spanSpanId,
    traceFlags: spanTraceFlags,
    agentId,
    runId,
  };

  await ctx.state
    .set(
      { scopeKind: "issue", scopeId: issueId, stateKey: "delegation-source" },
      source,
    )
    .catch(() => {});
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

  const agentId = String(p.agentId ?? "");
  const issueId = String(p.issueId ?? "");

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    if (p.exitCode != null) {
      span.setAttribute("paperclip.run.exit_code", Number(p.exitCode));
    }
    if (p.durationMs != null) {
      span.setAttribute("paperclip.run.duration_ms", Number(p.durationMs));
    }
    if (issueId) {
      span.setAttribute("paperclip.issue.id", issueId);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    ctx.activeRunSpans.delete(runId);

    // Store delegation source for cross-agent trace linking
    const sc = span.spanContext();
    await storeDelegationSource(ctx, issueId, agentId, runId, sc.traceId, sc.spanId, sc.traceFlags);
  }

  // Clean up agent → run mapping
  cleanupAgentRunMapping(ctx, agentId, runId);
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

  const agentId = String(p.agentId ?? "");
  const issueId = String(p.issueId ?? "");

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

    // Store delegation source for cross-agent trace linking
    const sc = span.spanContext();
    await storeDelegationSource(ctx, issueId, agentId, runId, sc.traceId, sc.spanId, sc.traceFlags);
  }

  // Clean up agent → run mapping
  cleanupAgentRunMapping(ctx, agentId, runId);
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

  const agentId = String(p.agentId ?? "");
  const issueId = String(p.issueId ?? "");

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    span.setStatus({ code: SpanStatusCode.OK, message: "cancelled" });
    span.setAttribute("paperclip.run.cancelled", true);
    span.end();
    ctx.activeRunSpans.delete(runId);

    // Store delegation source for cross-agent trace linking
    const sc = span.spanContext();
    await storeDelegationSource(ctx, issueId, agentId, runId, sc.traceId, sc.spanId, sc.traceFlags);
  }

  // Clean up agent → run mapping
  cleanupAgentRunMapping(ctx, agentId, runId);
}

// ---------------------------------------------------------------------------
// cost_event.created — LLM child span
// ---------------------------------------------------------------------------

export async function handleCostTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentId = String(p.agentId ?? "");
  const agentName = String(p.agentName ?? "");
  const provider = mapProvider(String(p.provider ?? ""));
  const model = String(p.model ?? "unknown");
  const spanName = `chat ${model}`;

  // Use per-agent tracer so cost spans appear under the correct service
  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // Resolve business context from agent's active issue
  const agentIssue = ctx.agentIssueMap.get(agentId);
  const costIssueId = agentIssue?.issueId || "";
  const costIssueCtx = costIssueId ? ctx.issueContextMap.get(costIssueId) : undefined;
  const costIssueIdentifier = agentIssue?.issueIdentifier || costIssueCtx?.identifier || "";
  const costIssueTitle = costIssueCtx?.title || "";
  const costProjectId = agentIssue?.projectId || costIssueCtx?.projectId || "";
  const costProjectName = costProjectId ? (ctx.projectNameMap.get(costProjectId) ?? "") : "";

  const llmSpanAttrs: Record<string, string | number | boolean> = {
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.company.id": String(p.companyId ?? ""),
    "paperclip.cost.cents": Number(p.costCents ?? 0),
    "paperclip.billing.type": String(p.billingType ?? ""),
    "paperclip.billing.biller": String(p.biller ?? ""),
    "paperclip.issue.id": costIssueId,
    "paperclip.issue.identifier": costIssueIdentifier,
    "paperclip.issue.title": costIssueTitle,
    "paperclip.project.id": costProjectId,
    "paperclip.project.name": costProjectName,
    "gen_ai.operation.name": "chat",
    "gen_ai.agent.id": agentId,
    "gen_ai.agent.name": agentName,
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
    ? tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: llmSpanAttrs },
        parentCtx,
      )
    : tracer.startSpan(spanName, {
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
  const assigneeAgentId = String(p.assigneeAgentId ?? "");
  const assigneeAgentName = String(p.assigneeAgentName ?? p.executionAgentNameKey ?? "");

  // Use per-agent tracer when an assignee is known
  const tracer = assigneeAgentId
    ? ctx.getTracerForAgent(assigneeAgentId, assigneeAgentName)
    : ctx.tracer;

  // Start span when issue transitions to in_progress
  if (status === "in_progress" && previousStatus !== "in_progress" && issueId) {
    const projectId = String(p.projectId ?? "");
    const projectName = ctx.projectNameMap.get(projectId) ?? "";
    const identifier = String(p.identifier ?? "");
    const title = String(p.title ?? "");

    const span = tracer.startSpan("paperclip.issue.execution", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.issue.id": issueId,
        "paperclip.issue.identifier": identifier,
        "paperclip.issue.title": title,
        "paperclip.issue.priority": String(p.priority ?? "medium"),
        "paperclip.issue.status": status,
        "paperclip.project.id": projectId,
        "paperclip.project.name": projectName,
        "paperclip.goal.id": String(p.goalId ?? ""),
        "paperclip.agent.name": assigneeAgentName,
        "gen_ai.agent.id": assigneeAgentId,
        "gen_ai.agent.name": assigneeAgentName,
      },
    });

    // Populate agentIssueMap so run/cost spans can look up business context
    if (assigneeAgentId) {
      ctx.agentIssueMap.set(assigneeAgentId, {
        issueId,
        issueIdentifier: identifier,
        projectId,
      });
    }

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

  // Detect real-time delegation: assignee changed while a run is still active.
  // Capture the previous agent's active run span as delegation source so Agent B's
  // next run becomes a child of Agent A's run in the trace.
  const previousAssigneeAgentId = String(p.previousAssigneeAgentId ?? "");
  if (
    assigneeAgentId &&
    previousAssigneeAgentId &&
    assigneeAgentId !== previousAssigneeAgentId &&
    issueId
  ) {
    const prevRunId = ctx.agentActiveRunId.get(previousAssigneeAgentId);
    if (prevRunId) {
      const prevSpan = ctx.activeRunSpans.get(prevRunId);
      if (prevSpan) {
        const sc = prevSpan.spanContext();
        await storeDelegationSource(
          ctx, issueId, previousAssigneeAgentId, prevRunId,
          sc.traceId, sc.spanId, sc.traceFlags,
        );
      }
    }
  }

  // Clean up agentIssueMap when issue leaves in_progress
  if (status !== "in_progress" && assigneeAgentId) {
    const mapped = ctx.agentIssueMap.get(assigneeAgentId);
    if (mapped && mapped.issueId === issueId) {
      ctx.agentIssueMap.delete(assigneeAgentId);
    }
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
        span = tracer.startSpan(
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

// ---------------------------------------------------------------------------
// approval.created — start approval lifecycle span
// ---------------------------------------------------------------------------

export async function handleApprovalCreatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const approvalId = String(p.id ?? "");
  if (!approvalId) return;

  const companyId = String(p.companyId ?? event.companyId ?? "");
  const requestingAgentId = String(p.requestingAgentId ?? "");
  const requestingAgentName = String(p.requestingAgentName ?? "");
  const approvalType = String(p.approvalType ?? p.type ?? "unknown");

  const span = ctx.tracer.startSpan("paperclip.approval.lifecycle", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "paperclip.approval.id": approvalId,
      "paperclip.company.id": companyId,
      "paperclip.approval.type": approvalType,
      "paperclip.approval.requesting_agent.id": requestingAgentId,
      "paperclip.approval.requesting_agent.name": requestingAgentName,
    },
  });

  ctx.activeApprovalSpans.set(approvalId, span);

  // Persist span context for cross-restart resilience
  await ctx.state
    .set(
      { scopeKind: "instance", stateKey: `span:approval:${approvalId}` },
      {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        traceFlags: span.spanContext().traceFlags,
        startTime: Date.now(),
      },
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// approval.decided — end approval lifecycle span with decision + latency
// ---------------------------------------------------------------------------

export async function handleApprovalDecidedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const approvalId = String(p.id ?? "");
  if (!approvalId) return;

  const decision = String(p.decision ?? "unknown");
  const approverAgentId = String(p.approverAgentId ?? p.decidedByAgentId ?? "");
  const approverUserId = String(p.approverUserId ?? p.decidedByUserId ?? "");

  let span = ctx.activeApprovalSpans.get(approvalId);
  let startTime: number | null = null;

  // Fallback: restore from plugin state if not in memory
  if (!span) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
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
        startTime: number;
      };
      startTime = s.startTime ?? null;
      const restoredCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
      span = ctx.tracer.startSpan(
        "paperclip.approval.decision",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "paperclip.approval.id": approvalId,
            "paperclip.approval.decision": decision,
          },
        },
        restoredCtx,
      );
    }
  }

  if (span) {
    span.setAttribute("paperclip.approval.decision", decision);
    span.setAttribute("paperclip.approval.approver.agent_id", approverAgentId);
    span.setAttribute("paperclip.approval.approver.user_id", approverUserId);

    // Compute decision latency from stored start time
    if (!startTime) {
      const stored = await ctx.state
        .get({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
        .catch(() => null);
      if (stored && typeof stored === "object" && "startTime" in (stored as Record<string, unknown>)) {
        startTime = (stored as { startTime: number }).startTime;
      }
    }

    if (startTime) {
      const decisionTimeMs = Date.now() - startTime;
      span.setAttribute("paperclip.approval.decision_time_ms", decisionTimeMs);

      // Record decision latency histogram
      const histogram = ctx.meter.createHistogram(
        METRIC_NAMES.approvalDecisionTime,
        { description: "Approval decision latency in milliseconds", unit: "ms" },
      );
      histogram.record(decisionTimeMs, {
        decision,
        company_id: String(p.companyId ?? ""),
      });
    }

    if (decision === "approved") {
      span.setStatus({ code: SpanStatusCode.OK });
    } else if (decision === "rejected") {
      span.setStatus({ code: SpanStatusCode.OK, message: "rejected" });
    } else {
      span.setStatus({ code: SpanStatusCode.UNSET });
    }

    span.end();
    ctx.activeApprovalSpans.delete(approvalId);
  }

  // Clean up persisted state
  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
    .catch(() => {});
}
