import { issueDisplayStatusSql } from "./issue-display-status.js";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { activityLog, issueComments, issueReadStates, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { directHumanCommentCondition } from "./issue-participation.js";
import { inboxVisibleForUserCondition, mineParticipationIssueIds, unreadForUserCondition } from "./issues.js";
import { externalConversationStateSql } from "./slack-conversation-state.js";

/** A bounded projection with the columns needed by task-read authorization. */
export async function listIssueSummaries(
  db: Db,
  companyId: string,
  ids: readonly string[],
  readCondition: SQL<boolean>,
) {
  if (ids.length > ISSUE_SUMMARIES_MAX_IDS) throw new Error("Too many issue summary IDs");
  if (ids.length === 0) return [];
  const rows = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    title: issues.title,
    identifier: issues.identifier,
    status: issues.status,
    displayStatus: issueDisplayStatusSql(),
    updatedAt: issues.updatedAt,
    externalConversationState: externalConversationStateSql(),
    projectId: issues.projectId,
    parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
  }).from(issues).where(and(
    eq(issues.companyId, companyId),
    inArray(issues.id, [...ids]),
    isNull(issues.hiddenAt),
    readCondition,
  ));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...new Set(ids)].flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** Counts stay on the server. Aggregate viewer facts once per readable task,
 * then evaluate the shared inbox rule without repeated comment/read lookups. */
export async function listIssueNavigationState(
  db: Db,
  companyId: string,
  ids: readonly string[],
  readCondition: SQL<boolean>,
  userId: string,
) {
  if (ids.length > ISSUE_SUMMARIES_MAX_IDS) throw new Error("Too many issue summary IDs");
  if (!ids.length) return new Map();
  const requested = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  const participation = mineParticipationIssueIds(db, companyId, userId);
  const unread = unreadForUserCondition(companyId, userId, {
    lastCommentAt: sql`issues.last_comment_at`, lastReadAt: sql`issues.last_read_at`,
    lastExternalCommentAt: sql`issues.last_external_comment_at`,
  });
  // Explicit SQL preserves qualification inside the shared correlated rules.
  // MATERIALIZED prevents PostgreSQL from repeating privacy and viewer facts
  // across the task-state and child-count branches of the final union.
  const rows = await db.execute<{
    kind: string; id: string; unread: boolean; participant: boolean; archived: boolean; total: number; unread_count: number;
  }>(sql`
    with navigation_candidates as materialized (
      select ${issues.id}, ${issues.parentId}, ${issues.conversationAgentId},
        case when ${issues.id} in (${requested}) then not (${inboxVisibleForUserCondition(companyId, userId)}) else false end as archived
      from ${issues}
      where ${issues.companyId} = ${companyId} and ${issues.hiddenAt} is null
        and (${issues.id} in (${requested}) or
          (${issues.parentId} in (${requested}) and ${issues.conversationAgentId} is null))
        and ${readCondition}
    ), navigation_participants as materialized (
      select c.id from navigation_candidates c where c.id in (select id from ${participation})
    ), possible_unread as materialized (
      -- A conservative set: any unread task must have a newer external
      -- comment, pending request, or withdrawal. The shared rule below still
      -- decides participation, resolver policy, direct authorship and reads.
      select c.id from navigation_candidates c
        join ${issueComments} on ${issueComments.issueId} = c.id and ${issueComments.companyId} = ${companyId}
        left join ${issueReadStates} on ${issueReadStates.issueId} = c.id
          and ${issueReadStates.companyId} = ${companyId} and ${issueReadStates.userId} = ${userId}
        where ${issueComments.deletedAt} is null
          and (${issueComments.authorUserId} is null or ${issueComments.authorUserId} <> ${userId})
          and ${issueComments.createdAt} > coalesce(${issueReadStates.lastReadAt}, to_timestamp(0))
      union
      select c.id from navigation_candidates c join ${issueThreadInteractions}
        on ${issueThreadInteractions.issueId} = c.id and ${issueThreadInteractions.companyId} = ${companyId}
        where ${issueThreadInteractions.status} = 'pending' and ${issueThreadInteractions.addresseeUserId} = ${userId}
      union
      select c.id from navigation_candidates c join ${activityLog}
        on ${activityLog.details}->'receipt'->>'issueId' = c.id::text and ${activityLog.companyId} = ${companyId}
        left join ${issueReadStates} on ${issueReadStates.issueId} = c.id
          and ${issueReadStates.companyId} = ${companyId} and ${issueReadStates.userId} = ${userId}
        where ${activityLog.details}->>'handledForUserId' = ${userId}
          and ${activityLog.details}->'receipt'->>'outcome' = 'withdrawn'
          and ${activityLog.createdAt} > coalesce(${issueReadStates.lastReadAt}, to_timestamp(0))
    ), unread_participants as materialized (
      select possible.id from possible_unread possible join navigation_participants p on p.id = possible.id
    ), navigation_comments as (
      select ${issueComments.issueId} as id,
        max(${issueComments.createdAt}) filter (where ${issueComments.authorUserId} = ${userId}
          and ${directHumanCommentCondition()}) as last_comment_at,
        max(${issueComments.createdAt}) filter (where ${issueComments.deletedAt} is null
          and (${issueComments.authorUserId} is null or ${issueComments.authorUserId} <> ${userId})) as last_external_comment_at
      from ${issueComments} join unread_participants c on c.id = ${issueComments.issueId}
      where ${issueComments.companyId} = ${companyId}
      group by ${issueComments.issueId}
    ), navigation_facts as (
      select ${issues.id}, ${issues.companyId}, ${issues.parentId}, ${issues.status},
        ${issues.conversationAgentId}, ${issues.createdByUserId}, ${issues.createdByAgentId},
        ${issues.assigneeUserId}, ${issues.createdAt}, ${issues.originKind},
        comments.last_comment_at, comments.last_external_comment_at,
        ${issueReadStates.lastReadAt} as last_read_at
      from navigation_candidates c join unread_participants possible on possible.id = c.id
      join ${issues} on ${issues.id} = c.id and ${issues.companyId} = ${companyId}
      left join navigation_comments comments on comments.id = c.id
      left join ${issueReadStates} on ${issueReadStates.issueId} = c.id
        and ${issueReadStates.companyId} = ${companyId} and ${issueReadStates.userId} = ${userId}
    ), navigation_state as materialized (
      select issues.id, issues.parent_id, issues.conversation_agent_id, coalesce(${unread}, false) as unread
      from navigation_facts as issues
    )
    select 'task' as kind, c.id, coalesce(s.unread, false) as unread, p.id is not null as participant, c.archived, 0 as total, 0 as unread_count
      from navigation_candidates c left join navigation_state s on s.id = c.id
      left join navigation_participants p on p.id = c.id where c.id in (${requested})
    union all
    select 'children', c.parent_id, false, false, false, count(*)::int, count(*) filter (where s.unread)::int
      from navigation_candidates c left join navigation_state s on s.id = c.id
      where c.parent_id in (${requested}) and c.conversation_agent_id is null group by c.parent_id
  `);
  const tasks = new Map(rows.filter(row => row.kind === "task").map(row => [row.id, row]));
  const children = new Map(rows.filter(row => row.kind === "children").map(row => [row.id, row]));
  return new Map(ids.map(id => [id, {
    isParticipantForMe: tasks.get(id)?.participant ?? false,
    isUnreadForMe: tasks.get(id)?.unread ?? false,
    isArchivedForMe: tasks.get(id)?.archived ?? false,
    subtaskCount: children.get(id)?.total ?? 0,
    unreadSubtaskCount: children.get(id)?.unread_count ?? 0,
  }]));
}
