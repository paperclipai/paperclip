import { and, asc, eq, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, folders, routines } from "@paperclipai/db";
import type {
  CreateFolder,
  Folder,
  FolderKind,
  FolderListResult,
  MoveFolder,
  MoveFolderItem,
  UpdateFolder,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type FolderRow = typeof folders.$inferSelect;

function mapFolder(row: FolderRow): Folder {
  return {
    ...row,
    color: row.color ?? null,
  };
}

function normalizeName(name: string) {
  return name.trim();
}

function normalizeColor(color: string | null | undefined) {
  if (color === undefined) return undefined;
  const trimmed = color?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function folderService(db: Db) {
  async function getFolder(companyId: string, folderId: string) {
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .then((rows) => rows[0] ?? null);
  }

  async function assertNoNameConflict(companyId: string, kind: FolderKind, name: string, excludeFolderId?: string) {
    const existing = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, kind), eq(folders.name, name)))
      .then((rows) => rows[0] ?? null);
    if (existing && existing.id !== excludeFolderId) {
      throw conflict("Folder name already exists for this kind");
    }
  }

  async function nextPosition(companyId: string, kind: FolderKind) {
    const row = await db
      .select({ value: max(folders.position) })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, kind)))
      .then((rows) => rows[0] ?? null);
    return Number(row?.value ?? -1) + 1;
  }

  async function routineCounts(companyId: string) {
    return db
      .select({
        folderId: routines.folderId,
        count: sql<number>`count(*)::int`,
      })
      .from(routines)
      .where(eq(routines.companyId, companyId))
      .groupBy(routines.folderId);
  }

  async function skillCounts(companyId: string) {
    return db
      .select({
        folderId: companySkills.folderId,
        count: sql<number>`count(*)::int`,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .groupBy(companySkills.folderId);
  }

  async function list(companyId: string, kind: FolderKind): Promise<FolderListResult> {
    const [folderRows, countRows] = await Promise.all([
      db
        .select()
        .from(folders)
        .where(and(eq(folders.companyId, companyId), eq(folders.kind, kind)))
        .orderBy(asc(folders.position), asc(folders.name), asc(folders.id)),
      kind === "routine" ? routineCounts(companyId) : skillCounts(companyId),
    ]);

    const countsByFolderId = new Map<string | null, number>();
    for (const row of countRows) {
      countsByFolderId.set(row.folderId ?? null, Number(row.count ?? 0));
    }

    return {
      kind,
      folders: folderRows.map((row) => ({
        ...mapFolder(row),
        itemCount: countsByFolderId.get(row.id) ?? 0,
      })),
      allCount: Array.from(countsByFolderId.values()).reduce((sum, count) => sum + count, 0),
      unfiledCount: countsByFolderId.get(null) ?? 0,
    };
  }

  async function create(companyId: string, input: CreateFolder): Promise<Folder> {
    const name = normalizeName(input.name);
    await assertNoNameConflict(companyId, input.kind, name);
    const position = input.position ?? await nextPosition(companyId, input.kind);
    const row = await db
      .insert(folders)
      .values({
        companyId,
        kind: input.kind,
        name,
        color: normalizeColor(input.color) ?? null,
        position,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Failed to create folder");
    return mapFolder(row);
  }

  async function update(companyId: string, folderId: string, patch: UpdateFolder): Promise<Folder | null> {
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    const nextName = patch.name === undefined ? existing.name : normalizeName(patch.name);
    if (nextName !== existing.name) {
      await assertNoNameConflict(companyId, existing.kind, nextName, folderId);
    }
    const row = await db
      .update(folders)
      .set({
        name: nextName,
        color: patch.color === undefined ? existing.color : normalizeColor(patch.color),
        position: patch.position ?? existing.position,
        updatedAt: new Date(),
      })
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? mapFolder(row) : null;
  }

  async function moveFolder(companyId: string, folderId: string, input: MoveFolder): Promise<Folder | null> {
    const row = await db
      .update(folders)
      .set({ position: input.position, updatedAt: new Date() })
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? mapFolder(row) : null;
  }

  async function deleteFolder(companyId: string, folderId: string): Promise<Folder | null> {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const folder = await txDb
        .select()
        .from(folders)
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
        .then((rows) => rows[0] ?? null);
      if (!folder) return null;

      if (folder.kind === "routine") {
        await txDb
          .update(routines)
          .set({ folderId: null, updatedAt: new Date() })
          .where(and(eq(routines.companyId, companyId), eq(routines.folderId, folderId)));
      } else {
        await txDb
          .update(companySkills)
          .set({ folderId: null, updatedAt: new Date() })
          .where(and(eq(companySkills.companyId, companyId), eq(companySkills.folderId, folderId)));
      }

      await txDb
        .delete(folders)
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
      return mapFolder(folder);
    });
  }

  async function assertTargetFolder(companyId: string, kind: FolderKind, folderId: string | null | undefined) {
    if (!folderId) return null;
    const folder = await getFolder(companyId, folderId);
    if (!folder) throw notFound("Folder not found");
    if (folder.kind !== kind) throw unprocessable("Folder kind must match item kind");
    return folder;
  }

  async function moveItem(companyId: string, input: MoveFolderItem) {
    const targetFolder = await assertTargetFolder(companyId, input.kind, input.folderId ?? null);
    if (input.kind === "routine") {
      const row = await db
        .update(routines)
        .set({ folderId: targetFolder?.id ?? null, updatedAt: new Date() })
        .where(and(eq(routines.companyId, companyId), eq(routines.id, input.itemId)))
        .returning({ id: routines.id, folderId: routines.folderId })
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Routine not found");
      return { kind: input.kind, itemId: row.id, folderId: row.folderId ?? null };
    }

    const row = await db
      .update(companySkills)
      .set({ folderId: targetFolder?.id ?? null, updatedAt: new Date() })
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, input.itemId)))
      .returning({ id: companySkills.id, folderId: companySkills.folderId })
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill not found");
    return { kind: input.kind, itemId: row.id, folderId: row.folderId ?? null };
  }

  return {
    list,
    create,
    update,
    moveFolder,
    deleteFolder,
    moveItem,
  };
}
