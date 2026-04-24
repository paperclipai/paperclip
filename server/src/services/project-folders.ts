import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectFolders, projects } from "@paperclipai/db";
import type { ProjectFolder } from "@paperclipai/shared";

type ProjectFolderRow = typeof projectFolders.$inferSelect;

function toProjectFolder(row: ProjectFolderRow): ProjectFolder {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function projectFolderService(db: Db) {
  return {
    list: async (companyId: string): Promise<ProjectFolder[]> => {
      const rows = await db
        .select()
        .from(projectFolders)
        .where(eq(projectFolders.companyId, companyId))
        .orderBy(asc(projectFolders.sortOrder), asc(projectFolders.createdAt));
      return rows.map(toProjectFolder);
    },

    getById: async (id: string): Promise<ProjectFolder | null> => {
      const rows = await db
        .select()
        .from(projectFolders)
        .where(eq(projectFolders.id, id));
      const row = rows[0];
      return row ? toProjectFolder(row) : null;
    },

    create: async (
      companyId: string,
      data: { name: string; sortOrder?: number },
    ): Promise<ProjectFolder> => {
      // Default sortOrder to one past the highest existing value.
      let sortOrder = data.sortOrder;
      if (sortOrder === undefined) {
        const existing = await db
          .select({ sortOrder: projectFolders.sortOrder })
          .from(projectFolders)
          .where(eq(projectFolders.companyId, companyId))
          .orderBy(asc(projectFolders.sortOrder));
        sortOrder = existing.length > 0 ? (existing[existing.length - 1]?.sortOrder ?? 0) + 1 : 0;
      }

      const rows = await db
        .insert(projectFolders)
        .values({ companyId, name: data.name, sortOrder })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Failed to create project folder");
      return toProjectFolder(row);
    },

    update: async (
      id: string,
      data: { name?: string; sortOrder?: number },
    ): Promise<ProjectFolder | null> => {
      const rows = await db
        .update(projectFolders)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(projectFolders.id, id))
        .returning();
      const row = rows[0];
      return row ? toProjectFolder(row) : null;
    },

    reorder: async (companyId: string, orderedIds: string[]): Promise<void> => {
      await db.transaction(async (tx) => {
        await Promise.all(
          orderedIds.map((id, index) =>
            tx
              .update(projectFolders)
              .set({ sortOrder: index, updatedAt: new Date() })
              .where(and(eq(projectFolders.id, id), eq(projectFolders.companyId, companyId))),
          ),
        );
      });
    },

    remove: async (id: string): Promise<ProjectFolder | null> => {
      // Move projects in this folder to uncategorized before deleting.
      await db
        .update(projects)
        .set({ folderId: null, updatedAt: new Date() })
        .where(eq(projects.folderId, id));

      const rows = await db
        .delete(projectFolders)
        .where(eq(projectFolders.id, id))
        .returning();
      const row = rows[0];
      return row ? toProjectFolder(row) : null;
    },
  };
}
