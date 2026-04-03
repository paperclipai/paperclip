import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues, companies } from "@ironworksai/db";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD in Central Time. */
function formatDateCT(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// ── Daily Standup ──────────────────────────────────────────────────────────

/**
 * Generate a daily standup update for a single agent.
 * Covers the last 24 hours for completed items and current assignments.
 * Saved to the activity log (standups are ephemeral).
 */
export async function generateDailyStandup(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<string> {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today = formatDateCT(now);

  // Fetch agent info
  const [agent] = await db
    .select({ name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) {
    logger.warn({ agentId }, "agent not found for daily standup");
    return "";
  }

  // Completed yesterday (last 24h)
  const completedIssues = await db
    .select({ title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "done"),
        gte(issues.completedAt, twentyFourHoursAgo),
      ),
    );

  // Working on today (in_progress)
  const inProgressIssues = await db
    .select({ title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "in_progress"),
      ),
    );

  // Blocked
  const blockedIssues = await db
    .select({ title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "blocked"),
      ),
    );

  // Format issue lines
  const formatIssue = (i: { title: string; identifier: string | null }) =>
    i.identifier ? `- [${i.identifier}] ${i.title}` : `- ${i.title}`;

  const completedSection =
    completedIssues.length > 0
      ? completedIssues.map(formatIssue).join("\n")
      : "- Nothing completed";

  const inProgressSection =
    inProgressIssues.length > 0
      ? inProgressIssues.map(formatIssue).join("\n")
      : "- No active work";

  const blockedSection =
    blockedIssues.length > 0
      ? blockedIssues.map(formatIssue).join("\n")
      : "- No blockers";

  const markdown = [
    `## ${agent.name} - Daily Update`,
    `**Date:** ${today}`,
    "",
    "**Completed yesterday:**",
    completedSection,
    "",
    "**Working on today:**",
    inProgressSection,
    "",
    "**Blocked:**",
    blockedSection,
  ].join("\n");

  // Save to activity log (standups are ephemeral)
  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "system",
    action: "agent.daily_standup",
    entityType: "agent",
    entityId: agentId,
    agentId,
    details: {
      date: today,
      completed: completedIssues.length,
      inProgress: inProgressIssues.length,
      blocked: blockedIssues.length,
      markdown,
    },
  });

  logger.info(
    { agentId, companyId, date: today },
    "generated daily standup",
  );

  return markdown;
}

// ── Run All Daily Standups ─────────────────────────────────────────────────

/**
 * Generate daily standups for all non-terminated agents in a company.
 */
export async function runDailyStandups(
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
      await generateDailyStandup(db, agent.id, companyId);
    } catch (err) {
      logger.error({ err, agentId: agent.id, companyId }, "failed to generate daily standup");
    }
  }
}

/**
 * Run daily standups for ALL companies.
 */
export async function runAllDailyStandups(db: Db): Promise<void> {
  const allCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(ne(companies.status, "pending_erasure"));

  for (const company of allCompanies) {
    try {
      await runDailyStandups(db, company.id);
    } catch (err) {
      logger.error({ err, companyId: company.id }, "failed to run daily standups for company");
    }
  }

  logger.info({ companiesProcessed: allCompanies.length }, "daily standups run complete");
}
