import { eq, and, desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueMockups, assets, issues } from "@paperclipai/db";

function notFound(msg: string) {
  const err = new Error(msg) as Error & { status: number };
  err.status = 404;
  return err;
}

export function mockupService(db: Db) {
  return {
    create: async (input: {
      companyId: string;
      issueId: string;
      title: string;
      viewport: string;
      fidelityLevel: string;
      notes?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      return db.transaction(async (tx) => {
        // Auto-increment version per (issueId, title)
        const maxVersionRow = await tx
          .select({ maxVersion: sql<number>`coalesce(max(${issueMockups.version}), 0)` })
          .from(issueMockups)
          .where(
            and(
              eq(issueMockups.issueId, input.issueId),
              eq(issueMockups.title, input.title),
            ),
          )
          .then((rows) => rows[0]);
        const nextVersion = (maxVersionRow?.maxVersion ?? 0) + 1;

        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [mockup] = await tx
          .insert(issueMockups)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            title: input.title,
            version: nextVersion,
            viewport: input.viewport,
            fidelityLevel: input.fidelityLevel,
            status: "draft",
            notes: input.notes ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        return {
          ...mockup,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
        };
      });
    },

    list: async (
      issueId: string,
      filters?: { status?: string; title?: string },
    ) => {
      const conditions = [eq(issueMockups.issueId, issueId)];
      if (filters?.status) {
        conditions.push(eq(issueMockups.status, filters.status));
      }
      if (filters?.title) {
        conditions.push(eq(issueMockups.title, filters.title));
      }

      return db
        .select({
          id: issueMockups.id,
          companyId: issueMockups.companyId,
          issueId: issueMockups.issueId,
          assetId: issueMockups.assetId,
          title: issueMockups.title,
          version: issueMockups.version,
          viewport: issueMockups.viewport,
          fidelityLevel: issueMockups.fidelityLevel,
          status: issueMockups.status,
          notes: issueMockups.notes,
          createdByAgentId: issueMockups.createdByAgentId,
          createdByUserId: issueMockups.createdByUserId,
          createdAt: issueMockups.createdAt,
          updatedAt: issueMockups.updatedAt,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          originalFilename: assets.originalFilename,
        })
        .from(issueMockups)
        .innerJoin(assets, eq(issueMockups.assetId, assets.id))
        .where(and(...conditions))
        .orderBy(desc(issueMockups.version));
    },

    getById: async (id: string) =>
      db
        .select({
          id: issueMockups.id,
          companyId: issueMockups.companyId,
          issueId: issueMockups.issueId,
          assetId: issueMockups.assetId,
          title: issueMockups.title,
          version: issueMockups.version,
          viewport: issueMockups.viewport,
          fidelityLevel: issueMockups.fidelityLevel,
          status: issueMockups.status,
          notes: issueMockups.notes,
          createdByAgentId: issueMockups.createdByAgentId,
          createdByUserId: issueMockups.createdByUserId,
          createdAt: issueMockups.createdAt,
          updatedAt: issueMockups.updatedAt,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
        })
        .from(issueMockups)
        .innerJoin(assets, eq(issueMockups.assetId, assets.id))
        .where(eq(issueMockups.id, id))
        .then((rows) => rows[0] ?? null),

    updateStatus: async (id: string, status: string) => {
      const [updated] = await db
        .update(issueMockups)
        .set({ status, updatedAt: new Date() })
        .where(eq(issueMockups.id, id))
        .returning();
      return updated ?? null;
    },

    remove: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueMockups.id,
            companyId: issueMockups.companyId,
            issueId: issueMockups.issueId,
            assetId: issueMockups.assetId,
            objectKey: assets.objectKey,
          })
          .from(issueMockups)
          .innerJoin(assets, eq(issueMockups.assetId, assets.id))
          .where(eq(issueMockups.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueMockups).where(eq(issueMockups.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));

        return existing;
      }),
  };
}
