import { createHash, randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { WIKI_ROOT_FOLDER_KEY } from "../manifest.js";
import {
  DEFAULT_SPACE_SLUG,
  DEFAULT_WIKI_ID,
  listSpaces,
  readWikiPage,
  resolveSpace,
  writeWikiPage,
  type WikiSpace,
  type WikiWriteAuthor,
} from "./core.js";
import { syncPageKnowledgeIndex } from "./second-brain-model.js";

export type WikiKnowledgeActor = {
  type: "user" | "agent" | "system";
  userId: string | null;
  agentId: string | null;
  runId: string | null;
};

export type WikiCanvasNode = {
  id: string;
  type: "note" | "text" | "entity";
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string;
  text?: string;
  pagePath?: string;
  pageSpaceId?: string;
  entityKind?: string;
  entityId?: string;
};

export type WikiCanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  relationType: string;
  label?: string;
  directed?: boolean;
};

export type WikiCanvasDocument = { nodes: WikiCanvasNode[]; edges: WikiCanvasEdge[] };

function table(ctx: PluginContext, name: string): string {
  return `${ctx.db.namespace}.${name}`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function actorFromAction(context: PluginPerformActionContext): WikiKnowledgeActor {
  return {
    type: context.actor.type,
    userId: context.actor.userId,
    agentId: context.actor.agentId,
    runId: context.actor.runId,
  };
}

export function authorFromActor(actor: WikiKnowledgeActor): WikiWriteAuthor {
  if (actor.type === "agent") return { kind: "agent", id: actor.agentId, runId: actor.runId };
  if (actor.type === "user") return { kind: "user", id: actor.userId };
  return { kind: "plugin", id: null };
}

function actorId(actor: WikiKnowledgeActor): string | null {
  return actor.type === "agent" ? actor.agentId : actor.type === "user" ? actor.userId : null;
}

function canReadPrivate(actor: WikiKnowledgeActor, ownerUserId: string | null): boolean {
  return actor.type === "agent" || actor.type === "system" || Boolean(actor.userId && ownerUserId === actor.userId);
}

function assertVisibility(value: unknown): "company" | "private" {
  if (value === "private") return "private";
  if (value === "company" || value == null) return "company";
  throw new Error("visibility must be company or private");
}

function assertNotePath(value: unknown): string {
  const path = stringField(value);
  if (!path) throw new Error("path is required");
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".md") || !normalized.startsWith("wiki/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Notes must use a safe .md path below wiki/");
  }
  return normalized;
}

function relativePath(space: Pick<WikiSpace, "pathPrefix">, path: string): string {
  return space.pathPrefix ? `${space.pathPrefix.replace(/\/$/, "")}/${path}` : path;
}

type PageAccessRow = {
  id: string;
  space_id: string;
  path: string;
  title: string | null;
  visibility: string;
  owner_user_id: string | null;
  deleted_at: string | null;
  content_hash: string | null;
  current_revision_id: string | null;
};

async function pageAccessRow(ctx: PluginContext, input: { companyId: string; wikiId: string; spaceId: string; path: string }): Promise<PageAccessRow> {
  const rows = await ctx.db.query<PageAccessRow>(
    `SELECT id, space_id, path, title, visibility, owner_user_id, deleted_at::text AS deleted_at,
            content_hash, current_revision_id
       FROM ${table(ctx, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 LIMIT 1`,
    [input.companyId, input.wikiId, input.spaceId, input.path],
  );
  if (!rows[0]) throw new Error(`Wiki page not found: ${input.path}`);
  return rows[0];
}

function assertPageAccess(row: PageAccessRow, actor: WikiKnowledgeActor): void {
  if (row.visibility === "private" && !canReadPrivate(actor, row.owner_user_id)) {
    throw new Error("Wiki page not found");
  }
}

async function audit(ctx: PluginContext, input: {
  companyId: string;
  actor: WikiKnowledgeActor;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}) {
  await ctx.activity.log({
    companyId: input.companyId,
    message: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: {
      action: input.action,
      actorType: input.actor.type,
      actorId: actorId(input.actor),
      runId: input.actor.runId,
      ...input.metadata,
    },
  });
}

export async function createWikiNote(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  path: string;
  title?: string | null;
  contents?: string | null;
  visibility?: "company" | "private";
  actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const visibility = assertVisibility(input.visibility);
  if (visibility === "private" && (input.actor.type !== "user" || !input.actor.userId)) {
    throw new Error("Only a signed-in human can create an owner-private note");
  }
  const existing = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 AND deleted_at IS NULL LIMIT 1`,
    [input.companyId, wikiId, space.id, path],
  );
  if (existing[0]) throw new Error(`A wiki page already exists at ${path}`);
  const title = stringField(input.title) ?? path.split("/").pop()!.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  const contents = input.contents ?? `# ${title}\n\n`;
  const result = await writeWikiPage(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    path,
    contents,
    writer: "board_ui",
    summary: `Created ${path}`,
    author: authorFromActor(input.actor),
  });
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")}
        SET visibility = $5, owner_user_id = $6, deleted_at = NULL,
            created_by_kind = $7, created_by_id = $8, updated_by_kind = $7, updated_by_id = $8
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4`,
    [input.companyId, wikiId, space.id, path, visibility, visibility === "private" ? input.actor.userId : null, input.actor.type, actorId(input.actor)],
  );
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.note.created", entityType: "wiki_page", entityId: path, metadata: { spaceSlug: space.slug, visibility } });
  return { ...result, visibility, ownerUserId: visibility === "private" ? input.actor.userId : null };
}

export async function writeWikiNoteContents(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  path: string;
  contents: string;
  expectedHash?: string | null;
  summary?: string | null;
  sourceRefs?: unknown;
  actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const requestedPath = stringField(input.path);
  if (!requestedPath) throw new Error("path is required");
  const normalizedPath = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPath.startsWith("wiki/")) {
    const result = await writeWikiPage(ctx, {
      companyId: input.companyId, wikiId, spaceSlug: space.slug, path: normalizedPath,
      contents: input.contents, expectedHash: input.expectedHash, summary: input.summary,
      sourceRefs: input.sourceRefs, writer: input.actor.type === "agent" ? "agent_tool" : "board_ui",
      author: authorFromActor(input.actor),
    });
    await audit(ctx, {
      companyId: input.companyId, actor: input.actor, action: "wiki.root_file.updated",
      entityType: "wiki_file", entityId: normalizedPath, metadata: { path: normalizedPath, revisionId: result.revisionId },
    });
    return { ...result, visibility: "company" as const, ownerUserId: null };
  }
  const path = assertNotePath(normalizedPath);
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path }).catch((error) => {
    if (error instanceof Error && error.message.startsWith("Wiki page not found:")) return null;
    throw error;
  });
  if (!row) {
    const result = await writeWikiPage(ctx, {
      companyId: input.companyId, wikiId, spaceSlug: space.slug, path, contents: input.contents,
      expectedHash: input.expectedHash, summary: input.summary, sourceRefs: input.sourceRefs,
      writer: input.actor.type === "agent" ? "agent_tool" : "board_ui", author: authorFromActor(input.actor),
    });
    await audit(ctx, {
      companyId: input.companyId, actor: input.actor, action: "wiki.note.created",
      entityType: "wiki_page", entityId: path, metadata: { path, spaceSlug: space.slug, visibility: "company", revisionId: result.revisionId },
    });
    return { ...result, visibility: "company" as const, ownerUserId: null };
  }
  assertPageAccess(row, input.actor);
  if (row.deleted_at) throw new Error("Wiki page not found");
  const result = await writeWikiPage(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    path,
    contents: input.contents,
    expectedHash: input.expectedHash,
    summary: input.summary,
    sourceRefs: input.sourceRefs,
    writer: input.actor.type === "agent" ? "agent_tool" : "board_ui",
    author: authorFromActor(input.actor),
  });
  await audit(ctx, {
    companyId: input.companyId,
    actor: input.actor,
    action: "wiki.note.updated",
    entityType: "wiki_page",
    entityId: row.id,
    metadata: { path, revisionId: result.revisionId, previousHash: result.previousHash, contentHash: result.hash },
  });
  return { ...result, visibility: row.visibility, ownerUserId: row.owner_user_id };
}

export async function moveWikiNote(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  path: string;
  newPath: string;
  actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const newPath = assertNotePath(input.newPath);
  if (path === newPath) return { status: "ok", path, previousPath: path, moved: false };
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  if (row.deleted_at) throw new Error("Wiki page not found");
  const conflicts = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 LIMIT 1`,
    [input.companyId, wikiId, space.id, newPath],
  );
  if (conflicts[0]) throw new Error(`A wiki page already exists at ${newPath}`);
  const current = await readWikiPage(ctx, { companyId: input.companyId, wikiId, spaceSlug: space.slug, path, actor: input.actor });

  // Make the destination durable first. The database path remains authoritative
  // until every indexed reference has been moved, then the old file is removed.
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, relativePath(space, newPath), current.contents);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")}
        SET path = $5, updated_by_kind = $6, updated_by_id = $7, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND id = $4`,
    [input.companyId, wikiId, space.id, row.id, newPath, input.actor.type, actorId(input.actor)],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_page_revisions")} SET path = $5
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND page_id = $4`,
    [input.companyId, wikiId, space.id, row.id, newPath],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_search_documents")} SET path = $5, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND doc_kind = 'page' AND path = $4`,
    [input.companyId, wikiId, space.id, path, newPath],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "paperclip_page_bindings")} SET page_path = $5, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND page_path = $4`,
    [input.companyId, wikiId, space.id, path, newPath],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_relations")} SET source_path = $5, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND source_space_id = $3 AND source_path = $4`,
    [input.companyId, wikiId, space.id, path, newPath],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_relations")} SET target_path = $5, target_ref = CASE WHEN target_ref = $4 THEN $5 ELSE target_ref END, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND target_space_id = $3 AND target_path = $4`,
    [input.companyId, wikiId, space.id, path, newPath],
  );

  const canvases = await ctx.db.query<{ id: string; document: unknown }>(
    `SELECT id, document FROM ${table(ctx, "wiki_canvases")} WHERE company_id = $1 AND wiki_id = $2 AND deleted_at IS NULL`,
    [input.companyId, wikiId],
  );
  for (const canvas of canvases) {
    const document = validateCanvasDocument(canvas.document);
    let changed = false;
    const nodes = document.nodes.map((node) => {
      if (node.type !== "note" || node.pagePath !== path || (node.pageSpaceId && node.pageSpaceId !== space.id)) return node;
      changed = true;
      return { ...node, pagePath: newPath, pageSpaceId: space.id };
    });
    if (changed) {
      await ctx.db.execute(
        `UPDATE ${table(ctx, "wiki_canvases")} SET document = $3::jsonb, revision_number = revision_number + 1, updated_at = now()
          WHERE company_id = $1 AND id = $2`,
        [input.companyId, canvas.id, JSON.stringify({ ...document, nodes })],
      );
    }
  }

  await syncPageKnowledgeIndex(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path: newPath, contents: current.contents, author: authorFromActor(input.actor) });
  await ctx.localFolders.deleteFile(input.companyId, WIKI_ROOT_FOLDER_KEY, relativePath(space, path));
  await audit(ctx, {
    companyId: input.companyId, actor: input.actor, action: "wiki.note.moved", entityType: "wiki_page", entityId: row.id,
    metadata: { previousPath: path, path: newPath, spaceSlug: space.slug },
  });
  return { status: "ok", path: newPath, previousPath: path, moved: true };
}

export async function setWikiNoteVisibility(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  path: string;
  visibility: "company" | "private";
  actor: WikiKnowledgeActor;
}) {
  if (input.actor.type !== "user" || !input.actor.userId) throw new Error("A signed-in human is required to change note privacy");
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  const visibility = assertVisibility(input.visibility);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")}
        SET visibility = $5, owner_user_id = $6, updated_by_kind = 'user', updated_by_id = $6, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4`,
    [input.companyId, wikiId, space.id, path, visibility, visibility === "private" ? input.actor.userId : null],
  );
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.note.visibility_changed", entityType: "wiki_page", entityId: row.id, metadata: { path, visibility } });
  return { status: "ok", path, visibility, ownerUserId: visibility === "private" ? input.actor.userId : null };
}

export async function archiveWikiNote(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; path: string; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  await ctx.localFolders.deleteFile(input.companyId, WIKI_ROOT_FOLDER_KEY, relativePath(space, path));
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")} SET deleted_at = now(), updated_by_kind = $5, updated_by_id = $6, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4`,
    [input.companyId, wikiId, space.id, path, input.actor.type, actorId(input.actor)],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_relations")} SET deleted_at = now(), updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND ((source_space_id = $3 AND source_path = $4) OR (target_space_id = $3 AND target_path = $4)) AND deleted_at IS NULL`,
    [input.companyId, wikiId, space.id, path],
  );
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.note.archived", entityType: "wiki_page", entityId: row.id, metadata: { path, revisionId: row.current_revision_id } });
  return { status: "archived", path, revisionId: row.current_revision_id };
}

export async function restoreWikiNote(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; path: string; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  if (!row.deleted_at) return { status: "ok", path, restored: false };
  const revisions = await ctx.db.query<{ contents: string | null }>(
    `SELECT contents FROM ${table(ctx, "wiki_page_revisions")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND page_id = $4 AND contents IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [input.companyId, wikiId, space.id, row.id],
  );
  const contents = revisions[0]?.contents;
  if (contents == null) throw new Error("This page has no restorable content snapshot");
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, relativePath(space, path), contents);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")} SET deleted_at = NULL, updated_by_kind = $5, updated_by_id = $6, updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4`,
    [input.companyId, wikiId, space.id, path, input.actor.type, actorId(input.actor)],
  );
  await syncPageKnowledgeIndex(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path, contents, author: authorFromActor(input.actor) });
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.note.restored", entityType: "wiki_page", entityId: row.id, metadata: { path } });
  return { status: "ok", path, restored: true };
}

export async function restoreWikiRevision(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; path: string; revisionId: string; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertNotePath(input.path);
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  const revisions = await ctx.db.query<{ contents: string | null }>(
    `SELECT contents FROM ${table(ctx, "wiki_page_revisions")}
      WHERE id = $1 AND company_id = $2 AND wiki_id = $3 AND space_id = $4 AND page_id = $5 LIMIT 1`,
    [input.revisionId, input.companyId, wikiId, space.id, row.id],
  );
  if (revisions[0]?.contents == null) throw new Error("Revision content is unavailable");
  const result = await writeWikiPage(ctx, {
    companyId: input.companyId, wikiId, spaceSlug: space.slug, path,
    contents: revisions[0].contents, expectedHash: row.content_hash,
    summary: `Restored revision ${input.revisionId}`, writer: "board_ui", author: authorFromActor(input.actor),
  });
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.note.revision_restored", entityType: "wiki_page", entityId: row.id, metadata: { path, revisionId: input.revisionId, newRevisionId: result.revisionId } });
  return result;
}

export async function listArchivedWikiNotes(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const params: unknown[] = [input.companyId, wikiId];
  let spaceClause = "";
  if (stringField(input.spaceSlug)) {
    params.push(stringField(input.spaceSlug));
    spaceClause = ` AND s.slug = $${params.length}`;
  }
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT p.id, p.path, p.title, p.page_type, p.visibility, p.owner_user_id,
            p.current_revision_id, p.deleted_at::text AS deleted_at, p.updated_at::text AS updated_at,
            s.slug AS space_slug, s.display_name AS space_name
       FROM ${table(ctx, "wiki_pages")} p
       JOIN ${table(ctx, "wiki_spaces")} s ON s.id = p.space_id
      WHERE p.company_id = $1 AND p.wiki_id = $2 AND p.deleted_at IS NOT NULL${spaceClause}
      ORDER BY p.deleted_at DESC LIMIT 250`,
    params,
  );
  return {
    notes: rows
      .filter((note) => note.visibility !== "private" || canReadPrivate(input.actor, stringField(note.owner_user_id)))
      .map(({ owner_user_id: ownerUserId, current_revision_id: currentRevisionId, deleted_at: deletedAt, updated_at: updatedAt, space_slug: spaceSlug, space_name: spaceName, ...note }) => ({
        ...note, ownerUserId, currentRevisionId, deletedAt, updatedAt, spaceSlug, spaceName,
      })),
  };
}

export async function getWikiPageContext(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; path: string; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = input.path.startsWith("raw/") ? input.path : assertNotePath(input.path);
  if (path.startsWith("raw/")) return { page: null, incoming: [], outgoing: [], revisions: [], unlinkedMentions: [] };
  const row = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path });
  assertPageAccess(row, input.actor);
  const relationRows = await ctx.db.query<Record<string, unknown>>(
    `SELECT r.id, r.source_space_id, ss.slug AS source_space_slug, r.source_path,
            r.target_space_id, ts.slug AS target_space_slug, r.target_path, r.target_ref,
            r.relation_type, r.label, r.origin_kind, r.metadata, r.created_at::text AS created_at,
            source_page.visibility AS source_visibility, source_page.owner_user_id AS source_owner_user_id,
            target_page.visibility AS target_visibility, target_page.owner_user_id AS target_owner_user_id
       FROM ${table(ctx, "wiki_relations")} r
       JOIN ${table(ctx, "wiki_spaces")} ss ON ss.id = r.source_space_id
       LEFT JOIN ${table(ctx, "wiki_spaces")} ts ON ts.id = r.target_space_id
       LEFT JOIN ${table(ctx, "wiki_pages")} source_page
         ON source_page.company_id = r.company_id AND source_page.wiki_id = r.wiki_id
        AND source_page.space_id = r.source_space_id AND source_page.path = r.source_path
       LEFT JOIN ${table(ctx, "wiki_pages")} target_page
         ON target_page.company_id = r.company_id AND target_page.wiki_id = r.wiki_id
        AND target_page.space_id = r.target_space_id AND target_page.path = r.target_path
      WHERE r.company_id = $1 AND r.wiki_id = $2 AND r.deleted_at IS NULL
        AND ((r.source_space_id = $3 AND r.source_path = $4) OR (r.target_space_id = $3 AND r.target_path = $4))
      ORDER BY r.created_at DESC LIMIT 300`,
    [input.companyId, wikiId, space.id, path],
  );
  const visibleRelations = [] as Record<string, unknown>[];
  for (const relation of relationRows) {
    const sourceVisible = relation.source_visibility !== "private" || canReadPrivate(input.actor, stringField(relation.source_owner_user_id));
    const targetVisible = relation.target_visibility == null || relation.target_visibility !== "private" || canReadPrivate(input.actor, stringField(relation.target_owner_user_id));
    if (!sourceVisible || !targetVisible) continue;
    const {
      source_visibility: _sourceVisibility,
      source_owner_user_id: _sourceOwnerUserId,
      target_visibility: _targetVisibility,
      target_owner_user_id: _targetOwnerUserId,
      ...publicRelation
    } = relation;
    visibleRelations.push(publicRelation);
  }
  const revisions = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, content_hash, summary, author_kind, author_id, author_run_id,
            (contents IS NOT NULL) AS restorable, created_at::text AS created_at
       FROM ${table(ctx, "wiki_page_revisions")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND page_id = $4
      ORDER BY created_at DESC LIMIT 50`,
    [input.companyId, wikiId, space.id, row.id],
  );
  const titleNeedle = (row.title ?? path.split("/").pop()?.replace(/\.md$/i, "") ?? "").trim();
  const unlinked = titleNeedle.length >= 3
    ? await ctx.db.query<Record<string, unknown>>(
        `SELECT p.path, p.title, s.slug AS space_slug, p.visibility, p.owner_user_id
           FROM ${table(ctx, "wiki_search_documents")} d
           JOIN ${table(ctx, "wiki_pages")} p ON p.company_id = d.company_id AND p.wiki_id = d.wiki_id AND p.space_id = d.space_id AND p.path = d.path
           JOIN ${table(ctx, "wiki_spaces")} s ON s.id = p.space_id
          WHERE d.company_id = $1 AND d.wiki_id = $2 AND d.doc_kind = 'page' AND p.deleted_at IS NULL
            AND d.body_text ILIKE '%' || $3 || '%' AND NOT (p.space_id = $4 AND p.path = $5)
          ORDER BY d.updated_at DESC LIMIT 30`,
        [input.companyId, wikiId, titleNeedle, space.id, path],
      )
    : [];
  const visibleUnlinked = unlinked
    .filter((candidate) => candidate.visibility !== "private" || canReadPrivate(input.actor, stringField(candidate.owner_user_id)))
    .map(({ visibility: _visibility, owner_user_id: _ownerUserId, ...candidate }) => candidate);
  return {
    page: { id: row.id, path, visibility: row.visibility, ownerUserId: row.owner_user_id, deletedAt: row.deleted_at },
    incoming: visibleRelations.filter((relation) => relation.target_space_id === space.id && relation.target_path === path),
    outgoing: visibleRelations.filter((relation) => relation.source_space_id === space.id && relation.source_path === path),
    revisions,
    unlinkedMentions: visibleUnlinked,
  };
}

function validateCanvasDocument(value: unknown): WikiCanvasDocument {
  const record = jsonObject(value);
  const rawNodes = jsonArray(record.nodes);
  const rawEdges = jsonArray(record.edges);
  if (rawNodes.length > 500 || rawEdges.length > 1000) throw new Error("Canvas is too large");
  const nodes: WikiCanvasNode[] = rawNodes.map((entry, index) => {
    const node = jsonObject(entry);
    const id = stringField(node.id) ?? `node-${index}`;
    const type = node.type === "note" || node.type === "entity" ? node.type : "text";
    return {
      id, type,
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
      width: Math.min(800, Math.max(120, Number(node.width) || 240)),
      height: Math.min(800, Math.max(80, Number(node.height) || 140)),
      ...(stringField(node.title) ? { title: stringField(node.title)! } : {}),
      ...(stringField(node.text) ? { text: String(node.text).slice(0, 20_000) } : {}),
      ...(stringField(node.pagePath) ? { pagePath: stringField(node.pagePath)! } : {}),
      ...(stringField(node.pageSpaceId) ? { pageSpaceId: stringField(node.pageSpaceId)! } : {}),
      ...(stringField(node.entityKind) ? { entityKind: stringField(node.entityKind)! } : {}),
      ...(stringField(node.entityId) ? { entityId: stringField(node.entityId)! } : {}),
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("Canvas node ids must be unique");
  const edges: WikiCanvasEdge[] = rawEdges.map((entry, index) => {
    const edge = jsonObject(entry);
    const fromNode = stringField(edge.fromNode);
    const toNode = stringField(edge.toNode);
    if (!fromNode || !toNode || !ids.has(fromNode) || !ids.has(toNode)) throw new Error("Canvas edges must reference existing nodes");
    return {
      id: stringField(edge.id) ?? `edge-${index}`,
      fromNode,
      toNode,
      relationType: stringField(edge.relationType) ?? "related",
      ...(stringField(edge.label) ? { label: stringField(edge.label)! } : {}),
      directed: edge.directed !== false,
    };
  });
  return { nodes, edges };
}

type CanvasRow = {
  id: string; company_id: string; wiki_id: string; space_id: string; space_slug?: string;
  title: string; visibility: string; owner_user_id: string | null; document: unknown; revision_number: number;
  created_at: string; updated_at: string; deleted_at?: string | null;
};

function canvasView(row: CanvasRow) {
  return {
    id: row.id, wikiId: row.wiki_id, spaceId: row.space_id, spaceSlug: row.space_slug ?? null,
    title: row.title, visibility: row.visibility, ownerUserId: row.owner_user_id,
    document: validateCanvasDocument(row.document), revisionNumber: Number(row.revision_number),
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null,
  };
}

function assertCanvasAccess(row: CanvasRow, actor: WikiKnowledgeActor): void {
  if (row.visibility === "private" && !canReadPrivate(actor, row.owner_user_id)) throw new Error("Canvas not found");
}

export async function listWikiCanvases(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; actor: WikiKnowledgeActor; includeArchived?: boolean;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const params: unknown[] = [input.companyId, wikiId];
  let spaceClause = "";
  if (stringField(input.spaceSlug)) {
    params.push(stringField(input.spaceSlug));
    spaceClause = ` AND s.slug = $${params.length}`;
  }
  const rows = await ctx.db.query<CanvasRow>(
    `SELECT c.id, c.company_id, c.wiki_id, c.space_id, s.slug AS space_slug, c.title, c.visibility,
            c.owner_user_id, c.document, c.revision_number, c.deleted_at::text AS deleted_at,
            c.created_at::text AS created_at, c.updated_at::text AS updated_at
       FROM ${table(ctx, "wiki_canvases")} c JOIN ${table(ctx, "wiki_spaces")} s ON s.id = c.space_id
      WHERE c.company_id = $1 AND c.wiki_id = $2${spaceClause}${input.includeArchived ? "" : " AND c.deleted_at IS NULL"}
      ORDER BY c.updated_at DESC LIMIT 200`,
    params,
  );
  return { canvases: rows.filter((row) => row.visibility !== "private" || canReadPrivate(input.actor, row.owner_user_id)).map(canvasView) };
}

async function canvasRow(ctx: PluginContext, companyId: string, canvasId: string): Promise<CanvasRow> {
  const rows = await ctx.db.query<CanvasRow>(
    `SELECT c.id, c.company_id, c.wiki_id, c.space_id, s.slug AS space_slug, c.title, c.visibility,
            c.owner_user_id, c.document, c.revision_number, c.deleted_at::text AS deleted_at,
            c.created_at::text AS created_at, c.updated_at::text AS updated_at
       FROM ${table(ctx, "wiki_canvases")} c JOIN ${table(ctx, "wiki_spaces")} s ON s.id = c.space_id
      WHERE c.company_id = $1 AND c.id = $2 LIMIT 1`,
    [companyId, canvasId],
  );
  if (!rows[0]) throw new Error("Canvas not found");
  return rows[0];
}

async function writeCanvasRevision(ctx: PluginContext, row: CanvasRow, actor: WikiKnowledgeActor, summary: string | null) {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "wiki_canvas_revisions")}
       (id, company_id, canvas_id, revision_number, title, visibility, document, summary, author_kind, author_id, author_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [randomUUID(), row.company_id, row.id, row.revision_number, row.title, row.visibility, JSON.stringify(validateCanvasDocument(row.document)), summary, actor.type, actorId(actor), actor.runId],
  );
}

async function syncCanvasRelations(ctx: PluginContext, row: CanvasRow, actor: WikiKnowledgeActor) {
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "wiki_relations")} WHERE company_id = $1 AND origin_kind = 'canvas' AND origin_id = $2`,
    [row.company_id, row.id],
  );
  const document = validateCanvasDocument(row.document);
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const edge of document.edges) {
    const source = nodes.get(edge.fromNode);
    const target = nodes.get(edge.toNode);
    if (source?.type !== "note" || target?.type !== "note" || !source.pagePath || !target.pagePath) continue;
    const sourceSpaceId = source.pageSpaceId ?? row.space_id;
    const targetSpaceId = target.pageSpaceId ?? row.space_id;
    const sourceRows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "wiki_pages")} WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 AND deleted_at IS NULL LIMIT 1`,
      [row.company_id, row.wiki_id, sourceSpaceId, source.pagePath],
    );
    const targetRows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "wiki_pages")} WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 AND deleted_at IS NULL LIMIT 1`,
      [row.company_id, row.wiki_id, targetSpaceId, target.pagePath],
    );
    if (!sourceRows[0] || !targetRows[0]) continue;
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "wiki_relations")}
         (id, company_id, wiki_id, source_space_id, source_page_id, source_path,
          target_kind, target_space_id, target_page_id, target_path, relation_type, label,
          origin_kind, origin_id, metadata, created_by_kind, created_by_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'wiki_page', $7, $8, $9, $10, $11, 'canvas', $12, $13::jsonb, $14, $15, $16)`,
      [randomUUID(), row.company_id, row.wiki_id, sourceSpaceId, sourceRows[0].id, source.pagePath,
        targetSpaceId, targetRows[0].id, target.pagePath, edge.relationType, edge.label ?? null, row.id,
        JSON.stringify({ canvasTitle: row.title, edgeId: edge.id, directed: edge.directed !== false }), actor.type, actorId(actor), actor.runId],
    );
  }
}

export async function getWikiCanvas(ctx: PluginContext, input: { companyId: string; canvasId: string; actor: WikiKnowledgeActor }) {
  const row = await canvasRow(ctx, input.companyId, input.canvasId);
  assertCanvasAccess(row, input.actor);
  const revisions = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, revision_number, summary, author_kind, author_id, author_run_id, created_at::text AS created_at
       FROM ${table(ctx, "wiki_canvas_revisions")} WHERE company_id = $1 AND canvas_id = $2 ORDER BY revision_number DESC LIMIT 50`,
    [input.companyId, input.canvasId],
  );
  return { canvas: canvasView(row), revisions };
}

export async function createWikiCanvas(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; title?: string | null;
  visibility?: "company" | "private"; document?: unknown; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const visibility = assertVisibility(input.visibility);
  if (visibility === "private" && (input.actor.type !== "user" || !input.actor.userId)) throw new Error("Only a signed-in human can own a private canvas");
  const id = randomUUID();
  const title = stringField(input.title) ?? "Untitled canvas";
  const document = validateCanvasDocument(input.document ?? { nodes: [], edges: [] });
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "wiki_canvases")}
       (id, company_id, wiki_id, space_id, title, visibility, owner_user_id, document, revision_number, created_by_kind, created_by_id, updated_by_kind, updated_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9, $10, $9, $10)`,
    [id, input.companyId, wikiId, space.id, title, visibility, visibility === "private" ? input.actor.userId : null, JSON.stringify(document), input.actor.type, actorId(input.actor)],
  );
  const row = await canvasRow(ctx, input.companyId, id);
  await writeCanvasRevision(ctx, row, input.actor, "Created canvas");
  await syncCanvasRelations(ctx, row, input.actor);
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.canvas.created", entityType: "wiki_canvas", entityId: id, metadata: { title, visibility, spaceSlug: space.slug } });
  return { status: "created", canvas: canvasView(row) };
}

export async function updateWikiCanvas(ctx: PluginContext, input: {
  companyId: string; canvasId: string; title?: string | null; visibility?: "company" | "private";
  document?: unknown; expectedRevision?: number | null; summary?: string | null; actor: WikiKnowledgeActor;
}) {
  const current = await canvasRow(ctx, input.companyId, input.canvasId);
  assertCanvasAccess(current, input.actor);
  if (input.expectedRevision != null && Number(input.expectedRevision) !== Number(current.revision_number)) {
    throw new Error(`Canvas changed since it was opened; current revision is ${current.revision_number}`);
  }
  const visibility = input.visibility ? assertVisibility(input.visibility) : current.visibility as "company" | "private";
  if (visibility === "private" && (input.actor.type !== "user" || !input.actor.userId)) {
    if (current.visibility !== "private") throw new Error("Only a signed-in human can make a canvas private");
  }
  const ownerUserId = visibility === "private" ? current.owner_user_id ?? input.actor.userId : null;
  if (visibility === "private" && input.actor.type === "user" && current.owner_user_id && current.owner_user_id !== input.actor.userId) throw new Error("Canvas not found");
  const document = input.document === undefined ? validateCanvasDocument(current.document) : validateCanvasDocument(input.document);
  const nextRevision = Number(current.revision_number) + 1;
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_canvases")}
        SET title = $3, visibility = $4, owner_user_id = $5, document = $6::jsonb,
            revision_number = $7, updated_by_kind = $8, updated_by_id = $9, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.canvasId, stringField(input.title) ?? current.title, visibility, ownerUserId, JSON.stringify(document), nextRevision, input.actor.type, actorId(input.actor)],
  );
  const updated = await canvasRow(ctx, input.companyId, input.canvasId);
  await writeCanvasRevision(ctx, updated, input.actor, stringField(input.summary));
  await syncCanvasRelations(ctx, updated, input.actor);
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.canvas.updated", entityType: "wiki_canvas", entityId: input.canvasId, metadata: { revisionNumber: nextRevision } });
  return { status: "ok", canvas: canvasView(updated) };
}

export async function restoreWikiCanvasRevision(ctx: PluginContext, input: {
  companyId: string; canvasId: string; revisionId: string; actor: WikiKnowledgeActor;
}) {
  const current = await canvasRow(ctx, input.companyId, input.canvasId);
  assertCanvasAccess(current, input.actor);
  const revisions = await ctx.db.query<{ id: string; revision_number: number; title: string; document: unknown }>(
    `SELECT id, revision_number, title, document FROM ${table(ctx, "wiki_canvas_revisions")}
      WHERE company_id = $1 AND canvas_id = $2 AND id = $3 LIMIT 1`,
    [input.companyId, input.canvasId, input.revisionId],
  );
  const revision = revisions[0];
  if (!revision) throw new Error("Canvas revision not found");
  const result = await updateWikiCanvas(ctx, {
    companyId: input.companyId,
    canvasId: input.canvasId,
    title: revision.title,
    document: revision.document,
    expectedRevision: current.revision_number,
    summary: `Restored canvas revision ${revision.revision_number}`,
    actor: input.actor,
  });
  await audit(ctx, {
    companyId: input.companyId, actor: input.actor, action: "wiki.canvas.revision_restored",
    entityType: "wiki_canvas", entityId: input.canvasId,
    metadata: { revisionId: input.revisionId, restoredRevisionNumber: revision.revision_number, newRevisionNumber: result.canvas.revisionNumber },
  });
  return result;
}

export async function archiveWikiCanvas(ctx: PluginContext, input: { companyId: string; canvasId: string; actor: WikiKnowledgeActor }) {
  const row = await canvasRow(ctx, input.companyId, input.canvasId);
  assertCanvasAccess(row, input.actor);
  await ctx.db.execute(`UPDATE ${table(ctx, "wiki_canvases")} SET deleted_at = now(), updated_at = now() WHERE company_id = $1 AND id = $2`, [input.companyId, input.canvasId]);
  await ctx.db.execute(`UPDATE ${table(ctx, "wiki_relations")} SET deleted_at = now(), updated_at = now() WHERE company_id = $1 AND origin_kind = 'canvas' AND origin_id = $2`, [input.companyId, input.canvasId]);
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.canvas.archived", entityType: "wiki_canvas", entityId: input.canvasId });
  return { status: "archived", canvasId: input.canvasId };
}

export async function proposeWikiRelation(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; sourceSpaceSlug?: string | null; sourcePath: string;
  targetSpaceSlug?: string | null; targetPath: string; relationType?: string | null; label?: string | null;
  evidence: string; confidence?: number | null; actor: WikiKnowledgeActor;
}) {
  if (input.actor.type !== "agent" || !input.actor.agentId) throw new Error("Semantic link suggestions must come from a company AI agent");
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const sourceSpace = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.sourceSpaceSlug });
  const targetSpace = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.targetSpaceSlug });
  const sourcePath = assertNotePath(input.sourcePath);
  const targetPath = assertNotePath(input.targetPath);
  const source = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: sourceSpace.id, path: sourcePath });
  const target = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: targetSpace.id, path: targetPath });
  assertPageAccess(source, input.actor);
  assertPageAccess(target, input.actor);
  const relationType = stringField(input.relationType) ?? "related";
  const evidence = stringField(input.evidence);
  if (!evidence) throw new Error("evidence is required");
  const fingerprint = createHash("sha256").update(`${source.content_hash}\0${target.content_hash}\0${relationType}\0${evidence}`).digest("hex");
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "wiki_link_suggestions")}
       (id, company_id, wiki_id, source_space_id, source_page_id, source_path,
        target_space_id, target_page_id, target_path, relation_type, label, evidence,
        confidence, content_fingerprint, status, proposed_by_agent_id, proposed_by_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', $15, $16)
     ON CONFLICT (company_id, wiki_id, source_space_id, source_path, target_space_id, target_path, relation_type, content_fingerprint)
     DO UPDATE SET evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence, label = EXCLUDED.label,
                   status = CASE WHEN ${table(ctx, "wiki_link_suggestions")}.status = 'rejected' THEN 'rejected' ELSE 'pending' END,
                   updated_at = now()`,
    [id, input.companyId, wikiId, sourceSpace.id, source.id, sourcePath, targetSpace.id, target.id, targetPath,
      relationType, stringField(input.label), evidence.slice(0, 10_000), input.confidence == null ? null : Math.max(0, Math.min(1, Number(input.confidence))),
      fingerprint, input.actor.agentId, input.actor.runId],
  );
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: "wiki.relation.suggested", entityType: "wiki_link_suggestion", entityId: id, metadata: { sourcePath, targetPath, relationType, fingerprint } });
  return { status: "pending", suggestionId: id, fingerprint };
}

export async function listWikiSuggestions(ctx: PluginContext, input: { companyId: string; wikiId?: string | null; status?: string | null; actor: WikiKnowledgeActor }) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const status = stringField(input.status) ?? "pending";
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT s.id, s.source_space_id, ss.slug AS source_space_slug, s.source_path,
            s.target_space_id, ts.slug AS target_space_slug, s.target_path,
            s.relation_type, s.label, s.evidence, s.confidence, s.status,
            s.proposed_by_agent_id, s.proposed_by_run_id, s.decided_by_user_id,
            s.decided_at::text AS decided_at, s.created_at::text AS created_at
       FROM ${table(ctx, "wiki_link_suggestions")} s
       JOIN ${table(ctx, "wiki_spaces")} ss ON ss.id = s.source_space_id
       JOIN ${table(ctx, "wiki_spaces")} ts ON ts.id = s.target_space_id
      WHERE s.company_id = $1 AND s.wiki_id = $2 AND s.status = $3
      ORDER BY s.created_at DESC LIMIT 200`,
    [input.companyId, wikiId, status],
  );
  const visible = [] as Record<string, unknown>[];
  for (const row of rows) {
    const source = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: String(row.source_space_id), path: String(row.source_path) }).catch(() => null);
    const target = await pageAccessRow(ctx, { companyId: input.companyId, wikiId, spaceId: String(row.target_space_id), path: String(row.target_path) }).catch(() => null);
    if (source && target && (source.visibility !== "private" || canReadPrivate(input.actor, source.owner_user_id)) && (target.visibility !== "private" || canReadPrivate(input.actor, target.owner_user_id))) visible.push(row);
  }
  return { suggestions: visible };
}

export async function listUnresolvedWikiRelations(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT r.id, r.source_space_id, s.slug AS source_space_slug, r.source_path,
            p.title AS source_title, r.target_path, r.target_ref, r.relation_type,
            r.label, r.origin_kind, r.metadata, r.created_at::text AS created_at,
            p.visibility, p.owner_user_id
       FROM ${table(ctx, "wiki_relations")} r
       JOIN ${table(ctx, "wiki_spaces")} s ON s.id = r.source_space_id
       JOIN ${table(ctx, "wiki_pages")} p ON p.id = r.source_page_id
      WHERE r.company_id = $1 AND r.wiki_id = $2 AND r.deleted_at IS NULL
        AND r.target_page_id IS NULL AND p.deleted_at IS NULL
      ORDER BY r.created_at DESC LIMIT 500`,
    [input.companyId, wikiId],
  );
  return {
    relations: rows
      .filter((relation) => relation.visibility !== "private" || canReadPrivate(input.actor, stringField(relation.owner_user_id)))
      .map(({ visibility: _visibility, owner_user_id: _ownerUserId, ...relation }) => relation),
  };
}

export async function reviewWikiSuggestion(ctx: PluginContext, input: { companyId: string; suggestionId: string; decision: "accepted" | "rejected"; actor: WikiKnowledgeActor }) {
  if (input.actor.type !== "user" || !input.actor.userId) throw new Error("A signed-in human must review semantic link suggestions");
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT * FROM ${table(ctx, "wiki_link_suggestions")} WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [input.companyId, input.suggestionId],
  );
  const suggestion = rows[0];
  if (!suggestion) throw new Error("Link suggestion not found");
  const source = await pageAccessRow(ctx, { companyId: input.companyId, wikiId: String(suggestion.wiki_id), spaceId: String(suggestion.source_space_id), path: String(suggestion.source_path) });
  const target = await pageAccessRow(ctx, { companyId: input.companyId, wikiId: String(suggestion.wiki_id), spaceId: String(suggestion.target_space_id), path: String(suggestion.target_path) });
  assertPageAccess(source, input.actor);
  assertPageAccess(target, input.actor);
  if (suggestion.status !== "pending") return { status: suggestion.status, suggestionId: input.suggestionId, changed: false };
  if (input.decision === "accepted") {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "wiki_relations")}
         (id, company_id, wiki_id, source_space_id, source_page_id, source_path,
          target_kind, target_space_id, target_page_id, target_path, relation_type, label,
          origin_kind, origin_id, metadata, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'wiki_page', $7, $8, $9, $10, $11, 'ai_suggestion', $12, $13::jsonb, 'user', $14)`,
      [randomUUID(), input.companyId, suggestion.wiki_id, suggestion.source_space_id, source.id, suggestion.source_path,
        suggestion.target_space_id, target.id, suggestion.target_path, suggestion.relation_type, suggestion.label,
        input.suggestionId, JSON.stringify({ evidence: suggestion.evidence, confidence: suggestion.confidence }), input.actor.userId],
    );
  }
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_link_suggestions")} SET status = $3, decided_by_user_id = $4, decided_at = now(), updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.suggestionId, input.decision, input.actor.userId],
  );
  await audit(ctx, { companyId: input.companyId, actor: input.actor, action: `wiki.relation.${input.decision}`, entityType: "wiki_link_suggestion", entityId: input.suggestionId, metadata: { sourcePath: suggestion.source_path, targetPath: suggestion.target_path, relationType: suggestion.relation_type } });
  return { status: input.decision, suggestionId: input.suggestionId, changed: true };
}

type BrainPageRow = {
  id: string; space_id: string; space_slug: string; space_name: string; binding_kind: string | null; project_id: string | null;
  path: string; title: string | null; page_type: string | null; tags: unknown; aliases: unknown;
  visibility: string; owner_user_id: string | null; updated_at: string | null;
};

export async function getSecondBrainGraph(ctx: PluginContext, input: {
  companyId: string; wikiId?: string | null; spaceSlug?: string | null; scope?: "company" | "space" | "project" | "local";
  focusPath?: string | null; focusSpaceSlug?: string | null; depth?: number | null; actor: WikiKnowledgeActor;
}) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const scope = input.scope ?? "company";
  const params: unknown[] = [input.companyId, wikiId];
  let scopeClause = "";
  const requestedSpace = stringField(input.spaceSlug);
  if ((scope === "space" || scope === "project") && requestedSpace) {
    params.push(requestedSpace);
    scopeClause = ` AND s.slug = $${params.length}`;
  }
  const pages = await ctx.db.query<BrainPageRow>(
    `SELECT p.id, p.space_id, s.slug AS space_slug, s.display_name AS space_name, s.binding_kind, s.project_id,
            p.path, p.title, p.page_type, p.tags, p.aliases, p.visibility, p.owner_user_id,
            p.updated_at::text AS updated_at
       FROM ${table(ctx, "wiki_pages")} p JOIN ${table(ctx, "wiki_spaces")} s ON s.id = p.space_id
      WHERE p.company_id = $1 AND p.wiki_id = $2 AND p.deleted_at IS NULL AND s.status = 'active'${scopeClause}
      ORDER BY p.updated_at DESC LIMIT 1200`,
    params,
  );
  let visiblePages = pages.filter((page) => page.visibility !== "private" || canReadPrivate(input.actor, page.owner_user_id));
  const visibleIds = new Set(visiblePages.map((page) => page.id));
  const relationRows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, source_page_id, source_space_id, source_path, target_page_id, target_space_id, target_path,
            target_ref, relation_type, label, origin_kind, metadata, created_at::text AS created_at
       FROM ${table(ctx, "wiki_relations")}
      WHERE company_id = $1 AND wiki_id = $2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 5000`,
    [input.companyId, wikiId],
  );
  let visibleRelations = relationRows.filter((relation) => visibleIds.has(String(relation.source_page_id)) && (!relation.target_page_id || visibleIds.has(String(relation.target_page_id))));
  if (scope === "local" && input.focusPath) {
    const focusSpaceSlug = stringField(input.focusSpaceSlug) ?? requestedSpace ?? DEFAULT_SPACE_SLUG;
    const focus = visiblePages.find((page) => page.space_slug === focusSpaceSlug && page.path === input.focusPath);
    if (focus) {
      const depth = Math.max(1, Math.min(4, Number(input.depth) || 1));
      const selected = new Set([focus.id]);
      for (let layer = 0; layer < depth; layer += 1) {
        for (const relation of visibleRelations) {
          const source = String(relation.source_page_id);
          const target = relation.target_page_id ? String(relation.target_page_id) : null;
          if (selected.has(source) && target) selected.add(target);
          if (target && selected.has(target)) selected.add(source);
        }
      }
      visiblePages = visiblePages.filter((page) => selected.has(page.id));
      visibleRelations = visibleRelations.filter((relation) => selected.has(String(relation.source_page_id)) && (!relation.target_page_id || selected.has(String(relation.target_page_id))));
    }
  }
  const pageById = new Map(visiblePages.map((page) => [page.id, page]));
  const spaceIds = new Set(visiblePages.map((page) => page.space_id));
  const nodes = [
    ...[...new Map(visiblePages.map((page) => [page.space_id, page])).values()].map((space) => ({
      id: `space:${space.space_id}`, kind: "space", label: space.space_name, sublabel: space.space_slug,
      status: null, group: "spaces", href: space.space_slug === DEFAULT_SPACE_SLUG ? "/wiki" : `/wiki/spaces/${encodeURIComponent(space.space_slug)}`,
      weight: 8, updatedAt: null, metadata: { spaceId: space.space_id, spaceSlug: space.space_slug, projectId: space.project_id, bindingKind: space.binding_kind },
    })),
    ...visiblePages.map((page) => ({
      id: `wiki_page:${page.space_id}:${page.path}`, kind: "wiki_page", label: page.title ?? page.path.split("/").pop()?.replace(/\.md$/i, "") ?? page.path,
      sublabel: `${page.space_name} · ${page.path}`, status: page.visibility === "private" ? "private" : null,
      group: page.page_type ?? page.space_slug,
      href: page.space_slug === DEFAULT_SPACE_SLUG ? `/wiki/page/${page.path}` : `/wiki/spaces/${encodeURIComponent(page.space_slug)}/page/${page.path}`,
      weight: 4, updatedAt: page.updated_at,
      metadata: { pageId: page.id, path: page.path, spaceId: page.space_id, spaceSlug: page.space_slug, tags: jsonArray(page.tags), aliases: jsonArray(page.aliases), visibility: page.visibility },
    })),
  ];
  const edges = [
    ...visiblePages.map((page) => ({
      id: `contains:${page.space_id}:${page.id}`, from: `space:${page.space_id}`, to: `wiki_page:${page.space_id}:${page.path}`,
      kind: "contains", label: "page", weight: 0.6, metadata: {},
    })),
    ...visibleRelations.flatMap((relation) => {
      const source = pageById.get(String(relation.source_page_id));
      const target = relation.target_page_id ? pageById.get(String(relation.target_page_id)) : null;
      if (!source || !target || !spaceIds.has(source.space_id) || !spaceIds.has(target.space_id)) return [];
      return [{
        id: String(relation.id), from: `wiki_page:${source.space_id}:${source.path}`, to: `wiki_page:${target.space_id}:${target.path}`,
        kind: "wiki_link", label: stringField(relation.label) ?? String(relation.relation_type), weight: relation.origin_kind === "ai_suggestion" ? 1.8 : relation.origin_kind === "canvas" ? 1.6 : 1.3,
        metadata: { relationType: relation.relation_type, originKind: relation.origin_kind, ...jsonObject(relation.metadata) },
      }];
    }),
  ];
  const connected = new Set(edges.filter((edge) => edge.kind === "wiki_link").flatMap((edge) => [edge.from, edge.to]));
  return {
    status: "ok", checkedAt: new Date().toISOString(), wikiId,
    scope: { kind: scope, spaceSlug: requestedSpace ?? null, depth: Math.max(1, Math.min(4, Number(input.depth) || 1)), focusPath: input.focusPath ?? null },
    nodes, edges,
    stats: {
      nodes: nodes.length, edges: edges.length, wikiPages: visiblePages.length, spaces: spaceIds.size,
      relations: visibleRelations.length, orphans: visiblePages.filter((page) => !connected.has(`wiki_page:${page.space_id}:${page.path}`)).length,
      issues: 0, projects: 0, agents: 0, documents: 0, workProducts: 0, references: visibleRelations.length,
    },
    warnings: [],
  };
}

export async function reindexSecondBrain(ctx: PluginContext, input: { companyId: string; wikiId?: string | null }) {
  const wikiId = stringField(input.wikiId) ?? DEFAULT_WIKI_ID;
  const spaces = (await listSpaces(ctx, { companyId: input.companyId, wikiId })).spaces;
  let indexed = 0;
  const warnings: string[] = [];
  for (const space of spaces) {
    const pages = await ctx.db.query<{ path: string }>(
      `SELECT path FROM ${table(ctx, "wiki_pages")} WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND deleted_at IS NULL ORDER BY path`,
      [input.companyId, wikiId, space.id],
    );
    for (const page of pages) {
      try {
        const contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, relativePath(space, page.path));
        await syncPageKnowledgeIndex(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, path: page.path, contents, author: { kind: "plugin" } });
        indexed += 1;
      } catch (error) {
        warnings.push(`${space.slug}:${page.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { status: "ok", indexed, warnings };
}
