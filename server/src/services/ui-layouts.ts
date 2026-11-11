import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyUserUiLayouts } from "@paperclipai/db";
import type { UiLayoutPreference, UiLayoutSurface } from "@paperclipai/shared";

function toPreference(
  surface: UiLayoutSurface,
  row: { layout: unknown; schemaVersion: number; updatedAt: Date } | undefined,
): UiLayoutPreference {
  return {
    surface,
    schemaVersion: row?.schemaVersion ?? null,
    layout: row?.layout ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function uiLayoutService(db: Db) {
  return {
    async get(companyId: string, userId: string, surface: UiLayoutSurface): Promise<UiLayoutPreference> {
      const row = await db.query.companyUserUiLayouts.findFirst({
        where: and(
          eq(companyUserUiLayouts.companyId, companyId),
          eq(companyUserUiLayouts.userId, userId),
          eq(companyUserUiLayouts.surface, surface),
        ),
      });
      return toPreference(surface, row);
    },

    async upsert(
      companyId: string,
      userId: string,
      surface: UiLayoutSurface,
      input: { layout: Record<string, unknown>; schemaVersion: number },
    ): Promise<{ preference: UiLayoutPreference; created: boolean }> {
      const now = new Date();
      const [row] = await db
        .insert(companyUserUiLayouts)
        .values({
          companyId,
          userId,
          surface,
          schemaVersion: input.schemaVersion,
          layout: input.layout,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            companyUserUiLayouts.companyId,
            companyUserUiLayouts.userId,
            companyUserUiLayouts.surface,
          ],
          set: {
            schemaVersion: input.schemaVersion,
            layout: input.layout,
            updatedAt: now,
          },
        })
        .returning({ ...getTableColumns(companyUserUiLayouts), created: sql<boolean>`(xmax = 0)` });
      return { preference: toPreference(surface, row), created: row?.created === true };
    },

    async remove(
      companyId: string,
      userId: string,
      surface: UiLayoutSurface,
    ): Promise<{ preference: UiLayoutPreference; removed: boolean }> {
      const removed = await db
        .delete(companyUserUiLayouts)
        .where(and(
          eq(companyUserUiLayouts.companyId, companyId),
          eq(companyUserUiLayouts.userId, userId),
          eq(companyUserUiLayouts.surface, surface),
        ))
        .returning({ id: companyUserUiLayouts.id });
      return { preference: toPreference(surface, undefined), removed: removed.length > 0 };
    },
  };
}
