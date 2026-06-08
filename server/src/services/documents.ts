import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  documentAnnotationThreads,
  documentLinks,
  documentRevisions,
  documentReviewThreads,
  documentSuggestions,
  documents,
  goals,
  heartbeatRuns,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  type CompanyDocumentListQuery,
  type DocumentBacklink,
  type DocumentFeedbackCounts,
  type DocumentLinkTargetType,
  type DocumentStatus,
  type DocumentType,
  documentTypeForIssueDocumentKey,
  isSystemIssueDocumentKey,
  issueDocumentKeySchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

function normalizeDocumentKey(key: string) {
  const normalized = key.trim().toLowerCase();
  const parsed = issueDocumentKeySchema.safeParse(normalized);
  if (!parsed.success) {
    throw unprocessable("Invalid document key", parsed.error.issues);
  }
  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

// Resolve a document-revision run-id to null when it does not reference a known
// heartbeat_runs row, avoiding a FK violation when an agent's live run-id is unknown to
// this server's DB. Returns the run-id unchanged when it exists.
async function persistableDocumentRunId(db: Db, runId: string | null): Promise<string | null> {
  if (!runId) return null;
  const run = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  return run ? runId : null;
}

function nextAvailableDocumentKey(sourceKey: string, existingKeys: string[]) {
  const usedKeys = new Set(existingKeys);
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const baseMaxLength = 64 - suffix.length;
    const base = sourceKey.slice(0, baseMaxLength).replace(/[-_]+$/g, "") || "document";
    const candidate = `${base}${suffix}`;
    if (!usedKeys.has(candidate) && issueDocumentKeySchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  throw conflict("Unable to choose a new document key for locked document", { key: sourceKey });
}

export function extractLegacyPlanBody(description: string | null | undefined) {
  if (!description) return null;
  const match = /<plan>\s*([\s\S]*?)\s*<\/plan>/i.exec(description);
  if (!match) return null;
  const body = match[1]?.trim();
  return body ? body : null;
}

function mapIssueDocumentRow(
  row: {
    id: string;
    companyId: string;
    issueId: string;
    key: string;
    title: string | null;
    format: string;
    status: typeof documents.$inferSelect.status;
    documentType: typeof documents.$inferSelect.documentType;
    summary: string | null;
    ownerAgentId: string | null;
    ownerUserId: string | null;
    latestBody: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    updatedByAgentId: string | null;
    updatedByUserId: string | null;
    lockedAt: Date | null;
    lockedByAgentId: string | null;
    lockedByUserId: string | null;
    sourceTrust: typeof documents.$inferSelect.sourceTrust;
    archivedAt: Date | null;
    archivedByAgentId: string | null;
    archivedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  includeBody: boolean,
) {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    key: row.key,
    title: row.title,
    format: row.format,
    status: row.status,
    documentType: row.documentType,
    summary: row.summary,
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    ...(includeBody ? { body: row.latestBody } : {}),
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lockedAt: row.lockedAt,
    lockedByAgentId: row.lockedByAgentId,
    lockedByUserId: row.lockedByUserId,
    sourceTrust: row.sourceTrust ?? null,
    archivedAt: row.archivedAt,
    archivedByAgentId: row.archivedByAgentId,
    archivedByUserId: row.archivedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const issueDocumentSelect = {
  id: documents.id,
  companyId: documents.companyId,
  issueId: issueDocuments.issueId,
  key: issueDocuments.key,
  title: documents.title,
  format: documents.format,
  status: documents.status,
  documentType: documents.documentType,
  summary: documents.summary,
  ownerAgentId: documents.ownerAgentId,
  ownerUserId: documents.ownerUserId,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  lockedAt: documents.lockedAt,
  lockedByAgentId: documents.lockedByAgentId,
  lockedByUserId: documents.lockedByUserId,
  sourceTrust: documents.sourceTrust,
  archivedAt: documents.archivedAt,
  archivedByAgentId: documents.archivedByAgentId,
  archivedByUserId: documents.archivedByUserId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

const documentSelect = {
  id: documents.id,
  companyId: documents.companyId,
  title: documents.title,
  format: documents.format,
  status: documents.status,
  documentType: documents.documentType,
  summary: documents.summary,
  ownerAgentId: documents.ownerAgentId,
  ownerUserId: documents.ownerUserId,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  lockedAt: documents.lockedAt,
  lockedByAgentId: documents.lockedByAgentId,
  lockedByUserId: documents.lockedByUserId,
  sourceTrust: documents.sourceTrust,
  archivedAt: documents.archivedAt,
  archivedByAgentId: documents.archivedByAgentId,
  archivedByUserId: documents.archivedByUserId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

function mapDocumentRow(
  row: typeof documents.$inferSelect,
  includeBody: boolean,
  backlinks: DocumentBacklink[] = [],
  feedbackCounts: DocumentFeedbackCounts = emptyFeedbackCounts(),
) {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    format: row.format as "markdown",
    status: row.status,
    documentType: row.documentType,
    summary: row.summary,
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    ...(includeBody ? { body: row.latestBody } : {}),
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lockedAt: row.lockedAt,
    lockedByAgentId: row.lockedByAgentId,
    lockedByUserId: row.lockedByUserId,
    sourceTrust: row.sourceTrust ?? null,
    archivedAt: row.archivedAt,
    archivedByAgentId: row.archivedByAgentId,
    archivedByUserId: row.archivedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    backlinks,
    feedbackCounts,
  };
}

function emptyFeedbackCounts(): DocumentFeedbackCounts {
  return {
    openComments: 0,
    resolvedComments: 0,
    openReviewThreads: 0,
    resolvedReviewThreads: 0,
    pendingSuggestions: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 0,
    staleAnchors: 0,
    orphanedAnchors: 0,
  };
}

function normalizeRelationship(value: string | null | undefined) {
  const normalized = (value ?? "related").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return normalized.slice(0, 80) || "related";
}

export function documentService(db: Db) {
  const filterSystemDocuments = <T extends { key: string }>(rows: T[], includeSystem: boolean) =>
    includeSystem ? rows : rows.filter((row) => !isSystemIssueDocumentKey(row.key));

  async function feedbackCountsForDocuments(companyId: string, documentIds: string[]) {
    const result = new Map<string, DocumentFeedbackCounts>();
    if (documentIds.length === 0) return result;

    const rows = await db
      .select({
        documentId: documentAnnotationThreads.documentId,
        openComments: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'open')`.mapWith(Number),
        resolvedComments: sql<number>`count(*) filter (where ${documentAnnotationThreads.status} = 'resolved')`.mapWith(Number),
        staleAnchors: sql<number>`count(*) filter (where ${documentAnnotationThreads.anchorState} = 'stale')`.mapWith(Number),
        orphanedAnchors: sql<number>`count(*) filter (where ${documentAnnotationThreads.anchorState} = 'orphaned')`.mapWith(Number),
      })
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.companyId, companyId),
        inArray(documentAnnotationThreads.documentId, documentIds),
      ))
      .groupBy(documentAnnotationThreads.documentId);

    for (const row of rows) {
      result.set(row.documentId, {
        ...emptyFeedbackCounts(),
        openComments: row.openComments,
        resolvedComments: row.resolvedComments,
        staleAnchors: row.staleAnchors,
        orphanedAnchors: row.orphanedAnchors,
      });
    }
    const reviewRows = await db
      .select({
        documentId: documentReviewThreads.documentId,
        openReviewThreads: sql<number>`count(*) filter (where ${documentReviewThreads.status} = 'open')`.mapWith(Number),
        resolvedReviewThreads: sql<number>`count(*) filter (where ${documentReviewThreads.status} = 'resolved')`.mapWith(Number),
      })
      .from(documentReviewThreads)
      .where(and(
        eq(documentReviewThreads.companyId, companyId),
        inArray(documentReviewThreads.documentId, documentIds),
      ))
      .groupBy(documentReviewThreads.documentId);

    for (const row of reviewRows) {
      const existing = result.get(row.documentId) ?? emptyFeedbackCounts();
      result.set(row.documentId, {
        ...existing,
        openReviewThreads: row.openReviewThreads,
        resolvedReviewThreads: row.resolvedReviewThreads,
      });
    }

    const suggestionRows = await db
      .select({
        documentId: documentSuggestions.documentId,
        pendingSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'pending')`.mapWith(Number),
        acceptedSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'accepted')`.mapWith(Number),
        rejectedSuggestions: sql<number>`count(*) filter (where ${documentSuggestions.status} = 'rejected')`.mapWith(Number),
        staleAnchors: sql<number>`count(*) filter (where ${documentSuggestions.anchorState} = 'stale' and ${documentSuggestions.status} = 'pending')`.mapWith(Number),
        orphanedAnchors: sql<number>`count(*) filter (where ${documentSuggestions.anchorState} = 'orphaned' and ${documentSuggestions.status} = 'pending')`.mapWith(Number),
      })
      .from(documentSuggestions)
      .where(and(
        eq(documentSuggestions.companyId, companyId),
        inArray(documentSuggestions.documentId, documentIds),
      ))
      .groupBy(documentSuggestions.documentId);

    for (const row of suggestionRows) {
      const existing = result.get(row.documentId) ?? emptyFeedbackCounts();
      result.set(row.documentId, {
        ...existing,
        pendingSuggestions: row.pendingSuggestions,
        acceptedSuggestions: row.acceptedSuggestions,
        rejectedSuggestions: row.rejectedSuggestions,
        staleAnchors: existing.staleAnchors + row.staleAnchors,
        orphanedAnchors: existing.orphanedAnchors + row.orphanedAnchors,
      });
    }
    return result;
  }

  async function targetTitles(companyId: string, links: Array<{ targetType: DocumentLinkTargetType; targetId: string }>) {
    const result = new Map<string, { title: string | null; identifier: string | null }>();
    const idsByType = new Map<DocumentLinkTargetType, string[]>();
    for (const link of links) {
      idsByType.set(link.targetType, [...(idsByType.get(link.targetType) ?? []), link.targetId]);
    }

    const put = (type: DocumentLinkTargetType, id: string, value: { title: string | null; identifier: string | null }) => {
      result.set(`${type}:${id}`, value);
    };

    const issueIds = idsByType.get("issue") ?? [];
    if (issueIds.length > 0) {
      const rows = await db
        .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
      for (const row of rows) put("issue", row.id, { title: row.title, identifier: row.identifier });
    }

    const projectIds = idsByType.get("project") ?? [];
    if (projectIds.length > 0) {
      const rows = await db
        .select({ id: projects.id, title: projects.name })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
      for (const row of rows) put("project", row.id, { title: row.title, identifier: null });
    }

    const goalIds = idsByType.get("goal") ?? [];
    if (goalIds.length > 0) {
      const rows = await db
        .select({ id: goals.id, title: goals.title })
        .from(goals)
        .where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds)));
      for (const row of rows) put("goal", row.id, { title: row.title, identifier: null });
    }

    const agentIds = idsByType.get("agent") ?? [];
    if (agentIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, title: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const row of rows) put("agent", row.id, { title: row.title, identifier: null });
    }

    const approvalIds = idsByType.get("approval") ?? [];
    if (approvalIds.length > 0) {
      const rows = await db
        .select({ id: approvals.id, type: approvals.type, status: approvals.status })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), inArray(approvals.id, approvalIds)));
      for (const row of rows) put("approval", row.id, { title: `${row.type} (${row.status})`, identifier: null });
    }

    const runIds = idsByType.get("run") ?? [];
    if (runIds.length > 0) {
      const rows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
      for (const row of rows) put("run", row.id, { title: `Run ${row.status}`, identifier: null });
    }

    const workProductIds = idsByType.get("work_product") ?? [];
    if (workProductIds.length > 0) {
      const rows = await db
        .select({ id: issueWorkProducts.id, title: issueWorkProducts.title })
        .from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.id, workProductIds)));
      for (const row of rows) put("work_product", row.id, { title: row.title, identifier: null });
    }

    return result;
  }

  async function backlinksForDocuments(companyId: string, documentIds: string[]) {
    const result = new Map<string, DocumentBacklink[]>();
    if (documentIds.length === 0) return result;
    const rows = await db
      .select({
        id: documentLinks.id,
        companyId: documentLinks.companyId,
        documentId: documentLinks.documentId,
        targetType: documentLinks.targetType,
        targetId: documentLinks.targetId,
        relationship: documentLinks.relationship,
        issueDocumentId: documentLinks.issueDocumentId,
        issueDocumentKey: issueDocuments.key,
        createdAt: documentLinks.createdAt,
        updatedAt: documentLinks.updatedAt,
      })
      .from(documentLinks)
      .leftJoin(issueDocuments, eq(documentLinks.issueDocumentId, issueDocuments.id))
      .where(and(eq(documentLinks.companyId, companyId), inArray(documentLinks.documentId, documentIds)))
      .orderBy(asc(documentLinks.targetType), asc(documentLinks.createdAt));

    const titles = await targetTitles(companyId, rows);
    for (const row of rows) {
      const target = titles.get(`${row.targetType}:${row.targetId}`) ?? { title: null, identifier: null };
      const backlink: DocumentBacklink = {
        id: row.id,
        companyId: row.companyId,
        documentId: row.documentId,
        targetType: row.targetType,
        targetId: row.targetId,
        relationship: row.relationship,
        issueDocumentId: row.issueDocumentId,
        issueDocumentKey: row.issueDocumentKey ?? null,
        title: target.title,
        identifier: target.identifier,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      result.set(row.documentId, [...(result.get(row.documentId) ?? []), backlink]);
    }
    return result;
  }

  async function assertTargetInCompany(companyId: string, targetType: DocumentLinkTargetType, targetId: string) {
    if (targetType === "issue") {
      const row = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "project") {
      const row = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "goal") {
      const row = await db.select({ id: goals.id }).from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "run") {
      const row = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "work_product") {
      const row = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "approval") {
      const row = await db.select({ id: approvals.id }).from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    if (targetType === "agent") {
      const row = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, targetId))).limit(1);
      if (row.length > 0) return;
    }
    throw notFound("Document link target not found");
  }

  return {
    listCompanyDocuments: async (companyId: string, query: CompanyDocumentListQuery) => {
      const conditions = [eq(documents.companyId, companyId)];
      if (!query.includeArchived) {
        conditions.push(ne(documents.status, "archived"));
      }
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
        conditions.push(or(
          ilike(documents.title, pattern),
          ilike(documents.summary, pattern),
          ilike(documents.latestBody, pattern),
        )!);
      }
      if (query.status?.length) conditions.push(inArray(documents.status, query.status));
      if (query.type?.length) conditions.push(inArray(documents.documentType, query.type));
      if (query.ownerAgentId) conditions.push(eq(documents.ownerAgentId, query.ownerAgentId));
      if (query.ownerUserId) conditions.push(eq(documents.ownerUserId, query.ownerUserId));
      if (query.updatedAfter) conditions.push(gte(documents.updatedAt, query.updatedAfter));
      if (query.updatedBefore) conditions.push(lte(documents.updatedAt, query.updatedBefore));
      if (query.trustedOnly) {
        conditions.push(sql`(${documents.sourceTrust} is null or ${documents.sourceTrust}->>'disposition' <> 'quarantined')`);
      }
      const targetType = query.targetType ?? (query.projectId ? "project" : undefined);
      const targetId = query.targetId ?? query.projectId;
      if (targetType && targetId) {
        conditions.push(sql`exists (
          select 1 from ${documentLinks}
          where ${documentLinks.companyId} = ${documents.companyId}
            and ${documentLinks.documentId} = ${documents.id}
            and ${documentLinks.targetType} = ${targetType}
            and ${documentLinks.targetId} = ${targetId}
        )`);
      }
      if (query.hasOpenFeedback) {
        conditions.push(sql`(exists (
          select 1 from ${documentAnnotationThreads}
          where ${documentAnnotationThreads.companyId} = ${documents.companyId}
            and ${documentAnnotationThreads.documentId} = ${documents.id}
            and ${documentAnnotationThreads.status} = 'open'
        ) or exists (
          select 1 from ${documentReviewThreads}
          where ${documentReviewThreads.companyId} = ${documents.companyId}
            and ${documentReviewThreads.documentId} = ${documents.id}
            and ${documentReviewThreads.status} = 'open'
        ) or exists (
          select 1 from ${documentSuggestions}
          where ${documentSuggestions.companyId} = ${documents.companyId}
            and ${documentSuggestions.documentId} = ${documents.id}
            and ${documentSuggestions.status} = 'pending'
        ))`);
      }

      const rows = await db
        .select(documentSelect)
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(query.limit)
        .offset(query.offset);
      const documentIds = rows.map((row) => row.id);
      const [backlinks, counts] = await Promise.all([
        backlinksForDocuments(companyId, documentIds),
        feedbackCountsForDocuments(companyId, documentIds),
      ]);
      return rows.map((row) => mapDocumentRow(
        row,
        false,
        backlinks.get(row.id) ?? [],
        counts.get(row.id) ?? emptyFeedbackCounts(),
      ));
    },

    getCompanyDocumentById: async (companyId: string, documentId: string) => {
      const row = await db
        .select(documentSelect)
        .from(documents)
        .where(and(eq(documents.companyId, companyId), eq(documents.id, documentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [backlinks, counts] = await Promise.all([
        backlinksForDocuments(companyId, [documentId]),
        feedbackCountsForDocuments(companyId, [documentId]),
      ]);
      return mapDocumentRow(
        row,
        true,
        backlinks.get(row.id) ?? [],
        counts.get(row.id) ?? emptyFeedbackCounts(),
      );
    },

    listDocumentBacklinks: async (companyId: string, documentId: string) => {
      const row = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.companyId, companyId), eq(documents.id, documentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Document not found");
      return backlinksForDocuments(companyId, [documentId]).then((map) => map.get(documentId) ?? []);
    },

    updateDocumentMetadata: async (input: {
      companyId: string;
      documentId: string;
      title?: string | null;
      status?: DocumentStatus;
      documentType?: DocumentType;
      summary?: string | null;
      ownerAgentId?: string | null;
      ownerUserId?: string | null;
      updatedByAgentId?: string | null;
      updatedByUserId?: string | null;
    }) => {
      if (input.ownerAgentId) {
        const owner = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.ownerAgentId)))
          .then((rows) => rows[0] ?? null);
        if (!owner) throw notFound("Document owner agent not found");
      }
      const existing = await db
        .select(documentSelect)
        .from(documents)
        .where(and(eq(documents.companyId, input.companyId), eq(documents.id, input.documentId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Document not found");
      const now = new Date();
      const patch: Partial<typeof documents.$inferInsert> = {
        updatedByAgentId: input.updatedByAgentId ?? null,
        updatedByUserId: input.updatedByUserId ?? null,
        updatedAt: now,
      };
      if ("title" in input) patch.title = input.title ?? null;
      if ("status" in input && input.status) {
        patch.status = input.status;
        if (input.status === "archived" && existing.status !== "archived") {
          patch.archivedAt = now;
          patch.archivedByAgentId = input.updatedByAgentId ?? null;
          patch.archivedByUserId = input.updatedByUserId ?? null;
        } else if (input.status !== "archived") {
          patch.archivedAt = null;
          patch.archivedByAgentId = null;
          patch.archivedByUserId = null;
        }
      }
      if ("documentType" in input && input.documentType) patch.documentType = input.documentType;
      if ("summary" in input) patch.summary = input.summary ?? null;
      if ("ownerAgentId" in input) patch.ownerAgentId = input.ownerAgentId ?? null;
      if ("ownerUserId" in input) patch.ownerUserId = input.ownerUserId ?? null;

      const [updated] = await db
        .update(documents)
        .set(patch)
        .where(and(eq(documents.companyId, input.companyId), eq(documents.id, input.documentId)))
        .returning();
      return mapDocumentRow(updated, true);
    },

    createDocumentLink: async (input: {
      companyId: string;
      documentId: string;
      targetType: DocumentLinkTargetType;
      targetId: string;
      relationship?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const document = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.companyId, input.companyId), eq(documents.id, input.documentId)))
        .then((rows) => rows[0] ?? null);
      if (!document) throw notFound("Document not found");
      await assertTargetInCompany(input.companyId, input.targetType, input.targetId);

      const now = new Date();
      const [link] = await db
        .insert(documentLinks)
        .values({
          companyId: input.companyId,
          documentId: input.documentId,
          targetType: input.targetType,
          targetId: input.targetId,
          relationship: normalizeRelationship(input.relationship),
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            documentLinks.companyId,
            documentLinks.documentId,
            documentLinks.targetType,
            documentLinks.targetId,
          ],
          set: {
            relationship: normalizeRelationship(input.relationship),
            updatedAt: now,
          },
        })
        .returning();
      await db.update(documents).set({ updatedAt: now }).where(eq(documents.id, input.documentId));
      return (await backlinksForDocuments(input.companyId, [input.documentId])).get(input.documentId)
        ?.find((backlink) => backlink.id === link.id) ?? null;
    },

    deleteDocumentLink: async (companyId: string, documentId: string, linkId: string) => {
      const existing = await db
        .select()
        .from(documentLinks)
        .where(and(
          eq(documentLinks.companyId, companyId),
          eq(documentLinks.documentId, documentId),
          eq(documentLinks.id, linkId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.issueDocumentId) {
        throw conflict("Issue document links must be removed through the issue document route", {
          issueDocumentId: existing.issueDocumentId,
        });
      }
      await db.delete(documentLinks).where(eq(documentLinks.id, existing.id));
      await db.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, documentId));
      return existing;
    },

    getIssueDocumentPayload: async (
      issue: { id: string; description: string | null },
      options: { includeSystem?: boolean } = {},
    ) => {
      const [planDocument, documentSummaries] = await Promise.all([
        db
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, "plan")))
          .then((rows) => rows[0] ?? null),
        db
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(eq(issueDocuments.issueId, issue.id))
          .orderBy(asc(issueDocuments.key), desc(documents.updatedAt)),
      ]);

      const legacyPlanBody = planDocument ? null : extractLegacyPlanBody(issue.description);

      return {
        planDocument: planDocument ? mapIssueDocumentRow(planDocument, true) : null,
        documentSummaries: filterSystemDocuments(documentSummaries, options.includeSystem ?? false)
          .map((row) => mapIssueDocumentRow(row, false)),
        legacyPlanDocument: legacyPlanBody
          ? {
              key: "plan" as const,
              body: legacyPlanBody,
              source: "issue_description" as const,
            }
          : null,
      };
    },

    listIssueDocuments: async (issueId: string, options: { includeSystem?: boolean } = {}) => {
      const rows = await db
        .select(issueDocumentSelect)
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(eq(issueDocuments.issueId, issueId))
        .orderBy(asc(issueDocuments.key), desc(documents.updatedAt));
      return filterSystemDocuments(rows, options.includeSystem ?? false).map((row) => mapIssueDocumentRow(row, true));
    },

    getIssueDocumentByKey: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      const row = await db
        .select(issueDocumentSelect)
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      return row ? mapIssueDocumentRow(row, true) : null;
    },

    listIssueDocumentRevisions: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db
        .select({
          id: documentRevisions.id,
          companyId: documentRevisions.companyId,
          documentId: documentRevisions.documentId,
          issueId: issueDocuments.issueId,
          key: issueDocuments.key,
          revisionNumber: documentRevisions.revisionNumber,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
        .orderBy(desc(documentRevisions.revisionNumber));
    },

    upsertIssueDocument: async (input: {
      issueId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdByRunId?: string | null;
      sourceTrust?: typeof documents.$inferInsert.sourceTrust;
      lockedDocumentStrategy?: "conflict" | "create_new_document";
    }) => {
      const key = normalizeDocumentKey(input.key);
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      // document_revisions.created_by_run_id is FK-constrained to heartbeat_runs. An agent
      // presents its live run-id, which may not exist in this server's DB (e.g. a worktree
      // dev environment whose DB never recorded the run). Persisting a missing run-id would
      // raise a FK violation and surface as a 500, so resolve provenance to null when the
      // run is unknown. In real deployments the run exists and the value is unchanged.
      const createdByRunId = await persistableDocumentRunId(db, input.createdByRunId ?? null);

      const maxAttempts = input.lockedDocumentStrategy === "create_new_document" ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
          const now = new Date();
          const existing = await tx
            .select({
              id: documents.id,
              companyId: documents.companyId,
              issueId: issueDocuments.issueId,
              key: issueDocuments.key,
              title: documents.title,
              format: documents.format,
              latestBody: documents.latestBody,
              latestRevisionId: documents.latestRevisionId,
              latestRevisionNumber: documents.latestRevisionNumber,
              createdByAgentId: documents.createdByAgentId,
              createdByUserId: documents.createdByUserId,
              updatedByAgentId: documents.updatedByAgentId,
              updatedByUserId: documents.updatedByUserId,
              lockedAt: documents.lockedAt,
              lockedByAgentId: documents.lockedByAgentId,
              lockedByUserId: documents.lockedByUserId,
              sourceTrust: documents.sourceTrust,
              createdAt: documents.createdAt,
              updatedAt: documents.updatedAt,
            })
            .from(issueDocuments)
            .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
            .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, key)))
            .then((rows) => rows[0] ?? null);

          if (existing) {
            if (existing.lockedAt) {
              if (input.lockedDocumentStrategy === "create_new_document") {
                const issueDocumentKeys = await tx
                  .select({ key: issueDocuments.key })
                  .from(issueDocuments)
                  .where(eq(issueDocuments.issueId, issue.id));
                const fallbackKey = nextAvailableDocumentKey(key, issueDocumentKeys.map((row) => row.key));

                const [document] = await tx
                  .insert(documents)
                  .values({
                    companyId: issue.companyId,
                    title: input.title ?? null,
                    format: input.format,
                    documentType: documentTypeForIssueDocumentKey(fallbackKey),
                    latestBody: input.body,
                    latestRevisionId: null,
                    latestRevisionNumber: 1,
                    createdByAgentId: input.createdByAgentId ?? null,
                    createdByUserId: input.createdByUserId ?? null,
                    updatedByAgentId: input.createdByAgentId ?? null,
                    updatedByUserId: input.createdByUserId ?? null,
                    lockedAt: null,
                    lockedByAgentId: null,
                    lockedByUserId: null,
                    sourceTrust: input.sourceTrust ?? null,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .returning();

                const [revision] = await tx
                  .insert(documentRevisions)
                  .values({
                    companyId: issue.companyId,
                    documentId: document.id,
                    revisionNumber: 1,
                    title: input.title ?? null,
                    format: input.format,
                    body: input.body,
                    changeSummary: input.changeSummary ?? null,
                    createdByAgentId: input.createdByAgentId ?? null,
                    createdByUserId: input.createdByUserId ?? null,
                    createdByRunId,
                    createdAt: now,
                  })
                  .returning();

                await tx
                  .update(documents)
                  .set({ latestRevisionId: revision.id })
                  .where(eq(documents.id, document.id));

                const [issueDocument] = await tx.insert(issueDocuments).values({
                  companyId: issue.companyId,
                  issueId: issue.id,
                  documentId: document.id,
                  key: fallbackKey,
                  createdAt: now,
                  updatedAt: now,
                }).returning({ id: issueDocuments.id });

                await tx.insert(documentLinks).values({
                  companyId: issue.companyId,
                  documentId: document.id,
                  targetType: "issue",
                  targetId: issue.id,
                  relationship: "issue_document",
                  issueDocumentId: issueDocument.id,
                  createdByAgentId: input.createdByAgentId ?? null,
                  createdByUserId: input.createdByUserId ?? null,
                  createdAt: now,
                  updatedAt: now,
                }).onConflictDoNothing();

                return {
                  created: true as const,
                  redirectedFromLockedDocument: {
                    id: existing.id,
                    key: existing.key,
                  },
                  document: {
                    id: document.id,
                    companyId: issue.companyId,
                    issueId: issue.id,
                    key: fallbackKey,
                    title: document.title,
                    format: document.format,
                    status: document.status,
                    documentType: document.documentType,
                    summary: document.summary,
                    ownerAgentId: document.ownerAgentId,
                    ownerUserId: document.ownerUserId,
                    body: document.latestBody,
                    latestRevisionId: revision.id,
                    latestRevisionNumber: 1,
                    createdByAgentId: document.createdByAgentId,
                    createdByUserId: document.createdByUserId,
                    updatedByAgentId: document.updatedByAgentId,
                    updatedByUserId: document.updatedByUserId,
                    lockedAt: null,
                    lockedByAgentId: null,
                    lockedByUserId: null,
                    sourceTrust: document.sourceTrust ?? null,
                    archivedAt: document.archivedAt,
                    archivedByAgentId: document.archivedByAgentId,
                    archivedByUserId: document.archivedByUserId,
                    createdAt: document.createdAt,
                    updatedAt: document.updatedAt,
                  },
                };
              }

              throw conflict("Document is locked", {
                key: existing.key,
                documentId: existing.id,
                lockedAt: existing.lockedAt,
              });
            }

            if (!input.baseRevisionId) {
              throw conflict("Document update requires baseRevisionId", {
                currentRevisionId: existing.latestRevisionId,
              });
            }
            if (input.baseRevisionId !== existing.latestRevisionId) {
              throw conflict("Document was updated by someone else", {
                currentRevisionId: existing.latestRevisionId,
              });
            }

            const nextRevisionNumber = existing.latestRevisionNumber + 1;
            const [revision] = await tx
              .insert(documentRevisions)
              .values({
                companyId: issue.companyId,
                documentId: existing.id,
                revisionNumber: nextRevisionNumber,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                changeSummary: input.changeSummary ?? null,
                createdByAgentId: input.createdByAgentId ?? null,
                createdByUserId: input.createdByUserId ?? null,
                createdByRunId,
                createdAt: now,
              })
              .returning();

            await tx
              .update(documents)
              .set({
                title: input.title ?? null,
                format: input.format,
                latestBody: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              })
              .where(eq(documents.id, existing.id));

            await tx
              .update(issueDocuments)
              .set({ updatedAt: now })
              .where(eq(issueDocuments.documentId, existing.id));

            return {
              created: false as const,
              document: {
                ...existing,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                lockedAt: existing.lockedAt,
                lockedByAgentId: existing.lockedByAgentId,
                lockedByUserId: existing.lockedByUserId,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              },
            };
          }

          if (input.baseRevisionId) {
            throw conflict("Document does not exist yet", { key });
          }

          const [document] = await tx
            .insert(documents)
            .values({
              companyId: issue.companyId,
              title: input.title ?? null,
              format: input.format,
              documentType: documentTypeForIssueDocumentKey(key),
              latestBody: input.body,
              latestRevisionId: null,
              latestRevisionNumber: 1,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              lockedAt: null,
              lockedByAgentId: null,
              lockedByUserId: null,
              sourceTrust: input.sourceTrust ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          const [revision] = await tx
            .insert(documentRevisions)
            .values({
              companyId: issue.companyId,
              documentId: document.id,
              revisionNumber: 1,
              title: input.title ?? null,
              format: input.format,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdByRunId,
              createdAt: now,
            })
            .returning();

          await tx
            .update(documents)
            .set({ latestRevisionId: revision.id })
            .where(eq(documents.id, document.id));

          const [issueDocument] = await tx.insert(issueDocuments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            documentId: document.id,
            key,
            createdAt: now,
            updatedAt: now,
          }).returning({ id: issueDocuments.id });

          await tx.insert(documentLinks).values({
            companyId: issue.companyId,
            documentId: document.id,
            targetType: "issue",
            targetId: issue.id,
            relationship: "issue_document",
            issueDocumentId: issueDocument.id,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing();

          return {
            created: true as const,
            document: {
              id: document.id,
              companyId: issue.companyId,
              issueId: issue.id,
              key,
              title: document.title,
              format: document.format,
              status: document.status,
              documentType: document.documentType,
              summary: document.summary,
              ownerAgentId: document.ownerAgentId,
              ownerUserId: document.ownerUserId,
              body: document.latestBody,
              latestRevisionId: revision.id,
              latestRevisionNumber: 1,
              createdByAgentId: document.createdByAgentId,
              createdByUserId: document.createdByUserId,
              updatedByAgentId: document.updatedByAgentId,
              updatedByUserId: document.updatedByUserId,
              lockedAt: document.lockedAt,
              lockedByAgentId: document.lockedByAgentId,
              lockedByUserId: document.lockedByUserId,
              sourceTrust: document.sourceTrust ?? null,
              archivedAt: document.archivedAt,
              archivedByAgentId: document.archivedByAgentId,
              archivedByUserId: document.archivedByUserId,
              createdAt: document.createdAt,
              updatedAt: document.updatedAt,
            },
          };
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            if (input.lockedDocumentStrategy === "create_new_document" && attempt < maxAttempts - 1) {
              continue;
            }
            throw conflict("Document key already exists on this issue", { key });
          }
          throw error;
        }
      }

      throw conflict("Unable to choose a new document key for locked document", { key });
    },

    restoreIssueDocumentRevision: async (input: {
      issueId: string;
      key: string;
      revisionId: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const key = normalizeDocumentKey(input.key);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        const revision = await tx
          .select({
            id: documentRevisions.id,
            companyId: documentRevisions.companyId,
            documentId: documentRevisions.documentId,
            revisionNumber: documentRevisions.revisionNumber,
            title: documentRevisions.title,
            format: documentRevisions.format,
            body: documentRevisions.body,
          })
          .from(documentRevisions)
          .where(and(eq(documentRevisions.id, input.revisionId), eq(documentRevisions.documentId, existing.id)))
          .then((rows) => rows[0] ?? null);

        if (!revision) throw notFound("Document revision not found");
        if (existing.latestRevisionId === revision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: existing.latestRevisionId,
          });
        }

        const now = new Date();
        const nextRevisionNumber = existing.latestRevisionNumber + 1;
        const [restoredRevision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: existing.companyId,
            documentId: existing.id,
            revisionNumber: nextRevisionNumber,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            changeSummary: `Restored from revision ${revision.revisionNumber}`,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            title: revision.title ?? null,
            format: revision.format,
            latestBody: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          restoredFromRevisionId: revision.id,
          restoredFromRevisionNumber: revision.revisionNumber,
          document: {
            ...existing,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    lockIssueDocument: async (input: {
      issueId: string;
      key: string;
      lockedByAgentId?: string | null;
      lockedByUserId?: string | null;
    }) => {
      const key = normalizeDocumentKey(input.key);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (existing.lockedAt) {
          return {
            changed: false as const,
            document: mapIssueDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapIssueDocumentRow(existing, true),
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    unlockIssueDocument: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (!existing.lockedAt) {
          return {
            changed: false as const,
            document: mapIssueDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapIssueDocumentRow(existing, true),
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          },
        };
      });
    },

    deleteIssueDocument: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) return null;
        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        await tx.delete(issueDocuments).where(eq(issueDocuments.documentId, existing.id));
        await tx.delete(documents).where(eq(documents.id, existing.id));

        return {
          ...existing,
          body: existing.latestBody,
          latestRevisionId: existing.latestRevisionId ?? null,
        };
      });
    },
  };
}
