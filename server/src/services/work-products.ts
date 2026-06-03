import { Readable } from "node:stream";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  issueDocuments,
  issueWorkProducts,
  workflowDeliverables,
  workflows,
} from "@paperclipai/db";
import {
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  type DeliverableDetail,
  type DeliverableIssueRef,
  type DeliverableListItem,
  type DeliverablePreview,
  type DeliverableAudience,
  type IssueWorkProduct,
  parseIssueArtifactWorkProductMetadata,
  deriveAgentUrlKey,
} from "@paperclipai/shared";
import { buildDocumentFilename } from "../lib/document-filenames.js";
import { getStorageService } from "../storage/index.js";

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
    audience: (row.audience as DeliverableAudience | null) ?? "human",
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
  async function listIssueDeliverablesForCompany(
    companyId: string,
    opts: ListDeliverablesOptions = {},
    limitOverride?: number,
    offsetOverride?: number,
  ): Promise<DeliverableListItem[]> {
    const limit = clampDeliverableLimit(limitOverride ?? opts.limit);
    const offset = Math.max(0, Math.floor(offsetOverride ?? opts.offset ?? 0));

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
    if (opts.audience) {
      artifactFilters.push(sql`wp.audience = ${opts.audience}`);
      documentFilters.push(sql`idoc.audience = ${opts.audience}`);
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
          wp.audience,
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
          idoc.audience,
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
  }

  async function listWorkflowDeliverablesForCompany(
    companyId: string,
    opts: ListDeliverablesOptions = {},
    limitOverride?: number,
    offsetOverride?: number,
  ): Promise<DeliverableListItem[]> {
    if (opts.projectId || opts.agentId) {
      return [];
    }

    const limit = clampDeliverableLimit(limitOverride ?? opts.limit);
    const offset = Math.max(0, Math.floor(offsetOverride ?? opts.offset ?? 0));

    const extraFilters: SQL[] = [];
    if (opts.audience) {
      extraFilters.push(sql`wd.audience = ${opts.audience}`);
    }
    if (opts.q && opts.q.trim().length > 0) {
      const escaped = escapeLikePattern(opts.q.trim());
      const like = `%${escaped}%`;
      extraFilters.push(sql`(
        wd.title ILIKE ${like} ESCAPE '\\'
        OR COALESCE(wd.summary, '') ILIKE ${like} ESCAPE '\\'
        OR w.title ILIKE ${like} ESCAPE '\\'
      )`);
    }

    const whereClause = extraFilters.length > 0
      ? sql` AND ${sql.join(extraFilters, sql` AND `)}`
      : sql``;

    type WorkflowDeliverableRawRow = {
      id: string;
      company_id: string;
      workflow_id: string;
      workflow_run_id: string;
      title: string;
      summary: string | null;
      audience: string;
      content_type: string;
      content_path: string | null;
      content_body: string | null;
      byte_size: number;
      original_filename: string | null;
      created_at: Date | string;
      updated_at: Date | string;
      workflow_title: string;
    };

    const rows = await db.execute<WorkflowDeliverableRawRow>(sql`
      SELECT
        wd.id,
        wd.company_id,
        wd.workflow_id,
        wd.workflow_run_id,
        wd.title,
        wd.summary,
        wd.audience,
        wd.content_type,
        wd.content_path,
        wd.content_body,
        wd.byte_size,
        wd.original_filename,
        wd.created_at,
        wd.updated_at,
        w.title AS workflow_title
      FROM workflow_deliverables wd
      INNER JOIN workflows w ON w.id = wd.workflow_id
      WHERE wd.company_id = ${companyId}${whereClause}
      ORDER BY wd.created_at DESC, wd.id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    return toRowArray<WorkflowDeliverableRawRow>(rows)
      .filter((row) => row.workflow_id != null)
      .map((row) =>
      workflowRowToDeliverableListItem({
        id: row.id,
        companyId: row.company_id,
        workflowId: row.workflow_id,
        workflowRunId: row.workflow_run_id,
        title: row.title,
        summary: row.summary,
        audience: row.audience,
        contentType: row.content_type,
        contentPath: row.content_path,
        contentBody: row.content_body,
        byteSize: Number(row.byte_size),
        originalFilename: row.original_filename,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
        workflowTitle: row.workflow_title,
      }),
    );
  }

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
              audience: data.audience ?? "human",
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
      const scanLimit = limit + offset;
      const [issueItems, workflowItems] = await Promise.all([
        listIssueDeliverablesForCompany(companyId, opts, scanLimit, 0),
        listWorkflowDeliverablesForCompany(companyId, opts, scanLimit, 0),
      ]);
      return [...issueItems, ...workflowItems]
        .sort((a, b) => {
          const byCreatedAt = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          return byCreatedAt !== 0 ? byCreatedAt : b.id.localeCompare(a.id);
        })
        .slice(offset, offset + limit);
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
            wp.audience,
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
            idoc.audience,
            NULL::jsonb AS metadata,
            dr.created_by_run_id,
            NULL::uuid AS execution_workspace_id,
            NULL::uuid AS runtime_service_id,
            d.created_at,
            d.updated_at,
            idoc.key AS document_key,
            d.format AS document_format,
            d.latest_body AS document_body,
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
      if (!base || !base.childIssue) return null;

      const ancestors = await loadAncestorChain(db, base.childIssue.id);
      const preview = row.deliverable_source === "document"
        ? buildPreviewFromBody(base.contentType, row.document_body ?? "", base.byteSize)
        : await loadArtifactPreview(db, row);
      return { ...base, ancestors, preview };
    },

    getWorkflowDeliverableById: async (id: string): Promise<DeliverableDetail | null> => {
      const row = await db
        .select({
          id: workflowDeliverables.id,
          companyId: workflowDeliverables.companyId,
          workflowId: workflowDeliverables.workflowId,
          workflowRunId: workflowDeliverables.workflowRunId,
          title: workflowDeliverables.title,
          summary: workflowDeliverables.summary,
          audience: workflowDeliverables.audience,
          contentType: workflowDeliverables.contentType,
          contentPath: workflowDeliverables.contentPath,
          contentBody: workflowDeliverables.contentBody,
          byteSize: workflowDeliverables.byteSize,
          originalFilename: workflowDeliverables.originalFilename,
          createdAt: workflowDeliverables.createdAt,
          updatedAt: workflowDeliverables.updatedAt,
          workflowTitle: workflows.title,
        })
        .from(workflowDeliverables)
        .innerJoin(workflows, eq(workflows.id, workflowDeliverables.workflowId))
        .where(eq(workflowDeliverables.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      const base = workflowRowToDeliverableListItem(row);
      const preview = row.contentBody == null
        ? await loadWorkflowArtifactPreview(row.companyId, row.contentPath, row.contentType, row.byteSize)
        : buildPreviewFromBody(base.contentType, row.contentBody, base.byteSize);
      return { ...base, ancestors: [], preview };
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
      const filename = buildDocumentDeliverableFilename(row.key, row.title, row.format, body);
      return {
        id: row.id,
        companyId: row.company_id,
        filename,
        title: row.title,
        contentType: row.format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
        body,
      };
    },

    getWorkflowDeliverableContentById: async (id: string) => {
      const row = await db
        .select({
          id: workflowDeliverables.id,
          companyId: workflowDeliverables.companyId,
          contentType: workflowDeliverables.contentType,
          contentPath: workflowDeliverables.contentPath,
          contentBody: workflowDeliverables.contentBody,
          originalFilename: workflowDeliverables.originalFilename,
        })
        .from(workflowDeliverables)
        .where(eq(workflowDeliverables.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        contentType: row.contentType,
        filename: row.originalFilename ?? "workflow-output.bin",
        body: row.contentBody,
        objectKey: row.contentPath,
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
  audience?: DeliverableAudience;
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
  audience: string | null;
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

const DELIVERABLE_PREVIEW_MAX_BYTES = 64 * 1024;
const DELIVERABLE_PREVIEW_TYPES = new Set(["text/markdown", "text/plain", "application/json"]);

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

function normalizeContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

function canInlinePreview(contentType: string): boolean {
  return DELIVERABLE_PREVIEW_TYPES.has(normalizeContentType(contentType));
}

function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  let byteLength = 0;
  let truncated = "";
  for (const char of value) {
    const nextByteLength = Buffer.byteLength(char, "utf8");
    if (byteLength + nextByteLength > maxBytes) break;
    truncated += char;
    byteLength += nextByteLength;
  }
  return truncated;
}

function buildPreviewFromBody(contentType: string, body: string, byteSize: number): DeliverablePreview | null {
  if (!canInlinePreview(contentType)) return null;
  const truncated = byteSize > DELIVERABLE_PREVIEW_MAX_BYTES;
  const safeBody = truncated
    ? truncateUtf8ByBytes(body, DELIVERABLE_PREVIEW_MAX_BYTES)
    : body;
  return {
    kind: normalizeContentType(contentType) === "text/markdown" ? "markdown" : "text",
    body: safeBody,
    truncated,
  };
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildDocumentDeliverableFilename(
  key: string | null | undefined,
  title: string | null | undefined,
  format?: string | null | undefined,
  body?: string | null | undefined,
) {
  return buildDocumentFilename(key, title, format, body);
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
    originalFilename = buildDocumentDeliverableFilename(row.document_key, row.title, row.document_format, body);
  }

  const rootIsSelf = row.ri_id === null || row.ri_id === row.ci_id;

  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    sourceKind: "issue",
    title: row.title,
    summary: row.summary,
    audience: (row.audience as DeliverableAudience | null) ?? "human",
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
    workflow: null,
  };
}

function workflowRowToDeliverableListItem(row: {
  id: string;
  companyId: string;
  workflowId: string;
  workflowRunId: string;
  title: string;
  summary: string | null;
  audience: string;
  contentType: string;
  contentPath: string | null;
  contentBody: string | null;
  byteSize: number;
  originalFilename: string | null;
  createdAt: Date;
  updatedAt: Date;
  workflowTitle: string;
}): DeliverableListItem {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: null,
    sourceKind: "workflow",
    title: row.title,
    summary: row.summary,
    audience: (row.audience as DeliverableAudience | null) ?? "human",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    contentPath: `/api/deliverables/${row.id}/content`,
    contentType: row.contentType,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename,
    childIssue: null,
    rootIssue: null,
    agent: null,
    runId: row.workflowRunId,
    workflow: {
      id: row.workflowId,
      title: row.workflowTitle,
      runId: row.workflowRunId,
    },
  };
}

async function loadArtifactPreview(db: Db, row: DeliverableQueryRow): Promise<DeliverablePreview | null> {
  if (row.deliverable_source !== "artifact") return null;
  const metadata = parseIssueArtifactWorkProductMetadata({
    type: row.type as IssueWorkProduct["type"],
    metadata: row.metadata,
  });
  if (!metadata || !canInlinePreview(metadata.contentType) || metadata.byteSize > DELIVERABLE_PREVIEW_MAX_BYTES) {
    return null;
  }

  const attachmentId = metadata.attachmentId;
  const rows = await db.execute<{
    company_id: string;
    object_key: string;
  }>(sql`
    SELECT ia.company_id, a.object_key
    FROM issue_attachments ia
    INNER JOIN assets a ON a.id = ia.asset_id
    WHERE ia.id = ${attachmentId}
    LIMIT 1
  `);
  const attachment = toRowArray<{ company_id: string; object_key: string }>(rows)[0];
  if (!attachment) return null;

  try {
    const object = await getStorageService().getObject(attachment.company_id, attachment.object_key);
    const body = (await readStreamToBuffer(object.stream)).toString("utf8");
    return buildPreviewFromBody(metadata.contentType, body, metadata.byteSize);
  } catch {
    return null;
  }
}

async function loadWorkflowArtifactPreview(
  companyId: string,
  objectKey: string | null,
  contentType: string,
  byteSize: number,
): Promise<DeliverablePreview | null> {
  if (!objectKey || !canInlinePreview(contentType) || byteSize > DELIVERABLE_PREVIEW_MAX_BYTES) {
    return null;
  }

  try {
    const object = await getStorageService().getObject(companyId, objectKey);
    const body = (await readStreamToBuffer(object.stream)).toString("utf8");
    return buildPreviewFromBody(contentType, body, byteSize);
  } catch {
    return null;
  }
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
