import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues, costEvents, agentMemoryEntries, companies, goals, goalKeyResults, approvals } from "@ironworksai/db";
import { computePerformanceScore } from "./performance-score.js";
import { createAgentDocument } from "./agent-workspace.js";
import { logger } from "../middleware/logger.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD in Central Time. */
function formatDateCT(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/** Format cents as a dollar string. */
function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Build a slug-safe date string. */
function slugDate(date: Date): string {
  return formatDateCT(date).replace(/-/g, "");
}

// ── Agent Weekly Report ────────────────────────────────────────────────────

/**
 * Generate a weekly report for a single agent covering the past 7 days.
 * Saves the report as a document in the agent's workspace and returns the markdown.
 */
export async function generateAgentWeeklyReport(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = formatDateCT(sevenDaysAgo);
  const periodEnd = formatDateCT(now);

  // Fetch agent info
  const [agent] = await db
    .select({
      name: agents.name,
      role: agents.role,
      department: agents.department,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) {
    logger.warn({ agentId }, "agent not found for weekly report");
    return "";
  }

  // 1. Issues completed in the last 7 days
  const completedIssues = await db
    .select({ id: issues.id, title: issues.title })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    );

  // 2. Issues created/assigned to this agent in the last 7 days
  const assignedIssues = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        gte(issues.createdAt, sevenDaysAgo),
      ),
    );
  const assignedCount = Number(assignedIssues[0]?.count ?? 0);

  // 3. Issues cancelled or blocked
  const blockedCancelled = await db
    .select({
      blocked: sql<number>`count(*) filter (where ${issues.status} = 'blocked')::int`,
      cancelled: sql<number>`count(*) filter (where ${issues.status} = 'cancelled')::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
      ),
    );
  const blockedCount = Number(blockedCancelled[0]?.blocked ?? 0);
  const cancelledCount = Number(blockedCancelled[0]?.cancelled ?? 0);

  // 4. Total cost from cost_events in the last 7 days
  const costResult = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        eq(costEvents.agentId, agentId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    );
  const totalCostCents = Number(costResult[0]?.total ?? 0);

  // 5. Performance score
  const score = await computePerformanceScore(db, agentId, companyId);

  // 6. Memory entries created in the last 7 days
  const memoryResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.companyId, companyId),
        eq(agentMemoryEntries.agentId, agentId),
        gte(agentMemoryEntries.createdAt, sevenDaysAgo),
      ),
    );
  const memoryCount = Number(memoryResult[0]?.count ?? 0);

  // Build markdown
  const completedList =
    completedIssues.length > 0
      ? completedIssues.map((i) => `  - ${i.title}`).join("\n")
      : "  - None";

  const markdown = [
    `# Weekly Report: ${agent.name}`,
    `**Period:** ${periodStart} to ${periodEnd}`,
    `**Department:** ${agent.department ?? "Unassigned"}`,
    "",
    "## Accomplishments",
    `- Completed ${completedIssues.length} issues:`,
    completedList,
    `- Created ${memoryCount} memory entries`,
    `- Received ${assignedCount} new issue assignments`,
    "",
    "## Metrics",
    `- Performance Score: ${score}/100`,
    `- Total Cost: $${centsToDollars(totalCostCents)}`,
    `- Issues Completed: ${completedIssues.length}`,
    `- Issues Blocked: ${blockedCount}`,
    `- Issues Cancelled: ${cancelledCount}`,
    "",
    "## Status",
    agent.status,
  ].join("\n");

  // Save to agent workspace
  const slug = `weekly-report-${slugDate(sevenDaysAgo)}-${slugDate(now)}`;
  await createAgentDocument(db, {
    agentId,
    companyId,
    title: `Weekly Report: ${periodStart} to ${periodEnd}`,
    content: markdown,
    documentType: "weekly-report",
    slug,
    department: agent.department ?? undefined,
    visibility: "private",
    autoGenerated: true,
    createdByUserId: "system",
  });

  logger.info(
    { agentId, companyId, periodStart, periodEnd },
    "generated agent weekly report",
  );

  return markdown;
}

// ── Company Weekly Report ──────────────────────────────────────────────────

/**
 * Generate a company-wide weekly report aggregating all agent data.
 * Saves to the CEO agent's workspace.
 */
export async function generateCompanyWeeklyReport(
  db: Db,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = formatDateCT(sevenDaysAgo);
  const periodEnd = formatDateCT(now);

  // Fetch all non-terminated agents
  const companyAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      department: agents.department,
      employmentType: agents.employmentType,
      performanceScore: agents.performanceScore,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  // Count FTE vs contractors
  const fteCount = companyAgents.filter((a) => a.employmentType === "full_time").length;
  const contractorCount = companyAgents.filter((a) => a.employmentType !== "full_time").length;

  // Total issues completed company-wide in the period
  const totalCompletedResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    );
  const totalCompleted = Number(totalCompletedResult[0]?.count ?? 0);

  // Total cost company-wide
  const totalCostResult = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    );
  const totalCostCents = Number(totalCostResult[0]?.total ?? 0);

  // Average performance score
  const scores = companyAgents
    .map((a) => a.performanceScore)
    .filter((s): s is number => s != null);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
    : 0;

  // Department breakdown: per-department agent count, issues done, cost
  const deptMap = new Map<string, { agents: number; issuesDone: number; costCents: number }>();
  for (const a of companyAgents) {
    const dept = a.department ?? "Unassigned";
    if (!deptMap.has(dept)) {
      deptMap.set(dept, { agents: 0, issuesDone: 0, costCents: 0 });
    }
    deptMap.get(dept)!.agents++;
  }

  // Issues done per department
  const deptIssues = await db
    .select({
      department: agents.department,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    )
    .groupBy(agents.department);

  for (const row of deptIssues) {
    const dept = row.department ?? "Unassigned";
    if (deptMap.has(dept)) {
      deptMap.get(dept)!.issuesDone = Number(row.count);
    }
  }

  // Cost per department
  const deptCosts = await db
    .select({
      department: agents.department,
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .innerJoin(agents, eq(costEvents.agentId, agents.id))
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    )
    .groupBy(agents.department);

  for (const row of deptCosts) {
    const dept = row.department ?? "Unassigned";
    if (deptMap.has(dept)) {
      deptMap.get(dept)!.costCents = Number(row.total);
    }
  }

  // Top performers (sorted by performance score descending)
  const topPerformers = [...companyAgents]
    .filter((a) => a.performanceScore != null)
    .sort((a, b) => (b.performanceScore ?? 0) - (a.performanceScore ?? 0))
    .slice(0, 5);

  // Per-agent issues completed for top performers
  const topPerformerIssues = new Map<string, number>();
  if (topPerformers.length > 0) {
    const topIds = topPerformers.map((a) => a.id);
    const perAgentIssues = await db
      .select({
        agentId: issues.assigneeAgentId,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          gte(issues.completedAt, sevenDaysAgo),
        ),
      )
      .groupBy(issues.assigneeAgentId);

    for (const row of perAgentIssues) {
      if (row.agentId && topIds.includes(row.agentId)) {
        topPerformerIssues.set(row.agentId, Number(row.count));
      }
    }
  }

  // Concerns: low performers and zero-completion agents
  const lowPerformers = companyAgents.filter(
    (a) => a.performanceScore != null && a.performanceScore < 50,
  );

  // Agents with 0 completed issues this week
  const allAgentCompletions = await db
    .select({
      agentId: issues.assigneeAgentId,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    )
    .groupBy(issues.assigneeAgentId);

  const completionMap = new Map<string, number>();
  for (const row of allAgentCompletions) {
    if (row.agentId) completionMap.set(row.agentId, Number(row.count));
  }
  const zeroCompletionAgents = companyAgents.filter(
    (a) => !completionMap.has(a.id),
  );

  // Build department table
  const deptRows: string[] = [];
  for (const [dept, data] of deptMap.entries()) {
    deptRows.push(
      `| ${dept} | ${data.agents} | ${data.issuesDone} | $${centsToDollars(data.costCents)} |`,
    );
  }

  // Build top performers list
  const topList = topPerformers.map((a, i) => {
    const issueCount = topPerformerIssues.get(a.id) ?? 0;
    return `${i + 1}. ${a.name} - ${a.performanceScore}/100, ${issueCount} issues`;
  });

  // Build concerns list
  const concerns: string[] = [];
  if (lowPerformers.length > 0) {
    concerns.push(
      `- Low performance (score < 50): ${lowPerformers.map((a) => `${a.name} (${a.performanceScore})`).join(", ")}`,
    );
  }
  if (zeroCompletionAgents.length > 0) {
    concerns.push(
      `- Zero completed issues this week: ${zeroCompletionAgents.map((a) => a.name).join(", ")}`,
    );
  }
  if (concerns.length === 0) {
    concerns.push("- No concerns this period");
  }

  const markdown = [
    "# Company Weekly Report",
    `**Period:** ${periodStart} to ${periodEnd}`,
    `**Generated:** ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    "",
    "## Summary",
    `- Total Agents: ${fteCount} FTE, ${contractorCount} Contractors`,
    `- Issues Completed: ${totalCompleted}`,
    `- Total Cost: $${centsToDollars(totalCostCents)}`,
    `- Average Performance: ${avgScore}/100`,
    "",
    "## Department Breakdown",
    "| Department | Agents | Issues Done | Cost |",
    "|---|---|---|---|",
    ...deptRows,
    "",
    "## Top Performers",
    ...(topList.length > 0 ? topList : ["No performance data available"]),
    "",
    "## Concerns",
    ...concerns,
  ].join("\n");

  // Save to CEO agent's workspace
  const [ceoAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.role}) like '%ceo%'`,
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (ceoAgent) {
    const slug = `company-weekly-report-${slugDate(sevenDaysAgo)}-${slugDate(now)}`;
    await createAgentDocument(db, {
      agentId: ceoAgent.id,
      companyId,
      title: `Company Weekly Report: ${periodStart} to ${periodEnd}`,
      content: markdown,
      documentType: "weekly-report",
      slug,
      visibility: "private",
      autoGenerated: true,
      createdByUserId: "system",
    });
  }

  logger.info(
    { companyId, periodStart, periodEnd, agentCount: companyAgents.length },
    "generated company weekly report",
  );

  return markdown;
}

// ── Sprint Retrospective ──────────────────────────────────────────────────

/**
 * Generate a retrospective analysis for the given period (default 14 days).
 * Saves the document to the CEO agent's workspace and returns the markdown.
 */
export async function generateRetrospective(
  db: Db,
  companyId: string,
  periodDays: number = 14,
): Promise<string> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const startStr = formatDateCT(periodStart);
  const endStr = formatDateCT(now);

  // 1. Completed vs cancelled issues
  const statusCounts = await db
    .select({
      done: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
      cancelled: sql<number>`count(*) filter (where ${issues.status} = 'cancelled')::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        gte(issues.createdAt, periodStart),
      ),
    );
  const doneCount = Number(statusCounts[0]?.done ?? 0);
  const cancelledCount = Number(statusCounts[0]?.cancelled ?? 0);
  const totalResolved = doneCount + cancelledCount;
  const completionRatio = totalResolved > 0
    ? `${Math.round((doneCount / totalResolved) * 100)}%`
    : "N/A";

  // 2. Average completion time (hours between createdAt and completedAt)
  const avgCompletionResult = await db
    .select({
      avgHours: sql<number>`coalesce(avg(extract(epoch from (${issues.completedAt} - ${issues.createdAt})) / 3600), 0)::float`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, periodStart),
      ),
    );
  const avgCompletionHours = Number(avgCompletionResult[0]?.avgHours ?? 0);

  // 3. Agents with most cancellations
  const cancellationsByAgent = await db
    .select({
      agentId: issues.assigneeAgentId,
      agentName: agents.name,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "cancelled"),
        gte(issues.cancelledAt, periodStart),
      ),
    )
    .groupBy(issues.assigneeAgentId, agents.name)
    .orderBy(sql`count(*) desc`)
    .limit(5);

  // 4. Recurring failure patterns (same agent, similar title keywords in cancelled issues)
  const cancelledIssueDetails = await db
    .select({
      agentName: agents.name,
      title: issues.title,
    })
    .from(issues)
    .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "cancelled"),
        gte(issues.cancelledAt, periodStart),
      ),
    )
    .limit(50);

  // Group by agent to detect repeated topics
  const patternMap = new Map<string, string[]>();
  for (const row of cancelledIssueDetails) {
    const key = row.agentName;
    if (!patternMap.has(key)) patternMap.set(key, []);
    patternMap.get(key)!.push(row.title);
  }
  const recurringPatterns: string[] = [];
  for (const [agentName, titles] of patternMap.entries()) {
    if (titles.length >= 2) {
      recurringPatterns.push(
        `- ${agentName}: ${titles.length} cancelled issues (${titles.slice(0, 3).join(", ")})`,
      );
    }
  }

  // 5. Budget overruns
  const overrunAgents = await db
    .select({
      name: agents.name,
      budgetMonthlyCents: agents.budgetMonthlyCents,
      spentMonthlyCents: agents.spentMonthlyCents,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        sql`${agents.spentMonthlyCents} > ${agents.budgetMonthlyCents}`,
        sql`${agents.budgetMonthlyCents} > 0`,
      ),
    );

  // 6. Total cost for the period
  const periodCostResult = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, periodStart),
      ),
    );
  const periodCostCents = Number(periodCostResult[0]?.total ?? 0);

  // Build recommendations
  const recommendations: string[] = [];
  if (cancelledCount > doneCount * 0.3) {
    recommendations.push("- High cancellation rate detected. Review issue scoping and assignment criteria.");
  }
  if (avgCompletionHours > 48) {
    recommendations.push("- Average completion time exceeds 48 hours. Consider breaking down large issues.");
  }
  if (overrunAgents.length > 0) {
    recommendations.push(`- ${overrunAgents.length} agent(s) over budget. Review cost governance policies.`);
  }
  if (recurringPatterns.length > 0) {
    recommendations.push("- Recurring cancellation patterns detected. Investigate root causes for affected agents.");
  }
  if (recommendations.length === 0) {
    recommendations.push("- No critical concerns this period. Continue current operating cadence.");
  }

  const markdown = [
    `# Sprint Retrospective`,
    `**Period:** ${startStr} to ${endStr} (${periodDays} days)`,
    `**Generated:** ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    "",
    "## Completion Metrics",
    `- Issues Completed: ${doneCount}`,
    `- Issues Cancelled: ${cancelledCount}`,
    `- Completion Ratio: ${completionRatio}`,
    `- Average Completion Time: ${avgCompletionHours.toFixed(1)} hours`,
    `- Total Cost: $${centsToDollars(periodCostCents)}`,
    "",
    "## Cancellation Leaderboard",
    ...(cancellationsByAgent.length > 0
      ? cancellationsByAgent.map(
          (r, i) => `${i + 1}. ${r.agentName} - ${r.count} cancelled`,
        )
      : ["No cancellations this period."]),
    "",
    "## Recurring Failure Patterns",
    ...(recurringPatterns.length > 0
      ? recurringPatterns
      : ["No recurring patterns detected."]),
    "",
    "## Budget Overruns",
    ...(overrunAgents.length > 0
      ? overrunAgents.map(
          (a) =>
            `- ${a.name}: spent $${centsToDollars(a.spentMonthlyCents)} of $${centsToDollars(a.budgetMonthlyCents)} budget`,
        )
      : ["All agents within budget."]),
    "",
    "## Recommendations",
    ...recommendations,
  ].join("\n");

  // Save to CEO workspace
  const [ceoAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.role}) like '%ceo%'`,
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (ceoAgent) {
    const slug = `retrospective-${slugDate(periodStart)}-${slugDate(now)}`;
    await createAgentDocument(db, {
      agentId: ceoAgent.id,
      companyId,
      title: `Sprint Retrospective: ${startStr} to ${endStr}`,
      content: markdown,
      documentType: "retrospective",
      slug,
      visibility: "private",
      autoGenerated: true,
      createdByUserId: "system",
    });
  }

  logger.info(
    { companyId, periodDays, startStr, endStr },
    "generated sprint retrospective",
  );

  return markdown;
}

// ── HR Weekly Report ──────────────────────────────────────────────────────

/**
 * Generate a weekly HR report covering personnel changes.
 * Saves to VP HR agent's workspace and returns the markdown.
 */
export async function generateHRWeeklyReport(
  db: Db,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = formatDateCT(sevenDaysAgo);
  const periodEnd = formatDateCT(now);

  // New hires in the period
  const newHires = await db
    .select({
      name: agents.name,
      role: agents.role,
      department: agents.department,
      employmentType: agents.employmentType,
      hiredAt: agents.hiredAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        gte(agents.hiredAt, sevenDaysAgo),
      ),
    );

  // Terminations in the period
  const terminations = await db
    .select({
      name: agents.name,
      role: agents.role,
      terminationReason: agents.terminationReason,
      terminatedAt: agents.terminatedAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.status, "terminated"),
        gte(agents.terminatedAt, sevenDaysAgo),
      ),
    );

  // All active agents with performance scores
  const activeAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      department: agents.department,
      status: agents.status,
      performanceScore: agents.performanceScore,
      employmentType: agents.employmentType,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  const totalHeadcount = activeAgents.length;
  const fteCount = activeAgents.filter((a) => a.employmentType === "full_time").length;
  const contractorCount = activeAgents.filter((a) => a.employmentType !== "full_time").length;

  // Performance distribution
  const withScores = activeAgents.filter((a) => a.performanceScore != null);
  const highPerformers = withScores.filter((a) => a.performanceScore! >= 80).length;
  const midPerformers = withScores.filter((a) => a.performanceScore! >= 50 && a.performanceScore! < 80).length;
  const lowPerformers = withScores.filter((a) => a.performanceScore! < 50);

  // Onboarding status: agents hired in last 30 days still active
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentHires = activeAgents.filter(
    (a) => a.status !== "terminated" && a.employmentType === "full_time",
  );
  const onboardingAgents = await db
    .select({
      name: agents.name,
      role: agents.role,
      hiredAt: agents.hiredAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        gte(agents.hiredAt, thirtyDaysAgo),
      ),
    );

  // Department headcount
  const deptCounts = new Map<string, number>();
  for (const a of activeAgents) {
    const dept = a.department ?? "Unassigned";
    deptCounts.set(dept, (deptCounts.get(dept) ?? 0) + 1);
  }

  const markdown = [
    "# HR Weekly Report",
    `**Period:** ${periodStart} to ${periodEnd}`,
    `**Generated:** ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    "",
    "## Headcount Summary",
    `- Total Active: ${totalHeadcount}`,
    `- Full-Time: ${fteCount}`,
    `- Contractors: ${contractorCount}`,
    "",
    "## Department Breakdown",
    "| Department | Headcount |",
    "|---|---|",
    ...[...deptCounts.entries()].map(([dept, count]) => `| ${dept} | ${count} |`),
    "",
    "## New Hires",
    ...(newHires.length > 0
      ? newHires.map(
          (h) => `- ${h.name} (${h.role}, ${h.department ?? "Unassigned"}) - ${h.employmentType === "full_time" ? "FTE" : "Contractor"}`,
        )
      : ["No new hires this period."]),
    "",
    "## Terminations",
    ...(terminations.length > 0
      ? terminations.map(
          (t) => `- ${t.name} (${t.role}) - Reason: ${t.terminationReason ?? "Not specified"}`,
        )
      : ["No terminations this period."]),
    "",
    "## Performance Distribution",
    `- High performers (80+): ${highPerformers}`,
    `- Mid performers (50-79): ${midPerformers}`,
    `- Low performers (<50): ${lowPerformers.length}`,
    ...(lowPerformers.length > 0
      ? lowPerformers.map((a) => `  - ${a.name}: ${a.performanceScore}/100`)
      : []),
    "",
    "## Onboarding (Last 30 Days)",
    ...(onboardingAgents.length > 0
      ? onboardingAgents.map((a) => `- ${a.name} (${a.role}) - hired ${formatDateCT(a.hiredAt!)}`)
      : ["No agents onboarded in the last 30 days."]),
  ].join("\n");

  // Save to VP HR workspace
  const [hrAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`(lower(${agents.role}) like '%vp%hr%' or lower(${agents.role}) like '%hr%' or lower(${agents.role}) like '%people%')`,
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (hrAgent) {
    const slug = `hr-weekly-report-${slugDate(sevenDaysAgo)}-${slugDate(now)}`;
    await createAgentDocument(db, {
      agentId: hrAgent.id,
      companyId,
      title: `HR Weekly Report: ${periodStart} to ${periodEnd}`,
      content: markdown,
      documentType: "weekly-report",
      slug,
      visibility: "private",
      autoGenerated: true,
      createdByUserId: "system",
    });
  }

  logger.info(
    { companyId, periodStart, periodEnd },
    "generated HR weekly report",
  );

  return markdown;
}

// ── CFO Weekly Report ─────────────────────────────────────────────────────

/**
 * Generate a weekly CFO financial report.
 * Saves to CFO agent's workspace and returns the markdown.
 */
export async function generateCFOWeeklyReport(
  db: Db,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const periodStart = formatDateCT(sevenDaysAgo);
  const periodEnd = formatDateCT(now);

  // Total spend this week
  const currentWeekCost = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    );
  const currentWeekCents = Number(currentWeekCost[0]?.total ?? 0);

  // Total spend last week (for trend comparison)
  const lastWeekCost = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, fourteenDaysAgo),
        sql`${costEvents.occurredAt} < ${sevenDaysAgo}`,
      ),
    );
  const lastWeekCents = Number(lastWeekCost[0]?.total ?? 0);

  const weekOverWeekChange = lastWeekCents > 0
    ? Math.round(((currentWeekCents - lastWeekCents) / lastWeekCents) * 100)
    : 0;

  // Spend by department
  const deptSpend = await db
    .select({
      department: agents.department,
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .innerJoin(agents, eq(costEvents.agentId, agents.id))
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    )
    .groupBy(agents.department)
    .orderBy(sql`sum(${costEvents.costCents}) desc`);

  // Spend by agent (top 10)
  const agentSpend = await db
    .select({
      agentName: agents.name,
      agentRole: agents.role,
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .innerJoin(agents, eq(costEvents.agentId, agents.id))
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    )
    .groupBy(agents.name, agents.role)
    .orderBy(sql`sum(${costEvents.costCents}) desc`)
    .limit(10);

  // Budget vs actual (company level)
  const [company] = await db
    .select({ budgetMonthlyCents: companies.budgetMonthlyCents })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const monthlyBudgetCents = company?.budgetMonthlyCents ?? 0;

  // Month-to-date spend
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mtdCost = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, monthStart),
      ),
    );
  const mtdCents = Number(mtdCost[0]?.total ?? 0);
  const budgetUtilization = monthlyBudgetCents > 0
    ? `${Math.round((mtdCents / monthlyBudgetCents) * 100)}%`
    : "No budget set";

  // Cost per issue this week
  const issuesDoneThisWeek = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    );
  const doneThisWeek = Number(issuesDoneThisWeek[0]?.count ?? 0);
  const costPerIssue = doneThisWeek > 0 ? currentWeekCents / doneThisWeek : 0;

  const markdown = [
    "# CFO Weekly Financial Report",
    `**Period:** ${periodStart} to ${periodEnd}`,
    `**Generated:** ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    "",
    "## Summary",
    `- Total Spend This Week: $${centsToDollars(currentWeekCents)}`,
    `- Total Spend Last Week: $${centsToDollars(lastWeekCents)}`,
    `- Week-over-Week Change: ${weekOverWeekChange > 0 ? "+" : ""}${weekOverWeekChange}%`,
    `- Month-to-Date Spend: $${centsToDollars(mtdCents)}`,
    `- Monthly Budget: ${monthlyBudgetCents > 0 ? `$${centsToDollars(monthlyBudgetCents)}` : "Unlimited"}`,
    `- Budget Utilization: ${budgetUtilization}`,
    `- Cost per Issue: ${doneThisWeek > 0 ? `$${centsToDollars(Math.round(costPerIssue))}` : "N/A (0 issues completed)"}`,
    "",
    "## Spend by Department",
    "| Department | Spend |",
    "|---|---|",
    ...(deptSpend.length > 0
      ? deptSpend.map((r) => `| ${r.department ?? "Unassigned"} | $${centsToDollars(Number(r.total))} |`)
      : ["| No spend data | - |"]),
    "",
    "## Top Spenders by Agent",
    "| Agent | Role | Spend |",
    "|---|---|---|",
    ...(agentSpend.length > 0
      ? agentSpend.map((r) => `| ${r.agentName} | ${r.agentRole} | $${centsToDollars(Number(r.total))} |`)
      : ["| No spend data | - | - |"]),
    "",
    "## Budget Health",
    `- Issues Completed This Week: ${doneThisWeek}`,
    `- Cost per Completed Issue: ${doneThisWeek > 0 ? `$${centsToDollars(Math.round(costPerIssue))}` : "N/A"}`,
    ...(weekOverWeekChange > 25
      ? ["- WARNING: Spend increased more than 25% week-over-week. Review agent cost controls."]
      : []),
    ...(monthlyBudgetCents > 0 && mtdCents > monthlyBudgetCents * 0.8
      ? ["- WARNING: Month-to-date spend exceeds 80% of monthly budget."]
      : []),
  ].join("\n");

  // Save to CFO workspace
  const [cfoAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.role}) like '%cfo%'`,
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (cfoAgent) {
    const slug = `cfo-weekly-report-${slugDate(sevenDaysAgo)}-${slugDate(now)}`;
    await createAgentDocument(db, {
      agentId: cfoAgent.id,
      companyId,
      title: `CFO Weekly Report: ${periodStart} to ${periodEnd}`,
      content: markdown,
      documentType: "weekly-report",
      slug,
      visibility: "private",
      autoGenerated: true,
      createdByUserId: "system",
    });
  }

  logger.info(
    { companyId, periodStart, periodEnd },
    "generated CFO weekly report",
  );

  return markdown;
}

// ── Board Meeting Packet ─────────────────────────────────────────────────

/**
 * Generate a comprehensive board meeting packet compiling company-wide data.
 * Saves to CEO workspace with document_type "board-packet" and returns the markdown.
 */
export async function generateBoardMeetingPacket(
  db: Db,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodEnd = formatDateCT(now);

  // ---- 1. Executive Summary ----

  // All non-terminated agents
  const companyAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      department: agents.department,
      performanceScore: agents.performanceScore,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  const scores = companyAgents
    .map((a) => a.performanceScore)
    .filter((s): s is number => s != null);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
    : 0;

  // Active projects
  const activeProjects = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.status} not in ('done', 'cancelled')`,
      ),
    );
  const openIssueCount = Number(activeProjects[0]?.count ?? 0);

  // ---- 2. Goal Status ----

  const allGoals = await db
    .select({
      id: goals.id,
      title: goals.title,
      status: goals.status,
      level: goals.level,
      targetDate: goals.targetDate,
    })
    .from(goals)
    .where(eq(goals.companyId, companyId));

  const goalSections: string[] = [];
  for (const goal of allGoals) {
    // Count issues per goal
    const goalIssueStats = await db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.goalId, goal.id),
        ),
      );
    const total = Number(goalIssueStats[0]?.total ?? 0);
    const done = Number(goalIssueStats[0]?.done ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Key results
    const krs = await db
      .select({
        description: goalKeyResults.description,
        currentValue: goalKeyResults.currentValue,
        targetValue: goalKeyResults.targetValue,
        unit: goalKeyResults.unit,
      })
      .from(goalKeyResults)
      .where(eq(goalKeyResults.goalId, goal.id));

    const krLines = krs.length > 0
      ? krs.map((kr) => `  - ${kr.description}: ${kr.currentValue}/${kr.targetValue} ${kr.unit}`).join("\n")
      : "  - No key results defined";

    const targetStr = goal.targetDate
      ? ` (target: ${formatDateCT(new Date(goal.targetDate))})`
      : "";

    goalSections.push(`- **${goal.title}** [${goal.status}]${targetStr} - ${pct}% complete (${done}/${total} issues)\n${krLines}`);
  }

  // ---- 3. Financial Summary ----

  const totalCostResult = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, sevenDaysAgo),
      ),
    );
  const weekCostCents = Number(totalCostResult[0]?.total ?? 0);

  const [company] = await db
    .select({
      budgetMonthlyCents: companies.budgetMonthlyCents,
      spentMonthlyCents: companies.spentMonthlyCents,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const budgetCents = company?.budgetMonthlyCents ?? 0;
  const spentCents = company?.spentMonthlyCents ?? 0;

  // Issues done this week for unit economics
  const weekDoneResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, sevenDaysAgo),
      ),
    );
  const weekDone = Number(weekDoneResult[0]?.count ?? 0);
  const costPerIssue = weekDone > 0 ? Math.round(weekCostCents / weekDone) : 0;

  // ---- 4. Agent Performance Rankings ----

  const ranked = [...companyAgents]
    .filter((a) => a.performanceScore != null)
    .sort((a, b) => (b.performanceScore ?? 0) - (a.performanceScore ?? 0));

  const topAgents = ranked.slice(0, 5);
  const bottomAgents = ranked.length > 5
    ? ranked.slice(-3)
    : [];

  // ---- 5. Key Decisions Made (approvals resolved in last 7 days) ----

  const recentApprovals = await db
    .select({
      type: approvals.type,
      status: approvals.status,
      decisionNote: approvals.decisionNote,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        gte(approvals.decidedAt, sevenDaysAgo),
        sql`${approvals.status} in ('approved', 'rejected')`,
      ),
    );

  const decisionLines = recentApprovals.length > 0
    ? recentApprovals.map(
        (a) => `- [${a.status?.toUpperCase()}] ${a.type}${a.decisionNote ? ` - ${a.decisionNote}` : ""}`,
      )
    : ["- No decisions recorded this week"];

  // ---- 6. Open Risks ----

  // Overdue issues (critical/high priority, open)
  const overdueIssues = await db
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
        sql`${issues.priority} in ('critical', 'high')`,
        sql`${issues.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    )
    .limit(10);

  // Stale items
  const staleItems = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.status} in ('backlog', 'todo')`,
        sql`${issues.createdAt} < ${sevenDaysAgo}`,
      ),
    );
  const staleCount = Number(staleItems[0]?.count ?? 0);

  // Low performers
  const lowPerfAgents = companyAgents.filter(
    (a) => a.performanceScore != null && a.performanceScore < 40,
  );

  const riskLines: string[] = [];
  for (const issue of overdueIssues) {
    riskLines.push(`- [${issue.priority?.toUpperCase()}] ${issue.title}`);
  }
  if (staleCount > 0) {
    riskLines.push(`- ${staleCount} stale issue(s) with no progress for 7+ days`);
  }
  for (const a of lowPerfAgents) {
    riskLines.push(`- Low performer: ${a.name} (score: ${a.performanceScore})`);
  }
  if (riskLines.length === 0) {
    riskLines.push("- No open risks identified");
  }

  // ---- 7. Recommended Actions ----

  const recommendations: string[] = [];
  if (lowPerfAgents.length > 0) {
    recommendations.push(`- Review ${lowPerfAgents.length} underperforming agent(s). Consider PIPs or role reassignment.`);
  }
  if (staleCount > 5) {
    recommendations.push("- Triage stale backlog. Reassign or close issues that have not moved in 7+ days.");
  }
  if (budgetCents > 0 && spentCents > budgetCents * 0.8) {
    recommendations.push("- Monthly spend is above 80% of budget. Review cost controls before month end.");
  }
  if (overdueIssues.length > 3) {
    recommendations.push("- Multiple critical/high priority issues open. Consider reallocating agents to clear the backlog.");
  }
  const goalsAtRisk = allGoals.filter((g) => g.status === "at_risk" || g.status === "blocked");
  if (goalsAtRisk.length > 0) {
    recommendations.push(`- ${goalsAtRisk.length} goal(s) at risk or blocked. Review blockers and reassign resources.`);
  }
  if (recommendations.length === 0) {
    recommendations.push("- Company health is good. Continue current operating cadence.");
  }

  // ---- Build Markdown ----

  const markdown = [
    "# Board Meeting Packet",
    `**Company:** ${company ? "Active" : "Unknown"}`,
    `**Date:** ${periodEnd}`,
    `**Generated:** ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    "",
    "## 1. Executive Summary",
    `- Average Agent Performance: ${avgScore}/100`,
    `- Total Active Agents: ${companyAgents.length}`,
    `- Open Issues: ${openIssueCount}`,
    `- Issues Completed This Week: ${weekDone}`,
    "",
    "## 2. Goal Status",
    ...(goalSections.length > 0 ? goalSections : ["- No goals defined"]),
    "",
    "## 3. Financial Summary",
    `- Weekly Spend: $${centsToDollars(weekCostCents)}`,
    `- Month-to-Date Spend: $${centsToDollars(spentCents)}`,
    `- Monthly Budget: ${budgetCents > 0 ? `$${centsToDollars(budgetCents)}` : "Unlimited"}`,
    `- Budget Utilization: ${budgetCents > 0 ? `${Math.round((spentCents / budgetCents) * 100)}%` : "N/A"}`,
    `- Cost per Issue: ${costPerIssue > 0 ? `$${centsToDollars(costPerIssue)}` : "N/A"}`,
    "",
    "## 4. Agent Performance Rankings",
    "### Top Performers",
    ...(topAgents.length > 0
      ? topAgents.map((a, i) => `${i + 1}. ${a.name} (${a.role}) - ${a.performanceScore}/100`)
      : ["No performance data available"]),
    ...(bottomAgents.length > 0
      ? [
          "",
          "### Needs Attention",
          ...bottomAgents.map((a) => `- ${a.name} (${a.role}) - ${a.performanceScore}/100`),
        ]
      : []),
    "",
    "## 5. Key Decisions Made (Last 7 Days)",
    ...decisionLines,
    "",
    "## 6. Open Risks",
    ...riskLines,
    "",
    "## 7. Recommended Actions",
    ...recommendations,
  ].join("\n");

  // Save to CEO workspace
  const [ceoAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.role}) like '%ceo%'`,
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (ceoAgent) {
    const slug = `board-packet-${slugDate(now)}`;
    await createAgentDocument(db, {
      agentId: ceoAgent.id,
      companyId,
      title: `Board Meeting Packet: ${periodEnd}`,
      content: markdown,
      documentType: "board-packet",
      slug,
      visibility: "private",
      autoGenerated: true,
      createdByUserId: "system",
    });
  }

  logger.info(
    { companyId, date: periodEnd },
    "generated board meeting packet",
  );

  return markdown;
}

// ── Run All Weekly Reports ─────────────────────────────────────────────────

/**
 * Generate weekly reports for all agents in a company, then the company rollup.
 */
export async function runWeeklyReports(
  db: Db,
  companyId: string,
): Promise<void> {
  const companyAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
      ),
    );

  for (const agent of companyAgents) {
    try {
      await generateAgentWeeklyReport(db, agent.id, companyId);
    } catch (err) {
      logger.error({ err, agentId: agent.id, companyId }, "failed to generate agent weekly report");
    }
  }

  try {
    await generateCompanyWeeklyReport(db, companyId);
  } catch (err) {
    logger.error({ err, companyId }, "failed to generate company weekly report");
  }

  try {
    await generateHRWeeklyReport(db, companyId);
  } catch (err) {
    logger.error({ err, companyId }, "failed to generate HR weekly report");
  }

  try {
    await generateCFOWeeklyReport(db, companyId);
  } catch (err) {
    logger.error({ err, companyId }, "failed to generate CFO weekly report");
  }

  try {
    await generateBoardMeetingPacket(db, companyId);
  } catch (err) {
    logger.error({ err, companyId }, "failed to generate board meeting packet");
  }
}

/**
 * Run weekly reports for ALL companies.
 */
export async function runAllWeeklyReports(db: Db): Promise<void> {
  const allCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(ne(companies.status, "pending_erasure"));

  for (const company of allCompanies) {
    try {
      await runWeeklyReports(db, company.id);
    } catch (err) {
      logger.error({ err, companyId: company.id }, "failed to run weekly reports for company");
    }
  }

  logger.info({ companiesProcessed: allCompanies.length }, "weekly reports run complete");
}
