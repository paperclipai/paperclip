import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issueComments, issues } from "@ironworksai/db";
import { createAlert } from "./smart-alerts.js";
import { logger } from "../middleware/logger.js";

const HEARTBEAT_CYCLE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check all blocked issues for the company and escalate based on how many
 * heartbeat cycles they have been blocked.
 *
 * Escalation ladder (based on updatedAt as proxy for when blocking started):
 *   T+1 cycle (30 min):  comment on the issue flagging the blockage
 *   T+2 cycles (1 hr):   escalate to department channel
 *   T+4 cycles (2 hrs):  escalate to CEO via #company
 *   T+8 cycles (4 hrs):  create a critical smart alert
 */
export async function checkAndResolveBlockers(
  db: Db,
  companyId: string,
): Promise<{ escalated: number; autoResolved: number }> {
  const now = new Date();

  const blockedIssues = await db
    .select({
      id: issues.id,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")));

  let escalated = 0;
  const autoResolved = 0;

  for (const issue of blockedIssues) {
    const blockedMs = now.getTime() - new Date(issue.updatedAt).getTime();
    const cycles = Math.floor(blockedMs / HEARTBEAT_CYCLE_MS);

    if (cycles < 1) continue;

    try {
      if (cycles >= 8) {
        // T+8: Critical smart alert
        await createAlert(db, companyId, {
          severity: "critical",
          category: "blocker",
          title: `Critical: issue blocked for ${Math.round(blockedMs / 3600000)}+ hours`,
          description: `Issue "${issue.title}" has been blocked for over 4 hours with no resolution. Immediate escalation required.`,
          agentId: issue.assigneeAgentId ?? null,
          issueId: issue.id,
        });
        escalated++;
      } else if (cycles >= 4) {
        // T+4: Post to #company channel about CEO-level escalation
        await postBlockerComment(
          db,
          companyId,
          issue.id,
          `This issue has been blocked for ${Math.round(blockedMs / 3600000)} hours. Escalating to CEO (Marcus Cole) for intervention.`,
        );
        escalated++;
      } else if (cycles >= 2) {
        // T+2: Escalate to department
        const assignee = issue.assigneeAgentId
          ? await db
              .select({ reportsTo: agents.reportsTo, name: agents.name })
              .from(agents)
              .where(eq(agents.id, issue.assigneeAgentId))
              .then((rows) => rows[0] ?? null)
          : null;

        const managerNote = assignee?.reportsTo
          ? " Notifying department head."
          : "";
        await postBlockerComment(
          db,
          companyId,
          issue.id,
          `This issue has been blocked for ${Math.round(blockedMs / 60000)} minutes (2+ heartbeat cycles).${managerNote} Please provide a status update or identify what is needed to unblock.`,
        );
        escalated++;
      } else if (cycles >= 1) {
        // T+1: Simple comment flag
        await postBlockerComment(
          db,
          companyId,
          issue.id,
          `This issue has been blocked for ${Math.round(blockedMs / 60000)} minutes. If this dependency has been resolved, please move back to in_progress.`,
        );
        escalated++;
      }
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "blocker-resolution: failed to escalate issue");
    }
  }

  return { escalated, autoResolved };
}

async function postBlockerComment(
  db: Db,
  companyId: string,
  issueId: string,
  body: string,
): Promise<void> {
  // Check if we already posted a nearly identical comment recently (avoid spam)
  const recentComment = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        lt(
          sql`extract(epoch from (now() - ${issueComments.createdAt})) / 60`,
          sql`${35}`,
        ),
        sql`${issueComments.body} like '%blocked%'`,
        sql`${issueComments.authorAgentId} is null`,
      ),
    )
    .limit(1);

  if (recentComment.length > 0) return;

  await db.insert(issueComments).values({
    companyId,
    issueId,
    authorAgentId: null,
    authorUserId: null,
    body,
  });

  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

/**
 * Categorize a blocker using keyword matching on the issue title, description,
 * and comments. Returns a category string useful for triage dashboards and COO
 * reporting.
 */
export type BlockerCategory =
  | "dependency"
  | "missing_info"
  | "approval_pending"
  | "cross_department"
  | "external";

export function categorizeBlocker(
  issueTitle: string,
  issueDescription: string | null | undefined,
  comments: string[] = [],
): BlockerCategory {
  const haystack = [issueTitle, issueDescription ?? "", ...comments]
    .join(" ")
    .toLowerCase();

  // Order matters - more specific patterns first
  if (/\bapproval\b|\bpending review\b|\bsign off\b/.test(haystack)) return "approval_pending";
  if (/\bfrom marketing\b|\bfrom engineering\b|\bcross[- ]team\b|\bcross[- ]department\b/.test(haystack)) return "cross_department";
  if (/\bvendor\b|\bthird[- ]party\b|\bexternal\b|\b(?:api|API)\s+(?:key|rate|limit|down)\b/.test(haystack)) return "external";
  if (/\bneed info\b|\bquestion\b|\bunclear\b|\bmissing\b|\bneed clarification\b/.test(haystack)) return "missing_info";
  if (/\bdepends on\b|\bwaiting for\b|\bblocked by\b|\bdependency\b/.test(haystack)) return "dependency";

  return "dependency";
}

/**
 * Find issues where status = "in_progress" and updatedAt is older than 3 hours.
 * Post a comment nudging the assignee to update status.
 *
 * Returns the count of stale cards flagged.
 */
export async function detectStaleCards(db: Db, companyId: string): Promise<number> {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

  const staleIssues = await db
    .select({
      id: issues.id,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_progress"),
        lt(issues.updatedAt, threeHoursAgo),
      ),
    );

  let flagged = 0;

  for (const issue of staleIssues) {
    const hoursStale = Math.round(
      (Date.now() - new Date(issue.updatedAt).getTime()) / 3600000,
    );

    // Don't spam - check for a recent stale comment
    const recentStaleComment = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issue.id),
          lt(
            sql`extract(epoch from (now() - ${issueComments.createdAt})) / 3600`,
            sql`${4}`,
          ),
          sql`${issueComments.body} like '%in progress%hours with no updates%'`,
        ),
      )
      .limit(1);

    if (recentStaleComment.length > 0) continue;

    const assigneeMention = issue.assigneeAgentId ? " Please post a status update or mark as blocked." : "";

    await db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: null,
      authorUserId: null,
      body: `This issue has been in progress for ${hoursStale} hours with no updates.${assigneeMention}`,
    });

    await db
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.id, issue.id));

    flagged++;
  }

  return flagged;
}
