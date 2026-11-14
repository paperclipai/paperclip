import { issueDisplayStatusSql } from "./issue-display-status.js";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
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

/** Counts stay on the server: a collapsed group never downloads its children. */
export async function listIssueNavigationState(
  db: Db,
  companyId: string,
  ids: readonly string[],
  readCondition: SQL<boolean>,
  unreadCondition: SQL<boolean>,
) {
  if (ids.length > ISSUE_SUMMARIES_MAX_IDS) throw new Error("Too many issue summary IDs");
  if (!ids.length) return new Map();
  // Keep the correlated unread predicate in WHERE. Drizzle unqualifies nested
  // column references in single-table SELECT expressions.
  const childCondition = and(eq(issues.companyId, companyId), inArray(issues.parentId, [...ids]),
    isNull(issues.hiddenAt), isNull(issues.conversationAgentId), readCondition);
  const [unreadTasks, children, unreadChildren] = await Promise.all([
    db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId), inArray(issues.id, [...ids]), isNull(issues.hiddenAt), readCondition, unreadCondition,
    )),
    db.select({
      parentId: issues.parentId,
      subtaskCount: sql<number>`count(*)::int`,
    }).from(issues).where(childCondition).groupBy(issues.parentId),
    db.select({ parentId: issues.parentId, count: sql<number>`count(*)::int` }).from(issues)
      .where(and(childCondition, unreadCondition)).groupBy(issues.parentId),
  ]);
  const byParent = new Map(children.map(child => [child.parentId, child]));
  const unreadByParent = new Map(unreadChildren.map(child => [child.parentId, child.count]));
  const unreadIds = new Set(unreadTasks.map(task => task.id));
  return new Map(ids.map(id => [id, {
    isUnreadForMe: unreadIds.has(id),
    subtaskCount: byParent.get(id)?.subtaskCount ?? 0,
    unreadSubtaskCount: unreadByParent.get(id) ?? 0,
  }]));
}
