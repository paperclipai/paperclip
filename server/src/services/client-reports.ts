import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { projects, issues, goals, knowledgePages } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

/** Format a Date as YYYY-MM-DD in Central Time. */
function formatDateCT(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export interface ClientReportMilestone {
  id: string;
  title: string;
  completedAt: string | null;
}

export interface ClientReportDeliverable {
  id: string;
  title: string;
  status: string;
  completedAt: string | null;
}

export interface ClientReportNextStep {
  id: string;
  title: string;
  priority: string;
  status: string;
}

export interface ClientReport {
  projectName: string;
  projectDescription: string | null;
  projectStatus: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  milestones: ClientReportMilestone[];
  deliverables: ClientReportDeliverable[];
  nextSteps: ClientReportNextStep[];
  totalCompleted: number;
  totalInProgress: number;
  totalPlanned: number;
  markdown: string;
}

/**
 * Generate a client-facing project progress report.
 * Omits internal details: no costs, no agent names, no org info.
 */
export async function generateProjectReport(
  db: Db,
  companyId: string,
  projectId: string,
  periodDays: number = 30,
): Promise<ClientReport | null> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const startStr = formatDateCT(periodStart);
  const endStr = formatDateCT(now);

  // Get project info
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);

  if (!project) {
    logger.warn({ projectId, companyId }, "project not found for client report");
    return null;
  }

  // Milestones: completed goals linked to this project (via issues)
  const milestoneRows = await db
    .selectDistinct({
      id: goals.id,
      title: goals.title,
      updatedAt: goals.updatedAt,
    })
    .from(goals)
    .innerJoin(issues, eq(issues.goalId, goals.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        eq(goals.status, "achieved"),
      ),
    )
    .orderBy(desc(goals.updatedAt))
    .limit(20);

  const milestones: ClientReportMilestone[] = milestoneRows.map((r) => ({
    id: r.id,
    title: r.title,
    completedAt: r.updatedAt?.toISOString() ?? null,
  }));

  // Deliverables: completed issues in the period
  const deliverableRows = await db
    .select({
      id: issues.id,
      title: issues.title,
      status: issues.status,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        eq(issues.status, "done"),
        gte(issues.completedAt, periodStart),
      ),
    )
    .orderBy(desc(issues.completedAt))
    .limit(50);

  const deliverables: ClientReportDeliverable[] = deliverableRows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    completedAt: r.completedAt?.toISOString() ?? null,
  }));

  // Next steps: open issues sorted by priority
  const priorityOrder = sql`case ${issues.priority}
    when 'critical' then 1
    when 'high' then 2
    when 'medium' then 3
    when 'low' then 4
    else 5 end`;

  const nextStepRows = await db
    .select({
      id: issues.id,
      title: issues.title,
      priority: issues.priority,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        sql`${issues.status} not in ('done', 'cancelled')`,
      ),
    )
    .orderBy(priorityOrder, desc(issues.createdAt))
    .limit(15);

  const nextSteps: ClientReportNextStep[] = nextStepRows.map((r) => ({
    id: r.id,
    title: r.title,
    priority: r.priority,
    status: r.status,
  }));

  // Counts
  const [counts] = await db
    .select({
      completed: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
      inProgress: sql<number>`count(*) filter (where ${issues.status} = 'in_progress')::int`,
      planned: sql<number>`count(*) filter (where ${issues.status} in ('todo', 'backlog'))::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
      ),
    );

  const totalCompleted = Number(counts?.completed ?? 0);
  const totalInProgress = Number(counts?.inProgress ?? 0);
  const totalPlanned = Number(counts?.planned ?? 0);

  // Build markdown
  const milestonesSection = milestones.length > 0
    ? milestones.map((m) => `- ${m.title}`).join("\n")
    : "- No milestones achieved yet";

  const deliverablesSection = deliverables.length > 0
    ? deliverables.map((d) => `- ${d.title}`).join("\n")
    : "- No deliverables completed this period";

  const nextStepsSection = nextSteps.length > 0
    ? nextSteps.map((s) => `- [${s.priority.toUpperCase()}] ${s.title}`).join("\n")
    : "- No upcoming items planned";

  const markdown = [
    `# Project Progress Report: ${project.name}`,
    "",
    `**Period:** ${startStr} to ${endStr}`,
    `**Project Status:** ${project.status ?? "Active"}`,
    "",
    project.description ? `${project.description}\n` : "",
    "## Summary",
    `- **${totalCompleted}** items completed`,
    `- **${totalInProgress}** items in progress`,
    `- **${totalPlanned}** items planned`,
    "",
    "## Milestones Achieved",
    milestonesSection,
    "",
    `## Deliverables (Last ${periodDays} Days)`,
    deliverablesSection,
    "",
    "## Next Steps",
    nextStepsSection,
    "",
    "---",
    `*Report generated ${endStr}*`,
  ].join("\n");

  logger.info({ companyId, projectId, periodStart: startStr, periodEnd: endStr }, "generated client project report");

  return {
    projectName: project.name,
    projectDescription: project.description,
    projectStatus: project.status ?? "active",
    periodStart: startStr,
    periodEnd: endStr,
    generatedAt: now.toISOString(),
    milestones,
    deliverables,
    nextSteps,
    totalCompleted,
    totalInProgress,
    totalPlanned,
    markdown,
  };
}
