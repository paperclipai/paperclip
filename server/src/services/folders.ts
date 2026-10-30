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
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

const MAX_FOLDER_DEPTH = 4;
const RESERVED_ROOT_SLUGS = new Set(["bundled", "my", "projects"]);
const RESERVED_CHILD_ROOT_SYSTEM_KEYS = new Set(["my", "projects"]);

type FolderRow = typeof folders.$inferSelect;

function isPostgresError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function normalizeName(name: string) {
  return name.trim();
}

function normalizeColor(color: string | null | undefined) {
  if (color === undefined) return undefined;
  const trimmed = color?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeFolderSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "folder";
}

function buildFolderViews(rows: FolderRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const views = new Map<string, Folder>();
  const visiting = new Set<string>();

  function resolve(row: FolderRow): Folder {
    const existing = views.get(row.id);
    if (existing) return existing;
    if (visiting.has(row.id)) throw unprocessable("Folder hierarchy contains a cycle");
    visiting.add(row.id);
    const parent = row.parentId ? byId.get(row.parentId) : null;
    if (row.parentId && !parent) throw unprocessable("Folder hierarchy contains an invalid parent");
    const parentView = parent ? resolve(parent) : null;
    const view: Folder = {
      ...row,
      parentId: row.parentId ?? null,
      systemKey: row.systemKey ?? null,
      color: row.color ?? null,
      path: parentView ? `${parentView.path}/${row.slug}` : row.slug,
      depth: (parentView?.depth ?? 0) + 1,
    };
    visiting.delete(row.id);
    views.set(row.id, view);
    return view;
  }

  for (const row of rows) resolve(row);
  return views;
}

export function folderService(db: Db, mutationLockHeld = false) {
  async function withCompanyFolderLock<T>(companyId: string, operation: (lockedDb: Db) => Promise<T>) {
    if (mutationLockHeld) return operation(db);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:folders:${companyId}`}, 0))`);
      return operation(tx as unknown as Db);
    });
  }

  async function getRows(companyId: string, kind: FolderKind) {
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, kind)))
      .orderBy(asc(folders.position), asc(folders.name), asc(folders.id));
  }

  async function getFolderRow(companyId: string, folderId: string) {
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getFolder(companyId: string, folderId: string) {
    const row = await getFolderRow(companyId, folderId);
    if (!row) return null;
    const views = buildFolderViews(await getRows(companyId, row.kind));
    return views.get(row.id) ?? null;
  }

  async function assertNoSlugConflict(
    companyId: string,
    kind: FolderKind,
    parentId: string | null,
    slug: string,
    excludeFolderId?: string,
  ) {
    const existing = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(
        eq(folders.companyId, companyId),
        eq(folders.kind, kind),
        parentId === null ? sql`${folders.parentId} is null` : eq(folders.parentId, parentId),
        eq(folders.slug, slug),
      ))
      .then((rows) => rows[0] ?? null);
    if (existing && existing.id !== excludeFolderId) {
      throw conflict("Folder slug already exists under this parent");
    }
  }

  async function nextPosition(companyId: string, kind: FolderKind, parentId: string | null) {
    const row = await db
      .select({ value: max(folders.position) })
      .from(folders)
      .where(and(
        eq(folders.companyId, companyId),
        eq(folders.kind, kind),
        parentId === null ? sql`${folders.parentId} is null` : eq(folders.parentId, parentId),
      ))
      .then((rows) => rows[0] ?? null);
    return Number(row?.value ?? -1) + 1;
  }

  async function routineCounts(companyId: string) {
    return db
      .select({ folderId: routines.folderId, count: sql<number>`count(*)::int` })
      .from(routines)
      .where(eq(routines.companyId, companyId))
      .groupBy(routines.folderId);
  }

  async function skillCounts(companyId: string) {
    return db
      .select({ folderId: companySkills.folderId, count: sql<number>`count(*)::int` })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .groupBy(companySkills.folderId);
  }

  async function list(companyId: string, kind: FolderKind): Promise<FolderListResult> {
    const [folderRows, countRows] = await Promise.all([
      getRows(companyId, kind),
      kind === "routine" ? routineCounts(companyId) : skillCounts(companyId),
    ]);
    const views = buildFolderViews(folderRows);
    const countsByFolderId = new Map<string | null, number>();
    for (const row of countRows) countsByFolderId.set(row.folderId ?? null, Number(row.count ?? 0));
    return {
      kind,
      folders: folderRows.map((row) => ({
        ...views.get(row.id)!,
        itemCount: countsByFolderId.get(row.id) ?? 0,
      })),
      allCount: Array.from(countsByFolderId.values()).reduce((sum, count) => sum + count, 0),
      unfiledCount: countsByFolderId.get(null) ?? 0,
    };
  }

  function isReservedRootSlug(kind: FolderKind, parentId: string | null, slug: string) {
    return kind === "skill" && parentId === null && RESERVED_ROOT_SLUGS.has(slug);
  }

  async function isBundledFolder(companyId: string, folderId: string) {
    let current = await getFolder(companyId, folderId);
    const visited = new Set<string>();
    while (current) {
      if (current.systemKey === "bundled") return true;
      if (!current.parentId || visited.has(current.id)) return false;
      visited.add(current.id);
      current = await getFolder(companyId, current.parentId);
    }
    return false;
  }

  async function assertMutableFolder(companyId: string, folder: Folder) {
    if (folder.systemKey || await isBundledFolder(companyId, folder.id)) {
      throw forbidden("System-managed folders cannot be changed");
    }
  }

  async function validateParent(companyId: string, kind: FolderKind, parentId: string | null) {
    if (!parentId) return null;
    const parent = await getFolder(companyId, parentId);
    if (!parent || parent.kind !== kind) throw notFound("Parent folder not found");
    if (await isBundledFolder(companyId, parent.id)) throw forbidden("Bundled folders are read-only");
    if (
      parent.kind === "skill"
      && parent.parentId === null
      && (RESERVED_CHILD_ROOT_SYSTEM_KEYS.has(parent.systemKey ?? "") || RESERVED_CHILD_ROOT_SYSTEM_KEYS.has(parent.slug))
    ) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    return parent;
  }

  async function create(companyId: string, input: CreateFolder): Promise<Folder> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).create(companyId, input));
    }
    const parentId = input.parentId ?? null;
    const parent = await validateParent(companyId, input.kind, parentId);
    if ((parent?.depth ?? 0) + 1 > MAX_FOLDER_DEPTH) {
      throw unprocessable(`Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`);
    }
    const name = normalizeName(input.name);
    const slug = input.slug ?? normalizeFolderSlug(name);
    if (isReservedRootSlug(input.kind, parentId, slug)) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    await assertNoSlugConflict(companyId, input.kind, parentId, slug);
    const position = input.position ?? await nextPosition(companyId, input.kind, parentId);
    let row: FolderRow;
    try {
      row = await db
        .insert(folders)
        .values({ companyId, kind: input.kind, parentId, name, slug, color: normalizeColor(input.color) ?? null, position })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return (await getFolder(companyId, row.id))!;
  }

  async function update(companyId: string, folderId: string, patch: UpdateFolder): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).update(companyId, folderId, patch));
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    const slug = patch.slug ?? (patch.name === undefined ? existing.slug : normalizeFolderSlug(name));
    if (isReservedRootSlug(existing.kind, existing.parentId, slug)) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    await assertNoSlugConflict(companyId, existing.kind, existing.parentId, slug, existing.id);
    try {
      await db
        .update(folders)
        .set({
          name,
          slug,
          color: patch.color === undefined ? existing.color : normalizeColor(patch.color),
          position: patch.position ?? existing.position,
          updatedAt: new Date(),
        })
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return getFolder(companyId, folderId);
  }

  function descendantIdsFromRows(rows: FolderRow[], folderId: string) {
    if (!rows.some((row) => row.id === folderId)) throw notFound("Folder not found");
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
    }
    const result = new Set([folderId]);
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const childId of children.get(current) ?? []) {
        if (result.has(childId)) throw unprocessable("Folder hierarchy contains a cycle");
        result.add(childId);
        queue.push(childId);
      }
    }
    return result;
  }

  async function descendantIds(companyId: string, kind: FolderKind, folderId: string) {
    return descendantIdsFromRows(await getRows(companyId, kind), folderId);
  }

  async function moveFolder(companyId: string, folderId: string, input: MoveFolder): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).moveFolder(companyId, folderId, input));
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
    if (parentId === existing.id) throw unprocessable("A folder cannot be its own parent");
    const rows = await getRows(companyId, existing.kind);
    const descendants = descendantIdsFromRows(rows, existing.id);
    if (parentId && descendants.has(parentId)) throw unprocessable("A folder cannot be moved into its own subtree");
    const parent = await validateParent(companyId, existing.kind, parentId);
    const views = buildFolderViews(rows);
    const relativeDepth = Math.max(...Array.from(descendants).map((id) => views.get(id)!.depth - existing.depth + 1));
    if ((parent?.depth ?? 0) + relativeDepth > MAX_FOLDER_DEPTH) {
      throw unprocessable(`Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`);
    }
    if (isReservedRootSlug(existing.kind, parentId, existing.slug)) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    await assertNoSlugConflict(companyId, existing.kind, parentId, existing.slug, existing.id);
    try {
      await db
        .update(folders)
        .set({ parentId, position: input.position, updatedAt: new Date() })
        .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      if (isPostgresError(error, "23503")) throw conflict("Parent folder changed during move");
      throw error;
    }
    return getFolder(companyId, folderId);
  }

  async function deleteFolder(companyId: string, folderId: string): Promise<Folder | null> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).deleteFolder(companyId, folderId));
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const child = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.parentId, folderId)))
      .then((rows) => rows[0] ?? null);
    if (child) throw conflict("Move or delete nested folders first");
    try {
      await db.delete(folders).where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23503")) throw conflict("Move or delete nested folders first");
      throw error;
    }
    return existing;
  }

  async function validateSkillFolder(companyId: string, folderId: string, options?: { allowBundled?: boolean }) {
    const folder = await getFolder(companyId, folderId);
    if (!folder || folder.kind !== "skill") throw notFound("Skill folder not found");
    if (!options?.allowBundled && await isBundledFolder(companyId, folder.id)) {
      throw forbidden("Bundled folders are read-only");
    }
    return folder;
  }

  async function moveItem(companyId: string, input: MoveFolderItem) {
    if (input.folderId) {
      const target = await getFolder(companyId, input.folderId);
      if (!target) throw notFound("Folder not found");
      if (target.kind !== input.kind) throw unprocessable("Folder kind must match item kind");
      if (await isBundledFolder(companyId, target.id)) throw forbidden("Bundled folders are read-only");
    }
    if (input.kind === "routine") {
      const row = await db
        .update(routines)
        .set({ folderId: input.folderId ?? null, updatedAt: new Date() })
        .where(and(eq(routines.companyId, companyId), eq(routines.id, input.itemId)))
        .returning({ id: routines.id, folderId: routines.folderId })
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Routine not found");
      return { kind: input.kind, itemId: row.id, folderId: row.folderId ?? null };
    }
    const existing = await db
      .select({ id: companySkills.id, folderId: companySkills.folderId })
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, input.itemId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Skill not found");
    if (existing.folderId && await isBundledFolder(companyId, existing.folderId)) {
      throw forbidden("Bundled skills cannot be moved");
    }
    const row = await db
      .update(companySkills)
      .set({ folderId: input.folderId ?? null, updatedAt: new Date() })
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, input.itemId)))
      .returning({ id: companySkills.id, folderId: companySkills.folderId })
      .then((rows) => rows[0]!);
    return { kind: input.kind, itemId: row.id, folderId: row.folderId ?? null };
  }

  async function uniqueSiblingSlug(companyId: string, parentId: string | null, baseSlug: string, stableSuffix: string) {
    const siblingSlugs = new Set(await db
      .select({ slug: folders.slug })
      .from(folders)
      .where(and(
        eq(folders.companyId, companyId),
        eq(folders.kind, "skill"),
        parentId === null ? sql`${folders.parentId} is null` : eq(folders.parentId, parentId),
      ))
      .then((rows) => rows.map((row) => row.slug)));
    if (!siblingSlugs.has(baseSlug)) return baseSlug;
    const suffix = normalizeFolderSlug(stableSuffix).slice(0, 24);
    let candidate = `${baseSlug}-${suffix}`;
    let duplicateNumber = 2;
    while (siblingSlugs.has(candidate)) {
      candidate = `${baseSlug}-${suffix}-${duplicateNumber}`;
      duplicateNumber += 1;
    }
    return candidate;
  }

  async function findSystemFolder(companyId: string, systemKey: string) {
    return db
      .select()
      .from(folders)
      .where(and(
        eq(folders.companyId, companyId),
        eq(folders.kind, "skill"),
        eq(folders.systemKey, systemKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function insertSystemFolder(input: {
    companyId: string;
    parentId: string | null;
    name: string;
    slug: string;
    systemKey: string;
  }) {
    const inserted = await db
      .insert(folders)
      .values({
        companyId: input.companyId,
        kind: "skill",
        parentId: input.parentId,
        name: input.name,
        slug: input.slug,
        systemKey: input.systemKey,
        position: await nextPosition(input.companyId, "skill", input.parentId),
      })
      .onConflictDoNothing()
      .returning({ id: folders.id })
      .then((rows) => rows[0] ?? null);
    if (inserted) return (await getFolder(input.companyId, inserted.id))!;
    const existing = await findSystemFolder(input.companyId, input.systemKey);
    return existing ? (await getFolder(input.companyId, existing.id))! : null;
  }

  async function ensureContainer(companyId: string, slug: "bundled" | "my" | "projects", name: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingSystem = await findSystemFolder(companyId, slug);
      if (existingSystem) return (await getFolder(companyId, existingSystem.id))!;
      const squatted = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(
          eq(folders.companyId, companyId),
          eq(folders.kind, "skill"),
          sql`${folders.parentId} is null`,
          eq(folders.slug, slug),
        ))
        .then((rows) => rows[0] ?? null);
      if (squatted) {
        await db
          .update(folders)
          .set({ slug: await uniqueSiblingSlug(companyId, null, slug, squatted.id.slice(0, 8)), updatedAt: new Date() })
          .where(and(eq(folders.companyId, companyId), eq(folders.id, squatted.id)));
      }
      const created = await insertSystemFolder({ companyId, parentId: null, name, slug, systemKey: slug });
      if (created) return created;
    }
    throw conflict(`Could not create ${name} folder`);
  }

  async function uniqueSystemSlug(
    companyId: string,
    parentId: string,
    baseSlug: string,
    systemKey: string,
    stableSuffix = systemKey.split(":").at(-1) ?? systemKey,
  ) {
    const existingSystem = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, "skill"), eq(folders.systemKey, systemKey)))
      .then((rows) => rows[0] ?? null);
    if (existingSystem) return { id: existingSystem.id, slug: null };
    return {
      id: null,
      slug: await uniqueSiblingSlug(companyId, parentId, baseSlug, stableSuffix),
    };
  }

  async function ensureMyFolder(companyId: string, userId: string, userName: string | null, requestedSlug?: string | null): Promise<Folder> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).ensureMyFolder(companyId, userId, userName, requestedSlug));
    }
    const parent = await ensureContainer(companyId, "my", "My Skills");
    const systemKey = `my:${userId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolved = await uniqueSystemSlug(companyId, parent.id, requestedSlug ?? normalizeFolderSlug(userName ?? userId), systemKey);
      if (resolved.id) return (await getFolder(companyId, resolved.id))!;
      const created = await insertSystemFolder({
        companyId,
        parentId: parent.id,
        name: userName?.trim() || "My Skills",
        slug: resolved.slug!,
        systemKey,
      });
      if (created) return created;
    }
    throw conflict("Could not create personal skill folder");
  }

  async function ensureProjectFolder(companyId: string, projectId: string, projectName: string): Promise<Folder> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).ensureProjectFolder(companyId, projectId, projectName));
    }
    const parent = await ensureContainer(companyId, "projects", "Projects");
    const systemKey = `project:${projectId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolved = await uniqueSystemSlug(companyId, parent.id, normalizeFolderSlug(projectName), systemKey);
      if (resolved.id) return (await getFolder(companyId, resolved.id))!;
      const created = await insertSystemFolder({
        companyId,
        parentId: parent.id,
        name: projectName,
        slug: resolved.slug!,
        systemKey,
      });
      if (created) return created;
    }
    throw conflict("Could not create project skill folder");
  }

  async function ensureBundledCategory(companyId: string, category: string): Promise<Folder> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).ensureBundledCategory(companyId, category));
    }
    const root = await ensureContainer(companyId, "bundled", "Bundled");
    const name = normalizeName(category);
    const slug = normalizeFolderSlug(category);
    const systemKey = `bundled:${slug}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolved = await uniqueSystemSlug(companyId, root.id, slug, systemKey, "bundled");
      if (resolved.id) {
        const existing = await getFolder(companyId, resolved.id);
        if (!existing) continue;
        if (existing.name === name) return existing;
        await db
          .update(folders)
          .set({ name, updatedAt: new Date() })
          .where(and(eq(folders.companyId, companyId), eq(folders.id, existing.id)));
        return (await getFolder(companyId, existing.id))!;
      }
      const created = await insertSystemFolder({
        companyId,
        parentId: root.id,
        name,
        slug: resolved.slug!,
        systemKey,
      });
      if (created) return created;
    }
    throw conflict("Could not create bundled skill folder");
  }

  async function pruneEmptyBundledCategories(companyId: string, retainedCategories: string[]): Promise<void> {
    if (!mutationLockHeld) {
      return withCompanyFolderLock(companyId, (lockedDb) => folderService(lockedDb, true).pruneEmptyBundledCategories(companyId, retainedCategories));
    }
    const root = await findSystemFolder(companyId, "bundled");
    if (!root) return;
    const rows = await getRows(companyId, "skill");
    const retainedSystemKeys = new Set(
      retainedCategories.map((category) => `bundled:${normalizeFolderSlug(category)}`),
    );
    const usedFolderIds = new Set(
      await db
        .select({ folderId: companySkills.folderId })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId))
        .then((skills) => skills.flatMap((skill) => skill.folderId ? [skill.folderId] : [])),
    );
    const parentIds = new Set(rows.flatMap((row) => row.parentId ? [row.parentId] : []));
    for (const row of rows) {
      if (row.parentId !== root.id || !row.systemKey?.startsWith("bundled:")) continue;
      if (retainedSystemKeys.has(row.systemKey) || usedFolderIds.has(row.id) || parentIds.has(row.id)) continue;
      await db.delete(folders).where(and(eq(folders.companyId, companyId), eq(folders.id, row.id)));
    }
  }

  return {
    list,
    create,
    update,
    moveFolder,
    deleteFolder,
    moveItem,
    getFolder,
    descendantIds,
    validateSkillFolder,
    ensureMyFolder,
    ensureProjectFolder,
    ensureBundledCategory,
    pruneEmptyBundledCategories,
  };
}
