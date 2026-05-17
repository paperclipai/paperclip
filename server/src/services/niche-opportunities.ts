import { eq, and, desc, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { nicheOpportunities } from "@paperclipai/db";
import type {
  NicheOpportunity,
  NicheOpportunityStatus,
  NicheOpportunityListResponse,
} from "@paperclipai/shared";

function toRow(row: typeof nicheOpportunities.$inferSelect): NicheOpportunity {
  return {
    id: row.id,
    companyId: row.companyId,
    headKeyword: row.headKeyword,
    categoryPath: row.categoryPath,
    tier: row.tier as NicheOpportunity["tier"],
    compositeScore: row.compositeScore,
    status: row.status as NicheOpportunityStatus,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    miaIssueId: row.miaIssueId,
    metadata: row.metadata,
    discoveredAt: row.discoveredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function nicheOpportunityService(db: Db) {
  return {
    list: async (
      companyId: string,
      status?: NicheOpportunityStatus,
      limit = 100,
      offset = 0,
    ): Promise<NicheOpportunityListResponse> => {
      const where = status
        ? and(eq(nicheOpportunities.companyId, companyId), eq(nicheOpportunities.status, status))
        : eq(nicheOpportunities.companyId, companyId);

      const [rows, [{ value: total }]] = await Promise.all([
        db
          .select()
          .from(nicheOpportunities)
          .where(where)
          .orderBy(desc(nicheOpportunities.compositeScore), desc(nicheOpportunities.discoveredAt))
          .limit(limit)
          .offset(offset),
        db.select({ value: count() }).from(nicheOpportunities).where(where),
      ]);

      return { items: rows.map(toRow), total };
    },

    get: async (companyId: string, id: string): Promise<NicheOpportunity | null> => {
      const [row] = await db
        .select()
        .from(nicheOpportunities)
        .where(and(eq(nicheOpportunities.companyId, companyId), eq(nicheOpportunities.id, id)));
      return row ? toRow(row) : null;
    },

    review: async (
      companyId: string,
      id: string,
      action: "approve" | "defer" | "reject",
      reviewedByUserId: string,
      reviewNote?: string,
      miaIssueId?: string,
    ): Promise<NicheOpportunity | null> => {
      const statusMap = {
        approve: "approved_for_analysis",
        defer: "deferred",
        reject: "rejected",
      } as const;

      const [updated] = await db
        .update(nicheOpportunities)
        .set({
          status: statusMap[action],
          reviewedByUserId,
          reviewedAt: new Date(),
          reviewNote: reviewNote ?? null,
          miaIssueId: miaIssueId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(nicheOpportunities.companyId, companyId), eq(nicheOpportunities.id, id)))
        .returning();

      return updated ? toRow(updated) : null;
    },

    create: async (
      companyId: string,
      data: {
        headKeyword: string;
        categoryPath: string;
        tier?: string;
        compositeScore?: number;
        metadata?: string;
        discoveredAt?: Date;
      },
    ): Promise<NicheOpportunity | null> => {
      const [row] = await db
        .insert(nicheOpportunities)
        .values({
          companyId,
          headKeyword: data.headKeyword,
          categoryPath: data.categoryPath,
          tier: data.tier ?? "B",
          compositeScore: data.compositeScore ?? 0,
          metadata: data.metadata ?? null,
          discoveredAt: data.discoveredAt ?? new Date(),
        })
        .onConflictDoNothing()
        .returning();
      return row ? toRow(row) : null;
    },
  };
}
