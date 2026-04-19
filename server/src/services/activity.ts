import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  const summarizedUsageJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.usageJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'inputTokens', coalesce(${heartbeatRuns.usageJson} -> 'inputTokens', ${heartbeatRuns.usageJson} -> 'input_tokens'),
        'input_tokens', coalesce(${heartbeatRuns.usageJson} -> 'input_tokens', ${heartbeatRuns.usageJson} -> 'inputTokens'),
        'outputTokens', coalesce(${heartbeatRuns.usageJson} -> 'outputTokens', ${heartbeatRuns.usageJson} -> 'output_tokens'),
        'output_tokens', coalesce(${heartbeatRuns.usageJson} -> 'output_tokens', ${heartbeatRuns.usageJson} -> 'outputTokens'),
        'cachedInputTokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cached_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cache_read_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens'
        ),
        'billingType', coalesce(${heartbeatRuns.usageJson} -> 'billingType', ${heartbeatRuns.usageJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.usageJson} -> 'billing_type', ${heartbeatRuns.usageJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'total_cost_usd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd'
        )
      ))
    end
  `.as("usageJson");
  const summarizedResultJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.resultJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'billingType', coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'total_cost_usd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd'
        )
      ))
    end
  `.as("resultJson");

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
          adapterType: agents.adapterType,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          usageJson: summarizedUsageJson,
          resultJson: summarizedResultJson,
          logBytes: heartbeatRuns.logBytes,
        })
        .from(heartbeatRuns)
        .innerJoin(
          agents,
          and(
            eq(agents.id, heartbeatRuns.agentId),
            eq(agents.companyId, heartbeatRuns.companyId),
          ),
        )
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
