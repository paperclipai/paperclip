import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments, issueDocuments, issues } from "@paperclipai/db";
import { createActivityDetailsRedactor } from "./activity-log.js";
import { badRequest } from "../errors.js";
import { visibleIssueCondition } from "./issue-visibility.js";

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

const cursorValueSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = cursorValueSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
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
      if (filters.cursor && !cursor) throw badRequest("Invalid audit cursor");
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
        conditions.push(or(
          sql<boolean>`${activityLog.createdAt} < ${cursor.createdAt}::timestamptz`,
          and(
            sql<boolean>`${activityLog.createdAt} = ${cursor.createdAt}::timestamptz`,
            lt(activityLog.id, cursor.id),
          ),
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
        cursorCreatedAt: sql<string>`to_char(${activityLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_created_at"),
      }).from(activityLog).leftJoin(heartbeatRuns, and(
        eq(heartbeatRuns.companyId, activityLog.companyId),
        eq(heartbeatRuns.id, activityLog.runId),
      )).where(and(...conditions)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(filters.limit + 1);

      const page = rows.slice(0, filters.limit);
      const commentEntityIds = [...new Set(page
        .filter((row) => row.entityType === "issue_comment")
        .map((row) => row.entityId))];
      const issueEntityIds = [...new Set(page
        .filter((row) => row.entityType === "issue")
        .map((row) => row.entityId))];
      const documentEntityIds = [...new Set(page
        .filter((row) => row.entityType === "issue_document")
        .map((row) => row.entityId))];
      const commentRows = commentEntityIds.length === 0 ? [] : await db.select({
        id: issueComments.id, body: issueComments.body, issueId: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issueComments).innerJoin(issues, and(
        eq(issues.id, issueComments.issueId),
        eq(issues.companyId, filters.companyId),
        visibleIssueCondition(),
      )).where(and(
        eq(issueComments.companyId, filters.companyId),
        inArray(issueComments.id, commentEntityIds),
      ));
      const issueRows = issueEntityIds.length === 0 ? [] : await db.select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issues).where(and(
        eq(issues.companyId, filters.companyId),
        visibleIssueCondition(),
        inArray(issues.id, issueEntityIds),
      ));
      const documentRows = documentEntityIds.length === 0 ? [] : await db.select({
        id: issueDocuments.id, documentId: issueDocuments.documentId, key: issueDocuments.key,
        issueId: issues.id, identifier: issues.identifier, title: issues.title,
      }).from(issueDocuments).innerJoin(issues, and(
        eq(issues.id, issueDocuments.issueId),
        eq(issues.companyId, filters.companyId),
        visibleIssueCondition(),
      )).where(and(
        eq(issueDocuments.companyId, filters.companyId),
        or(
          inArray(issueDocuments.id, documentEntityIds),
          inArray(issueDocuments.documentId, documentEntityIds),
        ),
      ));

      const comments = new Map(commentRows.map((row) => [row.id, row]));
      const issueMap = new Map(issueRows.map((row) => [row.id, row]));
      const documents = new Map<string, (typeof documentRows)[number]>();
      for (const row of documentRows) {
        documents.set(row.id, row);
        documents.set(row.documentId, row);
      }

      const redactDetails = await createActivityDetailsRedactor(db);
      const items = page.map((row) => {
        const comment = row.entityType === "issue_comment" ? comments.get(row.entityId) : undefined;
        const issue = row.entityType === "issue" ? issueMap.get(row.entityId) : undefined;
        const document = row.entityType === "issue_document" ? documents.get(row.entityId) : undefined;
        const issueSnippet = comment
          ? { id: comment.issueId, identifier: comment.identifier, title: comment.title }
          : document
            ? { id: document.issueId, identifier: document.identifier, title: document.title }
            : issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null;
        const isIssueDerived = row.entityType === "issue"
          || row.entityType === "issue_comment"
          || row.entityType === "issue_document";
        return {
          id: row.id,
          companyId: row.companyId,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          agentId: row.agentId,
          runId: row.runId,
          responsibleUserId: row.responsibleUserId,
          createdAt: row.createdAt,
          details: isIssueDerived && !issueSnippet ? null : redactDetails(row.details),
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
          ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.id })
          : null,
      };
    },
  };
}
