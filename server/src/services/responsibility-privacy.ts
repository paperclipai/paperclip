import { sql } from "drizzle-orm";
import { activityLog, issues } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";

const conversationKinds = ["responsibility_dashboard", "responsibility_bar", "responsibility_status_update", "automation_conversation"];
export function isPersonalDashboardConversation(kind: string | null) {
  return kind !== null && conversationKinds.includes(kind);
}

export type DashboardConversationFields = {
  originKind?: string | null;
  originId?: string | null;
  responsibleUserId?: string | null;
  assigneeAgentId?: string | null;
};

export function dashboardConversationReadable(actor: AuthorizationActor, issue: DashboardConversationFields) {
  if (!isPersonalDashboardConversation(issue.originKind ?? null)) return true;
  const ownerId = issue.originKind === "responsibility_dashboard" ? issue.originId : issue.responsibleUserId;
  if (!ownerId) return false;
  if (actor.type === "board") return actor.userId === ownerId;
  return actor.type === "agent" && !!issue.assigneeAgentId && actor.agentId === issue.assigneeAgentId
    && (!actor.onBehalfOfUserId || actor.onBehalfOfUserId === ownerId)
    && (!actor.authorizingUserId || actor.authorizingUserId === ownerId);
}

const personalConversationKinds = sql.join(conversationKinds.map(kind => sql`${kind}`), sql`, `);

export function dashboardConversationCondition(actor: AuthorizationActor) {
  const owner = sql`case when ${issues.originKind} = 'responsibility_dashboard' then ${issues.originId} else ${issues.responsibleUserId} end`;
  const allowed = actor.type === "board" ? sql`${owner} = ${actor.userId ?? null}`
    : actor.type === "agent" ? sql`${issues.assigneeAgentId} = ${actor.agentId ?? null}
      and ${actor.onBehalfOfUserId ? sql`${owner} = ${actor.onBehalfOfUserId}` : sql`true`}
      and ${actor.authorizingUserId ? sql`${owner} = ${actor.authorizingUserId}` : sql`true`}` : sql`false`;
  return sql<boolean>`(${issues.originKind} not in (${personalConversationKinds}) or (${owner} is not null and ${allowed}))`;
}

const entities = ["responsibility", "responsibility_area", "responsibility_dashboard_version"];
export function isDashboardActivity(entityType: unknown) {
  return typeof entityType === "string" && entities.includes(entityType);
}

/** Activity without a current owner stays in the audit store and is invisible in company feeds. */
export function dashboardActivityCondition(userId?: string | null) {
  const ordinary = sql`${activityLog.entityType} not in ('responsibility', 'responsibility_area', 'responsibility_dashboard_version')`;
  if (!userId) return sql<boolean>`${ordinary}`;
  return sql<boolean>`(${ordinary} or case ${activityLog.entityType}
    when 'responsibility' then exists (select 1 from responsibilities r where r.id::text = ${activityLog.entityId} and r.company_id = ${activityLog.companyId} and r.owner_user_id = ${userId})
    when 'responsibility_area' then exists (select 1 from responsibility_areas a where a.id::text = ${activityLog.entityId} and a.company_id = ${activityLog.companyId} and a.owner_user_id = ${userId})
    when 'responsibility_dashboard_version' then exists (select 1 from responsibility_dashboard_versions v where v.id::text = ${activityLog.entityId} and v.company_id = ${activityLog.companyId} and v.owner_user_id = ${userId})
    else false end)`;
}

/** Audit entries can refer to a conversation directly, through a comment or through a document. */
export function dashboardAuditConversationCondition(userId?: string | null) {
  const entity = activityLog.entityId;
  const privateIssue = sql`select 1 from issues i where i.company_id = ${activityLog.companyId}
    and i.origin_kind in (${personalConversationKinds})
    and (${userId ?? null}::text is null or (case when i.origin_kind = 'responsibility_dashboard' then i.origin_id else i.responsible_user_id end)
      is distinct from ${userId ?? null})`;
  return sql<boolean>`case ${activityLog.entityType}
    when 'issue' then not exists (${privateIssue} and i.id::text = ${entity})
    when 'issue_comment' then not exists (${privateIssue} and i.id in
      (select c.issue_id from issue_comments c where c.id::text = ${entity}))
    when 'issue_document' then not exists (${privateIssue} and i.id in
      (select d.issue_id from issue_documents d where d.id::text = ${entity} or d.document_id::text = ${entity}))
    else true end`;
}
