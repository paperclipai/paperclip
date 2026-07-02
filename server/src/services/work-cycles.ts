import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects, workCycles } from "@paperclipai/db";
import type { WorkCycle } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type WorkCycleRow = typeof workCycles.$inferSelect;
type WorkCycleInput = Omit<typeof workCycles.$inferInsert, "companyId">;

function toWorkCycle(row: WorkCycleRow): WorkCycle {
  return {
    ...row,
    status: row.status as WorkCycle["status"],
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
  };
}

async function assertProjectInCompany(db: Db, companyId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!project) {
    throw unprocessable("Cycle project must belong to the same company");
  }
}

export function workCycleService(db: Db) {
  return {
    list: async (
      companyId: string,
      filters: {
        projectId?: string | null;
        includeCompanyWide?: boolean;
        includeArchived?: boolean;
      } = {},
    ) => {
      const conditions = [eq(workCycles.companyId, companyId)];
      if (filters.projectId) {
        conditions.push(
          filters.includeCompanyWide === false
            ? eq(workCycles.projectId, filters.projectId)
            : or(eq(workCycles.projectId, filters.projectId), isNull(workCycles.projectId))!,
        );
      }
      if (!filters.includeArchived) {
        conditions.push(inArray(workCycles.status, ["planned", "active", "completed"]));
      }
      const rows = await db
        .select()
        .from(workCycles)
        .where(and(...conditions))
        .orderBy(
          asc(sql`CASE ${workCycles.status} WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END`),
          asc(workCycles.startDate),
          asc(workCycles.createdAt),
          asc(workCycles.name),
        );
      return rows.map(toWorkCycle);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(workCycles)
        .where(eq(workCycles.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toWorkCycle(row) : null;
    },

    create: async (companyId: string, data: WorkCycleInput) => {
      await assertProjectInCompany(db, companyId, data.projectId);
      const row = await db
        .insert(workCycles)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
      return toWorkCycle(row);
    },

    update: async (id: string, data: Partial<WorkCycleInput>) => {
      const existing = await db
        .select()
        .from(workCycles)
        .where(eq(workCycles.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (data.projectId !== undefined) {
        await assertProjectInCompany(db, existing.companyId, data.projectId);
      }
      const row = await db
        .update(workCycles)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(workCycles.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toWorkCycle(row) : null;
    },
  };
}
