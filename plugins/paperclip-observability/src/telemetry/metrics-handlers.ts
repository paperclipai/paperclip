/**
 * Metrics event handlers — counter, histogram, and gauge updates.
 *
 * Each handler is a pure function focused on recording OTel metrics from
 * Paperclip domain events. Handlers receive a TelemetryContext and should
 * never manage span lifecycle (that belongs in trace-handlers).
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { METRIC_NAMES } from "../constants.js";
import { mapProvider } from "../provider-map.js";

// ---------------------------------------------------------------------------
// agent.run.started — run counter
// ---------------------------------------------------------------------------

export async function handleRunStartedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  const runCounter = ctx.meter.createCounter(METRIC_NAMES.agentRunsStarted, {
    description: "Count of agent runs started",
  });
  runCounter.add(1, {
    agent_id: String(p.agentId ?? ""),
    agent_name: String(p.agentName ?? "unknown"),
    invocation_source: String(p.invocationSource ?? ""),
  });
}

// ---------------------------------------------------------------------------
// agent.run.finished — duration histograms
// ---------------------------------------------------------------------------

export async function handleRunFinishedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  if (p.durationMs == null) return;

  const durationMs = Number(p.durationMs);

  const durationHist = ctx.meter.createHistogram(
    METRIC_NAMES.agentRunDuration,
    {
      description: "Duration of agent heartbeat runs in milliseconds",
      unit: "ms",
    },
  );
  durationHist.record(durationMs, {
    agent_id: String(p.agentId ?? ""),
    agent_name: String(p.agentName ?? "unknown"),
    status: "finished",
  });

  const genAIDurationHist = ctx.meter.createHistogram(
    "gen_ai.client.operation.duration",
    { description: "GenAI operation duration", unit: "s" },
  );
  genAIDurationHist.record(durationMs / 1000, {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": mapProvider(String(p.provider ?? "anthropic")),
    "gen_ai.request.model": String(p.model ?? "unknown"),
  });
}

// ---------------------------------------------------------------------------
// agent.run.failed — error counter
// ---------------------------------------------------------------------------

export async function handleRunFailedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  const errorCounter = ctx.meter.createCounter(METRIC_NAMES.agentRunErrors, {
    description: "Count of failed agent runs",
  });
  errorCounter.add(1, {
    agent_id: String(p.agentId ?? ""),
    agent_name: String(p.agentName ?? "unknown"),
    error: String(p.error ?? "unknown"),
  });
}

// ---------------------------------------------------------------------------
// agent.run.cancelled — generic event counter
// ---------------------------------------------------------------------------

export async function handleRunCancelledMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const genericCounter = ctx.meter.createCounter(METRIC_NAMES.eventsTotal, {
    description: "Total domain events observed",
  });
  genericCounter.add(1, { event_type: event.eventType });
}

// ---------------------------------------------------------------------------
// cost_event.created — token/cost counters + GenAI token histogram
// ---------------------------------------------------------------------------

export async function handleCostMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const provider = mapProvider(String(p.provider ?? ""));

  // Paperclip-specific counters
  const inputTokensCounter = ctx.meter.createCounter(METRIC_NAMES.tokensInput, {
    description: "Total input tokens consumed",
  });
  const outputTokensCounter = ctx.meter.createCounter(
    METRIC_NAMES.tokensOutput,
    { description: "Total output tokens consumed" },
  );
  const costCounter = ctx.meter.createCounter(METRIC_NAMES.costCents, {
    description: "Total cost in cents",
    unit: "cent",
  });

  const costTags = {
    agent_id: String(p.agentId ?? ""),
    agent_name: String(p.agentName ?? "unknown"),
    provider,
    model: String(p.model ?? "unknown"),
    billing_type: String(p.billingType ?? ""),
    biller: String(p.biller ?? ""),
  };

  if (p.inputTokens != null) inputTokensCounter.add(Number(p.inputTokens), costTags);
  if (p.outputTokens != null) outputTokensCounter.add(Number(p.outputTokens), costTags);
  if (p.costCents != null) costCounter.add(Number(p.costCents), costTags);

  // GenAI semconv: gen_ai.client.token.usage histogram
  const tokenUsage = ctx.meter.createHistogram("gen_ai.client.token.usage", {
    description: "Measures number of input and output tokens used",
    unit: "{token}",
  });

  const genAIBaseAttrs = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": String(p.model ?? "unknown"),
  };

  if (p.inputTokens != null) {
    tokenUsage.record(Number(p.inputTokens), {
      ...genAIBaseAttrs,
      "gen_ai.token.type": "input",
    });
  }
  if (p.outputTokens != null) {
    tokenUsage.record(Number(p.outputTokens), {
      ...genAIBaseAttrs,
      "gen_ai.token.type": "output",
    });
  }
}

// ---------------------------------------------------------------------------
// issue.created — issue counter
// ---------------------------------------------------------------------------

export async function handleIssueCreatedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  const issueCounter = ctx.meter.createCounter(METRIC_NAMES.issuesCreated, {
    description: "Count of issues created",
  });
  issueCounter.add(1, {
    project_id: String(p.projectId ?? ""),
    priority: String(p.priority ?? "medium"),
  });
}

// ---------------------------------------------------------------------------
// issue.updated — transition counter + completion counter
// ---------------------------------------------------------------------------

export async function handleIssueUpdatedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = String(p.status ?? "unknown");
  const previousStatus = String(p.previousStatus ?? "");

  const issueTransitions = ctx.meter.createCounter(
    METRIC_NAMES.issueTransitions,
    { description: "Count of issue status transitions" },
  );
  issueTransitions.add(1, {
    status,
    project_id: String(p.projectId ?? ""),
  });

  if (status === "done" && previousStatus !== "done") {
    const issuesCompleted = ctx.meter.createCounter(
      METRIC_NAMES.issuesCompleted,
      { description: "Count of issues completed" },
    );
    issuesCompleted.add(1, {
      project_id: String(p.projectId ?? ""),
    });
  }
}

// ---------------------------------------------------------------------------
// agent.status_changed — status change counter
// ---------------------------------------------------------------------------

export async function handleAgentStatusChangedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;

  const agentStatusChanges = ctx.meter.createCounter(
    METRIC_NAMES.agentStatusChanges,
    { description: "Count of agent status changes" },
  );
  agentStatusChanges.add(1, {
    agent_id: String(p.agentId ?? ""),
    agent_name: String(p.agentName ?? "unknown"),
    status: String(p.status ?? "unknown"),
  });
}

// ---------------------------------------------------------------------------
// approval.created — counter + pending state increment
// ---------------------------------------------------------------------------

export async function handleApprovalCreatedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const companyId = String(p.companyId ?? "");

  const approvalCounter = ctx.meter.createCounter(
    METRIC_NAMES.approvalsCreated,
    { description: "Count of approvals created" },
  );
  approvalCounter.add(1, { company_id: companyId });

  if (companyId) {
    const stateKey = `approvals:pending:${companyId}`;
    const current = await ctx.state
      .get({ scopeKind: "instance", stateKey })
      .catch(() => null);
    const count = (typeof current === "number" ? current : 0) + 1;
    await ctx.state
      .set({ scopeKind: "instance", stateKey }, count)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// approval.decided — counter + pending state decrement
// ---------------------------------------------------------------------------

export async function handleApprovalDecidedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const companyId = String(p.companyId ?? "");

  const approvalCounter = ctx.meter.createCounter(
    METRIC_NAMES.approvalsDecided,
    { description: "Count of approval decisions" },
  );
  approvalCounter.add(1, {
    decision: String(p.decision ?? "unknown"),
    company_id: companyId,
  });

  if (companyId) {
    const stateKey = `approvals:pending:${companyId}`;
    const current = await ctx.state
      .get({ scopeKind: "instance", stateKey })
      .catch(() => null);
    const count = Math.max(0, (typeof current === "number" ? current : 0) - 1);
    await ctx.state
      .set({ scopeKind: "instance", stateKey }, count)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// activity.logged (generic) — total event counter
// ---------------------------------------------------------------------------

export async function handleGenericMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const genericCounter = ctx.meter.createCounter(METRIC_NAMES.eventsTotal, {
    description: "Total domain events observed",
  });
  genericCounter.add(1, { event_type: event.eventType });
}
