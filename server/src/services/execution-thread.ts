import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueComments, issueRelations, issues } from "@paperclipai/db";
import type {
  ExecutionThreadEntry,
  ExecutionThreadIssueSummary,
  ExecutionThreadResponse,
} from "@paperclipai/shared";

interface WaveIssueRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  parent_id: string | null;
  assignee_agent_id: string | null;
  created_at: string;
}

export function executionThreadService(db: Db) {
  return {
    async getThread(issueId: string): Promise<ExecutionThreadResponse> {
      // 1. Walk up to find root issue
      const rootId = await findRoot(db, issueId);

      // 2. Collect all issues in the wave via recursive CTE
      const waveRows: WaveIssueRow[] = await db.execute(sql`
        WITH RECURSIVE wave AS (
          SELECT id, identifier, title, status, "parent_id" AS parent_id,
                 "assignee_agent_id" AS assignee_agent_id, "created_at" AS created_at
          FROM issues
          WHERE id = ${rootId} AND "hidden_at" IS NULL
          UNION ALL
          SELECT i.id, i.identifier, i.title, i.status, i."parent_id" AS parent_id,
                 i."assignee_agent_id" AS assignee_agent_id, i."created_at" AS created_at
          FROM issues i
          INNER JOIN wave w ON i."parent_id" = w.id
          WHERE i."hidden_at" IS NULL
        )
        SELECT * FROM wave LIMIT 201
      `) as unknown as WaveIssueRow[];

      if (waveRows.length === 0) {
        return {
          rootIssueId: rootId,
          rootIssueIdentifier: null,
          issues: [],
          entries: [],
          truncated: false,
        };
      }

      const truncated = waveRows.length > 200;
      if (truncated) waveRows.splice(200);
      const waveIds = waveRows.map((r) => r.id);
      const issueMap = new Map<string, WaveIssueRow>(waveRows.map((r) => [r.id, r]));
      const rootIssue = issueMap.get(rootId);

      // 3. Batch-fetch comments, activity, and relations in parallel
      const [comments, activity] = await Promise.all([
        db
          .select()
          .from(issueComments)
          .where(inArray(issueComments.issueId, waveIds))
          .orderBy(asc(issueComments.createdAt)),
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, waveIds),
            ),
          )
          .orderBy(asc(activityLog.createdAt)),
      ]);

      // 4. Merge into timeline entries
      const entries: ExecutionThreadEntry[] = [];

      // Activity events
      for (const evt of activity) {
        const issue = issueMap.get(evt.entityId);
        const details = evt.details as Record<string, unknown> | null;

        if (evt.action === "issue.created") {
          entries.push({
            id: evt.id,
            kind: "issue_created",
            issueId: evt.entityId,
            issueIdentifier: issue?.identifier ?? null,
            actorType: evt.actorType as "agent" | "user" | "system",
            actorId: evt.actorId,
            timestamp: new Date(evt.createdAt).toISOString(),
            details,
          });
        } else if (evt.action === "issue.updated" && details) {
          if ("status" in details) {
            entries.push({
              id: evt.id,
              kind: "status_change",
              issueId: evt.entityId,
              issueIdentifier: issue?.identifier ?? null,
              actorType: evt.actorType as "agent" | "user" | "system",
              actorId: evt.actorId,
              timestamp: new Date(evt.createdAt).toISOString(),
              statusFrom: (details._previous as Record<string, unknown>)?.status as string | null ?? null,
              statusTo: details.status as string | null ?? null,
              details,
            });
          }
          if ("assigneeAgentId" in details || "assigneeUserId" in details) {
            entries.push({
              id: `${evt.id}-assign`,
              kind: "assignment_change",
              issueId: evt.entityId,
              issueIdentifier: issue?.identifier ?? null,
              actorType: evt.actorType as "agent" | "user" | "system",
              actorId: evt.actorId,
              timestamp: new Date(evt.createdAt).toISOString(),
              assigneeFrom:
                ((details._previous as Record<string, unknown>)?.assigneeAgentId as string | null) ??
                ((details._previous as Record<string, unknown>)?.assigneeUserId as string | null) ??
                null,
              assigneeTo:
                (details.assigneeAgentId as string | null) ??
                (details.assigneeUserId as string | null) ??
                null,
              details,
            });
          }
          // Generic update for fields not already covered above
          const hasKnownField = "status" in details || "assigneeAgentId" in details || "assigneeUserId" in details;
          const hasOtherFields = Object.keys(details).some((k) => !["status", "assigneeAgentId", "assigneeUserId", "_previous"].includes(k));
          if (!hasKnownField || hasOtherFields) {
            entries.push({
              id: evt.id,
              kind: "issue_updated",
              issueId: evt.entityId,
              issueIdentifier: issue?.identifier ?? null,
              actorType: evt.actorType as "agent" | "user" | "system",
              actorId: evt.actorId,
              timestamp: new Date(evt.createdAt).toISOString(),
              details,
            });
          }
        } else if (evt.action === "issue.blockers_updated" && details) {
          const added = (details.added as string[]) ?? [];
          const removed = (details.removed as string[]) ?? [];
          for (const blockerId of added) {
            const blockerIssue = issueMap.get(blockerId);
            entries.push({
              id: `${evt.id}-block-${blockerId}`,
              kind: "blocker_added",
              issueId: evt.entityId,
              issueIdentifier: issue?.identifier ?? null,
              actorType: evt.actorType as "agent" | "user" | "system",
              actorId: evt.actorId,
              timestamp: new Date(evt.createdAt).toISOString(),
              blockerIssueId: blockerId,
              blockerIssueIdentifier: blockerIssue?.identifier ?? null,
              details,
            });
          }
          for (const blockerId of removed) {
            const blockerIssue = issueMap.get(blockerId);
            entries.push({
              id: `${evt.id}-unblock-${blockerId}`,
              kind: "blocker_removed",
              issueId: evt.entityId,
              issueIdentifier: issue?.identifier ?? null,
              actorType: evt.actorType as "agent" | "user" | "system",
              actorId: evt.actorId,
              timestamp: new Date(evt.createdAt).toISOString(),
              blockerIssueId: blockerId,
              blockerIssueIdentifier: blockerIssue?.identifier ?? null,
              details,
            });
          }
        }
      }

      // Comments
      for (const comment of comments) {
        const issue = issueMap.get(comment.issueId);
        entries.push({
          id: `comment-${comment.id}`,
          kind: "comment",
          issueId: comment.issueId,
          issueIdentifier: issue?.identifier ?? null,
          actorType: comment.authorAgentId ? "agent" : "user",
          actorId: comment.authorAgentId ?? comment.authorUserId ?? "unknown",
          timestamp: new Date(comment.createdAt).toISOString(),
          commentBody: comment.body,
        });
      }

      // Sort chronologically, tie-break by id
      entries.sort((a, b) => {
        const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });

      const issueSummaries: ExecutionThreadIssueSummary[] = waveRows.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        title: r.title,
        status: r.status,
        parentId: r.parent_id,
        assigneeAgentId: r.assignee_agent_id,
        createdAt: new Date(r.created_at).toISOString(),
      }));

      return {
        rootIssueId: rootId,
        rootIssueIdentifier: rootIssue?.identifier ?? null,
        issues: issueSummaries,
        entries,
        truncated,
      };
    },
  };
}

async function findRoot(db: Db, issueId: string): Promise<string> {
  let currentId: string | null = issueId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId) && visited.size < 50) {
    visited.add(currentId);
    const [row] = await db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, currentId));
    if (!row) break;
    if (!row.parentId) return row.id;
    currentId = row.parentId;
  }

  return issueId;
}
