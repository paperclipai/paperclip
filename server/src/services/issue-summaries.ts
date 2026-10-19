import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
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
