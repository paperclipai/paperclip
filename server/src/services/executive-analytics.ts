import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  costEvents,
  goals,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
} from "@ironworksai/db";
import { SLA_TARGETS } from "@ironworksai/shared";
import type { IssuePriority, RiskLevel } from "@ironworksai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

function priorMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const priorStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const priorEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start: priorStart, end: priorEnd };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function executiveAnalyticsService(db: Db) {
  return {
    /**
     * Unit economics: cost per completed issue and cost per active heartbeat hour.
     * Includes prior-period comparison for trend.
     */
    unitEconomics: async (companyId: string) => {
      const now = new Date();
      const current = currentUtcMonthWindow(now);
      const prior = priorMonthWindow(now);

      async function periodMetrics(start: Date, end: Date) {
        const [spendRow] = await db
          .select({
            totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, start),
              lt(costEvents.occurredAt, end),
            ),
          );

        const [issuesDone] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              isNotNull(issues.completedAt),
              gte(issues.completedAt, start),
              lt(issues.completedAt, end),
            ),
          );

        const [runHoursRow] = await db
          .select({
            totalMinutes: sql<number>`coalesce(sum(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) / 60.0), 0)::int`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              isNotNull(heartbeatRuns.finishedAt),
              gte(heartbeatRuns.startedAt, start),
              lt(heartbeatRuns.startedAt, end),
            ),
          );

        const totalCents = Number(spendRow?.totalCents ?? 0);
        const doneCount = Number(issuesDone?.count ?? 0);
        const activeMinutes = Number(runHoursRow?.totalMinutes ?? 0);
        const activeHours = activeMinutes / 60;

        return {
          totalCents,
          issuesDone: doneCount,
          activeHours: Math.round(activeHours * 100) / 100,
          costPerIssue: doneCount > 0 ? Math.round(totalCents / doneCount) : 0,
          costPerActiveHour: activeHours > 0 ? Math.round(totalCents / activeHours) : 0,
        };
      }

      const currentMetrics = await periodMetrics(current.start, current.end);
      const priorMetrics = await periodMetrics(prior.start, prior.end);

      return {
        current: currentMetrics,
        prior: priorMetrics,
        costPerIssueTrend: currentMetrics.costPerIssue - priorMetrics.costPerIssue,
        costPerHourTrend: currentMetrics.costPerActiveHour - priorMetrics.costPerActiveHour,
      };
    },

    /**
     * Burn rate: extrapolate current month spend from last 7 days.
     * Runway: if a budget is set, how many days/months until exhausted.
     */
    burnRate: async (companyId: string) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [weekSpendRow] = await db
        .select({
          totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, sevenDaysAgo),
          ),
        );

      const weekSpendCents = Number(weekSpendRow?.totalCents ?? 0);
      const dailyRate = weekSpendCents / 7;
      const monthlyRate = Math.round(dailyRate * 30.44);

      const company = await db
        .select({
          budgetMonthlyCents: companies.budgetMonthlyCents,
          spentMonthlyCents: companies.spentMonthlyCents,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      const budgetCents = company?.budgetMonthlyCents ?? 0;
      const spentCents = company?.spentMonthlyCents ?? 0;
      const remainingCents = Math.max(0, budgetCents - spentCents);

      let runwayDays: number | null = null;
      let runwayMonths: number | null = null;

      if (budgetCents > 0 && dailyRate > 0) {
        runwayDays = Math.round(remainingCents / dailyRate);
        runwayMonths = Math.round((runwayDays / 30.44) * 10) / 10;
      }

      return {
        weekSpendCents,
        dailyRateCents: Math.round(dailyRate),
        monthlyRateCents: monthlyRate,
        budgetCents,
        spentCents,
        remainingCents,
        runwayDays,
        runwayMonths,
      };
    },

    /**
     * Cost allocation by project with issue count and cost per issue.
     */
    costAllocation: async (companyId: string) => {
      const current = currentUtcMonthWindow();

      const rows = await db
        .select({
          projectId: issues.projectId,
          projectName: projects.name,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          issueCount: sql<number>`count(distinct ${issues.id})::int`,
        })
        .from(costEvents)
        .innerJoin(issues, and(
          eq(costEvents.companyId, issues.companyId),
          sql`${costEvents.agentId} = ${issues.assigneeAgentId}`,
        ))
        .innerJoin(projects, eq(issues.projectId, projects.id))
        .where(
          and(
            eq(costEvents.companyId, companyId),
            isNotNull(issues.projectId),
            gte(costEvents.occurredAt, current.start),
            lt(costEvents.occurredAt, current.end),
          ),
        )
        .groupBy(issues.projectId, projects.name)
        .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

      return rows.map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        costCents: Number(row.costCents),
        issueCount: Number(row.issueCount),
        costPerIssue: Number(row.issueCount) > 0
          ? Math.round(Number(row.costCents) / Number(row.issueCount))
          : 0,
      }));
    },

    /**
     * SLA compliance: percentage of completed issues resolved within SLA.
     */
    slaCompliance: async (companyId: string) => {
      const completedIssues = await db
        .select({
          id: issues.id,
          priority: issues.priority,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            isNotNull(issues.completedAt),
          ),
        );

      let total = 0;
      let withinSla = 0;
      const byPriority: Record<string, { total: number; met: number; avgMinutes: number; sumMinutes: number }> = {};

      for (const issue of completedIssues) {
        if (!issue.completedAt) continue;
        const priority = issue.priority as IssuePriority;
        const target = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (target == null) continue;

        const resolutionMinutes =
          (new Date(issue.completedAt).getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);

        total += 1;
        const met = resolutionMinutes <= target;
        if (met) withinSla += 1;

        if (!byPriority[priority]) {
          byPriority[priority] = { total: 0, met: 0, avgMinutes: 0, sumMinutes: 0 };
        }
        byPriority[priority].total += 1;
        if (met) byPriority[priority].met += 1;
        byPriority[priority].sumMinutes += resolutionMinutes;
      }

      // Compute averages
      for (const p of Object.keys(byPriority)) {
        const entry = byPriority[p];
        entry.avgMinutes = entry.total > 0 ? Math.round(entry.sumMinutes / entry.total) : 0;
      }

      return {
        total,
        withinSla,
        compliancePercent: total > 0 ? Math.round((withinSla / total) * 100) : 100,
        byPriority: Object.entries(byPriority).map(([priority, data]) => ({
          priority,
          total: data.total,
          met: data.met,
          compliancePercent: data.total > 0 ? Math.round((data.met / data.total) * 100) : 100,
          avgResolutionMinutes: data.avgMinutes,
          targetMinutes: SLA_TARGETS[priority as keyof typeof SLA_TARGETS] ?? 0,
        })),
      };
    },

    /**
     * Tech debt: count of issues matching tech debt patterns.
     */
    techDebtCount: async (companyId: string) => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      async function countDebt(since: Date, until: Date) {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              ne(issues.status, "cancelled"),
              sql`(
                lower(${issues.title}) like '%tech debt%'
                or lower(${issues.title}) like '%technical debt%'
                or lower(${issues.title}) like '%refactor%'
                or lower(coalesce(${issues.description}, '')) like '%tech debt%'
                or lower(coalesce(${issues.description}, '')) like '%technical debt%'
              )`,
              gte(issues.createdAt, since),
              lt(issues.createdAt, until),
            ),
          );
        return Number(row?.count ?? 0);
      }

      const currentCount = await countDebt(thirtyDaysAgo, now);
      const priorCount = await countDebt(sixtyDaysAgo, thirtyDaysAgo);

      // Also get total open tech debt
      const [openRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
            sql`(
              lower(${issues.title}) like '%tech debt%'
              or lower(${issues.title}) like '%technical debt%'
              or lower(${issues.title}) like '%refactor%'
              or lower(coalesce(${issues.description}, '')) like '%tech debt%'
              or lower(coalesce(${issues.description}, '')) like '%technical debt%'
            )`,
          ),
        );

      return {
        openCount: Number(openRow?.count ?? 0),
        createdLast30d: currentCount,
        createdPrior30d: priorCount,
        trend: currentCount - priorCount,
      };
    },

    /**
     * Risk register: identifies high-risk items.
     */
    riskRegister: async (companyId: string) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Critical/high priority open issues that are overdue by SLA
      const overdueIssues = await db
        .select({
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          status: issues.status,
          createdAt: issues.createdAt,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.priority, ["critical", "high"]),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
          ),
        );

      // Issues open > 7 days with no progress (still in backlog or todo)
      const staleIssues = await db
        .select({
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo"]),
            lt(issues.createdAt, sevenDaysAgo),
          ),
        );

      // Agents with low performance score
      const lowPerfAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          performanceScore: agents.performanceScore,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
            lt(agents.performanceScore, 40),
          ),
        );

      // Classify risks
      const risks: Array<{
        level: RiskLevel;
        category: string;
        title: string;
        entityType: string;
        entityId: string;
        detail: string;
      }> = [];

      for (const issue of overdueIssues) {
        const priority = issue.priority as IssuePriority;
        const targetMinutes = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (!targetMinutes) continue;
        const ageMinutes = (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);
        if (ageMinutes > targetMinutes) {
          risks.push({
            level: priority === "critical" ? "critical" : "high",
            category: "overdue_issue",
            title: issue.title,
            entityType: "issue",
            entityId: issue.id,
            detail: `Open ${priority} issue overdue by ${Math.round((ageMinutes - targetMinutes) / 60)}h`,
          });
        }
      }

      for (const issue of staleIssues) {
        const ageDays = Math.round(
          (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        risks.push({
          level: "medium",
          category: "stale_issue",
          title: issue.title,
          entityType: "issue",
          entityId: issue.id,
          detail: `No progress for ${ageDays} days`,
        });
      }

      for (const agent of lowPerfAgents) {
        risks.push({
          level: (agent.performanceScore ?? 0) < 20 ? "high" : "medium",
          category: "low_performance",
          title: agent.name,
          entityType: "agent",
          entityId: agent.id,
          detail: `Performance score: ${agent.performanceScore}`,
        });
      }

      // Sort by severity
      const levelOrder: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      risks.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

      const countByLevel: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const r of risks) countByLevel[r.level] += 1;

      return {
        totalRisks: risks.length,
        countByLevel,
        risks: risks.slice(0, 25), // Cap at 25 items
      };
    },

    /**
     * Per-agent security profile: permissions, data scopes, tool authorizations, access log.
     */
    agentSecurityProfile: async (agentId: string): Promise<{
      permissions: string[];
      dataScopes: string[];
      toolAuthorizations: string[];
      recentAccessLog: Array<{ action: string; timestamp: Date; details: string }>;
    }> => {
      // 1. Permissions from principal_permission_grants
      const permissionRows = await db
        .select({ permissionKey: principalPermissionGrants.permissionKey })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agentId),
          ),
        );
      const permissions = permissionRows.map((r) => r.permissionKey);

      // 2. Data scopes: company + projects the agent can access
      const [agentRow] = await db
        .select({
          companyId: agents.companyId,
          adapterConfig: agents.adapterConfig,
          capabilities: agents.capabilities,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      const dataScopes: string[] = [];
      if (agentRow) {
        // Agent has access to its own company
        const [companyRow] = await db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, agentRow.companyId))
          .limit(1);
        if (companyRow) {
          dataScopes.push(`company:${companyRow.name}`);
        }

        // List projects the agent has touched (assigned issues)
        const projectRows = await db
          .selectDistinct({ projectName: projects.name, projectId: projects.id })
          .from(issues)
          .innerJoin(projects, eq(issues.projectId, projects.id))
          .where(eq(issues.assigneeAgentId, agentId))
          .limit(20);

        for (const p of projectRows) {
          dataScopes.push(`project:${p.projectName}`);
        }
      }

      // 3. Tool authorizations: from adapter config + company skills
      const toolAuthorizations: string[] = [];
      if (agentRow) {
        const config = agentRow.adapterConfig as Record<string, unknown>;
        if (config.tools && Array.isArray(config.tools)) {
          for (const tool of config.tools) {
            if (typeof tool === "string") toolAuthorizations.push(tool);
            else if (tool && typeof tool === "object" && "name" in tool) {
              toolAuthorizations.push(String((tool as { name: string }).name));
            }
          }
        }
        if (agentRow.capabilities) {
          const caps = agentRow.capabilities.split(",").map((c: string) => c.trim()).filter(Boolean);
          for (const cap of caps) {
            if (!toolAuthorizations.includes(cap)) toolAuthorizations.push(cap);
          }
        }

        // Skills assigned to the company
        const skillRows = await db
          .select({ skillName: companySkills.name })
          .from(companySkills)
          .where(eq(companySkills.companyId, agentRow.companyId))
          .limit(50);
        for (const s of skillRows) {
          toolAuthorizations.push(`skill:${s.skillName}`);
        }
      }

      // 4. Recent access log: last 20 activity log entries for this agent
      const logRows = await db
        .select({
          action: activityLog.action,
          createdAt: activityLog.createdAt,
          details: activityLog.details,
        })
        .from(activityLog)
        .where(eq(activityLog.agentId, agentId))
        .orderBy(desc(activityLog.createdAt))
        .limit(20);

      const recentAccessLog = logRows.map((r) => ({
        action: r.action,
        timestamp: r.createdAt,
        details: r.details ? JSON.stringify(r.details) : "",
      }));

      return { permissions, dataScopes, toolAuthorizations, recentAccessLog };
    },

    /**
     * Compliance export: all auditable events in a date range for SOC 2 evidence.
     */
    complianceExport: async (companyId: string, from: Date, to: Date) => {
      // 1. All agent actions in the period
      const allActivity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            gte(activityLog.createdAt, from),
            lt(activityLog.createdAt, to),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(5000);

      // 2. Approval decisions
      const approvalActions = allActivity.filter(
        (a) =>
          a.action.includes("approval") ||
          a.action.includes("approved") ||
          a.action.includes("rejected"),
      );

      // 3. Hiring/termination events
      const hiringTermEvents = allActivity.filter(
        (a) =>
          a.action.includes("hire") ||
          a.action.includes("terminated") ||
          a.action.includes("termination") ||
          a.action.includes("onboard"),
      );

      // 4. Cost events
      const costRows = await db
        .select()
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, from),
            lt(costEvents.occurredAt, to),
          ),
        )
        .orderBy(desc(costEvents.occurredAt))
        .limit(5000);

      // 5. Agent configurations at time of export
      const agentConfigs = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          permissions: agents.permissions,
          department: agents.department,
          employmentType: agents.employmentType,
          budgetMonthlyCents: agents.budgetMonthlyCents,
          spentMonthlyCents: agents.spentMonthlyCents,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      return {
        exportedAt: new Date().toISOString(),
        companyId,
        periodFrom: from.toISOString(),
        periodTo: to.toISOString(),
        allActions: allActivity,
        approvalDecisions: approvalActions,
        hiringTerminationEvents: hiringTermEvents,
        costEvents: costRows,
        agentConfigurations: agentConfigs,
        summary: {
          totalActions: allActivity.length,
          totalApprovals: approvalActions.length,
          totalHiringTerminations: hiringTermEvents.length,
          totalCostEvents: costRows.length,
          totalAgents: agentConfigs.length,
        },
      };
    },

    /**
     * Permission matrix: all agents and their permission grants.
     */
    permissionMatrix: async (companyId: string) => {
      const companyAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          department: agents.department,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
          ),
        )
        .orderBy(agents.name);

      const allGrants = await db
        .select({
          principalId: principalPermissionGrants.principalId,
          permissionKey: principalPermissionGrants.permissionKey,
        })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "agent"),
          ),
        );

      // Build a set of all distinct permission keys
      const allPermissions = [...new Set(allGrants.map((g) => g.permissionKey))].sort();

      // Build a lookup: agentId -> Set<permissionKey>
      const grantsByAgent = new Map<string, Set<string>>();
      for (const g of allGrants) {
        if (!grantsByAgent.has(g.principalId)) {
          grantsByAgent.set(g.principalId, new Set());
        }
        grantsByAgent.get(g.principalId)!.add(g.permissionKey);
      }

      const matrix = companyAgents.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        department: agent.department,
        permissions: Object.fromEntries(
          allPermissions.map((perm) => [perm, grantsByAgent.get(agent.id)?.has(perm) ?? false]),
        ),
      }));

      return { permissions: allPermissions, agents: matrix };
    },

    /**
     * Circuit breaker check: returns whether an agent's recent runs show anomalous token usage.
     */
    checkCostAnomaly: async (agentId: string) => {
      const recentRuns = await db
        .select({
          id: heartbeatRuns.id,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
            isNotNull(heartbeatRuns.usageJson),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(10);

      if (recentRuns.length < 5) return { anomaly: false, reason: "insufficient_data" };

      // Look at last 5 runs
      const last5 = recentRuns.slice(0, 5);

      // Compute token usage for last 5 and the historical average from runs 5-10
      function extractTokens(usageJson: unknown): number {
        if (!usageJson || typeof usageJson !== "object") return 0;
        const usage = usageJson as Record<string, unknown>;
        const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
        const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
        return input + output;
      }

      const recent5Tokens = last5.map((r) => extractTokens(r.usageJson));
      const older = recentRuns.slice(5);

      if (older.length === 0) {
        // No baseline available, cannot determine anomaly
        return { anomaly: false, reason: "no_baseline" };
      }

      const olderTokens = older.map((r) => extractTokens(r.usageJson));
      const avgOlder = olderTokens.reduce((s, t) => s + t, 0) / olderTokens.length;

      if (avgOlder <= 0) return { anomaly: false, reason: "zero_baseline" };

      // Check if ALL of the last 5 exceed 3x the baseline
      const allExceed = recent5Tokens.every((t) => t > avgOlder * 3);

      return {
        anomaly: allExceed,
        reason: allExceed ? "all_recent_runs_exceed_3x_baseline" : "within_normal_range",
        recentAvgTokens: Math.round(recent5Tokens.reduce((s, t) => s + t, 0) / recent5Tokens.length),
        baselineAvgTokens: Math.round(avgOlder),
      };
    },

    /**
     * Composite company health score (0-100) with breakdown by category.
     */
    companyHealthScore: async (companyId: string): Promise<{
      score: number;
      breakdown: {
        agentPerformance: number;
        goalCompletion: number;
        budgetHealth: number;
        slaCompliance: number;
        riskLevel: number;
      };
    }> => {
      // 1. Agent performance: average performance_score (0-100)
      const perfResult = await db
        .select({
          avg: sql<number>`coalesce(avg(${agents.performanceScore}), 0)::int`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
          ),
        );
      const agentPerformance = Math.min(100, Math.max(0, Number(perfResult[0]?.avg ?? 0)));

      // 2. Goal completion: % of goals that are active/completed vs total
      const goalCounts = await db
        .select({
          total: sql<number>`count(*)::int`,
          onTrack: sql<number>`count(*) filter (where ${goals.status} in ('active', 'completed'))::int`,
        })
        .from(goals)
        .where(eq(goals.companyId, companyId));
      const totalGoals = Number(goalCounts[0]?.total ?? 0);
      const onTrackGoals = Number(goalCounts[0]?.onTrack ?? 0);
      const goalCompletion = totalGoals > 0
        ? Math.round((onTrackGoals / totalGoals) * 100)
        : 100; // No goals = full score (not penalized)

      // 3. Budget health: under budget = 100, over budget scales down
      const [companyRow] = await db
        .select({
          budgetMonthlyCents: companies.budgetMonthlyCents,
          spentMonthlyCents: companies.spentMonthlyCents,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      let budgetHealth = 100;
      if (companyRow && companyRow.budgetMonthlyCents > 0) {
        const ratio = companyRow.spentMonthlyCents / companyRow.budgetMonthlyCents;
        if (ratio <= 1) {
          budgetHealth = 100;
        } else {
          // Scale down: at 150% of budget = 50, at 200% = 0
          budgetHealth = Math.max(0, Math.round(100 - (ratio - 1) * 100));
        }
      }

      // 4. SLA compliance (reuse existing method)
      const slaResult = await db
        .select({
          id: issues.id,
          priority: issues.priority,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            isNotNull(issues.completedAt),
          ),
        );

      let slaTotal = 0;
      let slaWithin = 0;
      for (const issue of slaResult) {
        if (!issue.completedAt) continue;
        const priority = issue.priority as IssuePriority;
        const target = SLA_TARGETS[priority as keyof typeof SLA_TARGETS];
        if (target == null) continue;
        const resolutionMinutes =
          (new Date(issue.completedAt).getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60);
        slaTotal += 1;
        if (resolutionMinutes <= target) slaWithin += 1;
      }
      const slaCompliance = slaTotal > 0 ? Math.round((slaWithin / slaTotal) * 100) : 100;

      // 5. Risk level: inverse of open risk count
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [critHighCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.priority, ["critical", "high"]),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
          ),
        );

      const [staleCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo"]),
            lt(issues.createdAt, sevenDaysAgo),
          ),
        );

      const [lowPerfCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            isNotNull(agents.performanceScore),
            lt(agents.performanceScore, 40),
          ),
        );

      const totalRisks =
        Number(critHighCount?.count ?? 0) +
        Math.ceil(Number(staleCount?.count ?? 0) / 2) + // Stale items count less
        Number(lowPerfCount?.count ?? 0) * 2; // Low perf agents count double

      // Map risk count to a 0-100 score: 0 risks = 100, 10+ risks = 0
      const riskLevel = Math.max(0, Math.min(100, 100 - totalRisks * 10));

      // Composite score: weighted average
      const weights = {
        agentPerformance: 0.25,
        goalCompletion: 0.20,
        budgetHealth: 0.20,
        slaCompliance: 0.20,
        riskLevel: 0.15,
      };

      const score = Math.round(
        agentPerformance * weights.agentPerformance +
        goalCompletion * weights.goalCompletion +
        budgetHealth * weights.budgetHealth +
        slaCompliance * weights.slaCompliance +
        riskLevel * weights.riskLevel,
      );

      return {
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
          agentPerformance,
          goalCompletion,
          budgetHealth,
          slaCompliance,
          riskLevel,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Budget Forecast
// ---------------------------------------------------------------------------

export interface BudgetForecastResult {
  currentMonthSpend: number;
  projectedMonthEnd: number;
  monthlyBudget: number | null;
  daysUntilBudgetExhausted: number | null;
  trend: "under" | "on_track" | "over";
  recommendation: string;
}

/**
 * Project current-month spend to end of month and assess budget health.
 * Uses daily average from spend so far this month to project month-end total.
 */
export async function budgetForecast(
  db: Db,
  companyId: string,
): Promise<BudgetForecastResult> {
  const now = new Date();

  // Month boundaries (UTC)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24));
  const dayOfMonth = Math.max(
    1,
    Math.round((now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);

  // Current month spend so far
  const [mtdRow] = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, monthStart),
        lt(costEvents.occurredAt, now),
      ),
    );
  const currentMonthSpend = Number(mtdRow?.total ?? 0);

  // Daily average this month
  const dailyAvg = dayOfMonth > 0 ? currentMonthSpend / dayOfMonth : 0;

  // Projected month-end total
  const projectedMonthEnd = Math.round(currentMonthSpend + dailyAvg * daysRemaining);

  // Monthly budget from company settings
  const [company] = await db
    .select({ budgetMonthlyCents: companies.budgetMonthlyCents })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const monthlyBudget: number | null =
    company?.budgetMonthlyCents && company.budgetMonthlyCents > 0
      ? company.budgetMonthlyCents
      : null;

  // Days until budget exhausted
  let daysUntilBudgetExhausted: number | null = null;
  if (monthlyBudget !== null && dailyAvg > 0) {
    const remaining = Math.max(0, monthlyBudget - currentMonthSpend);
    daysUntilBudgetExhausted = Math.round(remaining / dailyAvg);
  }

  // Trend classification
  let trend: "under" | "on_track" | "over";
  let recommendation: string;

  if (monthlyBudget === null) {
    // No budget set - classify by projection vs prior logic
    trend = "on_track";
    recommendation = `Projected month-end spend is $${(projectedMonthEnd / 100).toFixed(2)} at the current daily rate. Set a monthly budget to enable variance tracking.`;
  } else {
    const projectionRatio = projectedMonthEnd / monthlyBudget;
    if (projectionRatio < 0.9) {
      trend = "under";
      recommendation = `On track - projected to use ${Math.round(projectionRatio * 100)}% of budget. Remaining capacity may support additional agent workloads.`;
    } else if (projectionRatio <= 1.1) {
      trend = "on_track";
      recommendation = `Budget tracking well - projected to use ${Math.round(projectionRatio * 100)}% of the $${(monthlyBudget / 100).toFixed(2)} budget. Monitor daily spend rate.`;
    } else {
      trend = "over";
      const overageAmount = ((projectedMonthEnd - monthlyBudget) / 100).toFixed(2);
      recommendation = `Over budget - projected $${overageAmount} over the $${(monthlyBudget / 100).toFixed(2)} budget. Review high-spend agents and consider rate limiting or pausing non-critical work.`;
    }
  }

  return {
    currentMonthSpend,
    projectedMonthEnd,
    monthlyBudget,
    daysUntilBudgetExhausted,
    trend,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Model Health Check
// ---------------------------------------------------------------------------

const DEPRECATED_MODELS = ["claude-2", "claude-instant", "gpt-3.5-turbo", "gpt-4-0314"];

/**
 * Check each agent's configured model against known deprecated models.
 * Returns all agents using deprecated models with an upgrade recommendation.
 */
export async function modelHealthCheck(
  db: Db,
  companyId: string,
): Promise<Array<{
  agentId: string;
  agentName: string;
  model: string;
  isDeprecated: boolean;
  recommendation: string | null;
}>> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  return rows.map((row) => {
    const config = (typeof row.adapterConfig === "object" && row.adapterConfig !== null
      ? row.adapterConfig
      : {}) as Record<string, unknown>;
    const model = typeof config.model === "string" ? config.model : "";
    const isDeprecated = model.length > 0 && DEPRECATED_MODELS.some((d) => model.startsWith(d));
    let recommendation: string | null = null;
    if (isDeprecated) {
      if (model.startsWith("claude-2") || model.startsWith("claude-instant")) {
        recommendation = "Upgrade to claude-sonnet-4-20250514 or later";
      } else if (model.startsWith("gpt-3.5-turbo")) {
        recommendation = "Upgrade to gpt-4o-mini for better price-performance";
      } else if (model.startsWith("gpt-4-0314")) {
        recommendation = "Upgrade to gpt-4o";
      } else {
        recommendation = "Upgrade to a current model";
      }
    }
    return {
      agentId: row.id,
      agentName: row.name,
      model: model || "(not set)",
      isDeprecated,
      recommendation,
    };
  });
}

// ---------------------------------------------------------------------------
// Standalone exports
// ---------------------------------------------------------------------------

export interface DepartmentSpendingRow {
  department: string;
  agentCount: number;
  totalSpend: number;
  avgPerAgent: number;
}

/**
 * Per-department spending summary: joins cost_events through agents.
 * Agents with no department are grouped under "unassigned".
 */
export async function departmentSpendingSummary(
  db: Db,
  companyId: string,
): Promise<DepartmentSpendingRow[]> {
  const rows = await db
    .select({
      department: sql<string>`coalesce(${agents.department}, 'unassigned')`,
      agentCount: sql<number>`count(distinct ${agents.id})::int`,
      totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(agents)
    .leftJoin(costEvents, eq(costEvents.agentId, agents.id))
    .where(eq(agents.companyId, companyId))
    .groupBy(sql`coalesce(${agents.department}, 'unassigned')`);

  return rows.map((r) => {
    const count = Number(r.agentCount);
    const total = Number(r.totalCents);
    return {
      department: r.department,
      agentCount: count,
      totalSpend: total,
      avgPerAgent: count > 0 ? Math.round(total / count) : 0,
    };
  });
}
