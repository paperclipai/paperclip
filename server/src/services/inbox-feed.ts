import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  issueComments,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import type { InboxFeedActivity } from "@paperclipai/shared";
import { issueService } from "./issues.js";

export function inboxFeedService(db: Db) {
  const issueSvc = issueService(db);

  return {
    feed: async (
      companyId: string,
      userId: string,
      opts?: { limit?: number },
    ) => {
      const limit = Math.min(opts?.limit ?? 100, 200);

      // 1. Fetch touched issues (reuses existing list with touchedByUserId)
      const touchedIssues = await issueSvc.list(companyId, {
        touchedByUserId: userId,
        status: "backlog,todo,in_progress,in_review,blocked,done",
      });

      if (touchedIssues.length === 0) return [];

      const issueIds = touchedIssues.map((i) => i.id);

      // 2. Get latest comment per issue (any author)
      const latestComments = await db
        .selectDistinctOn([issueComments.issueId], {
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
          ),
        )
        .orderBy(issueComments.issueId, desc(issueComments.createdAt));

      const commentByIssueId = new Map(
        latestComments.map((c) => [c.issueId, c]),
      );

      // 3. Get latest activity_log entry per issue
      const issueIdAsText = sql<string>`${activityLog.entityId}`;
      const latestActivities = await db
        .selectDistinctOn([activityLog.entityId], {
          entityId: activityLog.entityId,
          action: activityLog.action,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          agentId: activityLog.agentId,
          runId: activityLog.runId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(issueIdAsText, issueIds),
          ),
        )
        .orderBy(activityLog.entityId, desc(activityLog.createdAt));

      const activityByIssueId = new Map(
        latestActivities.map((a) => [a.entityId, a]),
      );

      // 4. Get unread comment counts per issue (comments newer than user's last touch)
      const unreadCounts = await db
        .select({
          issueId: issueComments.issueId,
          count: sql<number>`count(*)`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
            sql`(
              ${issueComments.authorUserId} IS NULL
              OR ${issueComments.authorUserId} <> ${userId}
            )`,
            sql`${issueComments.createdAt} > COALESCE(
              (SELECT MAX(${issueReadStates.lastReadAt})
               FROM ${issueReadStates}
               WHERE ${issueReadStates.issueId} = ${issueComments.issueId}
                 AND ${issueReadStates.companyId} = ${companyId}
                 AND ${issueReadStates.userId} = ${userId}),
              '1970-01-01'::timestamptz
            )`,
          ),
        )
        .groupBy(issueComments.issueId);

      const unreadByIssueId = new Map(
        unreadCounts.map((r) => [r.issueId, Number(r.count)]),
      );

      // 5. Resolve agent names for activity actors
      const agentIds = new Set<string>();
      for (const comment of latestComments) {
        if (comment.authorAgentId) agentIds.add(comment.authorAgentId);
      }
      for (const activity of latestActivities) {
        if (activity.agentId) agentIds.add(activity.agentId);
      }

      const agentNameMap = new Map<string, string>();
      if (agentIds.size > 0) {
        const agentRows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, [...agentIds]));
        for (const row of agentRows) {
          agentNameMap.set(row.id, row.name);
        }
      }

      // 6. Assemble feed items
      const feedItems = touchedIssues.map((issue) => {
        const comment = commentByIssueId.get(issue.id);
        const activity = activityByIssueId.get(issue.id);

        let latestActivity: InboxFeedActivity | null = null;

        // Prefer whichever is more recent: comment or activity_log entry
        const commentTime = comment ? new Date(comment.createdAt).getTime() : 0;
        const activityTime = activity
          ? new Date(activity.createdAt).getTime()
          : 0;

        if (comment && commentTime >= activityTime) {
          // Comment is the latest activity
          const actorName = comment.authorAgentId
            ? agentNameMap.get(comment.authorAgentId) ?? null
            : comment.authorUserId ?? null;
          const firstLine =
            comment.body.split("\n").map((l) => l.trim()).find(Boolean) ??
            comment.body.slice(0, 200);

          latestActivity = {
            action: "comment.created",
            actorType: comment.authorAgentId ? "agent" : "user",
            actorId: comment.authorAgentId ?? comment.authorUserId ?? "unknown",
            actorName,
            summary: firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine,
            timestamp: new Date(comment.createdAt).toISOString(),
            runId: null,
          };
        } else if (activity) {
          // Activity log entry is the latest
          const actorName = activity.agentId
            ? agentNameMap.get(activity.agentId) ?? null
            : activity.actorId;
          const summary = formatActivitySummary(
            activity.action,
            activity.details,
          );

          latestActivity = {
            action: activity.action,
            actorType: activity.actorType as "agent" | "user" | "system",
            actorId: activity.actorId,
            actorName,
            summary,
            timestamp: new Date(activity.createdAt).toISOString(),
            runId: activity.runId,
          };
        }

        return {
          issue,
          latestActivity,
          unreadCount: unreadByIssueId.get(issue.id) ?? 0,
        };
      });

      // Sort by latest activity timestamp descending, then by issue.updatedAt
      feedItems.sort((a, b) => {
        const aTime = a.latestActivity
          ? new Date(a.latestActivity.timestamp).getTime()
          : new Date(a.issue.updatedAt).getTime();
        const bTime = b.latestActivity
          ? new Date(b.latestActivity.timestamp).getTime()
          : new Date(b.issue.updatedAt).getTime();
        return bTime - aTime;
      });

      return feedItems.slice(0, limit);
    },
  };
}

function formatActivitySummary(
  action: string,
  details: Record<string, unknown> | null,
): string {
  const d = details ?? {};
  switch (action) {
    case "issue.status_changed":
      return `status changed to ${d.newStatus ?? "unknown"}`;
    case "issue.assigned":
      return `assigned to ${d.assigneeName ?? d.assigneeAgentId ?? "someone"}`;
    case "issue.created":
      return "issue created";
    case "issue.updated":
      return summarizeIssueUpdate(d);
    case "comment.added":
    case "comment.created":
      return (d.bodyPreview as string) ?? "commented";
    case "issue.checked_out":
      return "started working";
    case "issue.released":
      return "released task";
    default:
      return action.replace(/\./g, " ");
  }
}

function summarizeIssueUpdate(details: Record<string, unknown>): string {
  const changes: string[] = [];
  if (details.newStatus) changes.push(`status → ${details.newStatus}`);
  if (details.newPriority) changes.push(`priority → ${details.newPriority}`);
  if (details.assigneeName) changes.push(`assigned to ${details.assigneeName}`);
  if (changes.length > 0) return changes.join(", ");
  return "updated";
}
