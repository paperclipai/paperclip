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
import { parentCtxFromServerTrace } from "./trace-utils.js";
import { mapProvider } from "../provider-map.js";
import { METRIC_NAMES } from "../constants.js";

// Debounce for fallback API lookups during cold starts (issue #5 from review).
// Prevents repeated companies.list + issues.list calls when multiple runs
// start before agentIssueMap is populated.
let lastFallbackLookupMs = 0;
let lastCostFallbackLookupMs = 0;
const FALLBACK_LOOKUP_DEBOUNCE_MS = 10_000; // 10 seconds

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
  // Debounced to avoid repeated API calls during cold starts with multiple runs.
  const now = Date.now();
  if (!agentIssue && now - lastFallbackLookupMs >= FALLBACK_LOOKUP_DEBOUNCE_MS) {
    lastFallbackLookupMs = now;
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
  // Cache agent name for cost spans that may arrive with empty agentName
  if (agentId && agentName) {
    ctx.agentNameMap.set(agentId, agentName);
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

  // --- Issue execution span context (highest priority for run spans) ---
  // Run spans should be children of the issue execution span to form
  // issue-centric trace trees visible in the trace backend UI.
  let parentCtx: ReturnType<typeof context.active> | undefined = undefined;

  if (resolvedIssueId) {
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
      // Use server-propagated trace context as parent so the issue execution
      // span is not orphaned in the trace backend.
      const serverCtx = parentCtxFromServerTrace(event);
      const issueSpanOpts = {
        kind: SpanKind.INTERNAL as const,
        attributes: {
          "paperclip.issue.id": resolvedIssueId,
          "paperclip.issue.identifier": issueIdentifier,
          "paperclip.issue.title": issueTitle,
          "paperclip.project.id": projectId,
          "paperclip.project.name": projectName,
          "gen_ai.agent.id": agentId,
          "gen_ai.agent.name": agentName,
        },
      };
      const issueSpan = serverCtx
        ? tracer.startSpan("paperclip.issue.execution", issueSpanOpts, serverCtx)
        : tracer.startSpan("paperclip.issue.execution", issueSpanOpts);
      parentCtx = trace.setSpan(context.active(), issueSpan);
      // End immediately — child spans link via traceId/spanId, not live object
      issueSpan.end();
      // Persist for future child span linking
      await ctx.state
        .set(
          { scopeKind: "issue", scopeId: resolvedIssueId, stateKey: "execution-span" },
          {
            traceId: issueSpan.spanContext().traceId,
            spanId: issueSpan.spanContext().spanId,
            traceFlags: issueSpan.spanContext().traceFlags,
            startTime: Date.now(),
          },
        )
        .catch(() => {});
    }
  }

  // Fallback: use server-propagated trace context so the run span is not
  // orphaned when no issue context is available.
  if (!parentCtx) {
    parentCtx = parentCtxFromServerTrace(event);
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

/**
 * Resolve parent context from server-propagated trace context, falling back
 * to persisted execution-span state (plugin state). Used when the execution
 * span was ended immediately and is not in activeIssueSpans.
 */
async function resolvePersistedParentCtx(
  ctx: TelemetryContext,
  issueId: string,
  event: PluginEvent,
) {
  // Try server-propagated trace context first
  const serverCtx = parentCtxFromServerTrace(event);
  if (serverCtx) return serverCtx;

  // Fall back to persisted execution-span context
  const stored = await ctx.state
    .get({ scopeKind: "issue", scopeId: issueId, stateKey: "execution-span" })
    .catch(() => null);
  if (
    stored &&
    typeof stored === "object" &&
    "traceId" in (stored as Record<string, unknown>) &&
    "spanId" in (stored as Record<string, unknown>)
  ) {
    const s = stored as { traceId: string; spanId: string; traceFlags: number };
    return trace.setSpanContext(context.active(), {
      traceId: s.traceId,
      spanId: s.spanId,
      traceFlags: s.traceFlags ?? 1,
      isRemote: true,
    });
  }
  return undefined;
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

    // Clean up persisted span state to prevent accumulation
    await ctx.state
      .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => {});

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

    // Clean up persisted span state to prevent accumulation
    await ctx.state
      .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => {});

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

    // Clean up persisted span state to prevent accumulation
    await ctx.state
      .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => {});

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
  // Resolve agent name from payload, falling back to the cached agentNameMap
  const agentName = String(p.agentName ?? "") || ctx.agentNameMap.get(agentId) || "";
  const provider = mapProvider(String(p.provider ?? ""));
  const model = String(p.model ?? "unknown");
  const spanName = `chat ${model}`;

  // Use per-agent tracer so cost spans appear under the correct service
  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // Resolve business context from agent's active issue
  let agentIssue = ctx.agentIssueMap.get(agentId);

  // Fallback: when agentIssueMap is empty (e.g. after plugin restart or missed
  // issue.updated event), query the API for the agent's active issue.
  const now = Date.now();
  if (!agentIssue && agentId && now - lastCostFallbackLookupMs >= FALLBACK_LOOKUP_DEBOUNCE_MS) {
    lastCostFallbackLookupMs = now;
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
        }
      }
    } catch {
      // Best-effort: continue without issue context
    }
  }

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

  // Fallback: use server-propagated trace context
  if (!parentCtx) {
    parentCtx = parentCtxFromServerTrace(event);
  }

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

  // Fallback: link to the agent's issue execution span when the run span
  // has already been ended and cleaned up (late-arriving cost events).
  if (!parentCtx && costIssueId) {
    const issueSpan = ctx.activeIssueSpans.get(costIssueId);
    if (issueSpan) {
      parentCtx = trace.setSpan(context.active(), issueSpan);
    } else {
      const stored = await ctx.state
        .get({ scopeKind: "issue", scopeId: costIssueId, stateKey: "execution-span" })
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
  }

  // Estimate LLM call duration from output tokens.
  // Typical throughput ~50 tokens/sec for large models, minimum 500ms.
  const outputTokens = Number(p.outputTokens ?? 0);
  const estimatedDurationMs = Math.max(500, Math.round((outputTokens / 50) * 1000));
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - estimatedDurationMs;

  const span = parentCtx
    ? tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: llmSpanAttrs, startTime: startTimeMs },
        parentCtx,
      )
    : tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: llmSpanAttrs,
        startTime: startTimeMs,
      });

  span.end(endTimeMs);
}

// ---------------------------------------------------------------------------
// issue.created — start issue lifecycle span at creation time
// ---------------------------------------------------------------------------

export async function handleIssueCreatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const issueId = String(p.id ?? event.entityId ?? "");
  if (!issueId) return;

  const identifier = String(p.identifier ?? "");
  const title = String(p.title ?? "");
  const projectId = String(p.projectId ?? "");
  const projectName = projectId ? (ctx.projectNameMap.get(projectId) ?? "") : "";
  const priority = String(p.priority ?? "medium");
  const assigneeAgentId = String(p.assigneeAgentId ?? "");
  const assigneeAgentName = String(p.assigneeAgentName ?? "");
  const createdByAgentId = String(p.createdByAgentId ?? "");
  const parentId = String(p.parentId ?? "");

  const tracer = assigneeAgentId
    ? ctx.getTracerForAgent(assigneeAgentId, assigneeAgentName)
    : ctx.tracer;

  // If this is a subtask, try to link to the parent issue's span for
  // end-to-end trace continuity from parent → child issue creation.
  let parentCtx: ReturnType<typeof context.active> | undefined;
  if (parentId) {
    const parentSpan = ctx.activeIssueSpans.get(parentId);
    if (parentSpan) {
      parentCtx = trace.setSpan(context.active(), parentSpan);
    } else {
      // Fallback: restore parent issue span from plugin state
      const stored = await ctx.state
        .get({ scopeKind: "issue", scopeId: parentId, stateKey: "execution-span" })
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
  }

  // Also check if the creating agent has an active run we can link to
  if (!parentCtx && createdByAgentId) {
    const creatorRunId = ctx.agentActiveRunId.get(createdByAgentId);
    if (creatorRunId) {
      const creatorSpan = ctx.activeRunSpans.get(creatorRunId);
      if (creatorSpan) {
        parentCtx = trace.setSpan(context.active(), creatorSpan);
      }
    }
  }

  // Fallback: use server-propagated trace context
  if (!parentCtx) {
    parentCtx = parentCtxFromServerTrace(event);
  }

  const spanAttrs: Record<string, string | number | boolean> = {
    "paperclip.issue.id": issueId,
    "paperclip.issue.identifier": identifier,
    "paperclip.issue.title": title,
    "paperclip.issue.priority": priority,
    "paperclip.issue.status": "created",
    "paperclip.project.id": projectId,
    "paperclip.project.name": projectName,
    "paperclip.goal.id": String(p.goalId ?? ""),
    "paperclip.issue.parent_id": parentId,
    "paperclip.issue.created_by_agent_id": createdByAgentId,
    "gen_ai.agent.id": assigneeAgentId,
    "gen_ai.agent.name": assigneeAgentName,
  };

  const span = parentCtx
    ? tracer.startSpan(
        "paperclip.issue.lifecycle",
        { kind: SpanKind.INTERNAL, attributes: spanAttrs },
        parentCtx,
      )
    : tracer.startSpan("paperclip.issue.lifecycle", {
        kind: SpanKind.INTERNAL,
        attributes: spanAttrs,
      });

  // End immediately so the span is exported right away. Child spans
  // (execution, runs) link via persisted traceId/spanId, not the live object.
  span.end();

  // Persist span context for child span linking
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

  // --- Create run-child span so issue creation appears under the heartbeat run ---
  if (createdByAgentId) {
    const creatorRunId = ctx.agentActiveRunId.get(createdByAgentId);
    if (creatorRunId) {
      const creatorRunSpan = ctx.activeRunSpans.get(creatorRunId);
      if (creatorRunSpan) {
        const creatorAgentName = ctx.agentNameMap.get(createdByAgentId) || "";
        const runParentCtx = trace.setSpan(context.active(), creatorRunSpan);
        const runChildTracer = ctx.getTracerForAgent(createdByAgentId, creatorAgentName);
        const runChildSpan = runChildTracer.startSpan(
          "paperclip.issue.created",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "paperclip.issue.id": issueId,
              "paperclip.issue.identifier": identifier,
              "paperclip.issue.title": title,
              "paperclip.issue.priority": priority,
              "paperclip.issue.parent_id": parentId,
              "paperclip.issue.assignee_agent_id": assigneeAgentId,
              "paperclip.issue.assignee_agent_name": assigneeAgentName,
              "paperclip.agent.id": createdByAgentId,
              "paperclip.agent.name": creatorAgentName,
              "paperclip.project.id": projectId,
              "paperclip.project.name": projectName,
            },
          },
          runParentCtx,
        );
        runChildSpan.end();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// issue.comment.created — add span event on issue execution span
// ---------------------------------------------------------------------------

export async function handleIssueCommentCreatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const issueId = String(p.issueId ?? "");
  if (!issueId) return;

  const commentId = String(p.id ?? p.commentId ?? "");
  const authorAgentId = String(p.authorAgentId ?? "");
  const authorAgentName = String(p.authorAgentName ?? "") || ctx.agentNameMap.get(authorAgentId) || "";
  const authorUserId = String(p.authorUserId ?? "");

  const spanEventAttrs = {
    "paperclip.comment.id": commentId,
    "paperclip.comment.author_agent_id": authorAgentId,
    "paperclip.comment.author_agent_name": authorAgentName,
    "paperclip.comment.author_user_id": authorUserId,
    "paperclip.issue.id": issueId,
  };

  // Try to add as span event on an active in-memory span
  let issueSpan = ctx.activeIssueSpans.get(issueId);

  // Fallback: check active run spans for the authoring agent
  if (!issueSpan && authorAgentId) {
    const runId = ctx.agentActiveRunId.get(authorAgentId);
    if (runId) {
      issueSpan = ctx.activeRunSpans.get(runId);
    }
  }

  if (issueSpan) {
    issueSpan.addEvent("issue.comment.created", spanEventAttrs);
    return;
  }

  // Fallback: the execution span was ended immediately (not in activeIssueSpans).
  // Create a short-lived child span linked to the persisted execution-span context
  // so comment activity still appears in the trace tree.
  const parentCtx = await resolvePersistedParentCtx(ctx, issueId, event);
  if (!parentCtx) return;

  const tracer = authorAgentId
    ? ctx.getTracerForAgent(authorAgentId, authorAgentName)
    : ctx.tracer;

  const span = tracer.startSpan(
    "paperclip.issue.comment",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        ...spanEventAttrs,
        "paperclip.issue.identifier": ctx.issueContextMap.get(issueId)?.identifier || "",
      },
    },
    parentCtx,
  );
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
  const prev = (p._previous as Record<string, unknown>) ?? {};
  const status = String(p.status ?? "unknown");
  const previousStatus = String(p.previousStatus ?? prev.status ?? "");
  const issueId = String(p.id ?? event.entityId ?? "");
  const assigneeAgentId = String(p.assigneeAgentId ?? "");
  const assigneeAgentName = String(p.assigneeAgentName ?? p.executionAgentNameKey ?? "");

  // Use per-agent tracer when an assignee is known
  const tracer = assigneeAgentId
    ? ctx.getTracerForAgent(assigneeAgentId, assigneeAgentName)
    : ctx.tracer;

  // Hoist assignee change fields needed before and after execution span creation
  const previousAssigneeAgentId = String(p.previousAssigneeAgentId ?? prev.assigneeAgentId ?? "");
  const previousAssigneeAgentName = String(p.previousAssigneeAgentName ?? "");

  // Start span when issue transitions to in_progress
  if (status === "in_progress" && previousStatus !== "in_progress" && issueId) {
    const projectId = String(p.projectId ?? "");
    const projectName = ctx.projectNameMap.get(projectId) ?? "";
    const identifier = String(p.identifier ?? "");
    const title = String(p.title ?? "");

    // If an execution span was already created (e.g. by handleRunStartedTraces
    // last-resort when the run started before checkout), skip creation to avoid
    // overwriting the persisted span that existing run spans are linked to.
    const existingPersisted = await ctx.state
      .get({ scopeKind: "issue", scopeId: issueId, stateKey: "execution-span" })
      .catch(() => null);
    const alreadyHasExecSpan =
      existingPersisted &&
      typeof existingPersisted === "object" &&
      "traceId" in (existingPersisted as Record<string, unknown>);

    if (!alreadyHasExecSpan) {
      // End existing lifecycle span (from issue.created) before creating execution
      // span, to avoid leaking a dangling span. Make execution span a child of the
      // lifecycle span for proper trace continuity.
      let executionParentCtx: ReturnType<typeof context.active> | undefined;
      const existingSpan = ctx.activeIssueSpans.get(issueId);
      if (existingSpan) {
        executionParentCtx = trace.setSpan(context.active(), existingSpan);
        existingSpan.setAttribute("paperclip.issue.status", "in_progress");
        existingSpan.setStatus({ code: SpanStatusCode.OK });
        existingSpan.end();
      }

      // Fallback: use server-propagated trace context so the execution span
      // is not orphaned when the plugin missed the original issue.created event.
      if (!executionParentCtx) {
        executionParentCtx = parentCtxFromServerTrace(event);
      }

      const spanAttrsExec = {
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
      };

      const span = executionParentCtx
        ? tracer.startSpan(
            "paperclip.issue.execution",
            { kind: SpanKind.INTERNAL, attributes: spanAttrsExec },
            executionParentCtx,
          )
        : tracer.startSpan("paperclip.issue.execution", {
            kind: SpanKind.INTERNAL,
            attributes: spanAttrsExec,
          });

      span.end();

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

    // Populate agentIssueMap so run/cost spans can look up business context
    if (assigneeAgentId) {
      ctx.agentIssueMap.set(assigneeAgentId, {
        issueId,
        issueIdentifier: identifier,
        projectId,
      });
    }
  }

  // --- Add spans for all status transitions (checkout, release, blocked, etc.) ---
  // Creates a child span under the execution span so transitions appear in the trace
  // even when the execution span was ended immediately and is not in activeIssueSpans.
  if (previousStatus && status !== previousStatus && issueId) {
    const transitionAttrs = {
      "paperclip.issue.id": issueId,
      "paperclip.issue.identifier": String(p.identifier ?? ""),
      "paperclip.issue.previous_status": previousStatus,
      "paperclip.issue.status": status,
      "paperclip.agent.id": assigneeAgentId,
      "paperclip.agent.name": assigneeAgentName,
    };

    const issueSpan = ctx.activeIssueSpans.get(issueId);
    if (issueSpan) {
      issueSpan.addEvent("issue.status_change", transitionAttrs);
    } else {
      // Create a child span from persisted execution-span context
      const parentCtx = await resolvePersistedParentCtx(ctx, issueId, event);
      if (parentCtx) {
        const span = tracer.startSpan(
          "paperclip.issue.status_change",
          { kind: SpanKind.INTERNAL, attributes: transitionAttrs },
          parentCtx,
        );
        span.end();
      }
    }
  }

  // --- Add spans for assignee changes (delegation moments) ---
  if (
    assigneeAgentId !== previousAssigneeAgentId &&
    (assigneeAgentId || previousAssigneeAgentId) &&
    issueId
  ) {
    const delegationAttrs = {
      "paperclip.issue.id": issueId,
      "paperclip.issue.identifier": String(p.identifier ?? ""),
      "paperclip.issue.previous_assignee_agent_id": previousAssigneeAgentId,
      "paperclip.issue.previous_assignee_agent_name": previousAssigneeAgentName,
      "paperclip.issue.assignee_agent_id": assigneeAgentId,
      "paperclip.issue.assignee_agent_name": assigneeAgentName,
    };

    const issueSpan = ctx.activeIssueSpans.get(issueId);
    if (issueSpan) {
      issueSpan.addEvent("issue.assignee_changed", delegationAttrs);
    } else {
      const parentCtx = await resolvePersistedParentCtx(ctx, issueId, event);
      if (parentCtx) {
        const span = tracer.startSpan(
          "paperclip.issue.assignee_changed",
          { kind: SpanKind.INTERNAL, attributes: delegationAttrs },
          parentCtx,
        );
        span.end();
      }
    }
  }

  // Detect real-time delegation: assignee changed while a run is still active.
  // Capture the previous agent's active run span as delegation source so Agent B's
  // next run becomes a child of Agent A's run in the trace.
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

  // --- Create run-child spans so ticket changes appear under the heartbeat run ---
  // This makes the trace tree show: heartbeat.run → issue.status_change / issue.created
  if (issueId && previousStatus && status !== previousStatus) {
    // Find the active run that triggered this update
    let triggerRunSpan: ReturnType<typeof ctx.activeRunSpans.get> | undefined;
    let triggerAgentId = "";
    let triggerAgentName = "";

    // Check if the assignee agent has an active run (most common: agent updating its own task)
    if (assigneeAgentId) {
      const runId = ctx.agentActiveRunId.get(assigneeAgentId);
      if (runId) {
        triggerRunSpan = ctx.activeRunSpans.get(runId);
        if (triggerRunSpan) {
          triggerAgentId = assigneeAgentId;
          triggerAgentName = assigneeAgentName;
        }
      }
    }

    // Fallback: check if the previous assignee triggered this (e.g. reassignment/delegation)
    if (!triggerRunSpan && previousAssigneeAgentId) {
      const runId = ctx.agentActiveRunId.get(previousAssigneeAgentId);
      if (runId) {
        triggerRunSpan = ctx.activeRunSpans.get(runId);
        if (triggerRunSpan) {
          triggerAgentId = previousAssigneeAgentId;
          triggerAgentName = previousAssigneeAgentName;
        }
      }
    }

    if (triggerRunSpan) {
      const runParentCtx = trace.setSpan(context.active(), triggerRunSpan);
      const runChildTracer = triggerAgentId
        ? ctx.getTracerForAgent(triggerAgentId, triggerAgentName)
        : ctx.tracer;
      const runChildSpan = runChildTracer.startSpan(
        "paperclip.issue.status_change",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "paperclip.issue.id": issueId,
            "paperclip.issue.identifier": String(p.identifier ?? ""),
            "paperclip.issue.title": String(p.title ?? ""),
            "paperclip.issue.previous_status": previousStatus,
            "paperclip.issue.status": status,
            "paperclip.agent.id": triggerAgentId,
            "paperclip.agent.name": triggerAgentName,
          },
        },
        runParentCtx,
      );
      runChildSpan.end();
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
