import { and, asc, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFolders, agents } from "@paperclipai/db";
import type {
  AgentFolder,
  AgentFolderListItem,
  AgentFolderListResult,
  CreateAgentFolder,
  MoveAgentFolder,
  UpdateAgentFolder,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveFolderInstructionsDir } from "./agent-instructions-inheritance.js";

type AgentFolderRow = typeof agentFolders.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function isPostgresError(error: unknown, code: string) {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === code
  );
}

const AGENTS_ENTRY = "AGENTS.md";

function normalizeName(name: string) {
  return name.trim();
}

export function normalizeAgentFolderSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "folder";
}

interface FolderView {
  path: string;
  depth: number;
}

function buildFolderViews(rows: AgentFolderRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const views = new Map<string, FolderView>();
  const visiting = new Set<string>();

  function resolve(row: AgentFolderRow): FolderView {
    const existing = views.get(row.id);
    if (existing) return existing;
    if (visiting.has(row.id)) throw unprocessable("Folder hierarchy contains a cycle");
    visiting.add(row.id);
    const parent = row.parentId ? byId.get(row.parentId) : null;
    if (row.parentId && !parent) throw unprocessable("Folder hierarchy contains an invalid parent");
    const parentView = parent ? resolve(parent) : null;
    const view: FolderView = {
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

function toAgentFolder(row: AgentFolderRow, views: Map<string, FolderView>): AgentFolder {
  const view = views.get(row.id) ?? { path: row.slug, depth: 0 };
  return {
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId ?? null,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function agentFolderService(db: Db, mutationLockHeld = false) {
  function withLock<T>(companyId: string, operation: (lockedDb: Db) => Promise<T>) {
    if (mutationLockHeld) return operation(db);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:agent-folders:${companyId}`}, 0))`);
      return operation(tx as unknown as Db);
    });
  }

  async function getRows(companyId: string) {
    return db
      .select()
      .from(agentFolders)
      .where(eq(agentFolders.companyId, companyId))
      .orderBy(asc(agentFolders.sortOrder), asc(agentFolders.name), asc(agentFolders.id));
  }

  async function getRawRow(companyId: string, folderId: string) {
    return db
      .select()
      .from(agentFolders)
      .where(and(eq(agentFolders.companyId, companyId), eq(agentFolders.id, folderId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getFolder(companyId: string, folderId: string): Promise<AgentFolder | null> {
    const row = await getRawRow(companyId, folderId);
    if (!row) return null;
    const views = buildFolderViews(await getRows(companyId));
    return toAgentFolder(row, views);
  }

  async function assertNoSlugConflict(
    companyId: string,
    parentId: string | null,
    slug: string,
    excludeFolderId?: string,
  ) {
    const existing = await db
      .select({ id: agentFolders.id })
      .from(agentFolders)
      .where(
        and(
          eq(agentFolders.companyId, companyId),
          parentId === null
            ? sql`${agentFolders.parentId} is null`
            : eq(agentFolders.parentId, parentId),
          eq(agentFolders.slug, slug),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing && existing.id !== excludeFolderId) {
      throw conflict("Folder slug already exists under this parent");
    }
  }

  async function nextSortOrder(companyId: string, parentId: string | null) {
    const row = await db
      .select({ value: max(agentFolders.sortOrder) })
      .from(agentFolders)
      .where(
        and(
          eq(agentFolders.companyId, companyId),
          parentId === null
            ? sql`${agentFolders.parentId} is null`
            : eq(agentFolders.parentId, parentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Number(row?.value ?? -1) + 1;
  }

  function descendantIdsFromRows(rows: AgentFolderRow[], folderId: string) {
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

  async function descendantIds(companyId: string, folderId: string) {
    const rows = await getRows(companyId);
    return descendantIdsFromRows(rows, folderId);
  }

  async function list(companyId: string): Promise<AgentFolderListResult> {
    const rows = await getRows(companyId);
    const views = buildFolderViews(rows);
    const agentCounts = await db
      .select({
        folderId: agents.folderId,
        count: sql<number>`count(*)::int`,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .groupBy(agents.folderId)
      .then((rows) => new Map(rows.map((r) => [r.folderId ?? null, Number(r.count ?? 0)])));

    const folders: AgentFolderListItem[] = rows.map((row): AgentFolderListItem => {
      const view = views.get(row.id) ?? { path: row.slug, depth: 0 };
      const allRows = rows;
      const descendantCount = Array.from(descendantIdsFromRows(allRows, row.id)).length - 1;
      return {
        id: row.id,
        companyId: row.companyId,
        parentId: row.parentId ?? null,
        name: row.name,
        slug: row.slug,
        sortOrder: row.sortOrder,
        metadata: row.metadata ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        agentCount: agentCounts.get(row.id) ?? 0,
        descendantCount,
      };
    });

    return { folders, totalCount: rows.length };
  }

  async function create(companyId: string, input: CreateAgentFolder): Promise<AgentFolder> {
    if (!mutationLockHeld) {
      return withLock(companyId, (lockedDb) =>
        agentFolderService(lockedDb, true).create(companyId, input),
      );
    }
    if (input.parentId) {
      const parent = await getFolder(companyId, input.parentId);
      if (!parent) throw notFound("Parent folder not found");
    }
    const parentId = input.parentId ?? null;
    const name = normalizeName(input.name);
    const slug = input.slug ?? normalizeAgentFolderSlug(name);
    if (!slug || slug.trim() === "") throw unprocessable("Slug cannot be empty");
    await assertNoSlugConflict(companyId, parentId, slug);
    const sortOrder = input.sortOrder ?? (await nextSortOrder(companyId, parentId));
    let row: AgentFolderRow;
    try {
      row = await db
        .insert(agentFolders)
        .values({
          companyId,
          parentId,
          name,
          slug,
          sortOrder,
          metadata: input.metadata ?? {},
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return (await getFolder(companyId, row.id))!;
  }

  async function get(companyId: string, folderId: string): Promise<AgentFolder | null> {
    return getFolder(companyId, folderId);
  }

  async function update(
    companyId: string,
    folderId: string,
    patch: UpdateAgentFolder,
  ): Promise<AgentFolder | null> {
    if (!mutationLockHeld) {
      return withLock(companyId, (lockedDb) =>
        agentFolderService(lockedDb, true).update(companyId, folderId, patch),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    const parentId = existing.parentId ?? null;
    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    const slug = patch.slug ?? null;
    if (slug && slug !== existing.slug) {
      await assertNoSlugConflict(companyId, parentId, slug, folderId);
    }
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) setClause["name"] = name;
    if (patch.slug !== undefined) setClause["slug"] = slug ?? existing.slug;
    if (patch.sortOrder !== undefined) setClause["sort_order"] = patch.sortOrder;
    if (patch.metadata !== undefined) setClause["metadata"] = patch.metadata ?? {};

    try {
      await db
        .update(agentFolders)
        .set(setClause as Record<string, unknown>)
        .where(and(eq(agentFolders.companyId, companyId), eq(agentFolders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      throw error;
    }
    return (await getFolder(companyId, folderId))!;
  }

  async function moveFolder(
    companyId: string,
    folderId: string,
    input: MoveAgentFolder,
  ): Promise<AgentFolder | null> {
    if (!mutationLockHeld) {
      return withLock(companyId, (lockedDb) =>
        agentFolderService(lockedDb, true).moveFolder(companyId, folderId, input),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
    if (parentId === folderId) throw unprocessable("A folder cannot be its own parent");
    const rows = await getRows(companyId);
    const descendants = descendantIdsFromRows(rows, folderId);
    if (parentId && descendants.has(parentId)) {
      throw unprocessable("A folder cannot be moved into its own subtree");
    }
    if (parentId) {
      const parent = await getFolder(companyId, parentId);
      if (!parent) throw notFound("Parent folder not found");
    }
    const sameSlugSiblings = await db
      .select({ slug: agentFolders.slug })
      .from(agentFolders)
      .where(
        and(
          eq(agentFolders.companyId, companyId),
          parentId === null ? sql`${agentFolders.parentId} is null` : eq(agentFolders.parentId, parentId),
          ne(agentFolders.id, folderId),
        ),
      )
      .then((rows) => new Set(rows.map((r) => r.slug)));
    const adjustedSlug = sameSlugSiblings.has(existing.slug)
      ? `${existing.slug}-${folderId.slice(0, 8)}`
      : existing.slug;
    try {
      const setClause: Record<string, unknown> = {
        parentId: parentId ?? null,
        sortOrder: input.sortOrder,
        updatedAt: new Date(),
      };
      if (adjustedSlug !== existing.slug) setClause["slug"] = adjustedSlug;
      await db
        .update(agentFolders)
        .set(setClause as Record<string, unknown>)
        .where(and(eq(agentFolders.companyId, companyId), eq(agentFolders.id, folderId)));
    } catch (error) {
      if (isPostgresError(error, "23505")) throw conflict("Folder slug already exists under this parent");
      if (isPostgresError(error, "23503")) throw conflict("Parent folder changed during move");
      throw error;
    }
    return (await getFolder(companyId, folderId))!;
  }

  async function deleteFolder(
    companyId: string,
    folderId: string,
    options?: { force?: boolean },
  ): Promise<AgentFolder | null> {
    if (!mutationLockHeld) {
      return withLock(companyId, (lockedDb) =>
        agentFolderService(lockedDb, true).deleteFolder(companyId, folderId, options),
      );
    }
    const existing = await getFolder(companyId, folderId);
    if (!existing) return null;
    const child = await db
      .select({ id: agentFolders.id })
      .from(agentFolders)
      .where(
        and(
          eq(agentFolders.companyId, companyId),
          eq(agentFolders.parentId, folderId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (child && !options?.force) {
      throw conflict("Move or delete nested folders first (use force=true to delete recursively)");
    }
    if (options?.force && child) {
      // Recursively delete all child folders
      const descendants = await descendantIds(companyId, folderId);
      await db
        .delete(agentFolders)
        .where(
          and(
            eq(agentFolders.companyId, companyId),
            inArray(agentFolders.id, Array.from(descendants)),
          ),
        );
    }
    await db
      .update(agents)
      .set({ folderId: null, updatedAt: new Date() })
      .where(and(eq(agents.companyId, companyId), eq(agents.folderId, folderId)));
    await db
      .delete(agentFolders)
      .where(and(eq(agentFolders.companyId, companyId), eq(agentFolders.id, folderId)));
    return existing;
  }

  async function assignAgents(
    companyId: string,
    folderId: string,
    agentIds: string[],
  ): Promise<void> {
    const folder = await getFolder(companyId, folderId);
    if (!folder) throw notFound("Folder not found");
    const validAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    if (validAgents.length !== agentIds.length) {
      throw notFound("One or more agents not found");
    }
    await withLock(companyId, (lockedDb) =>
      lockedDb
        .update(agents)
        .set({ folderId, updatedAt: new Date() })
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))),
    );
  }

  async function unassignAgent(companyId: string, agentId: string): Promise<void> {
    await db
      .update(agents)
      .set({ folderId: null, updatedAt: new Date() })
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  }

  async function listAgentsInFolder(
    companyId: string,
    folderId: string,
  ): Promise<Pick<AgentRow, "id" | "name" | "adapterType" | "status" | "folderId">[]> {
    const descendants = await descendantIds(companyId, folderId);
    const descendantFolderIds = Array.from(descendants);
    return db
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        status: agents.status,
        folderId: agents.folderId,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          inArray(agents.folderId, descendantFolderIds),
        ),
      )
      .orderBy(asc(agents.name));
  }

  async function getInstructionsBundle(companyId: string, folderId: string, filePath: string | null) {
    const folder = await getFolder(companyId, folderId);
    if (!folder) return null;

    const resolvedPath = filePath ?? AGENTS_ENTRY;
    // Containment guard: `resolvedPath` is caller-supplied (?path= query). Reject
    // absolute paths or any `..` traversal so a request cannot read files outside
    // a folder's instructions directory. Validated once — it is reused for the
    // folder and every ancestor dir below.
    const normalizedRelPath = path.normalize(resolvedPath);
    if (
      path.isAbsolute(normalizedRelPath) ||
      normalizedRelPath === ".." ||
      normalizedRelPath.startsWith(".." + path.sep)
    ) {
      throw unprocessable("Instructions path must stay within the folder's instructions directory");
    }
    const ownDir = resolveFolderInstructionsDir(companyId, folderId);
    const ownFile = path.join(ownDir, normalizedRelPath);

    let ownContent: string | null = null;
    try {
      ownContent = await fs.readFile(ownFile, "utf-8");
    } catch {
      ownContent = null;
    }

    // Walk the parent chain leaf→root to gather inherited instructions.
    const inherited: Array<{ folderId: string; folderName: string; content: string | null }> = [];
    let currentId: string | null = folder.parentId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const ancestor = await getFolder(companyId, currentId);
      if (!ancestor) break;
      const ancestorDir = resolveFolderInstructionsDir(companyId, ancestor.id);
      const ancestorFile = path.join(ancestorDir, normalizedRelPath);
      let ancestorContent: string | null = null;
      try {
        ancestorContent = await fs.readFile(ancestorFile, "utf-8");
      } catch {
        ancestorContent = null;
      }
      inherited.push({ folderId: ancestor.id, folderName: ancestor.name, content: ancestorContent });
      currentId = ancestor.parentId;
    }

    return {
      folderId: folder.id,
      folderName: folder.name,
      content: ownContent,
      inherited,
    };
  }

  return {
    list,
    get,
    create,
    update,
    moveFolder,
    deleteFolder,
    assignAgents,
    unassignAgent,
    listAgentsInFolder,
    descendantIds,
    getInstructionsBundle,
  };
}
