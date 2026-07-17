import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments, issueDocuments, issues } from "@paperclipai/db";
import { createActivityDetailsRedactor } from "./activity-log.js";

export interface AgentActionAuditFilters {
  companyId: string;
  agentId?: string;
  responsibleUserId?: string;
  runId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  actorType?: "agent" | "user" | "system" | "plugin";
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

type CursorValue = { createdAt: string; id: string };

function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorValue;
    const createdAt = new Date(value.createdAt);
    if (!value.id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt: createdAt.toISOString(), id: value.id };
  } catch {
    return null;
  }
}

function encodeCursor(value: CursorValue) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function excerpt(value: string, maxLength = 280) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function agentActionAuditService(db: Db) {
  return {
    list: async (filters: AgentActionAuditFilters) => {
      const cursor = decodeCursor(filters.cursor);
      if (filters.cursor && !cursor) throw new Error("Invalid audit cursor");
      const effectiveResponsibleUserId = sql<string | null>`coalesce(${activityLog.responsibleUserId}, ${heartbeatRuns.responsibleUserId})`;
      const conditions = [eq(activityLog.companyId, filters.companyId), isNotNull(activityLog.agentId)];
      if (filters.agentId) conditions.push(eq(activityLog.agentId, filters.agentId));
      if (filters.responsibleUserId) conditions.push(or(
        eq(activityLog.responsibleUserId, filters.responsibleUserId),
        and(
          isNull(activityLog.responsibleUserId),
          eq(heartbeatRuns.responsibleUserId, filters.responsibleUserId),
        ),
      )!);
      if (filters.runId) conditions.push(eq(activityLog.runId, filters.runId));
      if (filters.entityType) conditions.push(eq(activityLog.entityType, filters.entityType));
      if (filters.entityId) conditions.push(eq(activityLog.entityId, filters.entityId));
      if (filters.action) conditions.push(sql<boolean>`starts_with(${activityLog.action}, ${filters.action})`);
      if (filters.actorType) conditions.push(eq(activityLog.actorType, filters.actorType));
      if (filters.from) conditions.push(gte(activityLog.createdAt, filters.from));
      if (filters.to) conditions.push(lte(activityLog.createdAt, filters.to));
      if (cursor) {
        const cursorDate = new Date(cursor.createdAt);
        conditions.push(or(
          lt(activityLog.createdAt, cursorDate),
          and(eq(activityLog.createdAt, cursorDate), lt(activityLog.id, cursor.id)),
        )!);
      }

      const rows = await db.select({
        id: activityLog.id,
        companyId: activityLog.companyId,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        responsibleUserId: effectiveResponsibleUserId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      }).from(activityLog).leftJoin(heartbeatRuns, and(
        eq(heartbeatRuns.companyId, activityLog.companyId),
        eq(heartbeatRuns.id, activityLog.runId),
      )).where(and(...conditions)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(filters.limit + 1);

      const page = rows.slice(0, filters.limit);
      const entityIds = [...new Set(page.map((row) => row.entityId))];
      const commentRows = entityIds.length === 0 ? [] : await db.select({
        id: issueComments.id, body: issueComments.body, issueId: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issueComments).innerJoin(issues, and(eq(issues.id, issueComments.issueId), eq(issues.companyId, filters.companyId)))
        .where(and(eq(issueComments.companyId, filters.companyId), inArray(issueComments.id, entityIds)));
      const issueRows = entityIds.length === 0 ? [] : await db.select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issues).where(and(eq(issues.companyId, filters.companyId), inArray(issues.id, entityIds)));
      const documentRows = entityIds.length === 0 ? [] : await db.select({
        id: issueDocuments.id, documentId: issueDocuments.documentId, key: issueDocuments.key,
        issueId: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issueDocuments).innerJoin(issues, and(eq(issues.id, issueDocuments.issueId), eq(issues.companyId, filters.companyId)))
        .where(and(eq(issueDocuments.companyId, filters.companyId), or(
          inArray(issueDocuments.id, entityIds), inArray(issueDocuments.documentId, entityIds),
        )));

      const comments = new Map(commentRows.map((row) => [row.id, row]));
      const issueMap = new Map(issueRows.map((row) => [row.id, row]));
      const documents = new Map<string, (typeof documentRows)[number]>();
      for (const row of documentRows) {
        documents.set(row.id, row);
        documents.set(row.documentId, row);
      }

      const redactDetails = await createActivityDetailsRedactor(db);
      const items = page.map((row) => {
        const comment = comments.get(row.entityId);
        const issue = issueMap.get(row.entityId);
        const document = documents.get(row.entityId);
        const issueSnippet = comment
          ? { id: comment.issueId, identifier: comment.identifier, title: comment.title }
          : document
            ? { id: document.issueId, identifier: document.identifier, title: document.title }
            : issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null;
        return {
          ...row,
          details: redactDetails(row.details),
          entity: {
            issue: issueSnippet,
            comment: comment ? { id: comment.id, excerpt: excerpt(comment.body) } : null,
            document: document ? { id: document.documentId, key: document.key } : null,
          },
        };
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor: rows.length > filters.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      };
    },
  };
}
