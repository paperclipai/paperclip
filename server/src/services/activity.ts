import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.companyId, filters.companyId)];

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              isNull(issues.hiddenAt),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .then((rows) => rows.map((r) => r.activityLog));
    },

    forIssue: (issueId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
          ),
        )
        .orderBy(desc(activityLog.createdAt)),

    runsForIssue: (companyId: string, issueId: string) =>
      db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            or(
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
              sql`exists (
                select 1
                from ${activityLog}
                where ${activityLog.companyId} = ${companyId}
                  and ${activityLog.entityType} = 'issue'
                  and ${activityLog.entityId} = ${issueId}
                  and ${activityLog.runId} = ${heartbeatRuns.id}
              )`,
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt)),

    issuesForRun: async (runId: string) => {
      const run = await db
        .select({
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([issueIdAsText], {
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .where(
          and(
            eq(activityLog.companyId, run.companyId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "issue"),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issueIdAsText);

      const context = run.contextSnapshot;
      const contextIssueId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).issueId === "string"
          ? ((context as Record<string, unknown>).issueId as string)
          : null;
      if (!contextIssueId) return fromActivity;
      if (fromActivity.some((issue) => issue.issueId === contextIssueId)) return fromActivity;

      const fromContext = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.id, contextIssueId),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    create: (data: typeof activityLog.$inferInsert) =>
      db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]),
  };
}
