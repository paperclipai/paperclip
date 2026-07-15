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

export function folderService(db: Db) {
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
    const row = await db
      .insert(folders)
      .values({ companyId, kind: input.kind, parentId, name, slug, color: normalizeColor(input.color) ?? null, position })
      .returning()
      .then((rows) => rows[0]!);
    return (await getFolder(companyId, row.id))!;
  }

  async function update(companyId: string, folderId: string, patch: UpdateFolder): Promise<Folder | null> {
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    const slug = patch.slug ?? (patch.name === undefined ? existing.slug : normalizeFolderSlug(name));
    if (isReservedRootSlug(existing.kind, existing.parentId, slug)) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    await assertNoSlugConflict(companyId, existing.kind, existing.parentId, slug, existing.id);
    await db
      .update(folders)
      .set({
        name,
        slug,
        color: normalizeColor(patch.color) ?? existing.color,
        position: patch.position ?? existing.position,
        updatedAt: new Date(),
      })
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    return getFolder(companyId, folderId);
  }

  async function descendantIds(companyId: string, kind: FolderKind, folderId: string) {
    const rows = await getRows(companyId, kind);
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

  async function moveFolder(companyId: string, folderId: string, input: MoveFolder): Promise<Folder | null> {
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
    if (parentId === existing.id) throw unprocessable("A folder cannot be its own parent");
    const descendants = await descendantIds(companyId, existing.kind, existing.id);
    if (parentId && descendants.has(parentId)) throw unprocessable("A folder cannot be moved into its own subtree");
    const parent = await validateParent(companyId, existing.kind, parentId);
    const rows = await getRows(companyId, existing.kind);
    const views = buildFolderViews(rows);
    const relativeDepth = Math.max(...Array.from(descendants).map((id) => views.get(id)!.depth - existing.depth + 1));
    if ((parent?.depth ?? 0) + relativeDepth > MAX_FOLDER_DEPTH) {
      throw unprocessable(`Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`);
    }
    if (isReservedRootSlug(existing.kind, parentId, existing.slug)) {
      throw forbidden("Reserved skill folders are system-managed");
    }
    await assertNoSlugConflict(companyId, existing.kind, parentId, existing.slug, existing.id);
    await db
      .update(folders)
      .set({ parentId, position: input.position, updatedAt: new Date() })
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
    return getFolder(companyId, folderId);
  }

  async function deleteFolder(companyId: string, folderId: string): Promise<Folder | null> {
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    await assertMutableFolder(companyId, existing);
    const child = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.parentId, folderId)))
      .then((rows) => rows[0] ?? null);
    if (child) throw conflict("Move or delete nested folders first");
    await db.delete(folders).where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)));
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

  async function ensureContainer(companyId: string, slug: "my" | "projects", name: string) {
    const existingSystem = await db
      .select()
      .from(folders)
      .where(and(
        eq(folders.companyId, companyId),
        eq(folders.kind, "skill"),
        eq(folders.systemKey, slug),
      ))
      .then((rows) => rows[0] ?? null);
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
    const row = await db
      .insert(folders)
      .values({ companyId, kind: "skill", parentId: null, name, slug, systemKey: slug, position: await nextPosition(companyId, "skill", null) })
      .returning({ id: folders.id })
      .then((rows) => rows[0]!);
    return (await getFolder(companyId, row.id))!;
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

  async function ensureMyFolder(companyId: string, userId: string, userName: string | null, requestedSlug?: string | null) {
    const parent = await ensureContainer(companyId, "my", "My Skills");
    const systemKey = `my:${userId}`;
    const resolved = await uniqueSystemSlug(companyId, parent.id, requestedSlug ?? normalizeFolderSlug(userName ?? userId), systemKey);
    if (resolved.id) return (await getFolder(companyId, resolved.id))!;
    const row = await db
      .insert(folders)
      .values({
        companyId,
        kind: "skill",
        parentId: parent.id,
        name: userName?.trim() || "My Skills",
        slug: resolved.slug!,
        systemKey,
        position: await nextPosition(companyId, "skill", parent.id),
      })
      .returning({ id: folders.id })
      .then((rows) => rows[0]!);
    return (await getFolder(companyId, row.id))!;
  }

  async function ensureProjectFolder(companyId: string, projectId: string, projectName: string) {
    const parent = await ensureContainer(companyId, "projects", "Projects");
    const systemKey = `project:${projectId}`;
    const resolved = await uniqueSystemSlug(companyId, parent.id, normalizeFolderSlug(projectName), systemKey);
    if (resolved.id) return (await getFolder(companyId, resolved.id))!;
    const row = await db
      .insert(folders)
      .values({
        companyId,
        kind: "skill",
        parentId: parent.id,
        name: projectName,
        slug: resolved.slug!,
        systemKey,
        position: await nextPosition(companyId, "skill", parent.id),
      })
      .returning({ id: folders.id })
      .then((rows) => rows[0]!);
    return (await getFolder(companyId, row.id))!;
  }

  async function ensureBundledCategory(companyId: string, category: string) {
    let root = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.kind, "skill"), eq(folders.systemKey, "bundled")))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      const squatted = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(
          eq(folders.companyId, companyId),
          eq(folders.kind, "skill"),
          sql`${folders.parentId} is null`,
          eq(folders.slug, "bundled"),
        ))
        .then((rows) => rows[0] ?? null);
      if (squatted) {
        await db
          .update(folders)
          .set({ slug: await uniqueSiblingSlug(companyId, null, "bundled", squatted.id.slice(0, 8)), updatedAt: new Date() })
          .where(and(eq(folders.companyId, companyId), eq(folders.id, squatted.id)));
      }
      root = await db
        .insert(folders)
        .values({ companyId, kind: "skill", parentId: null, name: "Bundled", slug: "bundled", systemKey: "bundled", position: await nextPosition(companyId, "skill", null) })
        .returning({ id: folders.id })
        .then((rows) => rows[0]!);
    }
    const slug = normalizeFolderSlug(category);
    const systemKey = `bundled:${slug}`;
    const resolved = await uniqueSystemSlug(companyId, root.id, slug, systemKey, "bundled");
    if (resolved.id) return (await getFolder(companyId, resolved.id))!;
    const row = await db
      .insert(folders)
      .values({ companyId, kind: "skill", parentId: root.id, name: category, slug: resolved.slug!, systemKey, position: await nextPosition(companyId, "skill", root.id) })
      .returning({ id: folders.id })
      .then((rows) => rows[0]!);
    return (await getFolder(companyId, row.id))!;
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
  };
}
