import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, issueKnowledgeItems, issues, knowledgeItems } from "@paperclipai/db";
import type {
  AssetImage,
  CreateKnowledgeItem,
  IssueKnowledgeAttachment,
  KnowledgeItem,
  UpdateKnowledgeItem,
} from "@paperclipai/shared";
import { createKnowledgeItemSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type KnowledgeRow = typeof knowledgeItems.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type IssueKnowledgeRow = typeof issueKnowledgeItems.$inferSelect;

function toAssetImage(asset: AssetRow): AssetImage {
  return {
    assetId: asset.id,
    companyId: asset.companyId,
    provider: asset.provider,
    objectKey: asset.objectKey,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    originalFilename: asset.originalFilename,
    createdByAgentId: asset.createdByAgentId,
    createdByUserId: asset.createdByUserId,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    contentPath: `/api/assets/${asset.id}/content`,
  };
}

function toKnowledgeItem(row: KnowledgeRow, asset?: AssetRow | null): KnowledgeItem {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    kind: row.kind as KnowledgeItem["kind"],
    summary: row.summary,
    body: row.body,
    assetId: row.assetId,
    sourceUrl: row.sourceUrl,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    asset: asset ? toAssetImage(asset) : null,
    contentText: null,
  };
}

function toIssueKnowledgeAttachment(
  row: IssueKnowledgeRow,
  knowledgeRow: KnowledgeRow,
  asset?: AssetRow | null,
): IssueKnowledgeAttachment {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    knowledgeItemId: row.knowledgeItemId,
    sortOrder: row.sortOrder,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    knowledgeItem: toKnowledgeItem(knowledgeRow, asset),
  };
}

function isIssueKnowledgeConflict(error: unknown) {
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? (error as { constraint?: string }).constraint
    : typeof error === "object" && error !== null && "constraint_name" in error
      ? (error as { constraint_name?: string }).constraint_name
      : undefined;

  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "23505"
    && constraint === "issue_knowledge_items_issue_knowledge_uq";
}

type DbLike = Pick<Db, "select" | "insert" | "update" | "delete">;

async function assertAssetBelongsToCompanyWithDb(dbOrTx: DbLike, companyId: string, assetId: string) {
  const asset = await dbOrTx
    .select({
      id: assets.id,
      companyId: assets.companyId,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .then((rows) => rows[0] ?? null);

  if (!asset || asset.companyId !== companyId) {
    throw unprocessable("Asset must belong to same company");
  }
}

function assertPatchCompatibleWithKind(kind: KnowledgeItem["kind"], patch: UpdateKnowledgeItem) {
  if (kind === "note" && (patch.assetId !== undefined || patch.sourceUrl !== undefined)) {
    throw unprocessable("Note knowledge items cannot set assetId or sourceUrl");
  }
  if (kind === "asset" && (patch.body !== undefined || patch.sourceUrl !== undefined)) {
    throw unprocessable("Asset knowledge items cannot set body or sourceUrl");
  }
  if (kind === "url" && (patch.body !== undefined || patch.assetId !== undefined)) {
    throw unprocessable("URL knowledge items cannot set body or assetId");
  }
}

export function buildKnowledgePayloadForUpdate(
  row: Pick<KnowledgeRow, "title" | "kind" | "summary" | "body" | "assetId" | "sourceUrl">,
  patch?: UpdateKnowledgeItem,
): CreateKnowledgeItem {
  const base = {
    title: patch?.title ?? row.title,
    kind: row.kind,
    summary: patch?.summary === undefined ? row.summary : patch.summary,
  };

  const candidate = row.kind === "note"
    ? {
        ...base,
        body: patch?.body === undefined ? row.body : patch.body,
      }
    : row.kind === "asset"
      ? {
          ...base,
          assetId: patch?.assetId === undefined ? row.assetId : patch.assetId,
        }
      : {
          ...base,
          sourceUrl: patch?.sourceUrl === undefined ? row.sourceUrl : patch.sourceUrl,
        };

  const parsed = createKnowledgeItemSchema.safeParse(candidate);
  if (!parsed.success) {
    throw unprocessable("Knowledge item is invalid", parsed.error.issues);
  }
  return parsed.data;
}

async function resolveKnowledgeItem(db: DbLike, knowledgeItemId: string): Promise<KnowledgeItem | null> {
  const row = await db
    .select({
      knowledgeItem: knowledgeItems,
      asset: assets,
    })
    .from(knowledgeItems)
    .leftJoin(assets, eq(knowledgeItems.assetId, assets.id))
    .where(eq(knowledgeItems.id, knowledgeItemId))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return toKnowledgeItem(row.knowledgeItem, row.asset);
}

export function knowledgeService(db: Db) {
  async function attachToIssueInTx(
    dbOrTx: DbLike,
    issueId: string,
    knowledgeItemId: string,
    actor: { agentId?: string | null; userId?: string | null } = {},
  ) {
    const issue = await dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const knowledgeItem = await dbOrTx
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, knowledgeItemId))
      .then((rows) => rows[0] ?? null);
    if (!knowledgeItem) throw notFound("Knowledge item not found");

    if (knowledgeItem.companyId !== issue.companyId) {
      throw unprocessable("Knowledge item must belong to same company as issue");
    }

    const existingAttachments = await dbOrTx
      .select({ sortOrder: issueKnowledgeItems.sortOrder })
      .from(issueKnowledgeItems)
      .where(eq(issueKnowledgeItems.issueId, issueId))
      .orderBy(desc(issueKnowledgeItems.sortOrder))
      .then((rows) => rows[0] ?? null);

    try {
      const rows = await dbOrTx
        .insert(issueKnowledgeItems)
        .values({
          companyId: issue.companyId,
          issueId,
          knowledgeItemId,
          sortOrder: (existingAttachments?.sortOrder ?? -1) + 1,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning();

      const created = rows[0];
      return toIssueKnowledgeAttachment(created, knowledgeItem);
    } catch (error) {
      if (isIssueKnowledgeConflict(error)) {
        throw conflict("Knowledge item already attached to issue");
      }
      throw error;
    }
  }

  return {
    list: async (companyId: string) => {
      const rows = await db
        .select({
          knowledgeItem: knowledgeItems,
          asset: assets,
        })
        .from(knowledgeItems)
        .leftJoin(assets, eq(knowledgeItems.assetId, assets.id))
        .where(eq(knowledgeItems.companyId, companyId))
        .orderBy(desc(knowledgeItems.createdAt), asc(knowledgeItems.id));

      return rows.map((row) => toKnowledgeItem(row.knowledgeItem, row.asset));
    },

    getById: (knowledgeItemId: string) => resolveKnowledgeItem(db, knowledgeItemId),

    create: async (
      companyId: string,
      input: CreateKnowledgeItem,
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => {
      if (input.kind === "asset") {
        await assertAssetBelongsToCompanyWithDb(db, companyId, input.assetId);
      }

      const rows = await db
        .insert(knowledgeItems)
        .values({
          companyId,
          title: input.title,
          kind: input.kind,
          summary: input.summary ?? null,
          body: input.kind === "note" ? input.body : null,
          assetId: input.kind === "asset" ? input.assetId : null,
          sourceUrl: input.kind === "url" ? input.sourceUrl : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      const created = rows[0];
      return resolveKnowledgeItem(db, created.id);
    },

    update: async (
      knowledgeItemId: string,
      patch: UpdateKnowledgeItem,
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => {
      const existing = await db
        .select()
        .from(knowledgeItems)
        .where(eq(knowledgeItems.id, knowledgeItemId))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      assertPatchCompatibleWithKind(existing.kind as KnowledgeItem["kind"], patch);
      const payload = buildKnowledgePayloadForUpdate(existing, patch);
      if (payload.kind === "asset") {
        await assertAssetBelongsToCompanyWithDb(db, existing.companyId, payload.assetId);
      }

      await db
        .update(knowledgeItems)
        .set({
          title: payload.title,
          summary: payload.summary ?? null,
          body: payload.kind === "note" ? payload.body : null,
          assetId: payload.kind === "asset" ? payload.assetId : null,
          sourceUrl: payload.kind === "url" ? payload.sourceUrl : null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeItems.id, knowledgeItemId));

      return resolveKnowledgeItem(db, knowledgeItemId);
    },

    remove: async (knowledgeItemId: string) => {
      const rows = await db
        .delete(knowledgeItems)
        .where(eq(knowledgeItems.id, knowledgeItemId))
        .returning();

      const removed = rows[0] ?? null;
      return removed ? toKnowledgeItem(removed) : null;
    },

    getIssueById: (issueId: string) =>
      db
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),

    listForIssue: async (issueId: string) => {
      const rows = await db
        .select({
          attachment: issueKnowledgeItems,
          knowledgeItem: knowledgeItems,
          asset: assets,
        })
        .from(issueKnowledgeItems)
        .innerJoin(knowledgeItems, eq(issueKnowledgeItems.knowledgeItemId, knowledgeItems.id))
        .leftJoin(assets, eq(knowledgeItems.assetId, assets.id))
        .where(eq(issueKnowledgeItems.issueId, issueId))
        .orderBy(asc(issueKnowledgeItems.sortOrder), asc(issueKnowledgeItems.createdAt));

      return rows.map((row) => toIssueKnowledgeAttachment(row.attachment, row.knowledgeItem, row.asset));
    },

    attachToIssue: async (
      issueId: string,
      knowledgeItemId: string,
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => attachToIssueInTx(db, issueId, knowledgeItemId, actor),

    attachToIssueInTx: async (
      tx: DbLike,
      issueId: string,
      knowledgeItemId: string,
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => attachToIssueInTx(tx, issueId, knowledgeItemId, actor),

    detachFromIssue: async (issueId: string, knowledgeItemId: string) => {
      const existing = await db
        .select({
          attachment: issueKnowledgeItems,
          knowledgeItem: knowledgeItems,
          asset: assets,
        })
        .from(issueKnowledgeItems)
        .innerJoin(knowledgeItems, eq(issueKnowledgeItems.knowledgeItemId, knowledgeItems.id))
        .leftJoin(assets, eq(knowledgeItems.assetId, assets.id))
        .where(
          and(
            eq(issueKnowledgeItems.issueId, issueId),
            eq(issueKnowledgeItems.knowledgeItemId, knowledgeItemId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      await db
        .delete(issueKnowledgeItems)
        .where(
          and(
            eq(issueKnowledgeItems.issueId, issueId),
            eq(issueKnowledgeItems.knowledgeItemId, knowledgeItemId),
          ),
        );

      return toIssueKnowledgeAttachment(existing.attachment, existing.knowledgeItem, existing.asset);
    },
  };
}
