import { buffer } from "node:stream/consumers";
import { and, desc, eq, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companies,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  attachmentArtifactWorkProductMetadataSchema,
  COMPANY_ARTIFACTS_MAX_LIMIT,
  companyArtifactsQuerySchema,
  SYSTEM_ISSUE_DOCUMENT_KEYS,
  type CompanyArtifact,
  type CompanyArtifactMediaKind,
  type CompanyArtifactsQuery,
  type CompanyArtifactsResponse,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import type { StorageService } from "../storage/types.js";

const TEXT_PREVIEW_BYTES = 4096;
const PREVIEW_TEXT_MAX_LENGTH = 280;

type ArtifactCursor = {
  updatedAt: string;
  id: string;
};

function encodeCursor(cursor: ArtifactCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): ArtifactCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ArtifactCursor>;
    if (typeof parsed.id !== "string" || typeof parsed.updatedAt !== "string") {
      throw new Error("Invalid cursor");
    }
    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid cursor date");
    }
    return { id: parsed.id, updatedAt: date.toISOString() };
  } catch {
    throw badRequest("Invalid artifacts cursor");
  }
}

function cursorCondition(updatedAt: SQL<Date>, artifactId: SQL<string>, cursor: ArtifactCursor | null) {
  if (!cursor) return undefined;
  return sql`(${updatedAt} < ${cursor.updatedAt}::timestamptz OR (${updatedAt} = ${cursor.updatedAt}::timestamptz AND ${artifactId} < ${cursor.id}))`;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizePreviewText(input: string | null | undefined) {
  if (!input) return null;
  const stripped = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > PREVIEW_TEXT_MAX_LENGTH
    ? `${stripped.slice(0, PREVIEW_TEXT_MAX_LENGTH - 3).trimEnd()}...`
    : stripped;
}

function classifyMediaKind(contentType: string | null | undefined, fallback: CompanyArtifactMediaKind = "file") {
  const normalized = (contentType ?? "").toLowerCase();
  if (!normalized) return fallback;
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/markdown"
  ) {
    return "text";
  }
  return "file";
}

function contentTypeKindCondition(contentTypeExpression: SQL<string>, kind: CompanyArtifactsQuery["kind"]) {
  if (!kind || kind === "all") return undefined;
  if (kind === "image") return sql`${contentTypeExpression} ILIKE 'image/%'`;
  if (kind === "video") return sql`${contentTypeExpression} ILIKE 'video/%'`;
  if (kind === "text") {
    return sql`(${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  if (kind === "file") {
    return sql`NOT (${contentTypeExpression} ILIKE 'image/%' OR ${contentTypeExpression} ILIKE 'video/%' OR ${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  return undefined;
}

function buildIssueHref(companyPrefix: string, identifier: string, anchor: string) {
  return `/${encodeURIComponent(companyPrefix)}/issues/${encodeURIComponent(identifier)}#${anchor}`;
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

async function readTextAttachmentPreview(
  storage: StorageService | undefined,
  input: { companyId: string; objectKey: string; byteSize: number },
) {
  if (!storage || input.byteSize <= 0) return null;
  try {
    const object = await storage.getObject(input.companyId, input.objectKey, {
      range: { start: 0, end: Math.min(input.byteSize, TEXT_PREVIEW_BYTES) - 1 },
    });
    const body = await buffer(object.stream);
    return normalizePreviewText(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function companyArtifactsService(db: Db, storage?: StorageService) {
  return {
    list: async (companyId: string, rawQuery: Partial<CompanyArtifactsQuery> = {}): Promise<CompanyArtifactsResponse> => {
      const query = companyArtifactsQuerySchema.parse(rawQuery);
      const cursor = decodeCursor(query.cursor);
      const company = await db
        .select({ id: companies.id, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const fetchLimit = Math.min(query.limit + 1, COMPANY_ARTIFACTS_MAX_LIMIT + 1);
      const q = query.q ? `%${escapeLikePattern(query.q)}%` : null;
      const artifacts: CompanyArtifact[] = [];
      const workProductAttachmentIds = new Set<string>();

      if (query.kind === "all" || query.kind === "document") {
        const createdAgent = alias(agents, "document_created_agent");
        const updatedAgent = alias(agents, "document_updated_agent");
        const documentArtifactId = sql<string>`concat('document:', ${documents.id})`;
        const documentConditions: SQL[] = [
          eq(documents.companyId, companyId),
          or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
          notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
        ];
        const documentCursor = cursorCondition(sql<Date>`${documents.updatedAt}`, documentArtifactId, cursor);
        if (documentCursor) documentConditions.push(documentCursor);
        if (query.projectId) documentConditions.push(eq(issues.projectId, query.projectId));
        if (q) {
          documentConditions.push(sql`(
            coalesce(${documents.title}, '') ILIKE ${q} ESCAPE '\\'
            OR ${documents.latestBody} ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${issues.title} ILIKE ${q} ESCAPE '\\'
          )`);
        }

        const documentRows = await db
          .select({
            artifactId: documentArtifactId,
            documentId: documents.id,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            key: issueDocuments.key,
            title: documents.title,
            latestBody: documents.latestBody,
            createdByAgentId: sql<string | null>`coalesce(${createdAgent.id}, ${updatedAgent.id})`,
            createdByAgentName: sql<string | null>`coalesce(${createdAgent.name}, ${updatedAgent.name})`,
            updatedAt: documents.updatedAt,
          })
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .leftJoin(createdAgent, eq(documents.createdByAgentId, createdAgent.id))
          .leftJoin(updatedAgent, eq(documents.updatedByAgentId, updatedAgent.id))
          .where(and(...documentConditions))
          .orderBy(desc(documents.updatedAt), desc(documentArtifactId))
          .limit(fetchLimit);

        for (const row of documentRows) {
          const identifier = row.issueIdentifier ?? row.issueId;
          artifacts.push({
            id: row.artifactId,
            source: "document",
            mediaKind: "document",
            title: row.title ?? row.key,
            previewText: normalizePreviewText(row.latestBody),
            contentType: "text/markdown",
            contentPath: null,
            openPath: null,
            downloadPath: null,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `document-${row.key}`),
          });
        }
      }

      if (query.kind !== "document") {
        const workProductAgent = alias(agents, "work_product_agent");
        const workProductArtifactId = sql<string>`concat('work_product:', ${issueWorkProducts.id})`;
        const workProductContentType = sql<string>`coalesce(${issueWorkProducts.metadata}->>'contentType', '')`;
        const workProductBaseConditions: SQL[] = [
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "artifact"),
          eq(issueWorkProducts.provider, "paperclip"),
        ];
        const workProductConditions: SQL[] = [...workProductBaseConditions];
        const workProductCursor = cursorCondition(sql<Date>`${issueWorkProducts.updatedAt}`, workProductArtifactId, cursor);
        const workProductKind = contentTypeKindCondition(workProductContentType, query.kind);
        if (workProductCursor) workProductConditions.push(workProductCursor);
        if (workProductKind) {
          workProductBaseConditions.push(workProductKind);
          workProductConditions.push(workProductKind);
        }
        if (query.projectId) {
          const projectCondition = eq(issues.projectId, query.projectId);
          workProductBaseConditions.push(projectCondition);
          workProductConditions.push(projectCondition);
        }
        if (q) {
          const searchCondition = sql`(
            ${issueWorkProducts.title} ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issueWorkProducts.summary}, '') ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${issues.title} ILIKE ${q} ESCAPE '\\'
          )`;
          workProductBaseConditions.push(searchCondition);
          workProductConditions.push(searchCondition);
        }

        const workProductRows = await db
          .select({
            artifactId: workProductArtifactId,
            workProductId: issueWorkProducts.id,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            title: issueWorkProducts.title,
            summary: issueWorkProducts.summary,
            metadata: issueWorkProducts.metadata,
            createdByAgentId: workProductAgent.id,
            createdByAgentName: workProductAgent.name,
            updatedAt: issueWorkProducts.updatedAt,
          })
          .from(issueWorkProducts)
          .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .leftJoin(
            heartbeatRuns,
            and(
              eq(issueWorkProducts.createdByRunId, heartbeatRuns.id),
              eq(heartbeatRuns.companyId, issueWorkProducts.companyId),
            ),
          )
          .leftJoin(
            workProductAgent,
            and(
              eq(heartbeatRuns.agentId, workProductAgent.id),
              eq(workProductAgent.companyId, issueWorkProducts.companyId),
            ),
          )
          .where(and(...workProductConditions))
          .orderBy(desc(issueWorkProducts.updatedAt), desc(workProductArtifactId))
          .limit(fetchLimit);

        const workProductAttachmentRows = await db
          .select({
            attachmentId: sql<string | null>`${issueWorkProducts.metadata}->>'attachmentId'`,
          })
          .from(issueWorkProducts)
          .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
          .where(and(...workProductBaseConditions, sql`${issueWorkProducts.metadata}->>'attachmentId' IS NOT NULL`));

        for (const row of workProductAttachmentRows) {
          if (row.attachmentId) {
            workProductAttachmentIds.add(row.attachmentId);
          }
        }

        for (const row of workProductRows) {
          const metadata = attachmentArtifactWorkProductMetadataSchema.safeParse(row.metadata);
          const attachmentMetadata = metadata.success ? metadata.data : null;
          if (attachmentMetadata) {
            workProductAttachmentIds.add(attachmentMetadata.attachmentId);
          }
          const contentType = attachmentMetadata?.contentType ?? null;
          const identifier = row.issueIdentifier ?? row.issueId;
          artifacts.push({
            id: row.artifactId,
            source: "work_product",
            mediaKind: classifyMediaKind(contentType, attachmentMetadata ? "file" : "empty"),
            title: row.title,
            previewText: normalizePreviewText(row.summary),
            contentType,
            contentPath: attachmentMetadata?.contentPath ?? null,
            openPath: attachmentMetadata?.openPath ?? (typeof row.metadata?.openPath === "string" ? row.metadata.openPath : null),
            downloadPath: attachmentMetadata?.downloadPath ?? null,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `work-product-${row.workProductId}`),
          });
        }

        const attachmentAgent = alias(agents, "attachment_agent");
        const attachmentArtifactId = sql<string>`concat('attachment:', ${issueAttachments.id})`;
        const attachmentConditions: SQL[] = [
          eq(issueAttachments.companyId, companyId),
          isNull(issueAttachments.issueCommentId),
          isNotNull(assets.createdByAgentId),
        ];
        const attachmentCursor = cursorCondition(sql<Date>`${issueAttachments.updatedAt}`, attachmentArtifactId, cursor);
        const attachmentKind = contentTypeKindCondition(sql<string>`${assets.contentType}`, query.kind);
        if (attachmentCursor) attachmentConditions.push(attachmentCursor);
        if (attachmentKind) attachmentConditions.push(attachmentKind);
        if (query.projectId) attachmentConditions.push(eq(issues.projectId, query.projectId));
        if (q) {
          attachmentConditions.push(sql`(
            coalesce(${assets.originalFilename}, '') ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${issues.title} ILIKE ${q} ESCAPE '\\'
          )`);
        }

        const attachmentRows = await db
          .select({
            artifactId: attachmentArtifactId,
            attachmentId: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            originalFilename: assets.originalFilename,
            createdByAgentId: attachmentAgent.id,
            createdByAgentName: attachmentAgent.name,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .leftJoin(attachmentAgent, eq(assets.createdByAgentId, attachmentAgent.id))
          .where(and(...attachmentConditions))
          .orderBy(desc(issueAttachments.updatedAt), desc(attachmentArtifactId))
          .limit(fetchLimit);

        const attachmentArtifacts = await Promise.all(attachmentRows.map(async (row): Promise<CompanyArtifact | null> => {
          if (workProductAttachmentIds.has(row.attachmentId)) return null;
          const mediaKind = classifyMediaKind(row.contentType);
          const contentPath = attachmentContentPath(row.attachmentId);
          const identifier = row.issueIdentifier ?? row.issueId;
          return {
            id: row.artifactId,
            source: "attachment",
            mediaKind,
            title: row.originalFilename ?? "Attachment",
            previewText: mediaKind === "text"
              ? await readTextAttachmentPreview(storage, {
                companyId: row.companyId,
                objectKey: row.objectKey,
                byteSize: row.byteSize,
              })
              : null,
            contentType: row.contentType,
            contentPath,
            openPath: contentPath,
            downloadPath: `${contentPath}?download=1`,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `attachment-${row.attachmentId}`),
          };
        }));

        artifacts.push(...attachmentArtifacts.filter((artifact): artifact is CompanyArtifact => artifact !== null));
      }

      const sorted = artifacts
        .sort((a, b) => {
          const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
          if (dateDiff !== 0) return dateDiff;
          return b.id.localeCompare(a.id);
        });
      const page = sorted.slice(0, query.limit);
      const nextCursor = sorted.length > query.limit
        ? encodeCursor({ id: page[page.length - 1]?.id ?? "", updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString() })
        : null;

      return { artifacts: page, nextCursor };
    },
  };
}
