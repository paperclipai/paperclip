import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workspaceRuntimeServices } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { insertRowsInChunks } from "./batch-insert.js";
import type { ImportIssueWorkProductRow } from "./import-write-types.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

export interface RuntimeServiceWorkProductState {
  id: string;
  companyId: string;
  executionWorkspaceId: string | null;
  serviceName: string;
  status: string;
  port: number | null;
  url: string | null;
  healthStatus: string;
}

function runtimeServiceWorkProductStatus(status: string): IssueWorkProduct["status"] | null {
  if (status === "running") return "active";
  if (status === "provisioning" || status === "starting") return "draft";
  if (status === "failed") return "failed";
  if (status === "stopped") return "archived";
  return null;
}

function runtimeServiceHealthStatus(status: string): IssueWorkProduct["healthStatus"] {
  return status === "healthy" || status === "unhealthy" ? status : "unknown";
}

/**
 * Runtime-service work products are durable pointers, not snapshots. Resolve
 * their user-facing state from the managed runtime row so a restart that moves
 * or replaces the service cannot leave a dead URL presented as healthy.
 */
export function resolveRuntimeServiceWorkProductState(
  product: IssueWorkProduct,
  runtimeServices: RuntimeServiceWorkProductState[],
): IssueWorkProduct {
  if (product.type !== "runtime_service") return product;

  const resolved = product.runtimeServiceId
    ? runtimeServices.find((service) => service.id === product.runtimeServiceId && service.companyId === product.companyId)
    : null;
  if (!resolved) return product;
  const resolvedStatus = runtimeServiceWorkProductStatus(resolved.status);

  return {
    ...product,
    runtimeServiceId: resolved.id,
    externalId: product.provider === "paperclip" ? resolved.id : product.externalId,
    url: resolved.url,
    status: resolvedStatus ?? product.status,
    healthStatus: runtimeServiceHealthStatus(resolved.healthStatus),
    metadata: {
      ...(product.metadata ?? {}),
      runtimeService: {
        id: resolved.id,
        serviceName: resolved.serviceName,
        status: resolved.status,
        healthStatus: resolved.healthStatus,
        port: resolved.port,
      },
    },
  };
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
  const resolveRuntimeServiceState = async (products: IssueWorkProduct[]) => {
    const runtimeProducts = products.filter((product) => (
      product.type === "runtime_service"
      && product.runtimeServiceId
    ));
    if (runtimeProducts.length === 0) return products;

    const companyIds = [...new Set(runtimeProducts.map((product) => product.companyId))];
    const runtimeServiceIds = [
      ...new Set(runtimeProducts.flatMap((product) => product.runtimeServiceId ? [product.runtimeServiceId] : [])),
    ];
    const runtimeServices = await db
      .select({
        id: workspaceRuntimeServices.id,
        companyId: workspaceRuntimeServices.companyId,
        executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId,
        serviceName: workspaceRuntimeServices.serviceName,
        status: workspaceRuntimeServices.status,
        port: workspaceRuntimeServices.port,
        url: workspaceRuntimeServices.url,
        healthStatus: workspaceRuntimeServices.healthStatus,
      })
      .from(workspaceRuntimeServices)
      .where(and(
        inArray(workspaceRuntimeServices.companyId, companyIds),
        inArray(workspaceRuntimeServices.id, runtimeServiceIds),
      ));

    return products.map((product) => resolveRuntimeServiceWorkProductState(product, runtimeServices));
  };

  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return await resolveRuntimeServiceState(rows.map(toIssueWorkProduct));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return (await resolveRuntimeServiceState([toIssueWorkProduct(row)]))[0] ?? null;
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
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
