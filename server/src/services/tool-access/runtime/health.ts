import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolAccessAuditEvents, toolConnections, toolCallEvents, toolRuntimeMetricCounters, toolRuntimeSlots } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode, ToolRuntimeAlertRecommendation, ToolRuntimeHealthSummary } from "@paperclipai/shared";
import { TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC } from "../../tool-runtime-metrics.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function runtimeAlert(
  input: ToolRuntimeAlertRecommendation,
): ToolRuntimeAlertRecommendation {
  return input;
}

function buildRuntimeAlerts(input: {
  stuckStartingSlots: number;
  stuckRunningSlots: number;
  timeoutRate: number;
  timeoutCount: number;
  failureRate: number;
  failureCount: number;
  capacityDeferrals: number;
  restartAttempts: number;
  restartSuppressions: number;
  degradedConnections: number;
  disabledConnections: number;
  missingSecretFailures: number;
  auditWriteFailures: number;
}): ToolRuntimeAlertRecommendation[] {
  const runbookSection = "doc/MCP-RUNTIME-OPERATIONS.md";
  const timeoutSeverity =
    input.timeoutCount >= 10 || input.timeoutRate >= 25
      ? "critical"
      : input.timeoutCount >= 3 && input.timeoutRate >= 10
        ? "warning"
        : "warning";
  const failureSeverity =
    input.failureCount >= 10 || input.failureRate >= 25
      ? "critical"
      : input.failureCount >= 5 && input.failureRate >= 10
        ? "warning"
        : "warning";
  const restartSeverity =
    input.restartSuppressions > 0 ? "critical" : "warning";
  return [
    runtimeAlert({
      name: "mcp_runtime_stuck_starting_slot",
      severity: "critical",
      status: input.stuckStartingSlots > 0 ? "firing" : "ok",
      threshold: "Any starting slot older than 5 minutes.",
      observed: `${input.stuckStartingSlots} stuck starting slot(s).`,
      description:
        "A local stdio runtime slot is stuck before it reaches running state.",
      firstResponderAction:
        "Inspect the slot health/logs, stop the slot, restart it once, then disable the connection if the slot sticks again.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_stuck_running_slot",
      severity: "critical",
      status: input.stuckRunningSlots > 0 ? "firing" : "ok",
      threshold: "Any running slot with no progress for 5 minutes.",
      observed: `${input.stuckRunningSlots} stuck running slot(s).`,
      description:
        "A runtime slot is running but has not recorded progress inside the supervisor stuck-slot window.",
      firstResponderAction:
        "Inspect recent audit events and active tool calls; restart the slot only after confirming no healthy call is still in progress.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_high_timeout_rate",
      severity: timeoutSeverity,
      status:
        input.timeoutCount >= 3 && input.timeoutRate >= 10 ? "firing" : "ok",
      threshold:
        "Warning at >=3 timeouts and >=10% timeout rate in 1 hour; critical at >=10 timeouts or >=25%.",
      observed: `${input.timeoutCount} timeout(s), ${input.timeoutRate}% timeout rate.`,
      description:
        "Tool gateway calls are timing out or being runtime-deferred at an elevated rate.",
      firstResponderAction:
        "Check upstream MCP health, Paperclip runtime capacity, and recent gateway audit failures before retrying workloads.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_high_error_rate",
      severity: failureSeverity,
      status:
        input.failureCount >= 5 && input.failureRate >= 10 ? "firing" : "ok",
      threshold:
        "Warning at >=5 failures and >=10% failure rate in 1 hour; critical at >=10 failures or >=25%.",
      observed: `${input.failureCount} failure(s), ${input.failureRate}% failure rate.`,
      description:
        "Tool gateway calls are failing after policy authorization.",
      firstResponderAction:
        "Group audit failures by reasonCode, then fix credentials/config or disable the affected connection.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_capacity_deferrals_repeated",
      severity: input.capacityDeferrals >= 10 ? "critical" : "warning",
      status: input.capacityDeferrals >= 3 ? "firing" : "ok",
      threshold:
        "Warning at >=3 capacity deferrals in 1 hour; critical at >=10.",
      observed: `${input.capacityDeferrals} capacity deferral(s) in 1 hour.`,
      description:
        "The runtime supervisor is refusing local stdio work because company or host slot capacity is exhausted.",
      firstResponderAction:
        "Stop idle/stale slots, lower noisy workloads, or raise slot caps only after confirming host capacity.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_restart_storm",
      severity: restartSeverity,
      status:
        input.restartSuppressions > 0 || input.restartAttempts >= 3
          ? "firing"
          : "ok",
      threshold:
        "Warning at >=3 restarts in 1 hour; critical on any restart suppression.",
      observed: `${input.restartAttempts} restart attempt(s), ${input.restartSuppressions} suppression(s).`,
      description:
        "Runtime slots are restarting repeatedly or have hit restart-storm suppression.",
      firstResponderAction:
        "Stop the affected slot, inspect stderr/audit reason codes, and keep the connection disabled until the template/upstream is fixed.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_connection_health_degraded",
      severity: input.degradedConnections > 0 ? "critical" : "warning",
      status:
        input.degradedConnections > 0 || input.disabledConnections > 0
          ? "firing"
          : "ok",
      threshold:
        "Any active enabled connection with degraded/failed/missing-secret health, or any disabled enabled-path connection.",
      observed: `${input.degradedConnections} degraded connection(s), ${input.disabledConnections} disabled connection(s).`,
      description:
        "A configured MCP connection is not healthy or has been disabled.",
      firstResponderAction:
        "Run a connection health check, refresh catalog after recovery, or keep the connection disabled and route agents to alternatives.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_missing_secret_failures",
      severity: input.missingSecretFailures >= 3 ? "critical" : "warning",
      status: input.missingSecretFailures > 0 ? "firing" : "ok",
      threshold:
        "Warning on any missing-secret failure; critical at >=3 in 1 hour.",
      observed: `${input.missingSecretFailures} missing-secret failure(s) in 1 hour.`,
      description:
        "A connection or tool call needed a bound secret that could not be resolved.",
      firstResponderAction:
        "Check secret bindings and provider health without printing secret values; rotate or rebind missing secrets.",
      runbookSection,
    }),
    runtimeAlert({
      name: "mcp_runtime_audit_write_failures",
      severity: "critical",
      status: input.auditWriteFailures > 0 ? "firing" : "ok",
      threshold: "Any audit write failure.",
      observed: `${input.auditWriteFailures} audit write failure(s) in 1 hour.`,
      description:
        "Tool gateway audit writes failed, reducing incident traceability.",
      firstResponderAction:
        "Treat as a control-plane incident: check database writes, activity log writes, and retry only after audit durability is restored.",
      runbookSection,
    }),
  ];
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

type RuntimeHealthOptions = { deploymentMode?: DeploymentMode; deploymentExposure?: DeploymentExposure };

export function createToolRuntimeHealth(db: Db, options: RuntimeHealthOptions, now: () => Date, trustedRuntimeHost: () => string | null) {
  async function runtimeHealth(
    companyId: string,
  ): Promise<ToolRuntimeHealthSummary> {
    const generatedAt = now();
    const windowStartedAt = new Date(generatedAt.getTime() - 60 * 60 * 1000);
    const stuckSlotMs = 5 * 60 * 1000;
    const [
      slots,
      connections,
      auditRows,
      callEvents,
      auditWriteFailureCounterRows,
    ] = await Promise.all([
      db
        .select()
        .from(toolRuntimeSlots)
        .where(eq(toolRuntimeSlots.companyId, companyId)),
      db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.companyId, companyId)),
      db
        .select()
        .from(toolAccessAuditEvents)
        .where(
          and(
            eq(toolAccessAuditEvents.companyId, companyId),
            gte(toolAccessAuditEvents.createdAt, windowStartedAt),
          ),
        )
        .orderBy(desc(toolAccessAuditEvents.createdAt)),
      db
        .select()
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, companyId),
            gte(toolCallEvents.createdAt, windowStartedAt),
          ),
        )
        .orderBy(desc(toolCallEvents.createdAt)),
      db
        .select({
          count: sql<number>`coalesce(sum(${toolRuntimeMetricCounters.count}), 0)::int`,
        })
        .from(toolRuntimeMetricCounters)
        .where(
          and(
            eq(toolRuntimeMetricCounters.companyId, companyId),
            eq(
              toolRuntimeMetricCounters.metric,
              TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC,
            ),
            gte(toolRuntimeMetricCounters.bucketStartAt, windowStartedAt),
          ),
        ),
    ]);
    const activeSlots = slots.filter(
      (slot) =>
        slot.status === "starting" ||
        slot.status === "running" ||
        slot.status === "idle",
    );
    const staleActiveSlots = activeSlots.filter((slot) => {
      const lastProgressAt =
        slot.lastUsedAt ?? slot.startedAt ?? slot.updatedAt;
      return generatedAt.getTime() - lastProgressAt.getTime() > stuckSlotMs;
    });
    const callTerminalEvents = callEvents.filter(
      (event) =>
        event.eventType === "call_completed" ||
        event.eventType === "call_failed" ||
        event.eventType === "call_denied",
    );
    const toolCallsLastHour = callTerminalEvents.length;
    const toolTimeoutsLastHour = callTerminalEvents.filter(
      (event) => event.outcome === "timeout",
    ).length;
    const toolFailuresLastHour = callTerminalEvents.filter(
      (event) => event.outcome === "failure",
    ).length;
    const durations = auditRows
      .map((row) => numberValue(asRecord(row.details).durationMs))
      .filter((value): value is number => value !== null && value >= 0);
    const capacityDeferrals = auditRows.filter(
      (row) =>
        row.action === "runtime_deferred" ||
        row.reasonCode === "runtime_company_capacity_exhausted" ||
        row.reasonCode === "runtime_host_capacity_exhausted",
    ).length;
    const restartAttempts = auditRows.filter(
      (row) =>
        row.action === "runtime_started" && row.reasonCode !== "lazy_start",
    ).length;
    const restartSuppressions = auditRows.filter(
      (row) =>
        row.action === "runtime_restart_suppressed" ||
        row.reasonCode === "runtime_restart_suppressed",
    ).length;
    const idleEvictions = auditRows.filter(
      (row) =>
        row.action === "runtime_stopped" &&
        row.reasonCode === "idle_ttl_expired",
    ).length;
    const missingSecretFailures = auditRows.filter(
      (row) =>
        row.reasonCode === "missing_secret" ||
        (row.outcome === "failure" && row.reasonCode?.includes("secret")),
    ).length;
    const legacyAuditWriteFailures = auditRows.filter(
      (row) =>
        row.action === "runtime_audit_write_failed" ||
        row.reasonCode === "audit_write_failed",
    ).length;
    const auditWriteFailuresMetric =
      Number(auditWriteFailureCounterRows[0]?.count ?? 0) +
      legacyAuditWriteFailures;
    const enabledPathConnections = connections.filter(
      (connection) => connection.status === "active" && connection.enabled,
    );
    const activeConnections = enabledPathConnections.length;
    const disabledConnections = connections.filter(
      (connection) => connection.status === "disabled",
    ).length;
    const degradedConnections = enabledPathConnections.filter((connection) =>
      ["degraded", "failed", "error", "missing_secret"].includes(
        connection.healthStatus,
      ),
    ).length;
    const metrics = {
      windowStartedAt,
      windowEndedAt: generatedAt,
      activeSlots: activeSlots.length,
      startingSlots: slots.filter((slot) => slot.status === "starting").length,
      runningSlots: slots.filter((slot) => slot.status === "running").length,
      idleSlots: slots.filter((slot) => slot.status === "idle").length,
      failedSlots: slots.filter(
        (slot) => slot.status === "failed" || slot.status === "error",
      ).length,
      stoppedSlots: slots.filter(
        (slot) => slot.status === "stopped" || slot.status === "disabled",
      ).length,
      stuckStartingSlots: staleActiveSlots.filter(
        (slot) => slot.status === "starting",
      ).length,
      stuckRunningSlots: staleActiveSlots.filter(
        (slot) => slot.status === "running",
      ).length,
      capacityDeferralsLastHour: capacityDeferrals,
      restartAttemptsLastHour: restartAttempts,
      restartSuppressionsLastHour: restartSuppressions,
      idleEvictionsLastHour: idleEvictions,
      toolCallsLastHour,
      toolTimeoutsLastHour,
      toolFailuresLastHour,
      timeoutRateLastHour: percent(toolTimeoutsLastHour, toolCallsLastHour),
      failureRateLastHour: percent(toolFailuresLastHour, toolCallsLastHour),
      averageToolLatencyMsLastHour:
        durations.length > 0
          ? Math.round(
              durations.reduce((sum, value) => sum + value, 0) /
                durations.length,
            )
          : null,
      p95ToolLatencyMsLastHour: percentile(durations, 95),
      missingSecretFailuresLastHour: missingSecretFailures,
      auditWriteFailuresLastHour: auditWriteFailuresMetric,
      activeConnections,
      disabledConnections,
      degradedConnections,
      remoteHttpConnections: connections.filter(
        (connection) =>
          connection.status !== "archived" &&
          connection.transport === "mcp_remote",
      ).length,
      localStdioConnections: connections.filter(
        (connection) =>
          connection.status !== "archived" &&
          connection.transport === "local_stdio",
      ).length,
    };
    const recommendations = buildRuntimeAlerts({
      stuckStartingSlots: metrics.stuckStartingSlots,
      stuckRunningSlots: metrics.stuckRunningSlots,
      timeoutRate: metrics.timeoutRateLastHour,
      timeoutCount: metrics.toolTimeoutsLastHour,
      failureRate: metrics.failureRateLastHour,
      failureCount: metrics.toolFailuresLastHour,
      capacityDeferrals,
      restartAttempts,
      restartSuppressions,
      degradedConnections,
      disabledConnections,
      missingSecretFailures,
      auditWriteFailures: metrics.auditWriteFailuresLastHour,
    });
    const firing = recommendations.filter((alert) => alert.status === "firing");
    const status = firing.some((alert) => alert.severity === "critical")
      ? "critical"
      : firing.length > 0
        ? "degraded"
        : "ok";
    const deploymentMode = options.deploymentMode ?? "local_trusted";
    const deploymentExposure = options.deploymentExposure ?? "private";
    const localStdioSupported =
      deploymentMode === "local_trusted" || Boolean(trustedRuntimeHost());
    return {
      status,
      generatedAt,
      runbookPath: "doc/MCP-RUNTIME-OPERATIONS.md",
      metrics,
      supportMatrix: {
        remoteHttp: {
          supported: true,
          note: "mcp_remote MCP connections are supported in hosted cloud and local deployments.",
        },
        localStdio: {
          supported: localStdioSupported,
          note: localStdioSupported
            ? "local_stdio is available for local trusted mode or through the configured trusted MCP runtime host."
            : `local_stdio should stay disabled for ${deploymentMode}/${deploymentExposure}; use mcp_remote or configure a trusted runtime worker.`,
        },
      },
      alerts: firing,
      recommendations,
    };
  }
  return runtimeHealth;
}
