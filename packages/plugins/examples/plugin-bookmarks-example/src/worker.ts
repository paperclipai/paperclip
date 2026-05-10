import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { BOOKMARKS_FOLDER_KEY } from "./manifest.js";

export interface BookmarkRecord {
  id: string;
  companyId: string;
  slug: string;
  url: string;
  title: string;
  notes: string;
  tags: string[];
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkInput {
  url: string;
  title?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  slug?: string | null;
}

export interface BookmarkListResult {
  databaseNamespace: string;
  bookmarks: BookmarkRecord[];
}

const SLUG_RESERVED = new Set(["", ".", "..", "_"]);
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 32;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 4000;
const MAX_BOOKMARKS_PER_LIST = 200;

function tableName(namespace: string): string {
  return `${namespace}.bookmarks`;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(value: unknown): string {
  const raw = asNonEmptyString(value);
  if (!raw) {
    throw new Error("`url` is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("`url` must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("`url` must use http or https");
  }
  return parsed.toString();
}

function normalizeTitle(value: unknown, fallback: string): string {
  const raw = asNonEmptyString(value);
  const candidate = raw ?? fallback;
  return candidate.length > MAX_TITLE_LENGTH ? candidate.slice(0, MAX_TITLE_LENGTH) : candidate;
}

function normalizeNotes(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new Error("`notes` must be a string when provided");
  }
  if (value.length > MAX_NOTES_LENGTH) {
    throw new Error(`\`notes\` must be ${MAX_NOTES_LENGTH} characters or fewer`);
  }
  return value;
}

function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("`tags` must be an array of strings when provided");
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("`tags` must contain only strings");
    }
    const cleaned = entry.trim().toLowerCase();
    if (!cleaned) continue;
    if (cleaned.length > MAX_TAG_LENGTH) {
      throw new Error(`tag "${entry}" exceeds ${MAX_TAG_LENGTH} characters`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) {
      throw new Error(`tag "${entry}" must use lowercase letters, digits, hyphens, or underscores`);
    }
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    tags.push(cleaned);
    if (tags.length > MAX_TAGS) {
      throw new Error(`bookmarks accept at most ${MAX_TAGS} tags`);
    }
  }
  return tags;
}

export function deriveSlugCandidate(url: string, title: string | null): string {
  const titleSource = title?.trim();
  if (titleSource) {
    const slug = slugify(titleSource);
    if (slug) return slug;
  }
  try {
    const parsed = new URL(url);
    const base = `${parsed.hostname}${parsed.pathname}`;
    const slug = slugify(base);
    if (slug) return slug;
  } catch {
    // fall through
  }
  return "bookmark";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeSlug(value: unknown, fallback: string): string {
  const raw = asNonEmptyString(value);
  if (!raw) {
    if (SLUG_RESERVED.has(fallback)) return "bookmark";
    return fallback;
  }
  const cleaned = slugify(raw);
  if (!cleaned || SLUG_RESERVED.has(cleaned)) {
    throw new Error("`slug` must contain at least one alphanumeric character");
  }
  return cleaned;
}

function bookmarkFilePath(slug: string): string {
  return `bookmarks/${slug}.md`;
}

export function renderBookmarkMarkdown(bookmark: BookmarkRecord): string {
  const frontmatter = [
    "---",
    `slug: ${bookmark.slug}`,
    `url: ${bookmark.url}`,
    `title: ${escapeFrontmatterValue(bookmark.title)}`,
    `tags: [${bookmark.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `created_at: ${bookmark.createdAt}`,
    `updated_at: ${bookmark.updatedAt}`,
    "---",
    "",
  ].join("\n");
  if (bookmark.notes.length === 0) return frontmatter;
  return `${frontmatter}\n${bookmark.notes.trimEnd()}\n`;
}

function escapeFrontmatterValue(value: string): string {
  if (/^[A-Za-z0-9 _.,:'/()&-]+$/.test(value) && !value.startsWith(" ")) {
    return value;
  }
  return JSON.stringify(value);
}

interface BookmarkRow {
  id: string;
  company_id: string;
  slug: string;
  url: string;
  title: string;
  notes: string;
  tags: string[];
  file_path: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToBookmark(row: BookmarkRow): BookmarkRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    slug: row.slug,
    url: row.url,
    title: row.title,
    notes: row.notes,
    tags: Array.isArray(row.tags) ? [...row.tags] : [],
    filePath: row.file_path,
    createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
  };
}

async function listBookmarks(
  ctx: PluginContext,
  companyId: string,
  search: string | null,
  tag: string | null,
  limit: number,
): Promise<BookmarkRecord[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    where += ` AND (lower(title) LIKE $${idx} OR lower(url) LIKE $${idx} OR lower(notes) LIKE $${idx})`;
  }
  if (tag) {
    params.push(tag);
    where += ` AND $${params.length} = ANY(tags)`;
  }
  params.push(Math.min(Math.max(limit, 1), MAX_BOOKMARKS_PER_LIST));
  const rows = await ctx.db.query<BookmarkRow>(
    `SELECT id, company_id, slug, url, title, notes, tags, file_path, created_at, updated_at
     FROM ${tableName(ctx.db.namespace)}
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToBookmark);
}

export async function createBookmark(
  ctx: PluginContext,
  companyId: string,
  input: BookmarkInput,
): Promise<BookmarkRecord> {
  const url = normalizeUrl(input.url);
  const inputTitle = asNonEmptyString(input.title);
  const title = inputTitle ? normalizeTitle(inputTitle, url) : url;
  const notes = normalizeNotes(input.notes);
  const tags = normalizeTags(input.tags);
  const fallbackSlug = deriveSlugCandidate(url, inputTitle);
  const slug = input.slug != null
    ? normalizeSlug(input.slug, fallbackSlug)
    : (SLUG_RESERVED.has(fallbackSlug) ? "bookmark" : fallbackSlug);
  const id = randomUUID();
  const filePath = bookmarkFilePath(slug);
  const now = new Date().toISOString();

  const insert = await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace)}
       (id, company_id, slug, url, title, notes, tags, file_path, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (company_id, slug) DO NOTHING`,
    [id, companyId, slug, url, title, notes, tags, filePath, now],
  );
  if (insert.rowCount === 0) {
    throw new Error(`Bookmark with slug "${slug}" already exists`);
  }

  const bookmark: BookmarkRecord = {
    id,
    companyId,
    slug,
    url,
    title,
    notes,
    tags,
    filePath,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ctx.localFolders.writeTextAtomic(
      companyId,
      BOOKMARKS_FOLDER_KEY,
      filePath,
      renderBookmarkMarkdown(bookmark),
    );
  } catch (error) {
    ctx.logger.warn("Failed to write bookmark markdown to local folder; row kept", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return bookmark;
}

export async function deleteBookmark(
  ctx: PluginContext,
  companyId: string,
  slug: string,
): Promise<{ deleted: boolean; slug: string }> {
  const result = await ctx.db.execute(
    `DELETE FROM ${tableName(ctx.db.namespace)} WHERE company_id = $1 AND slug = $2`,
    [companyId, slug],
  );
  if (result.rowCount > 0) {
    try {
      await ctx.localFolders.deleteFile(companyId, BOOKMARKS_FOLDER_KEY, bookmarkFilePath(slug));
    } catch (error) {
      ctx.logger.warn("Failed to delete bookmark markdown from local folder; row was removed", {
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted: result.rowCount > 0, slug };
}

let listHandler: ((companyId: string, search: string | null, tag: string | null, limit: number) => Promise<BookmarkListResult>) | null = null;
let createHandler: ((companyId: string, input: BookmarkInput) => Promise<BookmarkRecord>) | null = null;
let deleteHandler: ((companyId: string, slug: string) => Promise<{ deleted: boolean; slug: string }>) | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    listHandler = (companyId, search, tag, limit) =>
      listBookmarks(ctx, companyId, search, tag, limit).then((bookmarks) => ({
        databaseNamespace: ctx.db.namespace,
        bookmarks,
      }));
    createHandler = (companyId, input) => createBookmark(ctx, companyId, input);
    deleteHandler = (companyId, slug) => deleteBookmark(ctx, companyId, slug);

    ctx.data.register("list", async (params) => {
      const companyId = asNonEmptyString(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      const search = asNonEmptyString(params.search)?.toLowerCase() ?? null;
      const tag = asNonEmptyString(params.tag)?.toLowerCase() ?? null;
      const limit = typeof params.limit === "number" ? params.limit : 50;
      if (!listHandler) throw new Error("Bookmarks plugin not ready");
      return listHandler(companyId, search, tag, limit);
    });

    ctx.actions.register("create", async (params) => {
      const companyId = asNonEmptyString(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      if (!createHandler) throw new Error("Bookmarks plugin not ready");
      return createHandler(companyId, {
        url: typeof params.url === "string" ? params.url : "",
        title: typeof params.title === "string" ? params.title : null,
        notes: typeof params.notes === "string" ? params.notes : null,
        tags: Array.isArray(params.tags) ? (params.tags as unknown[] as string[]) : null,
        slug: typeof params.slug === "string" ? params.slug : null,
      });
    });

    ctx.actions.register("delete", async (params) => {
      const companyId = asNonEmptyString(params.companyId);
      const slug = asNonEmptyString(params.slug);
      if (!companyId || !slug) throw new Error("companyId and slug are required");
      if (!deleteHandler) throw new Error("Bookmarks plugin not ready");
      return deleteHandler(companyId, slug);
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    switch (input.routeKey) {
      case "list": {
        if (!listHandler) return { status: 503, body: { error: "Bookmarks plugin not ready" } };
        const search = asNonEmptyString(input.query.search)?.toLowerCase() ?? null;
        const tag = asNonEmptyString(input.query.tag)?.toLowerCase() ?? null;
        const limitRaw = asNonEmptyString(input.query.limit);
        const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
        const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
        return { body: await listHandler(input.companyId, search, tag, limit) };
      }
      case "create": {
        if (!createHandler) return { status: 503, body: { error: "Bookmarks plugin not ready" } };
        const body = (input.body ?? {}) as Record<string, unknown>;
        try {
          const bookmark = await createHandler(input.companyId, {
            url: typeof body.url === "string" ? body.url : "",
            title: typeof body.title === "string" ? body.title : null,
            notes: typeof body.notes === "string" ? body.notes : null,
            tags: Array.isArray(body.tags) ? (body.tags as unknown[] as string[]) : null,
            slug: typeof body.slug === "string" ? body.slug : null,
          });
          return { status: 201, body: bookmark };
        } catch (error) {
          return {
            status: 400,
            body: { error: error instanceof Error ? error.message : "Invalid bookmark" },
          };
        }
      }
      case "delete": {
        if (!deleteHandler) return { status: 503, body: { error: "Bookmarks plugin not ready" } };
        const slug = input.params.slug;
        if (!slug) return { status: 400, body: { error: "slug is required" } };
        const result = await deleteHandler(input.companyId, slug);
        return { status: result.deleted ? 200 : 404, body: result };
      }
      default:
        return { status: 404, body: { error: `Unknown bookmarks route: ${input.routeKey}` } };
    }
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Bookmarks plugin worker is running",
      details: {
        surfaces: ["scoped-api-route", "database-namespace", "local-folder", "page", "dashboard-widget"],
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
