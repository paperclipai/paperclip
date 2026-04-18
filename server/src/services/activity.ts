import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, costEvents, departments, financeEvents, heartbeatRuns, issues, projects, teams } from "@paperclipai/db";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  scopeDepartmentIds?: string[];
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;

  const activityDepartmentId = sql<string | null>`case
    when ${activityLog.entityType} = 'issue' then (
      select coalesce(issue_row.department_id, issue_project.department_id)
      from ${issues} issue_row
      left join ${projects} issue_project on issue_project.id = issue_row.project_id
      where issue_row.company_id = ${activityLog.companyId}
        and issue_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'project' then (
      select project_row.department_id
      from ${projects} project_row
      where project_row.company_id = ${activityLog.companyId}
        and project_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'agent' then (
      select agent_row.department_id
      from ${agents} agent_row
      where agent_row.company_id = ${activityLog.companyId}
        and agent_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'department' then (
      select department_row.id
      from ${departments} department_row
      where department_row.company_id = ${activityLog.companyId}
        and department_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'team' then (
      select team_row.department_id
      from ${teams} team_row
      where team_row.company_id = ${activityLog.companyId}
        and team_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'cost_event' then (
      select coalesce(cost_project.department_id, cost_issue.department_id, cost_issue_project.department_id, cost_agent.department_id)
      from ${costEvents} cost_event_row
      left join ${projects} cost_project on cost_project.id = cost_event_row.project_id
      left join ${issues} cost_issue on cost_issue.id = cost_event_row.issue_id
      left join ${projects} cost_issue_project on cost_issue_project.id = cost_issue.project_id
      left join ${agents} cost_agent on cost_agent.id = cost_event_row.agent_id
      where cost_event_row.company_id = ${activityLog.companyId}
        and cost_event_row.id::text = ${activityLog.entityId}
      limit 1
    )
    when ${activityLog.entityType} = 'finance_event' then (
      select coalesce(finance_project.department_id, finance_issue.department_id, finance_issue_project.department_id, finance_agent.department_id)
      from ${financeEvents} finance_event_row
      left join ${projects} finance_project on finance_project.id = finance_event_row.project_id
      left join ${issues} finance_issue on finance_issue.id = finance_event_row.issue_id
      left join ${projects} finance_issue_project on finance_issue_project.id = finance_issue.project_id
      left join ${agents} finance_agent on finance_agent.id = finance_event_row.agent_id
      where finance_event_row.company_id = ${activityLog.companyId}
        and finance_event_row.id::text = ${activityLog.entityId}
      limit 1
    )
    else null
  end`;

  function scopeCondition(departmentIds: string[]) {
    return sql`${activityDepartmentId} in (${sql.join(departmentIds.map((departmentId) => sql`${departmentId}`), sql`, `)})`;
  }

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
      if (filters.scopeDepartmentIds?.length) {
        conditions.push(scopeCondition(filters.scopeDepartmentIds));
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
          departmentId: sql<string | null>`coalesce(${issues.departmentId}, ${projects.departmentId})`,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .leftJoin(projects, eq(issues.projectId, projects.id))
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
          departmentId: sql<string | null>`coalesce(${issues.departmentId}, ${projects.departmentId})`,
        })
        .from(issues)
        .leftJoin(projects, eq(issues.projectId, projects.id))
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
