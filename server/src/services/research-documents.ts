import { and, desc, eq, like, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, documents, issueDocuments, issues } from "@paperclipai/db";
import type { ResearchDocument, ResearchDocumentDetail } from "@paperclipai/shared";

// Research documents are issue documents written under the `research` key. When
// the base document is locked, upserts fall back to `research-2`, `research-3`,
// … so we match both the exact key and that suffixed family.
export const RESEARCH_DOCUMENT_KEY = "research";

function researchKeyFilter() {
  return or(
    eq(issueDocuments.key, RESEARCH_DOCUMENT_KEY),
    like(issueDocuments.key, `${RESEARCH_DOCUMENT_KEY}-%`),
  );
}

function buildExcerpt(body: string, max = 280): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

const researchSelect = {
  documentId: documents.id,
  issueId: issues.id,
  issueIdentifier: issues.identifier,
  issueTitle: issues.title,
  key: issueDocuments.key,
  title: documents.title,
  format: documents.format,
  latestBody: documents.latestBody,
  latestRevisionNumber: documents.latestRevisionNumber,
  startedByUserId: issues.createdByUserId,
  startedByAgentId: issues.createdByAgentId,
  startedByAgentName: agents.name,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

type ResearchRow = {
  documentId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionNumber: number;
  startedByUserId: string | null;
  startedByAgentId: string | null;
  startedByAgentName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(row: ResearchRow): ResearchDocument;
function mapRow(row: ResearchRow, includeBody: true): ResearchDocumentDetail;
function mapRow(row: ResearchRow, includeBody = false): ResearchDocument | ResearchDocumentDetail {
  const startedByLabel = row.startedByAgentName ?? row.startedByUserId ?? "Unknown";
  const base: ResearchDocument = {
    documentId: row.documentId,
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    key: row.key,
    title: row.title,
    format: row.format,
    excerpt: buildExcerpt(row.latestBody),
    latestRevisionNumber: row.latestRevisionNumber,
    startedByUserId: row.startedByUserId,
    startedByAgentId: row.startedByAgentId,
    startedByAgentName: row.startedByAgentName,
    startedByLabel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return includeBody ? { ...base, body: row.latestBody } : base;
}

export function researchDocumentService(db: Db) {
  const baseQuery = () =>
    db
      .select(researchSelect)
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .leftJoin(agents, eq(issues.createdByAgentId, agents.id));

  return {
    list: async (companyId: string): Promise<ResearchDocument[]> => {
      const rows = await baseQuery()
        .where(and(eq(issueDocuments.companyId, companyId), researchKeyFilter()))
        .orderBy(desc(documents.updatedAt));
      return rows.map((row) => mapRow(row));
    },

    get: async (companyId: string, documentId: string): Promise<ResearchDocumentDetail | null> => {
      const row = await baseQuery()
        .where(
          and(
            eq(issueDocuments.companyId, companyId),
            eq(documents.id, documentId),
            researchKeyFilter(),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? mapRow(row, true) : null;
    },
  };
}
