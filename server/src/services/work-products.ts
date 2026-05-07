import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, documentRevisions, issueDocuments, issueWorkProducts, issues } from "@paperclipai/db";
import {
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  type DeliverableDetail,
  type DeliverableIssueRef,
  type DeliverableListItem,
  type IssueWorkProduct,
  parseIssueArtifactWorkProductMetadata,
  deriveAgentUrlKey,
} from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    findByExternalIdForIssue: async (issueId: string, companyId: string, externalId: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.externalId, externalId),
          ),
        )
        .orderBy(desc(issueWorkProducts.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    /**
     * Atomically insert-or-update a work product keyed on (issueId, externalId).
     * Uses the unique partial index on those two columns to guarantee no duplicate
     * rows can be created even under concurrent callers.
     *
     * Returns the upserted row.
     */
    upsertByExternalId: async (
      issueId: string,
      companyId: string,
      data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId"> & { externalId: string },
    ) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        const now = new Date();
        return await tx
          .insert(issueWorkProducts)
          .values({ ...data, companyId, issueId })
          .onConflictDoUpdate({
            target: [issueWorkProducts.issueId, issueWorkProducts.externalId],
            targetWhere: sql`external_id IS NOT NULL`,
            set: {
              title: data.title,
              url: data.url,
              status: data.status,
              healthStatus: data.healthStatus ?? "healthy",
              reviewState: data.reviewState ?? "none",
              summary: data.summary ?? null,
              metadata: data.metadata,
              isPrimary: data.isPrimary,
              provider: data.provider,
              createdByRunId: data.createdByRunId ?? null,
              updatedAt: now,
            },
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    listDeliverablesForCompany: async (
      companyId: string,
      opts: ListDeliverablesOptions = {},
    ): Promise<DeliverableListItem[]> => {
      const limit = clampDeliverableLimit(opts.limit);
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));

      const artifactFilters: SQL[] = [];
      const documentFilters: SQL[] = [];
      if (opts.projectId) {
        artifactFilters.push(sql`wp.project_id = ${opts.projectId}`);
        documentFilters.push(sql`ci.project_id = ${opts.projectId}`);
      }
      if (opts.agentId) {
        artifactFilters.push(sql`a.id = ${opts.agentId}`);
        documentFilters.push(sql`da.id = ${opts.agentId}`);
      }
      if (opts.q && opts.q.trim().length > 0) {
        const escaped = escapeLikePattern(opts.q.trim());
        const like = `%${escaped}%`;
        artifactFilters.push(sql`wp.title ILIKE ${like} ESCAPE '\\'`);
        documentFilters.push(sql`COALESCE(d.title, idoc.key) ILIKE ${like} ESCAPE '\\'`);
      }
      const artifactWhere = artifactFilters.length > 0 ? sql` AND ${sql.join(artifactFilters, sql` AND `)}` : sql``;
      const documentWhere = documentFilters.length > 0 ? sql` AND ${sql.join(documentFilters, sql` AND `)}` : sql``;

      const rows = await db.execute<DeliverableQueryRow>(sql`
        WITH RECURSIVE deliverable_seeds AS (
          SELECT wp.issue_id AS issue_id
          FROM issue_work_products wp
          WHERE wp.company_id = ${companyId}
            AND wp.type = 'artifact'
          UNION
          SELECT idoc.issue_id AS issue_id
          FROM issue_documents idoc
          WHERE idoc.company_id = ${companyId}
            AND idoc.key <> ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}
        ),
        issue_chain AS (
          SELECT s.issue_id AS start_id, i.id AS current_id, i.parent_id, 0 AS depth
          FROM deliverable_seeds s
          JOIN issues i ON i.id = s.issue_id
          UNION ALL
          SELECT ic.start_id, p.id, p.parent_id, ic.depth + 1
          FROM issue_chain ic
          JOIN issues p ON p.id = ic.parent_id
          WHERE ic.parent_id IS NOT NULL AND ic.depth < 50
        ),
        roots AS (
          SELECT DISTINCT ON (start_id) start_id, current_id AS root_id
          FROM issue_chain
          WHERE parent_id IS NULL
          ORDER BY start_id, depth DESC
        ),
        all_deliverables AS (
          SELECT
            wp.id,
            'artifact'::text AS deliverable_source,
            wp.company_id,
            wp.project_id,
            wp.issue_id,
            wp.type,
            wp.provider,
            wp.external_id,
            wp.title,
            wp.url,
            wp.status,
            wp.review_state,
            wp.is_primary,
            wp.health_status,
            wp.summary,
            wp.metadata,
            wp.created_by_run_id,
            wp.execution_workspace_id,
            wp.runtime_service_id,
            wp.created_at,
            wp.updated_at,
            NULL::text AS document_key,
            NULL::text AS document_format,
            NULL::text AS document_body,
            NULL::integer AS document_byte_size,
            ci.id AS ci_id,
            ci.identifier AS ci_identifier,
            ci.title AS ci_title,
            ci.status AS ci_status,
            ri.id AS ri_id,
            ri.identifier AS ri_identifier,
            ri.title AS ri_title,
            ri.status AS ri_status,
            a.id AS agent_id,
            a.name AS agent_name,
            a.icon AS agent_icon
          FROM issue_work_products wp
          JOIN issues ci ON ci.id = wp.issue_id
          LEFT JOIN roots r ON r.start_id = wp.issue_id
          LEFT JOIN issues ri ON ri.id = r.root_id
          LEFT JOIN heartbeat_runs hr ON hr.id = wp.created_by_run_id
          LEFT JOIN agents a ON a.id = hr.agent_id
          WHERE wp.company_id = ${companyId}
            AND wp.type = 'artifact'${artifactWhere}

          UNION ALL

          SELECT
            idoc.id,
            'document'::text AS deliverable_source,
            idoc.company_id,
            ci.project_id,
            idoc.issue_id,
            'artifact'::text AS type,
            'paperclip'::text AS provider,
            NULL::text AS external_id,
            COALESCE(d.title, idoc.key) AS title,
            NULL::text AS url,
            'ready_for_review'::text AS status,
            'none'::text AS review_state,
            true AS is_primary,
            'healthy'::text AS health_status,
            NULL::text AS summary,
            NULL::jsonb AS metadata,
            dr.created_by_run_id,
            NULL::uuid AS execution_workspace_id,
            NULL::uuid AS runtime_service_id,
            d.created_at,
            d.updated_at,
            idoc.key AS document_key,
            d.format AS document_format,
            NULL::text AS document_body,
            COALESCE(octet_length(d.latest_body), 0)::integer AS document_byte_size,
            ci.id AS ci_id,
            ci.identifier AS ci_identifier,
            ci.title AS ci_title,
            ci.status AS ci_status,
            ri.id AS ri_id,
            ri.identifier AS ri_identifier,
            ri.title AS ri_title,
            ri.status AS ri_status,
            da.id AS agent_id,
            da.name AS agent_name,
            da.icon AS agent_icon
          FROM issue_documents idoc
          JOIN issues ci ON ci.id = idoc.issue_id
          JOIN documents d ON d.id = idoc.document_id
          LEFT JOIN roots r ON r.start_id = idoc.issue_id
          LEFT JOIN issues ri ON ri.id = r.root_id
          LEFT JOIN document_revisions dr ON dr.id = d.latest_revision_id
          LEFT JOIN agents da ON da.id = COALESCE(d.updated_by_agent_id, d.created_by_agent_id)
          WHERE idoc.company_id = ${companyId}
            AND idoc.key <> ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}${documentWhere}
        )
        SELECT *
        FROM all_deliverables
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const list: DeliverableListItem[] = [];
      for (const row of toRowArray<DeliverableQueryRow>(rows)) {
        const item = rowToDeliverableListItem(row);
        if (item) list.push(item);
      }
      return list;
    },

    getDeliverableById: async (id: string): Promise<DeliverableDetail | null> => {
      const rows = await db.execute<DeliverableQueryRow>(sql`
        WITH RECURSIVE deliverable_seed AS (
          SELECT wp.issue_id AS issue_id
          FROM issue_work_products wp
          WHERE wp.id = ${id} AND wp.type = 'artifact'
          UNION
          SELECT idoc.issue_id AS issue_id
          FROM issue_documents idoc
          WHERE idoc.id = ${id}
            AND idoc.key <> ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}
        ),
        issue_chain AS (
          SELECT s.issue_id AS start_id, i.id AS current_id, i.parent_id, 0 AS depth
          FROM deliverable_seed s
          JOIN issues i ON i.id = s.issue_id
          UNION ALL
          SELECT ic.start_id, p.id, p.parent_id, ic.depth + 1
          FROM issue_chain ic
          JOIN issues p ON p.id = ic.parent_id
          WHERE ic.parent_id IS NOT NULL AND ic.depth < 50
        ),
        roots AS (
          SELECT DISTINCT ON (start_id) start_id, current_id AS root_id
          FROM issue_chain
          WHERE parent_id IS NULL
          ORDER BY start_id, depth DESC
        ),
        deliverable AS (
          SELECT
            wp.id,
            'artifact'::text AS deliverable_source,
            wp.company_id,
            wp.project_id,
            wp.issue_id,
            wp.type,
            wp.provider,
            wp.external_id,
            wp.title,
            wp.url,
            wp.status,
            wp.review_state,
            wp.is_primary,
            wp.health_status,
            wp.summary,
            wp.metadata,
            wp.created_by_run_id,
            wp.execution_workspace_id,
            wp.runtime_service_id,
            wp.created_at,
            wp.updated_at,
            NULL::text AS document_key,
            NULL::text AS document_format,
            NULL::text AS document_body,
            ci.id AS ci_id,
            ci.identifier AS ci_identifier,
            ci.title AS ci_title,
            ci.status AS ci_status,
            ri.id AS ri_id,
            ri.identifier AS ri_identifier,
            ri.title AS ri_title,
            ri.status AS ri_status,
            a.id AS agent_id,
            a.name AS agent_name,
            a.icon AS agent_icon
          FROM issue_work_products wp
          JOIN issues ci ON ci.id = wp.issue_id
          LEFT JOIN roots r ON r.start_id = wp.issue_id
          LEFT JOIN issues ri ON ri.id = r.root_id
          LEFT JOIN heartbeat_runs hr ON hr.id = wp.created_by_run_id
          LEFT JOIN agents a ON a.id = hr.agent_id
          WHERE wp.id = ${id}
            AND wp.type = 'artifact'

          UNION ALL

          SELECT
            idoc.id,
            'document'::text AS deliverable_source,
            idoc.company_id,
            ci.project_id,
            idoc.issue_id,
            'artifact'::text AS type,
            'paperclip'::text AS provider,
            NULL::text AS external_id,
            COALESCE(d.title, idoc.key) AS title,
            NULL::text AS url,
            'ready_for_review'::text AS status,
            'none'::text AS review_state,
            true AS is_primary,
            'healthy'::text AS health_status,
            NULL::text AS summary,
            NULL::jsonb AS metadata,
            dr.created_by_run_id,
            NULL::uuid AS execution_workspace_id,
            NULL::uuid AS runtime_service_id,
            d.created_at,
            d.updated_at,
            idoc.key AS document_key,
            d.format AS document_format,
            d.latest_body AS document_body,
            ci.id AS ci_id,
            ci.identifier AS ci_identifier,
            ci.title AS ci_title,
            ci.status AS ci_status,
            ri.id AS ri_id,
            ri.identifier AS ri_identifier,
            ri.title AS ri_title,
            ri.status AS ri_status,
            da.id AS agent_id,
            da.name AS agent_name,
            da.icon AS agent_icon
          FROM issue_documents idoc
          JOIN issues ci ON ci.id = idoc.issue_id
          JOIN documents d ON d.id = idoc.document_id
          LEFT JOIN roots r ON r.start_id = idoc.issue_id
          LEFT JOIN issues ri ON ri.id = r.root_id
          LEFT JOIN document_revisions dr ON dr.id = d.latest_revision_id
          LEFT JOIN agents da ON da.id = COALESCE(d.updated_by_agent_id, d.created_by_agent_id)
          WHERE idoc.id = ${id}
            AND idoc.key <> ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}
        )
        SELECT *
        FROM deliverable
        LIMIT 1
      `);
      const row = toRowArray<DeliverableQueryRow>(rows)[0];
      if (!row) return null;
      const base = rowToDeliverableListItem(row);
      if (!base) return null;

      const ancestors = await loadAncestorChain(db, base.childIssue.id);
      return { ...base, ancestors };
    },

    getDeliverableDocumentContentById: async (id: string): Promise<DeliverableDocumentContent | null> => {
      const rows = await db.execute<{
        id: string;
        company_id: string;
        key: string;
        format: string;
        body: string;
        title: string | null;
      }>(sql`
        SELECT
          idoc.id,
          idoc.company_id,
          idoc.key,
          d.format,
          d.latest_body AS body,
          d.title
        FROM issue_documents idoc
        JOIN documents d ON d.id = idoc.document_id
        WHERE idoc.id = ${id}
          AND idoc.key <> ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}
        LIMIT 1
      `);
      const row = toRowArray<{
        id: string;
        company_id: string;
        key: string;
        format: string;
        body: string;
        title: string | null;
      }>(rows)[0];
      if (!row) return null;
      const body = row.body ?? "";
      const normalizedKey = row.key.trim().length > 0 ? row.key.trim() : "document";
      const filename = `${normalizedKey}.md`;
      return {
        id: row.id,
        companyId: row.company_id,
        filename,
        title: row.title,
        contentType: row.format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
        body,
      };
    },
  };
}

export const DELIVERABLE_LIST_DEFAULT_LIMIT = 50;
export const DELIVERABLE_LIST_MAX_LIMIT = 200;

export interface ListDeliverablesOptions {
  limit?: number;
  offset?: number;
  projectId?: string;
  agentId?: string;
  q?: string;
}

export function clampDeliverableLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DELIVERABLE_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), DELIVERABLE_LIST_MAX_LIMIT);
}

interface DeliverableQueryRow extends Record<string, unknown> {
  id: string;
  deliverable_source: "artifact" | "document";
  company_id: string;
  project_id: string | null;
  issue_id: string;
  type: string;
  provider: string;
  external_id: string | null;
  title: string;
  url: string | null;
  status: string;
  review_state: string;
  is_primary: boolean;
  health_status: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  created_by_run_id: string | null;
  execution_workspace_id: string | null;
  runtime_service_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  document_key: string | null;
  document_format: string | null;
  document_body: string | null;
  document_byte_size?: number | string | null;
  ci_id: string;
  ci_identifier: string | null;
  ci_title: string;
  ci_status: string;
  ri_id: string | null;
  ri_identifier: string | null;
  ri_title: string | null;
  ri_status: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_icon: string | null;
}

interface DeliverableDocumentContent {
  id: string;
  companyId: string;
  filename: string;
  title: string | null;
  contentType: string;
  body: string;
}

function toRowArray<T>(result: unknown): T[] {
  // drizzle-orm/postgres-js returns the array directly; node-postgres returns { rows }.
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToDeliverableListItem(row: DeliverableQueryRow): DeliverableListItem | null {
  let contentPath: string;
  let contentType: string;
  let byteSize: number;
  let originalFilename: string | null;

  if (row.deliverable_source === "artifact") {
    const metadata = parseIssueArtifactWorkProductMetadata({
      type: row.type as IssueWorkProduct["type"],
      metadata: row.metadata,
    });
    if (!metadata) return null;
    contentPath = metadata.contentPath;
    contentType = metadata.contentType;
    byteSize = metadata.byteSize;
    originalFilename = metadata.originalFilename;
  } else {
    const body = row.document_body ?? "";
    const sqlByteSize =
      typeof row.document_byte_size === "number"
        ? row.document_byte_size
        : typeof row.document_byte_size === "string"
          ? Number.parseInt(row.document_byte_size, 10)
          : Number.NaN;
    contentPath = `/api/deliverables/${row.id}/content`;
    contentType = row.document_format === "markdown"
      ? "text/markdown; charset=utf-8"
      : "text/plain; charset=utf-8";
    byteSize = Number.isFinite(sqlByteSize) ? sqlByteSize : Buffer.byteLength(body, "utf8");
    const key = (row.document_key ?? "document").trim() || "document";
    originalFilename = `${key}.md`;
  }

  const rootIsSelf = row.ri_id === null || row.ri_id === row.ci_id;

  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    title: row.title,
    summary: row.summary,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    contentPath,
    contentType,
    byteSize,
    originalFilename,
    childIssue: {
      id: row.ci_id,
      identifier: row.ci_identifier,
      title: row.ci_title,
      status: row.ci_status,
    },
    rootIssue:
      rootIsSelf || row.ri_id === null || row.ri_title === null || row.ri_status === null
        ? null
        : {
            id: row.ri_id,
            identifier: row.ri_identifier,
            title: row.ri_title,
            status: row.ri_status,
          },
    agent:
      row.agent_id && row.agent_name
        ? { id: row.agent_id, name: row.agent_name, urlKey: deriveAgentUrlKey(row.agent_name, row.agent_id), icon: row.agent_icon }
        : null,
    runId: row.created_by_run_id,
  };
}

async function loadAncestorChain(db: Db, startIssueId: string): Promise<DeliverableIssueRef[]> {
  const rows = await db.execute<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  }>(sql`
    WITH RECURSIVE issue_chain AS (
      SELECT i.id, i.identifier, i.title, i.status, i.parent_id, 0 AS depth
      FROM issues i
      WHERE i.id = ${startIssueId}
      UNION ALL
      SELECT p.id, p.identifier, p.title, p.status, p.parent_id, ic.depth + 1
      FROM issue_chain ic
      JOIN issues p ON p.id = ic.parent_id
      WHERE ic.parent_id IS NOT NULL AND ic.depth < 50
    ),
    dedup AS (
      SELECT DISTINCT ON (id) id, identifier, title, status, depth
      FROM issue_chain
      WHERE depth > 0
      ORDER BY id, depth ASC
    )
    SELECT id, identifier, title, status
    FROM dedup
    ORDER BY depth ASC
  `);

  return toRowArray<{ id: string; identifier: string | null; title: string; status: string }>(rows).map(
    (row) => ({
      id: row.id,
      identifier: row.identifier ?? null,
      title: row.title,
      status: row.status,
    }),
  );
}

export { toIssueWorkProduct, escapeLikePattern };
