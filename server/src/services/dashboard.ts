import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

type OpsProbeConfig = {
  id: string;
  label: string;
  url: string;
  method?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

function parseOpsProbeConfigs(): OpsProbeConfig[] {
  const raw = process.env.PAPERCLIP_OPS_PROBES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const probes: OpsProbeConfig[] = [];
    for (const value of parsed) {
      if (typeof value !== "object" || value == null) continue;
      const row = value as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const label = typeof row.label === "string" ? row.label.trim() : "";
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (!id || !label || !url || seen.has(id)) continue;
      const headers: Record<string, string> = {};
      if (typeof row.headers === "object" && row.headers != null) {
        for (const [k, v] of Object.entries(row.headers as Record<string, unknown>)) {
          if (typeof v === "string" && k.trim().length > 0) {
            headers[k] = v;
          }
        }
      }
      probes.push({
        id,
        label,
        url,
        method: typeof row.method === "string" ? row.method : undefined,
        timeoutMs: typeof row.timeoutMs === "number" ? row.timeoutMs : undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      seen.add(id);
    }
    return probes;
  } catch {
    return [];
  }
}

function actionForErrorCode(errorCode: string | null) {
  switch ((errorCode ?? "").trim()) {
    case "process_lost":
      return "Collect host diagnostics and resume the interrupted run.";
    case "claude_auth_required":
      return "Run Claude login and retry the run.";
    case "timeout":
      return "Split scope or raise timeout for this project.";
    case "adapter_failed":
      return "Inspect stderr/result payload and re-run with a narrower prompt.";
    case "cancelled":
      return "No action required unless cancellation was unexpected.";
    default:
      return "Inspect run log and follow the incident checklist.";
  }
}

export function dashboardService(db: Db) {
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);
      const staleTasks = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_progress"),
            sql`${issues.startedAt} < ${staleCutoff.toISOString()}`,
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;

      const billingRows = await db
        .select({
          billingType: sql<string>`coalesce(${heartbeatRuns.usageJson} ->> 'billingType', 'unknown')`,
          count: sql<number>`count(*)`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.finishedAt, monthStart),
          ),
        )
        .groupBy(sql`coalesce(${heartbeatRuns.usageJson} ->> 'billingType', 'unknown')`);

      let apiRuns = 0;
      let subscriptionRuns = 0;
      for (const row of billingRows) {
        const count = Number(row.count);
        if (row.billingType === "api") apiRuns += count;
        if (row.billingType === "subscription") subscriptionRuns += count;
      }

      const billingType =
        apiRuns > 0 && subscriptionRuns > 0
          ? "mixed"
          : apiRuns > 0
            ? "api"
            : subscriptionRuns > 0
              ? "subscription"
              : "unknown";

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
          billingType,
        },
        pendingApprovals,
        staleTasks,
      };
    },
    operationsPulse: async (companyId: string) => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const since24hIso = since24h.toISOString();
      const staleRunCutoff = new Date(now.getTime() - 5 * 60 * 1000);
      const staleRunCutoffIso = staleRunCutoff.toISOString();

      const [runHealth] = await db
        .select({
          running: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')::int`,
          queued: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')::int`,
          failed24h: sql<number>`count(*) filter (where ${heartbeatRuns.createdAt} >= ${since24hIso}::timestamptz and ${heartbeatRuns.status} in ('failed', 'timed_out'))::int`,
          processLost24h: sql<number>`count(*) filter (where ${heartbeatRuns.createdAt} >= ${since24hIso}::timestamptz and ${heartbeatRuns.errorCode} = 'process_lost')::int`,
          staleRunning: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running' and ${heartbeatRuns.updatedAt} < ${staleRunCutoffIso}::timestamptz)::int`,
          safeModeActiveRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} in ('queued', 'running') and coalesce(${heartbeatRuns.contextSnapshot} -> 'paperclipSafeMode' ->> 'enabled', 'false') = 'true')::int`,
          safeModeRuns24h: sql<number>`count(*) filter (where ${heartbeatRuns.createdAt} >= ${since24hIso}::timestamptz and coalesce(${heartbeatRuns.contextSnapshot} -> 'paperclipSafeMode' ->> 'enabled', 'false') = 'true')::int`,
          blockedByConcurrency: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued' and coalesce(${heartbeatRuns.contextSnapshot} -> 'paperclipOps' ->> 'guardrailBlocked', '') = 'project_max_concurrency')::int`,
          recentRecommendations: sql<number>`count(*) filter (where ${heartbeatRuns.createdAt} >= ${since24hIso}::timestamptz and (${heartbeatRuns.resultJson} -> 'paperclipOps' ->> 'recommendedAction') is not null)::int`,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId));

      const [deferredWakeups] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));

      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
        })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), sql`${projects.archivedAt} is null`));

      const workspaceRows = await db
        .select({
          projectId: projectWorkspaces.projectId,
          metadata: projectWorkspaces.metadata,
          isPrimary: projectWorkspaces.isPrimary,
          createdAt: projectWorkspaces.createdAt,
        })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.companyId, companyId))
        .orderBy(sql`${projectWorkspaces.isPrimary} desc`, projectWorkspaces.createdAt);

      const projectGuardrailState = new Map<string, { configured: boolean; safeModeDefault: boolean }>();
      for (const workspace of workspaceRows) {
        if (projectGuardrailState.has(workspace.projectId)) continue;
        const metadata = (workspace.metadata ?? {}) as Record<string, unknown>;
        const runGuardrails =
          typeof metadata.runGuardrails === "object" && metadata.runGuardrails != null
            ? (metadata.runGuardrails as Record<string, unknown>)
            : null;
        projectGuardrailState.set(workspace.projectId, {
          configured: Boolean(runGuardrails),
          safeModeDefault: runGuardrails?.safeModeDefault === true,
        });
      }

      const missingProjectNames: string[] = [];
      let configuredProjects = 0;
      let defaultSafeModeProjects = 0;
      for (const project of projectRows) {
        const state = projectGuardrailState.get(project.id);
        if (state?.configured) configuredProjects += 1;
        else missingProjectNames.push(project.name);
        if (state?.safeModeDefault) defaultSafeModeProjects += 1;
      }

      const errorCodeRows = await db
        .select({
          errorCode: heartbeatRuns.errorCode,
          count: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            sql`${heartbeatRuns.createdAt} >= ${since24hIso}::timestamptz`,
            sql`${heartbeatRuns.errorCode} is not null`,
          ),
        )
        .groupBy(heartbeatRuns.errorCode)
        .orderBy(sql`count(*) desc`)
        .limit(5);

      const probeConfigs = parseOpsProbeConfigs();
      const probes = await Promise.all(
        probeConfigs.map(async (probe) => {
          const startedAt = Date.now();
          const timeoutMs = Math.max(250, Math.min(15_000, probe.timeoutMs ?? 2500));
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(probe.url, {
              method: (probe.method ?? "GET").toUpperCase(),
              headers: probe.headers,
              signal: controller.signal,
            });
            const latencyMs = Date.now() - startedAt;
            return {
              id: probe.id,
              label: probe.label,
              url: probe.url,
              status: res.ok ? ("ok" as const) : ("degraded" as const),
              statusCode: res.status,
              latencyMs,
              error: null,
              checkedAt: new Date().toISOString(),
            };
          } catch (err) {
            const latencyMs = Date.now() - startedAt;
            const message = err instanceof Error ? err.message : "probe_failed";
            return {
              id: probe.id,
              label: probe.label,
              url: probe.url,
              status: "down" as const,
              statusCode: null,
              latencyMs,
              error: message,
              checkedAt: new Date().toISOString(),
            };
          } finally {
            clearTimeout(timer);
          }
        }),
      );

      const failingProbeCount = probes.filter((probe) => probe.status !== "ok").length;

      return {
        companyId,
        generatedAt: now.toISOString(),
        runHealth: {
          running: Number(runHealth?.running ?? 0),
          queued: Number(runHealth?.queued ?? 0),
          failed24h: Number(runHealth?.failed24h ?? 0),
          processLost24h: Number(runHealth?.processLost24h ?? 0),
          staleRunning: Number(runHealth?.staleRunning ?? 0),
          deferredWakeups: Number(deferredWakeups?.count ?? 0),
        },
        integrationHealth: {
          total: probes.length,
          failing: failingProbeCount,
          probes,
        },
        projectGuardrails: {
          totalProjects: projectRows.length,
          configuredProjects,
          defaultSafeModeProjects,
          missingProjectNames: missingProjectNames.slice(0, 10),
          blockedByConcurrency: Number(runHealth?.blockedByConcurrency ?? 0),
        },
        failureRouting: {
          recentRecommendations: Number(runHealth?.recentRecommendations ?? 0),
          topErrorCodes: errorCodeRows.map((row) => ({
            errorCode: row.errorCode ?? "unknown",
            count: Number(row.count ?? 0),
            recommendedAction: actionForErrorCode(row.errorCode ?? null),
          })),
        },
        safeMode: {
          activeRuns: Number(runHealth?.safeModeActiveRuns ?? 0),
          runs24h: Number(runHealth?.safeModeRuns24h ?? 0),
        },
      };
    },
  };
}
