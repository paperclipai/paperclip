import { and, desc, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues, agentMemoryEntries, knowledgePages } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";
import { randomUUID } from "node:crypto";

/** Format a Date as YYYY-MM-DD in Central Time. */
function formatDateCT(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export interface RetroSection {
  title: string;
  items: string[];
}

export interface RetroActionItem {
  title: string;
  issueId?: string;
}

export interface RetrospectiveResult {
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  sections: {
    whatWorked: RetroSection;
    whatDidntWork: RetroSection;
    actionItems: RetroSection;
  };
  actionItemIssueIds: string[];
  knowledgePageId: string | null;
  markdown: string;
}

/**
 * Generate a sprint retrospective for the company, save it as a KB page,
 * and create issues for each action item.
 */
export async function generateRetrospective(
  db: Db,
  companyId: string,
  periodDays: number = 14,
): Promise<RetrospectiveResult> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const startStr = formatDateCT(periodStart);
  const endStr = formatDateCT(now);

  // Get company agents
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const agentNameMap = new Map(companyAgents.map((a) => [a.id, a.name]));

  // 1. Completed issues (What Worked)
  const completedIssues = await db
    .select({ id: issues.id, title: issues.title })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, periodStart),
      ),
    )
    .orderBy(desc(issues.completedAt))
    .limit(30);

  // 2. Cancelled issues (What Didn't Work)
  const cancelledIssues = await db
    .select({ id: issues.id, title: issues.title })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "cancelled"),
        gte(issues.cancelledAt, periodStart),
      ),
    )
    .limit(20);

  // 3. Blocked issues
  const blockedIssues = await db
    .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "blocked"),
      ),
    )
    .limit(10);

  // 4. Overdue issues
  const overdueIssues = await db
    .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.status} not in ('done', 'cancelled')`,
        isNotNull(issues.targetDate),
        lt(issues.targetDate, now),
      ),
    )
    .limit(10);

  // 5. Agent reflections / mistake learnings
  const learnings = await db
    .select({ content: agentMemoryEntries.content, agentId: agentMemoryEntries.agentId })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.companyId, companyId),
        eq(agentMemoryEntries.category, "mistake_learning"),
        gte(agentMemoryEntries.createdAt, periodStart),
      ),
    )
    .limit(10);

  // Build sections
  const whatWorkedItems = completedIssues.length > 0
    ? completedIssues.map((i) => i.title)
    : ["No issues completed this period"];

  const whatDidntItems: string[] = [];
  if (cancelledIssues.length > 0) {
    whatDidntItems.push(...cancelledIssues.map((i) => `Cancelled: ${i.title}`));
  }
  if (blockedIssues.length > 0) {
    whatDidntItems.push(...blockedIssues.map((i) => `Blocked: ${i.identifier ? `[${i.identifier}] ` : ""}${i.title}`));
  }
  if (overdueIssues.length > 0) {
    whatDidntItems.push(...overdueIssues.map((i) => `Overdue: ${i.identifier ? `[${i.identifier}] ` : ""}${i.title}`));
  }
  if (learnings.length > 0) {
    whatDidntItems.push(...learnings.map((m) => {
      const name = m.agentId ? (agentNameMap.get(m.agentId) ?? "Agent") : "System";
      return `Learning (${name}): ${m.content}`;
    }));
  }
  if (whatDidntItems.length === 0) {
    whatDidntItems.push("No issues or concerns identified");
  }

  // Action items: create issues for overdue follow-ups and blockers
  const actionItemTitles: string[] = [];
  if (overdueIssues.length > 0) {
    for (const iss of overdueIssues.slice(0, 5)) {
      actionItemTitles.push(`Follow up on overdue: ${iss.identifier ? `[${iss.identifier}] ` : ""}${iss.title}`);
    }
  }
  if (blockedIssues.length > 0) {
    for (const iss of blockedIssues.slice(0, 5)) {
      actionItemTitles.push(`Unblock: ${iss.identifier ? `[${iss.identifier}] ` : ""}${iss.title}`);
    }
  }
  if (actionItemTitles.length === 0) {
    actionItemTitles.push("No action items generated - team is on track");
  }

  // Create issues for each real action item
  const actionItemIssueIds: string[] = [];
  for (const title of actionItemTitles) {
    if (title.startsWith("No action items")) continue;

    try {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `[Retro] ${title}`,
        description: `Auto-generated from sprint retrospective (${startStr} to ${endStr}).`,
        status: "todo",
        priority: "medium",
        originKind: "retrospective",
      });
      actionItemIssueIds.push(issueId);
    } catch (err) {
      logger.warn({ err, title }, "failed to create retro action item issue");
    }
  }

  // Build markdown
  const markdown = [
    `# Sprint Retrospective: ${startStr} to ${endStr}`,
    "",
    "## What Worked",
    ...whatWorkedItems.map((i) => `- ${i}`),
    "",
    "## What Didn't Work",
    ...whatDidntItems.map((i) => `- ${i}`),
    "",
    "## Action Items",
    ...actionItemTitles.map((i) => `- ${i}`),
    "",
    "---",
    `*Generated ${endStr}*`,
  ].join("\n");

  // Save as knowledge page
  let knowledgePageId: string | null = null;
  try {
    const slug = `retro-${startStr.replace(/-/g, "")}-${endStr.replace(/-/g, "")}`;
    const pageId = randomUUID();

    await db.insert(knowledgePages).values({
      id: pageId,
      companyId,
      slug,
      title: `Sprint Retrospective: ${startStr} to ${endStr}`,
      body: markdown,
      documentType: "retrospective",
      autoGenerated: true,
      createdByUserId: "system",
    });

    knowledgePageId = pageId;
  } catch (err) {
    logger.warn({ err }, "failed to save retrospective as knowledge page");
  }

  logger.info(
    { companyId, periodStart: startStr, periodEnd: endStr, actionItems: actionItemIssueIds.length },
    "generated retrospective",
  );

  return {
    periodStart: startStr,
    periodEnd: endStr,
    generatedAt: now.toISOString(),
    sections: {
      whatWorked: { title: "What Worked", items: whatWorkedItems },
      whatDidntWork: { title: "What Didn't Work", items: whatDidntItems },
      actionItems: { title: "Action Items", items: actionItemTitles },
    },
    actionItemIssueIds,
    knowledgePageId,
    markdown,
  };
}

/**
 * Get the most recent retrospective from KB pages.
 */
export async function getLatestRetrospective(
  db: Db,
  companyId: string,
): Promise<{ id: string; title: string; body: string; createdAt: string } | null> {
  const [page] = await db
    .select({
      id: knowledgePages.id,
      title: knowledgePages.title,
      body: knowledgePages.body,
      createdAt: knowledgePages.createdAt,
    })
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.companyId, companyId),
        eq(knowledgePages.documentType, "retrospective"),
      ),
    )
    .orderBy(desc(knowledgePages.createdAt))
    .limit(1);

  if (!page) return null;

  return {
    id: page.id,
    title: page.title,
    body: page.body ?? "",
    createdAt: page.createdAt.toISOString(),
  };
}
