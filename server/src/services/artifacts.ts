import { and, eq, desc, asc, like, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifactFolders, artifacts, assets } from "@paperclipai/db";
import type { Artifact, ArtifactFolder, ArtifactFolderTreeNode } from "@paperclipai/shared";

type ArtifactFolderRow = typeof artifactFolders.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;

function toArtifactFolder(row: ArtifactFolderRow): ArtifactFolder {
  return {
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId ?? null,
    name: row.name,
    path: row.path,
    sourceType: row.sourceType as ArtifactFolder["sourceType"],
    sourceId: row.sourceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    companyId: row.companyId,
    folderId: row.folderId,
    assetId: row.assetId,
    title: row.title,
    description: row.description ?? null,
    mimeType: row.mimeType,
    issueId: row.issueId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePath(p: string): string {
  const segments = p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  return "/" + segments.join("/") + "/";
}

function buildTree(folders: ArtifactFolder[], fileCounts: Map<string, number>): ArtifactFolderTreeNode[] {
  const map = new Map<string, ArtifactFolderTreeNode>();
  for (const f of folders) {
    map.set(f.id, { ...f, children: [], fileCount: fileCounts.get(f.id) ?? 0 });
  }
  const roots: ArtifactFolderTreeNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export interface ListArtifactsFilters {
  folderId?: string;
  issueId?: string;
  agentId?: string;
  mimeType?: string;
  search?: string;
  sort?: "name" | "createdAt" | "size";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export function artifactService(db: Db) {
  return {
    // ── Folder operations ──

    listFolderTree: async (companyId: string): Promise<ArtifactFolderTreeNode[]> => {
      const folderRows = await db
        .select()
        .from(artifactFolders)
        .where(eq(artifactFolders.companyId, companyId))
        .orderBy(asc(artifactFolders.path));
      const folders = folderRows.map(toArtifactFolder);

      // Count files per folder
      const countRows = await db
        .select({
          folderId: artifacts.folderId,
          count: sql<number>`count(*)::int`,
        })
        .from(artifacts)
        .where(eq(artifacts.companyId, companyId))
        .groupBy(artifacts.folderId);
      const fileCounts = new Map(countRows.map((r) => [r.folderId, r.count]));

      return buildTree(folders, fileCounts);
    },

    getFolderById: async (id: string, companyId?: string): Promise<ArtifactFolder | null> => {
      const conditions = [eq(artifactFolders.id, id)];
      if (companyId) conditions.push(eq(artifactFolders.companyId, companyId));
      const row = await db
        .select()
        .from(artifactFolders)
        .where(and(...conditions))
        .then((rows) => rows[0] ?? null);
      return row ? toArtifactFolder(row) : null;
    },

    createFolder: async (
      companyId: string,
      data: { parentId?: string | null; name: string } | { path: string },
    ): Promise<ArtifactFolder> => {
      if ("path" in data) {
        // Create from path — ensure all intermediaries exist
        const normalized = normalizePath(data.path);
        const segments = normalized.split("/").filter((s) => s.length > 0);
        let currentPath = "/";
        let parentId: string | null = null;
        let lastFolder: ArtifactFolder | null = null;

        for (const segment of segments) {
          currentPath += segment + "/";
          const existing = await db
            .select()
            .from(artifactFolders)
            .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.path, currentPath)))
            .then((rows) => rows[0] ?? null);

          if (existing) {
            parentId = existing.id;
            lastFolder = toArtifactFolder(existing);
          } else {
            const inserted: ArtifactFolderRow = await db
              .insert(artifactFolders)
              .values({
                companyId,
                parentId,
                name: segment,
                path: currentPath,
                sourceType: "custom",
              })
              .returning()
              .then((rows) => rows[0]);
            parentId = inserted.id;
            lastFolder = toArtifactFolder(inserted);
          }
        }

        return lastFolder!;
      }

      // Create from parentId + name
      let parentPath = "/";
      if (data.parentId) {
        const parent = await db
          .select()
          .from(artifactFolders)
          .where(and(eq(artifactFolders.id, data.parentId), eq(artifactFolders.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (parent) parentPath = parent.path;
      }

      const path = parentPath + data.name + "/";
      const row = await db
        .insert(artifactFolders)
        .values({
          companyId,
          parentId: data.parentId ?? null,
          name: data.name,
          path,
          sourceType: "custom",
        })
        .returning()
        .then((rows) => rows[0]);
      return toArtifactFolder(row);
    },

    updateFolder: async (
      id: string,
      companyId: string,
      patch: { name?: string; parentId?: string | null },
    ): Promise<ArtifactFolder | null> => {
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(artifactFolders)
          .where(and(eq(artifactFolders.id, id), eq(artifactFolders.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const newName = patch.name ?? existing.name;
        const newParentId = patch.parentId !== undefined ? patch.parentId : existing.parentId;

        // Compute new path
        let parentPath = "/";
        if (newParentId) {
          const parent = await tx
            .select()
            .from(artifactFolders)
            .where(eq(artifactFolders.id, newParentId))
            .then((rows) => rows[0] ?? null);
          if (parent) parentPath = parent.path;
        }
        const newPath = parentPath + newName + "/";
        const oldPath = existing.path;

        // Update this folder
        const updated = await tx
          .update(artifactFolders)
          .set({ name: newName, parentId: newParentId, path: newPath, updatedAt: new Date() })
          .where(eq(artifactFolders.id, id))
          .returning()
          .then((rows) => rows[0]);

        // Update all descendant paths
        if (oldPath !== newPath) {
          const descendants = await tx
            .select()
            .from(artifactFolders)
            .where(
              and(
                eq(artifactFolders.companyId, companyId),
                like(artifactFolders.path, oldPath + "%"),
                sql`${artifactFolders.id} != ${id}`,
              ),
            );

          for (const d of descendants) {
            const updatedPath = newPath + d.path.slice(oldPath.length);
            await tx
              .update(artifactFolders)
              .set({ path: updatedPath, updatedAt: new Date() })
              .where(eq(artifactFolders.id, d.id));
          }
        }

        return toArtifactFolder(updated);
      });
    },

    deleteFolder: async (id: string, companyId: string, recursive: boolean): Promise<boolean> => {
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(artifactFolders)
          .where(and(eq(artifactFolders.id, id), eq(artifactFolders.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!existing) return false;

        if (recursive) {
          // Delete all descendants (files + subfolders)
          const descendantFolders = await tx
            .select({ id: artifactFolders.id })
            .from(artifactFolders)
            .where(
              and(eq(artifactFolders.companyId, companyId), like(artifactFolders.path, existing.path + "%")),
            );
          const allFolderIds = [id, ...descendantFolders.map((d) => d.id)];

          await tx.delete(artifacts).where(inArray(artifacts.folderId, allFolderIds));
          await tx.delete(artifactFolders).where(inArray(artifactFolders.id, allFolderIds));
        } else {
          // Check if empty
          const childCount = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(artifactFolders)
            .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.parentId, id)))
            .then((rows) => rows[0]?.count ?? 0);
          const fileCount = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(artifacts)
            .where(eq(artifacts.folderId, id))
            .then((rows) => rows[0]?.count ?? 0);

          if (childCount > 0 || fileCount > 0) {
            throw new Error("Folder is not empty. Use recursive=true to delete with contents.");
          }

          await tx.delete(artifactFolders).where(eq(artifactFolders.id, id));
        }

        return true;
      });
    },

    // ── Artifact operations ──

    listArtifacts: async (companyId: string, filters: ListArtifactsFilters) => {
      const conditions = [eq(artifacts.companyId, companyId)];

      if (filters.folderId) conditions.push(eq(artifacts.folderId, filters.folderId));
      if (filters.issueId) conditions.push(eq(artifacts.issueId, filters.issueId));
      if (filters.agentId) conditions.push(eq(artifacts.createdByAgentId, filters.agentId));
      if (filters.mimeType) conditions.push(like(artifacts.mimeType, filters.mimeType.replace("*", "%")));
      if (filters.search) conditions.push(like(artifacts.title, `%${filters.search}%`));

      const orderDir = filters.order === "asc" ? asc : desc;
      let orderCol;
      switch (filters.sort) {
        case "name":
          orderCol = orderDir(artifacts.title);
          break;
        default:
          orderCol = orderDir(artifacts.createdAt);
          break;
      }

      const rows = await db
        .select()
        .from(artifacts)
        .where(and(...conditions))
        .orderBy(orderCol)
        .limit(filters.limit ?? 50)
        .offset(filters.offset ?? 0);

      return rows.map(toArtifact);
    },

    getArtifact: async (id: string, companyId?: string): Promise<Artifact | null> => {
      const conditions = [eq(artifacts.id, id)];
      if (companyId) conditions.push(eq(artifacts.companyId, companyId));
      const row = await db
        .select()
        .from(artifacts)
        .where(and(...conditions))
        .then((rows) => rows[0] ?? null);
      return row ? toArtifact(row) : null;
    },

    createArtifact: async (
      companyId: string,
      data: {
        folderId: string;
        assetId: string;
        title: string;
        description?: string | null;
        mimeType: string;
        issueId?: string | null;
        createdByAgentId?: string | null;
        createdByUserId?: string | null;
      },
    ): Promise<Artifact> => {
      const row = await db
        .insert(artifacts)
        .values({
          companyId,
          folderId: data.folderId,
          assetId: data.assetId,
          title: data.title,
          description: data.description ?? null,
          mimeType: data.mimeType,
          issueId: data.issueId ?? null,
          createdByAgentId: data.createdByAgentId ?? null,
          createdByUserId: data.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
      return toArtifact(row);
    },

    updateArtifact: async (
      id: string,
      companyId: string,
      patch: { title?: string; description?: string | null; folderId?: string },
    ): Promise<Artifact | null> => {
      const setCols: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) setCols.title = patch.title;
      if (patch.description !== undefined) setCols.description = patch.description;
      if (patch.folderId !== undefined) setCols.folderId = patch.folderId;

      const row = await db
        .update(artifacts)
        .set(setCols)
        .where(and(eq(artifacts.id, id), eq(artifacts.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toArtifact(row) : null;
    },

    deleteArtifact: async (id: string, companyId: string): Promise<Artifact | null> => {
      const row = await db
        .delete(artifacts)
        .where(and(eq(artifacts.id, id), eq(artifacts.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toArtifact(row) : null;
    },

    // ── Auto-folder helper ──

    ensureAutoFolder: async (
      companyId: string,
      projectId: string | null,
      projectName: string | null,
      issueId?: string | null,
      issueTitle?: string | null,
    ): Promise<string> => {
      // Determine project folder
      const projName = projectName ?? "Uncategorized";
      const projPath = "/" + projName.replace(/\//g, "_") + "/";

      let projFolder = await db
        .select()
        .from(artifactFolders)
        .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.path, projPath)))
        .then((rows) => rows[0] ?? null);

      if (!projFolder) {
        projFolder = await db
          .insert(artifactFolders)
          .values({
            companyId,
            parentId: null,
            name: projName,
            path: projPath,
            sourceType: "project",
            sourceId: projectId,
          })
          .returning()
          .then((rows) => rows[0]);
      }

      if (!issueId || !issueTitle) return projFolder.id;

      // Determine issue subfolder
      const issueName = issueTitle.replace(/\//g, "_");
      const issuePath = projPath + issueName + "/";

      let issueFolder = await db
        .select()
        .from(artifactFolders)
        .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.path, issuePath)))
        .then((rows) => rows[0] ?? null);

      if (!issueFolder) {
        issueFolder = await db
          .insert(artifactFolders)
          .values({
            companyId,
            parentId: projFolder.id,
            name: issueName,
            path: issuePath,
            sourceType: "issue",
            sourceId: issueId,
          })
          .returning()
          .then((rows) => rows[0]);
      }

      return issueFolder.id;
    },

    // ── Local path helper ──

    getAssetObjectKey: async (artifactId: string): Promise<string | null> => {
      const row = await db
        .select({ objectKey: assets.objectKey, provider: assets.provider })
        .from(artifacts)
        .innerJoin(assets, eq(artifacts.assetId, assets.id))
        .where(eq(artifacts.id, artifactId))
        .then((rows) => rows[0] ?? null);
      if (!row || row.provider !== "local_disk") return null;
      return row.objectKey;
    },
  };
}
