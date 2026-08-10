import { and, desc, eq, getTableColumns, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issues,
  issueWorkProducts,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  assertIssueCompletionEvidenceProducts,
  loadCompanyScopedIssueCompletionEvidenceProducts,
} from "./issue-completion-evidence.js";
import { insertRowsInChunks } from "./batch-insert.js";
import type { ImportIssueWorkProductRow } from "./import-write-types.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
const issueWorkProductColumns = getTableColumns(issueWorkProducts);

const validWorkProductCompanyScope = and(
  eq(issueWorkProducts.companyId, issues.companyId),
  or(isNull(issueWorkProducts.projectId), eq(projects.companyId, issueWorkProducts.companyId)),
  or(
    isNull(issueWorkProducts.executionWorkspaceId),
    eq(executionWorkspaces.companyId, issueWorkProducts.companyId),
  ),
  or(
    isNull(issueWorkProducts.runtimeServiceId),
    eq(workspaceRuntimeServices.companyId, issueWorkProducts.companyId),
  ),
  or(
    isNull(issueWorkProducts.createdByRunId),
    eq(heartbeatRuns.companyId, issueWorkProducts.companyId),
  ),
);

function executionContractRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function referenceScopeError(field: string, id: string) {
  return unprocessable("Work product references must belong to the issue company", {
    code: "issue_work_product_reference_scope_mismatch",
    field,
    referencedId: id,
  });
}

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
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  async function lockIssueAndValidateReferences(
    tx: any,
    input: {
      companyId: string;
      issueId: string;
      projectId?: string | null;
      executionWorkspaceId?: string | null;
      runtimeServiceId?: string | null;
      createdByRunId?: string | null;
    },
  ) {
    const issue = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update")
      .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
    if (!issue) throw referenceScopeError("issueId", input.issueId);

    const references = [
      input.projectId
        ? tx.select({ companyId: projects.companyId }).from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
          .then((rows: Array<{ companyId: string }>) => rows[0] ?? null)
        : Promise.resolve({ companyId: input.companyId }),
      input.executionWorkspaceId
        ? tx.select({ companyId: executionWorkspaces.companyId }).from(executionWorkspaces)
          .where(and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.companyId),
          ))
          .then((rows: Array<{ companyId: string }>) => rows[0] ?? null)
        : Promise.resolve({ companyId: input.companyId }),
      input.runtimeServiceId
        ? tx.select({ companyId: workspaceRuntimeServices.companyId }).from(workspaceRuntimeServices)
          .where(and(
            eq(workspaceRuntimeServices.id, input.runtimeServiceId),
            eq(workspaceRuntimeServices.companyId, input.companyId),
          ))
          .then((rows: Array<{ companyId: string }>) => rows[0] ?? null)
        : Promise.resolve({ companyId: input.companyId }),
      input.createdByRunId
        ? tx.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, input.createdByRunId),
            eq(heartbeatRuns.companyId, input.companyId),
          ))
          .then((rows: Array<{ companyId: string }>) => rows[0] ?? null)
        : Promise.resolve({ companyId: input.companyId }),
    ] as const;
    const [project, executionWorkspace, runtimeService, createdByRun] = await Promise.all(references);
    if (!project && input.projectId) throw referenceScopeError("projectId", input.projectId);
    if (!executionWorkspace && input.executionWorkspaceId) {
      throw referenceScopeError("executionWorkspaceId", input.executionWorkspaceId);
    }
    if (!runtimeService && input.runtimeServiceId) {
      throw referenceScopeError("runtimeServiceId", input.runtimeServiceId);
    }
    if (!createdByRun && input.createdByRunId) {
      throw referenceScopeError("createdByRunId", input.createdByRunId);
    }
    return issue;
  }

  async function assertDoneIssueEvidence(
    issue: typeof issues.$inferSelect,
    products: IssueWorkProductRow[],
  ) {
    if (issue.status !== "done") return;
    assertIssueCompletionEvidenceProducts(
      executionContractRecord(issue.executionContract),
      products,
      issue.id,
    );
  }

  return {
    listForIssue: async (issueId: string, companyId: string) => {
      const rows = await db
        .select(issueWorkProductColumns)
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
        .leftJoin(projects, eq(issueWorkProducts.projectId, projects.id))
        .leftJoin(
          executionWorkspaces,
          eq(issueWorkProducts.executionWorkspaceId, executionWorkspaces.id),
        )
        .leftJoin(
          workspaceRuntimeServices,
          eq(issueWorkProducts.runtimeServiceId, workspaceRuntimeServices.id),
        )
        .leftJoin(heartbeatRuns, eq(issueWorkProducts.createdByRunId, heartbeatRuns.id))
        .where(and(
          eq(issueWorkProducts.issueId, issueId),
          eq(issueWorkProducts.companyId, companyId),
          eq(issues.companyId, companyId),
          validWorkProductCompanyScope,
        ))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select(issueWorkProductColumns)
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
        .leftJoin(projects, eq(issueWorkProducts.projectId, projects.id))
        .leftJoin(
          executionWorkspaces,
          eq(issueWorkProducts.executionWorkspaceId, executionWorkspaces.id),
        )
        .leftJoin(
          workspaceRuntimeServices,
          eq(issueWorkProducts.runtimeServiceId, workspaceRuntimeServices.id),
        )
        .leftJoin(heartbeatRuns, eq(issueWorkProducts.createdByRunId, heartbeatRuns.id))
        .where(and(eq(issueWorkProducts.id, id), validWorkProductCompanyScope))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        await lockIssueAndValidateReferences(tx, {
          companyId,
          issueId,
          projectId: data.projectId ?? null,
          executionWorkspaceId: data.executionWorkspaceId ?? null,
          runtimeServiceId: data.runtimeServiceId ?? null,
          createdByRunId: data.createdByRunId ?? null,
        });
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
          .select(issueWorkProductColumns)
          .from(issueWorkProducts)
          .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
          .leftJoin(projects, eq(issueWorkProducts.projectId, projects.id))
          .leftJoin(
            executionWorkspaces,
            eq(issueWorkProducts.executionWorkspaceId, executionWorkspaces.id),
          )
          .leftJoin(
            workspaceRuntimeServices,
            eq(issueWorkProducts.runtimeServiceId, workspaceRuntimeServices.id),
          )
          .leftJoin(heartbeatRuns, eq(issueWorkProducts.createdByRunId, heartbeatRuns.id))
          .where(and(eq(issueWorkProducts.id, id), validWorkProductCompanyScope))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (
          (patch.id !== undefined && patch.id !== existing.id) ||
          (patch.companyId !== undefined && patch.companyId !== existing.companyId) ||
          (patch.issueId !== undefined && patch.issueId !== existing.issueId)
        ) {
          throw unprocessable("Work products cannot move between issues or companies", {
            code: "issue_work_product_scope_immutable",
          });
        }
        const candidate = {
          ...existing,
          ...patch,
          companyId: existing.companyId,
          issueId: existing.issueId,
        } as IssueWorkProductRow;
        const issue = await lockIssueAndValidateReferences(tx, {
          companyId: existing.companyId,
          issueId: existing.issueId,
          projectId: candidate.projectId ?? null,
          executionWorkspaceId: candidate.executionWorkspaceId ?? null,
          runtimeServiceId: candidate.runtimeServiceId ?? null,
          createdByRunId: candidate.createdByRunId ?? null,
        });
        if (issue.status === "done") {
          const products = await loadCompanyScopedIssueCompletionEvidenceProducts(tx, {
            companyId: existing.companyId,
            issueId: existing.issueId,
          });
          await assertDoneIssueEvidence(
            issue,
            products.map((product: IssueWorkProductRow) => product.id === id ? candidate : product),
          );
        }

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, candidate.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(
            eq(issueWorkProducts.id, id),
            eq(issueWorkProducts.companyId, existing.companyId),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    /**
     * Batched work-product insert for company import.
     *
     * {@link createForIssue} clears the prior primary of the same type on every
     * call; imported issues are brand new, so the only primaries in play are the
     * imported rows themselves. We reproduce "last primary wins" within each
     * (issue, type) group and insert the whole batch in chunked statements.
     */
    createManyForImport: async (rows: ImportIssueWorkProductRow[]): Promise<void> => {
      if (rows.length === 0) return;
      const lastPrimaryIndexByGroup = new Map<string, number>();
      rows.forEach((row, index) => {
        if (row.isPrimary) lastPrimaryIndexByGroup.set(`${row.issueId}:${row.type}`, index);
      });
      const values = rows.map((row, index) => ({
        companyId: row.companyId,
        issueId: row.issueId,
        projectId: row.projectId ?? null,
        type: row.type,
        provider: row.provider,
        externalId: row.externalId ?? null,
        title: row.title,
        url: row.url ?? null,
        status: row.status,
        reviewState: row.reviewState,
        isPrimary: row.isPrimary
          ? lastPrimaryIndexByGroup.get(`${row.issueId}:${row.type}`) === index
          : false,
        healthStatus: row.healthStatus,
        summary: row.summary ?? null,
        metadata: row.metadata ?? null,
        executionWorkspaceId: row.executionWorkspaceId ?? null,
        runtimeServiceId: row.runtimeServiceId ?? null,
        createdByRunId: row.createdByRunId ?? null,
        sourceTrust: row.sourceTrust ?? null,
      }));
      // Chunked writes are wrapped in a single transaction so a large import
      // that spans multiple insert statements is atomic: if a later chunk
      // fails, the earlier chunks roll back rather than leaving a partial
      // prefix behind (which a retry would then duplicate). Mirrors the
      // per-writer transaction the batched issue/document writers use.
      await db.transaction(async (tx) => {
        await insertRowsInChunks(tx, issueWorkProducts, values);
      });
    },

    remove: async (id: string) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select(issueWorkProductColumns)
          .from(issueWorkProducts)
          .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
          .leftJoin(projects, eq(issueWorkProducts.projectId, projects.id))
          .leftJoin(
            executionWorkspaces,
            eq(issueWorkProducts.executionWorkspaceId, executionWorkspaces.id),
          )
          .leftJoin(
            workspaceRuntimeServices,
            eq(issueWorkProducts.runtimeServiceId, workspaceRuntimeServices.id),
          )
          .leftJoin(heartbeatRuns, eq(issueWorkProducts.createdByRunId, heartbeatRuns.id))
          .where(and(eq(issueWorkProducts.id, id), validWorkProductCompanyScope))
          .then((rows: IssueWorkProductRow[]) => rows[0] ?? null);
        if (!existing) return null;
        const issue = await lockIssueAndValidateReferences(tx, {
          companyId: existing.companyId,
          issueId: existing.issueId,
          projectId: existing.projectId ?? null,
          executionWorkspaceId: existing.executionWorkspaceId ?? null,
          runtimeServiceId: existing.runtimeServiceId ?? null,
          createdByRunId: existing.createdByRunId ?? null,
        });
        if (issue.status === "done") {
          const remainingProducts = (
            await loadCompanyScopedIssueCompletionEvidenceProducts(tx, {
              companyId: existing.companyId,
              issueId: existing.issueId,
            })
          ).filter((product) => product.id !== id);
          await assertDoneIssueEvidence(issue, remainingProducts);
        }
        return await tx
          .delete(issueWorkProducts)
          .where(and(
            eq(issueWorkProducts.id, id),
            eq(issueWorkProducts.companyId, existing.companyId),
          ))
          .returning()
          .then((rows: IssueWorkProductRow[]) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
