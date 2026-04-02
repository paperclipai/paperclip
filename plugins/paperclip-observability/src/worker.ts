/**
 * Observability plugin worker.
 *
 * Subscribes to Paperclip domain events (agent runs, issue lifecycle, cost
 * events, approvals) and forwards them as OTel metrics, traces, and logs
 * to a configured OTLP collector.
 *
 * Event dispatch is handled by the EventTelemetryRouter, which fans out
 * each event to focused handler modules (metrics, traces, logs) via
 * Promise.allSettled.
 */

import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type Agent,
  type Issue,
  type Project,
} from "@paperclipai/plugin-sdk";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { ObservabilityConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { JOB_KEYS, METRIC_NAMES } from "./constants.js";
import { initOTel, type OTelHandle } from "./otel-setup.js";
import {
  EventTelemetryRouter,
  type TelemetryContext,
} from "./telemetry/router.js";
import {
  computeHealthScore,
  type HealthScoreResult,
} from "./health-score.js";

// Metrics handlers
import {
  handleRunStartedMetrics,
  handleRunFinishedMetrics,
  handleRunFailedMetrics,
  handleRunCancelledMetrics,
  handleCostMetrics,
  handleIssueCreatedMetrics,
  handleIssueUpdatedMetrics,
  handleAgentStatusChangedMetrics,
  handleApprovalCreatedMetrics,
  handleApprovalDecidedMetrics,
  handleGenericMetrics,
} from "./telemetry/metrics-handlers.js";

// Trace handlers
import {
  handleRunStartedTraces,
  handleRunFinishedTraces,
  handleRunFailedTraces,
  handleRunCancelledTraces,
  handleCostTraces,
  handleIssueUpdatedTraces,
} from "./telemetry/trace-handlers.js";

// Log handlers
import {
  handleRunStartedLogs,
  handleRunFinishedLogs,
  handleRunFailedLogs,
  handleAgentStatusChangedLogs,
  handleIssueCreatedLogs,
  handleIssueUpdatedLogs,
  handleApprovalCreatedLogs,
  handleApprovalDecidedLogs,
  handleCostEventLogs,
} from "./telemetry/log-handlers.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let otel: OTelHandle | null = null;
let ctx: PluginContext | null = null;
let resolvedConfig: ObservabilityConfig | null = null;
let startedAt: string | null = null;
let eventsProcessed = 0;
let lastError: string | null = null;

// Active span maps — shared across handler modules via TelemetryContext
const activeRunSpans = new Map<string, Span>();
const activeIssueSpans = new Map<string, Span>();

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

interface IssueSnapshot {
  companyId: string;
  projectId: string;
  projectName: string;
  status: string;
  count: number;
}
let issueSnapshots: IssueSnapshot[] = [];

interface GovernanceSnapshot {
  companyId: string;
  approvalsPending: number;
  budgetIncidentsActive: number;
  companyBudgetUtilPct: number;
  pausedAgentCount: number;
  pausedProjectCount: number;
}
let governanceSnapshots: GovernanceSnapshot[] = [];

interface HealthScoreSnapshot {
  agentId: string;
  agentName: string;
  agentRole: string;
  companyId: string;
  score: number;
  healthStatus: string;
}
let healthScoreSnapshots: HealthScoreSnapshot[] = [];

interface ServerHealthSnapshot {
  score: number;
  dbReachable: boolean;
  otelSdkInitialized: boolean;
}
let serverHealthSnapshot: ServerHealthSnapshot = {
  score: 0,
  dbReachable: false,
  otelSdkInitialized: false,
};

// ---------------------------------------------------------------------------
// Router setup — register all handlers
// ---------------------------------------------------------------------------

function createRouter(): EventTelemetryRouter {
  const router = new EventTelemetryRouter();

  // agent.run.started
  router.register("agent.run.started", handleRunStartedMetrics);
  router.register("agent.run.started", handleRunStartedTraces);
  router.register("agent.run.started", handleRunStartedLogs);

  // agent.run.finished
  router.register("agent.run.finished", handleRunFinishedMetrics);
  router.register("agent.run.finished", handleRunFinishedTraces);
  router.register("agent.run.finished", handleRunFinishedLogs);

  // agent.run.failed
  router.register("agent.run.failed", handleRunFailedMetrics);
  router.register("agent.run.failed", handleRunFailedTraces);
  router.register("agent.run.failed", handleRunFailedLogs);

  // agent.run.cancelled
  router.register("agent.run.cancelled", handleRunCancelledMetrics);
  router.register("agent.run.cancelled", handleRunCancelledTraces);

  // cost_event.created
  router.register("cost_event.created", handleCostMetrics);
  router.register("cost_event.created", handleCostTraces);
  router.register("cost_event.created", handleCostEventLogs);

  // issue.created
  router.register("issue.created", handleIssueCreatedMetrics);
  router.register("issue.created", handleIssueCreatedLogs);

  // issue.updated
  router.register("issue.updated", handleIssueUpdatedMetrics);
  router.register("issue.updated", handleIssueUpdatedTraces);
  router.register("issue.updated", handleIssueUpdatedLogs);

  // agent.status_changed
  router.register("agent.status_changed", handleAgentStatusChangedMetrics);
  router.register("agent.status_changed", handleAgentStatusChangedLogs);

  // approval.created
  router.register("approval.created", handleApprovalCreatedMetrics);
  router.register("approval.created", handleApprovalCreatedLogs);

  // approval.decided
  router.register("approval.decided", handleApprovalDecidedMetrics);
  router.register("approval.decided", handleApprovalDecidedLogs);

  // activity.logged (generic)
  router.register("activity.logged", handleGenericMetrics);

  return router;
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
    resolvedConfig = config;

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

    // ----- Create router and telemetry context -----

    const router = createRouter();

    const telemetryCtx: TelemetryContext | null = otel
      ? {
          meter: otel.meter,
          tracer: otel.tracer,
          state: ctx.state,
          logger: ctx.logger,
          otelLogger: otel.otelLogger,
          activeRunSpans,
          activeIssueSpans,
        }
      : null;

    // ----- Subscribe to domain events via router -----

    const eventTypes = [
      "agent.run.started",
      "agent.run.finished",
      "agent.run.failed",
      "agent.run.cancelled",
      "cost_event.created",
      "issue.created",
      "issue.updated",
      "agent.status_changed",
      "approval.created",
      "approval.decided",
      "activity.logged",
    ] as const;

    for (const eventType of eventTypes) {
      ctx.events.on(eventType, async (event) => {
        if (!telemetryCtx) return;
        eventsProcessed++;
        await router.dispatch(event, telemetryCtx);
      });
    }

    // ----- Register observable gauges (read from snapshots) -----

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

    const healthScoreGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.agentHealthScore,
      { description: "Agent health score (0-100)" },
    );
    healthScoreGauge.addCallback((obs) => {
      for (const snap of healthScoreSnapshots) {
        obs.observe(snap.score, {
          agent_id: snap.agentId,
          agent_name: snap.agentName,
          agent_role: snap.agentRole,
          company_id: snap.companyId,
          health_status: snap.healthStatus,
        });
      }
    });

    const serverHealthGauge = otel.meter.createObservableGauge(
      METRIC_NAMES.serverHealthScore,
      { description: "Server health score (100 if healthy, 0 if error)" },
    );
    serverHealthGauge.addCallback((obs) => {
      obs.observe(serverHealthSnapshot.score, {
        db_reachable: String(serverHealthSnapshot.dbReachable),
        otel_initialized: String(serverHealthSnapshot.otelSdkInitialized),
      });
    });

    } // end if (otel) — gauge registration

    // ----- Register collect-metrics job (refreshes snapshots) -----

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
          const pendingCount = await ctx.state
            .get({
              scopeKind: "instance",
              stateKey: `approvals:pending:${company.id}`,
            })
            .catch(() => null);
          const approvalsPending =
            typeof pendingCount === "number" ? Math.max(0, pendingCount) : 0;

          const companyBudgetUtilPct =
            company.budgetMonthlyCents > 0
              ? (company.spentMonthlyCents / company.budgetMonthlyCents) * 100
              : 0;

          const companyAgents = snapshots.filter(
            (s) => s.companyId === company.id,
          );
          const budgetIncidentsActive = companyAgents.filter(
            (a) =>
              a.budgetMonthlyCents > 0 &&
              a.spentMonthlyCents >= a.budgetMonthlyCents,
          ).length;

          const pausedAgentCount = companyAgents.filter(
            (a) => a.status === "paused",
          ).length;

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

        // --- Compute agent health scores ---

        const healthSnapshots: HealthScoreSnapshot[] = [];
        for (const snap of snapshots) {
          const result = computeHealthScore({
            status: snap.status,
            heartbeatAgeSec: snap.heartbeatAgeSec,
            budgetMonthlyCents: snap.budgetMonthlyCents,
            spentMonthlyCents: snap.spentMonthlyCents,
            runSuccessRate: null, // TODO: compute from recent runs when run history API is available
          });
          healthSnapshots.push({
            agentId: snap.agentId,
            agentName: snap.agentName,
            agentRole: snap.agentRole,
            companyId: snap.companyId,
            score: result.score,
            healthStatus: result.healthStatus,
          });
        }

        healthScoreSnapshots = healthSnapshots;
        ctx.logger.info("Health score snapshots updated", {
          agentCount: healthSnapshots.length,
        });

        // --- Collect server health probe ---

        let dbReachable = false;
        try {
          await ctx.companies.list({ limit: 1, offset: 0 });
          dbReachable = true;
        } catch {
          dbReachable = false;
        }

        const otelSdkInitialized = otel != null;
        const serverScore = dbReachable && otelSdkInitialized ? 100 : 0;

        serverHealthSnapshot = {
          score: serverScore,
          dbReachable,
          otelSdkInitialized,
        };

        ctx.logger.info("Server health probe completed", {
          score: serverScore,
          dbReachable,
          otelSdkInitialized,
        });

        await ctx.activity.log({
          companyId: "",
          message: `Metrics collection — ${snapshots.length} agents, ${issueSnapshots.length} issue buckets, ${govSnapshots.length} governance snapshots, ${healthSnapshots.length} health scores, ${eventsProcessed} events processed since startup`,
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
    const otelSdkInitialized = otel != null;
    const tracingEnabled = resolvedConfig?.enableTracing ?? false;
    const metricsEnabled = resolvedConfig?.enableMetrics ?? false;
    const otlpEndpoint = resolvedConfig?.otlpEndpoint ?? null;

    // DB reachability probe
    let dbReachable = false;
    try {
      if (ctx) {
        await ctx.companies.list({ limit: 1, offset: 0 });
        dbReachable = true;
      }
    } catch {
      dbReachable = false;
    }

    const details = {
      startedAt,
      eventsProcessed,
      otelSdkInitialized,
      tracingEnabled,
      metricsEnabled,
      otlpEndpoint,
      dbReachable,
      lastError,
    };

    if (!otelSdkInitialized && !dbReachable) {
      return {
        status: "error",
        message: "OTel SDK not initialised and DB unreachable",
        details,
      };
    }

    if (!otelSdkInitialized) {
      return {
        status: lastError ? "degraded" : "error",
        message: lastError ?? "OTel SDK not initialised",
        details,
      };
    }

    if (!dbReachable) {
      return {
        status: "degraded",
        message: "DB unreachable — metrics collection may be stale",
        details,
      };
    }

    return {
      status: "ok",
      message: `Healthy — ${eventsProcessed} events processed`,
      details,
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
    resolvedConfig = config;
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

    // End any active run spans before shutdown
    for (const [runId, span] of activeRunSpans) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "plugin_shutdown" });
      span.setAttribute("paperclip.run.interrupted", true);
      span.end();
      ctx?.logger.info("Ended orphaned run span on shutdown", { runId });
    }
    activeRunSpans.clear();

    // End any active issue lifecycle spans before shutdown
    for (const [issueId, span] of activeIssueSpans) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "plugin_shutdown" });
      span.setAttribute("paperclip.issue.interrupted", true);
      span.end();
      ctx?.logger.info("Ended orphaned issue span on shutdown", { issueId });
    }
    activeIssueSpans.clear();

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
