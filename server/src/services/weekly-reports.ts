import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues, costEvents, agentMemoryEntries, companies } from "@ironworksai/db";
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
