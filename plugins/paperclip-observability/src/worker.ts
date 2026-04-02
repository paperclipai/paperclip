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
  type Agent,
  type Issue,
  type Project,
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

// Gauge snapshot data — written by the collect-metrics job, read by observable gauge callbacks
interface AgentSnapshot {
  agentId: string;
  agentName: string;
  agentRole: string;
  companyId: string;
  status: string;
  heartbeatAgeSec: number | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
}
let agentSnapshots: AgentSnapshot[] = [];

// Issue gauge snapshot data — written by the collect-metrics job, read by observable gauge callback
interface IssueSnapshot {
  companyId: string;
  projectId: string;
  projectName: string;
  status: string;
  count: number;
}
let issueSnapshots: IssueSnapshot[] = [];

// Governance gauge snapshot data — written by the collect-metrics job
interface GovernanceSnapshot {
  companyId: string;
  approvalsPending: number;
  budgetIncidentsActive: number;
  companyBudgetUtilPct: number;
  pausedAgentCount: number;
  pausedProjectCount: number;
}
let governanceSnapshots: GovernanceSnapshot[] = [];

// ---------------------------------------------------------------------------
// Provider name mapping (adapter type → OTel well-known value)
// ---------------------------------------------------------------------------

function mapProvider(adapterType: string): string {
  switch (adapterType) {
    case "claude_local":
    case "claude":
      return "anthropic";
    case "openai":
    case "cursor-local":
    case "codex-local":
      return "openai";
    case "gemini-local":
      return "gcp.gemini";
    case "openclaw-gateway":
    case "openclaw":
      // OpenClaw proxies multiple providers; best-effort from model name
      return adapterType;
    default:
      return adapterType || "unknown";
  }
}

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
      "gen_ai.provider.name": mapProvider(String(p.provider ?? "anthropic")),
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
  const provider = mapProvider(String(p.provider ?? ""));

  // --- Paperclip-specific counters ---

  const inputTokensCounter = otel.meter.createCounter(
    METRIC_NAMES.tokensInput,
    { description: "Total input tokens consumed" },
  );
  const outputTokensCounter = otel.meter.createCounter(
    METRIC_NAMES.tokensOutput,
    { description: "Total output tokens consumed" },
  );
  const costCounter = otel.meter.createCounter(METRIC_NAMES.costCents, {
    description: "Total cost in cents",
    unit: "cent",
  });

  const costTags = {
    agent_id: String(p.agentId ?? ""),
    provider,
    model: String(p.model ?? "unknown"),
    billing_type: String(p.billingType ?? ""),
    biller: String(p.biller ?? ""),
  };

  if (p.inputTokens != null) inputTokensCounter.add(Number(p.inputTokens), costTags);
  if (p.outputTokens != null) outputTokensCounter.add(Number(p.outputTokens), costTags);
  if (p.costCents != null) costCounter.add(Number(p.costCents), costTags);

  // --- GenAI semconv: gen_ai.client.token.usage histogram ---

  const tokenUsage = otel.meter.createHistogram(
    "gen_ai.client.token.usage",
    {
      description: "Measures number of input and output tokens used",
      unit: "{token}",
    },
  );

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

  // --- LLM span for cost event ---

  const span = otel.tracer.startSpan("llm.cost", {
    attributes: {
      "paperclip.agent.id": String(p.agentId ?? ""),
      "paperclip.company.id": String(p.companyId ?? ""),
      "paperclip.cost.cents": Number(p.costCents ?? 0),
      "paperclip.billing.type": String(p.billingType ?? ""),
      "paperclip.billing.biller": String(p.biller ?? ""),
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": String(p.model ?? "unknown"),
      "gen_ai.usage.input_tokens": Number(p.inputTokens ?? 0),
      "gen_ai.usage.output_tokens": Number(p.outputTokens ?? 0),
      "gen_ai.usage.cache_read.input_tokens": Number(
        p.cachedInputTokens ?? 0,
      ),
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

  // Track issue completions (transition to "done")
  if (
    String(p.status ?? "") === "done" &&
    String(p.previousStatus ?? "") !== "done"
  ) {
    const issuesCompleted = otel.meter.createCounter(
      METRIC_NAMES.issuesCompleted,
      { description: "Count of issues completed" },
    );
    issuesCompleted.add(1, {
      project_id: String(p.projectId ?? ""),
    });
  }
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
  const companyId = String(p.companyId ?? "");

  const approvalCounter = otel.meter.createCounter(
    METRIC_NAMES.approvalsDecided,
    { description: "Count of approval decisions" },
  );
  approvalCounter.add(1, {
    decision: String(p.decision ?? "unknown"),
    company_id: companyId,
  });

  // Track pending approval count in plugin state (decrement)
  if (ctx && companyId) {
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
  const companyId = String(p.companyId ?? "");

  const approvalCounter = otel.meter.createCounter(
    METRIC_NAMES.approvalsCreated,
    { description: "Count of approvals created" },
  );
  approvalCounter.add(1, {
    company_id: companyId,
  });

  // Track pending approval count in plugin state (increment)
  if (ctx && companyId) {
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

    // ----- Register observable gauges (read from agentSnapshots) -----

    if (otel) {
    const agentCountGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.agentsCount,
      { description: "Number of agents by status" },
    );
    agentCountGauge.addCallback((obs) => {
      const seen = new Map<string, { count: number; companyId: string; status: string }>();
      for (const snap of agentSnapshots) {
        const key = `${snap.companyId}:${snap.status}`;
        const entry = seen.get(key);
        if (entry) {
          entry.count++;
        } else {
          seen.set(key, { count: 1, companyId: snap.companyId, status: snap.status });
        }
      }
      for (const { count, companyId, status } of seen.values()) {
        obs.observe(count, { status, company_id: companyId });
      }
    });

    const heartbeatAgeGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.agentsHeartbeatAge,
      { description: "Seconds since last agent heartbeat", unit: "s" },
    );
    heartbeatAgeGauge.addCallback((obs) => {
      for (const snap of agentSnapshots) {
        if (snap.heartbeatAgeSec != null) {
          obs.observe(snap.heartbeatAgeSec, {
            agent_id: snap.agentId,
            agent_name: snap.agentName,
            agent_role: snap.agentRole,
            company_id: snap.companyId,
          });
        }
      }
    });

    const budgetUtilGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.budgetUtilization,
      { description: "Budget utilization percentage" },
    );
    budgetUtilGauge.addCallback((obs) => {
      for (const snap of agentSnapshots) {
        if (snap.budgetMonthlyCents > 0) {
          const utilPct = (snap.spentMonthlyCents / snap.budgetMonthlyCents) * 100;
          obs.observe(utilPct, {
            agent_id: snap.agentId,
            agent_name: snap.agentName,
            company_id: snap.companyId,
            scope: "agent",
          });
        }
      }
    });

    const budgetRemainingGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.budgetRemaining,
      { description: "Remaining budget in cents", unit: "cent" },
    );
    budgetRemainingGauge.addCallback((obs) => {
      for (const snap of agentSnapshots) {
        if (snap.budgetMonthlyCents > 0) {
          obs.observe(snap.budgetMonthlyCents - snap.spentMonthlyCents, {
            agent_id: snap.agentId,
            agent_name: snap.agentName,
            company_id: snap.companyId,
          });
        }
      }
    });
    const issueCountGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.issuesCount,
      { description: "Number of issues by status and project" },
    );
    issueCountGauge.addCallback((obs) => {
      for (const snap of issueSnapshots) {
        obs.observe(snap.count, {
          status: snap.status,
          project_id: snap.projectId,
          project_name: snap.projectName,
          company_id: snap.companyId,
        });
      }
    });
    // --- Governance & budget gauges (read from governanceSnapshots) ---

    const approvalsPendingGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.approvalsPending,
      { description: "Number of pending approvals" },
    );
    approvalsPendingGauge.addCallback((obs) => {
      for (const snap of governanceSnapshots) {
        obs.observe(snap.approvalsPending, { company_id: snap.companyId });
      }
    });

    const budgetIncidentsGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.budgetIncidentsActive,
      { description: "Number of active budget incidents" },
    );
    budgetIncidentsGauge.addCallback((obs) => {
      for (const snap of governanceSnapshots) {
        obs.observe(snap.budgetIncidentsActive, {
          company_id: snap.companyId,
        });
      }
    });

    const companyBudgetUtilGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.companyBudgetUtilization,
      { description: "Company-level budget utilization percentage" },
    );
    companyBudgetUtilGauge.addCallback((obs) => {
      for (const snap of governanceSnapshots) {
        obs.observe(snap.companyBudgetUtilPct, {
          company_id: snap.companyId,
        });
      }
    });

    const pausedAgentsGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.budgetPausedAgents,
      { description: "Number of agents paused due to budget" },
    );
    pausedAgentsGauge.addCallback((obs) => {
      for (const snap of governanceSnapshots) {
        obs.observe(snap.pausedAgentCount, { company_id: snap.companyId });
      }
    });

    const pausedProjectsGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.budgetPausedProjects,
      { description: "Number of projects paused due to budget" },
    );
    pausedProjectsGauge.addCallback((obs) => {
      for (const snap of governanceSnapshots) {
        obs.observe(snap.pausedProjectCount, { company_id: snap.companyId });
      }
    });

    } // end if (otel) — gauge registration

    // ----- Register collect-metrics job (refreshes agentSnapshots) -----

    ctx.jobs.register(
      JOB_KEYS.collectMetrics,
      async (_job: PluginJobContext) => {
        if (!ctx) return;

        ctx.logger.info("Collecting agent health snapshots");

        const companies = await ctx.companies.list({ limit: 100, offset: 0 });
        const now = Date.now();
        const snapshots: AgentSnapshot[] = [];

        for (const company of companies) {
          const agents = await ctx.agents.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });

          for (const agent of agents as Agent[]) {
            const lastHb = agent.lastHeartbeatAt
              ? new Date(agent.lastHeartbeatAt).getTime()
              : null;

            snapshots.push({
              agentId: agent.id,
              agentName: agent.name,
              agentRole: agent.role,
              companyId: company.id,
              status: agent.status,
              heartbeatAgeSec: lastHb != null ? (now - lastHb) / 1000 : null,
              budgetMonthlyCents: agent.budgetMonthlyCents,
              spentMonthlyCents: agent.spentMonthlyCents,
            });
          }
        }

        agentSnapshots = snapshots;
        ctx.logger.info("Agent health snapshots updated", {
          agentCount: snapshots.length,
          companyCount: companies.length,
        });

        // --- Collect issue count gauges ---

        // Build project name lookup
        const projectNameMap = new Map<string, string>();
        for (const company of companies) {
          const projects = await ctx.projects.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });
          for (const project of projects as Project[]) {
            projectNameMap.set(project.id, project.name);
          }
        }

        // Fetch all issues and group by (companyId, projectId, status)
        const issueBuckets = new Map<string, IssueSnapshot>();

        for (const company of companies) {
          const issues = await ctx.issues.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });

          for (const issue of issues as Issue[]) {
            const projectId = issue.projectId ?? "";
            const key = `${company.id}:${projectId}:${issue.status}`;
            const existing = issueBuckets.get(key);
            if (existing) {
              existing.count++;
            } else {
              issueBuckets.set(key, {
                companyId: company.id,
                projectId,
                projectName: projectNameMap.get(projectId) ?? "",
                status: issue.status,
                count: 1,
              });
            }
          }
        }

        issueSnapshots = Array.from(issueBuckets.values());
        ctx.logger.info("Issue count snapshots updated", {
          buckets: issueSnapshots.length,
        });

        // --- Collect governance & budget gauges ---

        const govSnapshots: GovernanceSnapshot[] = [];

        for (const company of companies) {
          // Pending approvals — read from event-driven state counter
          const pendingCount = await ctx.state
            .get({
              scopeKind: "instance",
              stateKey: `approvals:pending:${company.id}`,
            })
            .catch(() => null);
          const approvalsPending =
            typeof pendingCount === "number" ? Math.max(0, pendingCount) : 0;

          // Company-level budget utilization
          const companyBudgetUtilPct =
            company.budgetMonthlyCents > 0
              ? (company.spentMonthlyCents / company.budgetMonthlyCents) * 100
              : 0;

          // Budget incidents: agents whose spend has reached or exceeded budget
          const companyAgents = snapshots.filter(
            (s) => s.companyId === company.id,
          );
          const budgetIncidentsActive = companyAgents.filter(
            (a) =>
              a.budgetMonthlyCents > 0 &&
              a.spentMonthlyCents >= a.budgetMonthlyCents,
          ).length;

          // Paused agent/project counts
          const pausedAgentCount = companyAgents.filter(
            (a) => a.status === "paused",
          ).length;

          // Projects paused due to budget — check project status
          const companyProjects = await ctx.projects.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });
          const pausedProjectCount = (companyProjects as Project[]).filter(
            (p) => p.pauseReason != null,
          ).length;

          govSnapshots.push({
            companyId: company.id,
            approvalsPending,
            budgetIncidentsActive,
            companyBudgetUtilPct: Number(companyBudgetUtilPct.toFixed(2)),
            pausedAgentCount,
            pausedProjectCount,
          });
        }

        governanceSnapshots = govSnapshots;
        ctx.logger.info("Governance snapshots updated", {
          companyCount: govSnapshots.length,
        });

        await ctx.activity.log({
          companyId: "",
          message: `Metrics collection — ${snapshots.length} agents, ${issueSnapshots.length} issue buckets, ${govSnapshots.length} governance snapshots, ${eventsProcessed} events processed since startup`,
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
