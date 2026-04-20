import { and, desc, eq, gte, inArray, lt, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns } from "@paperclipai/db";
import type {
  AgentServiceHealth,
  AgentServiceHealthFailureExample,
  AgentServiceHealthReason,
} from "@paperclipai/shared";

const INELIGIBLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
const LIVE_RUN_STATUSES = ["queued", "running"];
const RECENT_HEALTHY_RUN_STATUSES = ["succeeded", "running"];
const RECENT_RUNTIME_FAILURE_STATUSES = ["failed", "timed_out"];
const STUCK_QUEUED_RUN_MS = 5 * 60 * 1000;
const RECENT_RUNTIME_WINDOW_MS = 30 * 60 * 1000;
const FAILURE_EXAMPLE_LIMIT = 3;

const RUNTIME_ERROR_CODES = new Set([
  "adapter_failed",
  "auth_required",
  "claude_auth_required",
  "codex_auth_required",
  "cursor_auth_required",
  "gemini_auth_required",
  "opencode_auth_required",
  "process_detached",
  "process_lost",
  "quota_exhausted",
  "rate_limited",
  "timeout",
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseBooleanLike(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function parseNumberLike(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function readHeartbeatPolicy(runtimeConfig: unknown) {
  const heartbeat = asRecord(asRecord(runtimeConfig).heartbeat);
  return {
    enabled: parseBooleanLike(heartbeat.enabled),
    intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec)),
  };
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function latestIsoTimestamp(values: Array<Date | string | null | undefined>) {
  let latest = 0;
  for (const value of values) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function isRuntimeFailure(row: { status: string; error: string | null; errorCode: string | null }) {
  if (!RECENT_RUNTIME_FAILURE_STATUSES.includes(row.status)) return false;
  if (row.status === "timed_out") return true;

  const code = row.errorCode?.trim().toLowerCase() ?? "";
  if (RUNTIME_ERROR_CODES.has(code)) return true;

  const error = row.error?.toLowerCase() ?? "";
  return (
    error.includes("command not found") ||
    error.includes("enoent") ||
    error.includes("no such file or directory") ||
    error.includes("auth required") ||
    error.includes("requires login") ||
    error.includes("login required") ||
    error.includes("quota") ||
    error.includes("rate limit") ||
    error.includes("rate-limit") ||
    error.includes("429") ||
    error.includes("process lost") ||
    error.includes("detached") ||
    error.includes("timed out") ||
    error.includes("timeout") ||
    error.includes("spawn") ||
    error.includes("adapter failed")
  );
}

function buildMessage(reason: AgentServiceHealthReason | null) {
  switch (reason) {
    case "scheduler_disabled":
      return "AI agent service is down: the heartbeat scheduler is disabled.";
    case "no_scheduler_active_agents":
      return "AI agent service is down: no scheduler-active heartbeats are enabled across active companies.";
    case "queued_runs_stuck":
      return "AI agent service is down: queued agent runs have not started for over 5 minutes.";
    case "recent_runtime_failures":
      return "AI agent service is down: recent agent runtime failures are preventing scheduled agents from progressing.";
    default:
      return "AI agent service is healthy.";
  }
}

function buildHealth(input: {
  status: AgentServiceHealth["status"];
  reason: AgentServiceHealthReason | null;
  now: Date;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  activeCompanyCount: number;
  eligibleAgentCount: number;
  schedulerActiveAgentCount: number;
  liveRunCount: number;
  stuckQueuedRunCount: number;
  recentHealthyRunCount: number;
  recentRuntimeFailureAgentCount: number;
  latestHeartbeatAt: string | null;
  failureExamples: AgentServiceHealthFailureExample[];
}): AgentServiceHealth {
  return {
    status: input.status,
    reason: input.reason,
    message: buildMessage(input.reason),
    checkedAt: input.now.toISOString(),
    scheduler: {
      enabled: input.schedulerEnabled,
      intervalMs: input.schedulerIntervalMs,
    },
    counts: {
      activeCompanyCount: input.activeCompanyCount,
      eligibleAgentCount: input.eligibleAgentCount,
      schedulerActiveAgentCount: input.schedulerActiveAgentCount,
      liveRunCount: input.liveRunCount,
      stuckQueuedRunCount: input.stuckQueuedRunCount,
      recentHealthyRunCount: input.recentHealthyRunCount,
      recentRuntimeFailureAgentCount: input.recentRuntimeFailureAgentCount,
    },
    latestHeartbeatAt: input.latestHeartbeatAt,
    failureExamples: input.failureExamples,
  };
}

export function agentServiceHealthService(db: Db) {
  return {
    get: async (input: {
      heartbeatSchedulerEnabled: boolean;
      heartbeatSchedulerIntervalMs: number;
      now?: Date;
    }): Promise<AgentServiceHealth> => {
      const now = input.now ?? new Date();
      const stuckQueuedBefore = new Date(now.getTime() - STUCK_QUEUED_RUN_MS);
      const recentWindowStart = new Date(now.getTime() - RECENT_RUNTIME_WINDOW_MS);

      const activeCompanyRows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.status, "active"));

      const eligibleAgentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          runtimeConfig: agents.runtimeConfig,
          lastHeartbeatAt: agents.lastHeartbeatAt,
          companyName: companies.name,
        })
        .from(agents)
        .innerJoin(companies, eq(agents.companyId, companies.id))
        .where(
          and(
            eq(companies.status, "active"),
            not(inArray(agents.status, INELIGIBLE_AGENT_STATUSES)),
          ),
        );

      const schedulerActiveAgentRows = eligibleAgentRows.filter((agent) => {
        const policy = readHeartbeatPolicy(agent.runtimeConfig);
        return policy.enabled && policy.intervalSec > 0;
      });
      const schedulerActiveAgentIds = schedulerActiveAgentRows.map((agent) => agent.id);

      const liveRunRows = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(companies, eq(heartbeatRuns.companyId, companies.id))
        .where(
          and(
            eq(companies.status, "active"),
            inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
          ),
        );

      const oldQueuedRunRows = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
        })
        .from(heartbeatRuns)
        .innerJoin(companies, eq(heartbeatRuns.companyId, companies.id))
        .where(
          and(
            eq(companies.status, "active"),
            eq(heartbeatRuns.status, "queued"),
            lt(heartbeatRuns.createdAt, stuckQueuedBefore),
          ),
        );
      const runningAgentKeys = new Set(
        liveRunRows
          .filter((row) => row.status === "running")
          .map((row) => `${row.companyId}:${row.agentId}`),
      );
      const stuckQueuedRunRows = oldQueuedRunRows.filter(
        (row) => !runningAgentKeys.has(`${row.companyId}:${row.agentId}`),
      );

      let recentHealthyRunCount = 0;
      let recentRuntimeFailureAgentCount = 0;
      let failureExamples: AgentServiceHealthFailureExample[] = [];

      if (schedulerActiveAgentIds.length > 0) {
        const recentRunRows = await db
          .select({
            runId: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            companyName: companies.name,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            adapterType: agents.adapterType,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
            errorCode: heartbeatRuns.errorCode,
            createdAt: heartbeatRuns.createdAt,
            finishedAt: heartbeatRuns.finishedAt,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .innerJoin(companies, eq(heartbeatRuns.companyId, companies.id))
          .where(
            and(
              eq(companies.status, "active"),
              inArray(heartbeatRuns.agentId, schedulerActiveAgentIds),
              gte(heartbeatRuns.createdAt, recentWindowStart),
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt));

        const recentHealthyAgentIds = new Set(
          recentRunRows
            .filter((row) => RECENT_HEALTHY_RUN_STATUSES.includes(row.status))
            .map((row) => row.agentId),
        );
        const runtimeFailureRows = recentRunRows.filter(isRuntimeFailure);
        const runtimeFailureAgentIds = new Set(runtimeFailureRows.map((row) => row.agentId));

        recentHealthyRunCount = recentHealthyAgentIds.size;
        recentRuntimeFailureAgentCount = runtimeFailureAgentIds.size;
        failureExamples = runtimeFailureRows.slice(0, FAILURE_EXAMPLE_LIMIT).map((row) => ({
          runId: row.runId,
          companyId: row.companyId,
          companyName: row.companyName,
          agentId: row.agentId,
          agentName: row.agentName,
          adapterType: row.adapterType,
          status: row.status as AgentServiceHealthFailureExample["status"],
          error: row.error,
          errorCode: row.errorCode,
          createdAt: toIsoString(row.createdAt) ?? now.toISOString(),
          finishedAt: toIsoString(row.finishedAt),
        }));
      }

      const latestHeartbeatAt = latestIsoTimestamp(eligibleAgentRows.map((agent) => agent.lastHeartbeatAt));
      const base = {
        now,
        schedulerEnabled: input.heartbeatSchedulerEnabled,
        schedulerIntervalMs: input.heartbeatSchedulerIntervalMs,
        activeCompanyCount: activeCompanyRows.length,
        eligibleAgentCount: eligibleAgentRows.length,
        schedulerActiveAgentCount: schedulerActiveAgentRows.length,
        liveRunCount: liveRunRows.length,
        stuckQueuedRunCount: stuckQueuedRunRows.length,
        recentHealthyRunCount,
        recentRuntimeFailureAgentCount,
        latestHeartbeatAt,
        failureExamples,
      };

      if (!input.heartbeatSchedulerEnabled && eligibleAgentRows.length > 0) {
        return buildHealth({ ...base, status: "down", reason: "scheduler_disabled" });
      }

      if (eligibleAgentRows.length > 0 && schedulerActiveAgentRows.length === 0) {
        return buildHealth({ ...base, status: "down", reason: "no_scheduler_active_agents" });
      }

      if (stuckQueuedRunRows.length > 0) {
        return buildHealth({ ...base, status: "down", reason: "queued_runs_stuck" });
      }

      const runtimeFailureThreshold = Math.max(1, Math.ceil(schedulerActiveAgentRows.length / 2));
      if (
        schedulerActiveAgentRows.length > 0 &&
        recentHealthyRunCount === 0 &&
        recentRuntimeFailureAgentCount >= runtimeFailureThreshold
      ) {
        return buildHealth({ ...base, status: "down", reason: "recent_runtime_failures" });
      }

      return buildHealth({ ...base, status: "healthy", reason: null });
    },
  };
}
