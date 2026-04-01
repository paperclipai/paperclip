/**
 * Observability plugin worker.
 *
 * Subscribes to Paperclip domain events (agent runs, issue lifecycle, cost
 * events, approvals) and forwards them as OTel metrics and traces to a
 * configured OTLP collector.
 */

import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import type { ObservabilityConfig } from "./config.js";
import { DEFAULT_CONFIG, resolveConfig } from "./config.js";
import { JOB_KEYS, METRIC_NAMES } from "./constants.js";
import { initOTel, type OTelHandle } from "./otel-setup.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let otel: OTelHandle | null = null;
let ctx: PluginContext | null = null;
let startedAt: string | null = null;
let eventsProcessed = 0;
let lastError: string | null = null;

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleAgentRunStarted(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  // Run counter
  const runCounter = otel.meter.createCounter(METRIC_NAMES.agentRunsStarted, {
    description: "Count of agent runs started",
  });
  runCounter.add(1, {
    agent_id: String(p.agentId ?? ""),
    invocation_source: String(p.invocationSource ?? ""),
  });

  // Root span — kept open for correlation on run.finished/failed
  const span = otel.tracer.startSpan("agent.run", {
    attributes: {
      // Paperclip-specific
      "paperclip.agent.id": String(p.agentId ?? ""),
      "paperclip.run.id": String(p.runId ?? ""),
      "paperclip.company.id": String(p.companyId ?? ""),
      "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
      // GenAI semconv agent span attributes
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": String(p.agentId ?? ""),
      "gen_ai.agent.name": String(p.agentName ?? ""),
    },
  });

  // Store span context in plugin state for correlation on run.finished/failed
  const runId = String(p.runId ?? "");
  if (runId && ctx) {
    await ctx.state
      .set(
        { scopeKind: "instance", stateKey: `span:run:${runId}` },
        {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          startTime: Date.now(),
        },
      )
      .catch(() => {});
  }

  span.end();
}

async function handleAgentRunFinished(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");

  const durationHist = otel.meter.createHistogram(
    METRIC_NAMES.agentRunDuration,
    {
      description: "Duration of agent heartbeat runs in milliseconds",
      unit: "ms",
    },
  );

  // GenAI semconv: gen_ai.client.operation.duration (seconds)
  const genAIDurationHist = otel.meter.createHistogram(
    "gen_ai.client.operation.duration",
    {
      description: "GenAI operation duration",
      unit: "s",
    },
  );

  if (p.durationMs != null) {
    const durationMs = Number(p.durationMs);
    durationHist.record(durationMs, {
      agent_id: String(p.agentId ?? ""),
      status: "finished",
    });
    genAIDurationHist.record(durationMs / 1000, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": String(p.provider ?? "anthropic"),
      "gen_ai.request.model": String(p.model ?? "unknown"),
    });
  }

  if (runId && ctx) {
    await ctx.state
      .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => {});
  }
}

async function handleAgentRunFailed(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");

  const errorCounter = otel.meter.createCounter(METRIC_NAMES.agentRunErrors, {
    description: "Count of failed agent runs",
  });
  errorCounter.add(1, {
    agent_id: String(p.agentId ?? ""),
    error: String(p.error ?? "unknown"),
  });

  if (runId && ctx) {
    await ctx.state
      .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => {});
  }
}

async function handleCostEvent(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const inputTokens = otel.meter.createCounter(METRIC_NAMES.tokensInput, {
    description: "Total input tokens consumed",
  });
  const outputTokens = otel.meter.createCounter(METRIC_NAMES.tokensOutput, {
    description: "Total output tokens consumed",
  });
  const costCounter = otel.meter.createCounter(METRIC_NAMES.costCents, {
    description: "Total cost in cents",
    unit: "cents",
  });

  // GenAI semconv: gen_ai.client.token.usage histogram
  const genAITokenUsage = otel.meter.createHistogram(
    "gen_ai.client.token.usage",
    {
      description: "Measures number of input and output tokens used",
      unit: "{token}",
    },
  );

  const tags = {
    agent_id: String(p.agentId ?? ""),
    company_id: String(p.companyId ?? ""),
    model: String(p.model ?? "unknown"),
  };

  const genAIBaseTags = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": String(p.provider ?? "anthropic"),
    "gen_ai.request.model": String(p.model ?? "unknown"),
  };

  if (p.inputTokens != null) {
    const count = Number(p.inputTokens);
    inputTokens.add(count, tags);
    genAITokenUsage.record(count, {
      ...genAIBaseTags,
      "gen_ai.token.type": "input",
    });
  }
  if (p.outputTokens != null) {
    const count = Number(p.outputTokens);
    outputTokens.add(count, tags);
    genAITokenUsage.record(count, {
      ...genAIBaseTags,
      "gen_ai.token.type": "output",
    });
  }
  if (p.costCents != null) costCounter.add(Number(p.costCents), tags);

  // LLM span for cost event
  const span = otel.tracer.startSpan("llm.cost", {
    attributes: {
      "paperclip.agent.id": String(p.agentId ?? ""),
      "paperclip.company.id": String(p.companyId ?? ""),
      "paperclip.cost.cents": Number(p.costCents ?? 0),
      "paperclip.billing.type": String(p.billingType ?? ""),
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": String(p.provider ?? "anthropic"),
      "gen_ai.request.model": String(p.model ?? "unknown"),
      "gen_ai.usage.input_tokens": Number(p.inputTokens ?? 0),
      "gen_ai.usage.output_tokens": Number(p.outputTokens ?? 0),
    },
  });
  span.end();
}

async function handleIssueUpdated(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const issueTransitions = otel.meter.createCounter(
    METRIC_NAMES.issueTransitions,
    { description: "Count of issue status transitions" },
  );
  issueTransitions.add(1, {
    status: String(p.status ?? "unknown"),
    project_id: String(p.projectId ?? ""),
  });
}

async function handleAgentStatusChanged(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const agentStatusChanges = otel.meter.createCounter(
    METRIC_NAMES.agentStatusChanges,
    { description: "Count of agent status changes" },
  );
  agentStatusChanges.add(1, {
    agent_id: String(p.agentId ?? ""),
    status: String(p.status ?? "unknown"),
  });
}

async function handleApprovalDecided(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const approvalCounter = otel.meter.createCounter(
    METRIC_NAMES.approvalsDecided,
    { description: "Count of approval decisions" },
  );
  approvalCounter.add(1, {
    decision: String(p.decision ?? "unknown"),
    company_id: String(p.companyId ?? ""),
  });
}

async function handleIssueCreated(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const issueCounter = otel.meter.createCounter(METRIC_NAMES.issuesCreated, {
    description: "Count of issues created",
  });
  issueCounter.add(1, {
    project_id: String(p.projectId ?? ""),
    priority: String(p.priority ?? "medium"),
  });
}

async function handleApprovalCreated(
  event: PluginEvent<unknown>,
): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const approvalCounter = otel.meter.createCounter(
    METRIC_NAMES.approvalsCreated,
    { description: "Count of approvals created" },
  );
  approvalCounter.add(1, {
    company_id: String(p.companyId ?? ""),
  });
}

async function handleGenericEvent(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const genericCounter = otel.meter.createCounter(METRIC_NAMES.eventsTotal, {
    description: "Total domain events observed",
  });
  genericCounter.add(1, { event_type: event.eventType });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    startedAt = new Date().toISOString();
    ctx.logger.info("Observability plugin starting");

    // Load config and initialise OTel SDK
    const rawConfig = await ctx.config.get();
    const config = resolveConfig(rawConfig);

    try {
      otel = initOTel(config);
      ctx.logger.info("OTel SDK initialised", {
        endpoint: config.otlpEndpoint,
        tracing: config.enableTracing,
        metrics: config.enableMetrics,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.logger.error("Failed to initialise OTel SDK", {
        error: lastError,
      });
    }

    // ----- Subscribe to domain events -----

    ctx.events.on("agent.run.started", handleAgentRunStarted);
    ctx.events.on("agent.run.finished", handleAgentRunFinished);
    ctx.events.on("agent.run.failed", handleAgentRunFailed);
    ctx.events.on("agent.run.cancelled", handleGenericEvent);

    ctx.events.on("cost_event.created", handleCostEvent);

    ctx.events.on("issue.created", handleIssueCreated);
    ctx.events.on("issue.updated", handleIssueUpdated);

    ctx.events.on("agent.status_changed", handleAgentStatusChanged);

    ctx.events.on("approval.created", handleApprovalCreated);
    ctx.events.on("approval.decided", handleApprovalDecided);

    ctx.events.on("activity.logged", handleGenericEvent);

    // ----- Register collect-metrics job -----

    ctx.jobs.register(
      JOB_KEYS.collectMetrics,
      async (_job: PluginJobContext) => {
        if (!otel || !ctx) return;

        ctx.logger.info("Collecting gauge metrics");

        // Future: query ctx.agents.list / ctx.issues.list to record gauge
        // snapshots (active agent count, open issue count, etc.)

        await ctx.activity.log({
          companyId: "",
          message: `Metrics collection — ${eventsProcessed} events processed since startup`,
        });
      },
    );

    await ctx.activity.log({
      companyId: "",
      message:
        "Observability plugin initialised and subscribed to domain events",
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!otel) {
      return {
        status: lastError ? "degraded" : "error",
        message: lastError ?? "OTel SDK not initialised",
        details: { startedAt, eventsProcessed, lastError },
      };
    }

    return {
      status: "ok",
      message: `Healthy — ${eventsProcessed} events processed`,
      details: { startedAt, eventsProcessed, otelInitialised: true },
    };
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    ctx?.logger.info("Config changed — reinitialising OTel SDK");

    if (otel) {
      try {
        await otel.shutdown();
      } catch (err) {
        ctx?.logger.warn("Error shutting down old OTel SDK", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const config = resolveConfig(newConfig);
    try {
      otel = initOTel(config);
      lastError = null;
      ctx?.logger.info("OTel SDK reinitialised with new config");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      otel = null;
      ctx?.logger.error("Failed to reinitialise OTel SDK", {
        error: lastError,
      });
    }
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (config.otlpEndpoint) {
      const endpoint = String(config.otlpEndpoint);
      if (
        !endpoint.startsWith("http://") &&
        !endpoint.startsWith("https://")
      ) {
        errors.push("otlpEndpoint must start with http:// or https://");
      }
    }

    if (config.exportIntervalMs != null) {
      const interval = Number(config.exportIntervalMs);
      if (interval < 1000) {
        warnings.push(
          "exportIntervalMs below 1000ms may cause excessive load",
        );
      }
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onShutdown() {
    ctx?.logger.info(
      "Observability plugin shutting down — flushing telemetry",
    );

    if (otel) {
      try {
        await otel.shutdown();
        ctx?.logger.info("OTel SDK shut down successfully");
      } catch (err) {
        ctx?.logger.error("Error during OTel shutdown", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      otel = null;
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
