import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamWorkflowStatuses } from "@paperclipai/db";
import {
  slugifyWorkflowStatusName,
  type WorkflowStatusCategory,
} from "@paperclipai/shared";

export function workflowStatusService(db: Db) {
  return {
    list: (teamId: string) =>
      db
        .select()
        .from(teamWorkflowStatuses)
        .where(eq(teamWorkflowStatuses.teamId, teamId))
        .orderBy(asc(teamWorkflowStatuses.position), asc(teamWorkflowStatuses.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(teamWorkflowStatuses)
        .where(eq(teamWorkflowStatuses.id, id))
        .then((rows) => rows[0] ?? null),

    getByTeamAndSlug: (teamId: string, slug: string) =>
      db
        .select()
        .from(teamWorkflowStatuses)
        .where(and(eq(teamWorkflowStatuses.teamId, teamId), eq(teamWorkflowStatuses.slug, slug)))
        .then((rows) => rows[0] ?? null),

    create: async (
      teamId: string,
      data: {
        name: string;
        slug?: string;
        category: WorkflowStatusCategory;
        color?: string | null;
        description?: string | null;
        position?: number;
        isDefault?: boolean;
      },
    ) => {
      const slug = data.slug ?? slugifyWorkflowStatusName(data.name);

      // Check slug uniqueness within team
      const existing = await db
        .select()
        .from(teamWorkflowStatuses)
        .where(and(eq(teamWorkflowStatuses.teamId, teamId), eq(teamWorkflowStatuses.slug, slug)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        throw Object.assign(new Error(`Workflow status slug "${slug}" already exists in this team`), {
          status: 409,
        });
      }

      // If isDefault, unset other defaults
      if (data.isDefault) {
        await db
          .update(teamWorkflowStatuses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(teamWorkflowStatuses.teamId, teamId));
      }

      return db
        .insert(teamWorkflowStatuses)
        .values({
          teamId,
          name: data.name,
          slug,
          category: data.category,
          color: data.color ?? null,
          description: data.description ?? null,
          position: data.position ?? 0,
          isDefault: data.isDefault ?? false,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (
      id: string,
      data: Partial<{
        name: string;
        category: WorkflowStatusCategory;
        color: string | null;
        description: string | null;
        position: number;
        isDefault: boolean;
      }>,
    ) => {
      // slug is immutable - never updated
      const existing = await db
        .select()
        .from(teamWorkflowStatuses)
        .where(eq(teamWorkflowStatuses.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      if (data.isDefault === true) {
        await db
          .update(teamWorkflowStatuses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(teamWorkflowStatuses.teamId, existing.teamId));
      }

      return db
        .update(teamWorkflowStatuses)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(teamWorkflowStatuses.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (id: string) => {
      const existing = await db
        .select()
        .from(teamWorkflowStatuses)
        .where(eq(teamWorkflowStatuses.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      // Ensure at least 1 status remains in the same category
      const sameCategoryCount = await db
        .select()
        .from(teamWorkflowStatuses)
        .where(
          and(
            eq(teamWorkflowStatuses.teamId, existing.teamId),
            eq(teamWorkflowStatuses.category, existing.category),
          ),
        )
        .then((rows) => rows.length);
      if (sameCategoryCount <= 1) {
        throw Object.assign(
          new Error(`Cannot delete the last status in category "${existing.category}"`),
          { status: 400 },
        );
      }

      return db
        .delete(teamWorkflowStatuses)
        .where(eq(teamWorkflowStatuses.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
