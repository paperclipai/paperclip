import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { milestones } from "@paperclipai/db";
import type { Milestone, CreateMilestoneInput, UpdateMilestoneInput } from "@paperclipai/shared";

function toMilestone(row: typeof milestones.$inferSelect): Milestone {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    targetDate: row.targetDate,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createMilestonesService(db: Db) {
  return {
    async list(companyId: string, projectId?: string | null): Promise<Milestone[]> {
      const conditions = [eq(milestones.companyId, companyId)];
      if (projectId) {
        conditions.push(eq(milestones.projectId, projectId));
      }
      const rows = await db
        .select()
        .from(milestones)
        .where(and(...conditions))
        .orderBy(asc(milestones.sortOrder), asc(milestones.createdAt));
      return rows.map(toMilestone);
    },

    async getById(id: string): Promise<Milestone | null> {
      const row = await db
        .select()
        .from(milestones)
        .where(eq(milestones.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toMilestone(row) : null;
    },

    async create(companyId: string, input: CreateMilestoneInput): Promise<Milestone> {
      const [row] = await db
        .insert(milestones)
        .values({
          companyId,
          projectId: input.projectId ?? null,
          name: input.name,
          description: input.description ?? null,
          targetDate: input.targetDate ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning();
      return toMilestone(row!);
    },

    async update(id: string, input: UpdateMilestoneInput): Promise<Milestone | null> {
      const patch: Partial<typeof milestones.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (input.projectId !== undefined) patch.projectId = input.projectId;

      const [row] = await db
        .update(milestones)
        .set(patch)
        .where(eq(milestones.id, id))
        .returning();
      return row ? toMilestone(row) : null;
    },

    async remove(id: string): Promise<boolean> {
      const [row] = await db
        .delete(milestones)
        .where(eq(milestones.id, id))
        .returning({ id: milestones.id });
      return row != null;
    },
  };
}
