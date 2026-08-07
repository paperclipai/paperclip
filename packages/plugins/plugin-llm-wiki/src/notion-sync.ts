import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Company, PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { WIKI_ROOT_FOLDER_KEY } from "./manifest.js";
import { DEFAULT_SPACE_SLUG, DEFAULT_WIKI_ID, resolveSpace, writeWikiPage, type WikiSpace } from "./wiki.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_NOTION_TOKEN_PATH = "~/.paperclip/instances/default/secrets/notion-token.txt";
const DEFAULT_NOTION_TASKS_DATABASE_ID_PATH = "~/.paperclip/instances/default/secrets/notion-tasks-database-id.txt";
const MAX_NOTION_BLOCK_CHILDREN = 100;

type NotionSyncConfig = {
  enabled: boolean;
  wikiId: string;
  spaceSlug: string;
  tokenPath: string;
  tasksDatabaseIdPath: string;
  token?: string | null;
  tasksDatabaseId?: string | null;
  /**
   * Companies this job fans out over. The host never grants a plugin a wildcard
   * ("all companies") scope on a proactive worker-to-host call, so the job must
   * name each company explicitly and issue one company-scoped call per entry.
   */
  companyIds: string[];
};

type SyncCursor = {
  notionPageId: string;
  wikiPath: string;
  notionLastEditedTime: string | null;
  notionContentHash: string | null;
  wikiContentHash: string | null;
  origin: "notion" | "wiki" | string;
};

type NotionPage = {
  id: string;
  object: "page";
  url?: string;
  archived?: boolean;
  last_edited_time?: string;
  created_time?: string;
  properties?: Record<string, unknown>;
  parent?: Record<string, unknown>;
};

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type SyncCounts = {
  companies: number;
  notionPagesSeen: number;
  notionPagesWritten: number;
  notionPagesSkipped: number;
  wikiPagesSeen: number;
  wikiPagesPushed: number;
  conflicts: number;
  failures: number;
};

type CompanySyncResult = {
  companyId: string;
  wikiId: string;
  spaceSlug: string;
  status: "succeeded" | "failed" | "partial";
  counts: SyncCounts;
  warnings: string[];
  affectedPages: string[];
};

function contentHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function tableName(namespace: string, table: string): string {
  return `${namespace}.${table}`;
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? "";
  if (path.startsWith("~/")) return `${process.env.HOME ?? ""}${path.slice(1)}`;
  return path;
}

function readSecretFile(path: string): string | null {
  try {
    const value = readFileSync(expandHome(path), "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const CYRILLIC_TRANSLIT: Record<string, string> = {
  "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d",
  "\u0435": "e", "\u0451": "e", "\u0436": "zh", "\u0437": "z", "\u0438": "i",
  "\u0439": "i", "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n",
  "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t",
  "\u0443": "u", "\u0444": "f", "\u0445": "h", "\u0446": "ts", "\u0447": "ch",
  "\u0448": "sh", "\u0449": "shch", "\u044a": "", "\u044b": "y", "\u044c": "",
  "\u044d": "e", "\u044e": "yu", "\u044f": "ya",
};

function transliterate(value: string): string {
  let out = "";
  for (const ch of value) {
    out += CYRILLIC_TRANSLIT[ch] ?? ch;
  }
  return out;
}

const MAX_SLUG_LENGTH = 80;

function slugify(value: string): string {
  const slug = transliterate(value.trim().toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function normalizePageId(id: string): string {
  return id.replace(/-/g, "");
}

function notionPagePath(page: NotionPage, title: string): string {
  return `wiki/notion/${slugify(title)}-${normalizePageId(page.id)}.md`;
}

function frontmatterValue(value: string): string {
  return JSON.stringify(value);
}

function buildFrontmatter(input: {
  title: string;
  pageId: string;
  lastEditedTime: string;
  url?: string | null;
  contentHash: string;
}) {
  const lines = [
    "---",
    `title: ${frontmatterValue(input.title)}`,
    "source: notion",
    `notion_page_id: ${frontmatterValue(input.pageId)}`,
    `notion_last_edited_time: ${frontmatterValue(input.lastEditedTime)}`,
    `notion_content_hash: ${frontmatterValue(input.contentHash)}`,
    "notion_sync: true",
    input.url ? `notion_url: ${frontmatterValue(input.url)}` : null,
    "---",
    "",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function parseFrontmatter(contents: string): { frontmatter: Record<string, string | boolean>; body: string } {
  if (!contents.startsWith("---\n")) return { frontmatter: {}, body: contents };
  const end = contents.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: contents };
  const raw = contents.slice(4, end).split(/\r?\n/);
  const frontmatter: Record<string, string | boolean> = {};
  for (const line of raw) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    if (trimmed === "true") {
      frontmatter[key] = true;
    } else if (trimmed === "false") {
      frontmatter[key] = false;
    } else if (trimmed.startsWith("\"")) {
      try {
        frontmatter[key] = JSON.parse(trimmed) as string;
      } catch {
        frontmatter[key] = trimmed;
      }
    } else {
      frontmatter[key] = trimmed;
    }
  }
  return { frontmatter, body: contents.slice(end + "\n---".length).replace(/^\r?\n/, "") };
}

function serializeFrontmatter(frontmatter: Record<string, string | boolean>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${typeof value === "boolean" ? String(value) : frontmatterValue(value)}`);
  }
  lines.push("---", "", body.replace(/^\r?\n/, "").trimEnd(), "");
  return lines.join("\n");
}

function plainText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((part) => typeof part === "object" && part != null && "plain_text" in part ? String(part.plain_text ?? "") : "")
    .join("");
}

function titleFromPage(page: NotionPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (typeof property !== "object" || property == null) continue;
    const maybe = property as { type?: string; title?: unknown };
    if (maybe.type === "title") {
      const title = plainText(maybe.title);
      if (title.trim()) return title.trim();
    }
  }
  return `Notion page ${normalizePageId(page.id).slice(0, 8)}`;
}

function renderBlock(block: NotionBlock): string {
  const value = block[block.type];
  const payload = typeof value === "object" && value != null ? value as Record<string, unknown> : {};
  const text = plainText(payload.rich_text);
  switch (block.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${payload.checked === true ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`${stringField(payload.language) ?? ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "paragraph":
      return text;
    case "child_page":
      return `[[${stringField(payload.title) ?? "Child page"}]]`;
    default:
      return text.trim() ? text : `<!-- unsupported Notion block: ${block.type} -->`;
  }
}

function markdownToNotionBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    for (const chunk of chunkText(text)) {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: richText(chunk) } });
    }
  };
  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const todo = /^[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const type = `heading_${level}`;
      blocks.push({ object: "block", type, [type]: { rich_text: richText(heading[2]) } });
    } else if (todo) {
      flushParagraph();
      blocks.push({ object: "block", type: "to_do", to_do: { checked: todo[1].toLowerCase() === "x", rich_text: richText(todo[2]) } });
    } else if (bullet) {
      flushParagraph();
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(bullet[1]) } });
    } else {
      paragraph.push(line);
    }
    if (blocks.length >= MAX_NOTION_BLOCK_CHILDREN) break;
  }
  flushParagraph();
  return blocks.slice(0, MAX_NOTION_BLOCK_CHILDREN);
}

function richText(text: string): Array<Record<string, unknown>> {
  return chunkText(text).map((content) => ({ type: "text", text: { content } }));
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
  return chunks.length > 0 ? chunks : [""];
}

async function notionRequest<T>(
  ctx: PluginContext,
  token: string,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const response = await ctx.http.fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      ...(init.headers ?? {}),
    },
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 250 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return notionRequest<T>(ctx, token, path, init, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Notion ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`);
  }
  return await response.json() as T;
}

async function listAccessiblePages(ctx: PluginContext, token: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;
  do {
    const payload = await notionRequest<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(ctx, token, "/search", {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "object", value: "page" },
        page_size: 100,
        start_cursor: startCursor,
      }),
    });
    for (const row of payload.results ?? []) {
      if (typeof row === "object" && row != null && (row as { object?: string }).object === "page") {
        pages.push(row as NotionPage);
      }
    }
    startCursor = payload.has_more ? payload.next_cursor ?? undefined : undefined;
  } while (startCursor);
  return pages.filter((page) => page.archived !== true);
}

async function listPageBlocks(ctx: PluginContext, token: string, pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let startCursor: string | undefined;
  do {
    const suffix = new URLSearchParams({ page_size: "100" });
    if (startCursor) suffix.set("start_cursor", startCursor);
    const payload = await notionRequest<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(
      ctx,
      token,
      `/blocks/${pageId}/children?${suffix.toString()}`,
    );
    for (const row of payload.results ?? []) {
      if (typeof row === "object" && row != null && typeof (row as { type?: unknown }).type === "string") {
        blocks.push(row as NotionBlock);
      }
    }
    startCursor = payload.has_more ? payload.next_cursor ?? undefined : undefined;
  } while (startCursor);
  return blocks;
}

async function replacePageBlocks(ctx: PluginContext, token: string, pageId: string, blocks: Array<Record<string, unknown>>) {
  const current = await listPageBlocks(ctx, token, pageId);
  for (const block of current) {
    await notionRequest(ctx, token, `/blocks/${block.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
  }
  if (blocks.length === 0) return;
  await notionRequest(ctx, token, `/blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children: blocks.slice(0, MAX_NOTION_BLOCK_CHILDREN) }),
  });
}

async function titlePropertyName(ctx: PluginContext, token: string, databaseId: string): Promise<string> {
  const database = await notionRequest<{ properties?: Record<string, { type?: string }> }>(ctx, token, `/databases/${databaseId}`);
  for (const [name, property] of Object.entries(database.properties ?? {})) {
    if (property?.type === "title") return name;
  }
  return "Name";
}

async function createNotionPage(ctx: PluginContext, token: string, databaseId: string, title: string, markdown: string): Promise<NotionPage> {
  const titleProp = await titlePropertyName(ctx, token, databaseId);
  return await notionRequest<NotionPage>(ctx, token, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        [titleProp]: { title: richText(title) },
      },
      children: markdownToNotionBlocks(markdown),
    }),
  });
}

function stringArrayField(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => stringField(entry))
    .filter((entry): entry is string => Boolean(entry));
  return out.length > 0 ? out : null;
}

async function readConfig(ctx: PluginContext): Promise<NotionSyncConfig> {
  const config = await ctx.config.get();
  return {
    enabled: config.notionSyncEnabled !== false,
    wikiId: stringField(config.notionSyncWikiId) ?? DEFAULT_WIKI_ID,
    spaceSlug: stringField(config.notionSyncSpaceSlug) ?? DEFAULT_SPACE_SLUG,
    token: stringField(config.notionToken) ?? process.env.NOTION_TOKEN ?? null,
    tokenPath: stringField(config.notionTokenPath) ?? process.env.NOTION_TOKEN_PATH ?? DEFAULT_NOTION_TOKEN_PATH,
    tasksDatabaseId: stringField(config.notionTasksDatabaseId) ?? process.env.NOTION_TASKS_DATABASE_ID ?? null,
    tasksDatabaseIdPath: stringField(config.notionTasksDatabaseIdPath) ?? process.env.NOTION_TASKS_DATABASE_ID_PATH ?? DEFAULT_NOTION_TASKS_DATABASE_ID_PATH,
    companyIds: stringArrayField(config.notionSyncCompanyIds) ?? [],
  };
}

function resolveToken(config: NotionSyncConfig): string {
  const token = config.token ?? readSecretFile(config.tokenPath);
  if (!token) {
    throw new Error(`Notion token missing. Configure notionToken/notionTokenPath or create ${config.tokenPath}.`);
  }
  return token;
}

function resolveTasksDatabaseId(config: NotionSyncConfig): string | null {
  return config.tasksDatabaseId ?? readSecretFile(config.tasksDatabaseIdPath);
}

async function readCursor(ctx: PluginContext, input: { companyId: string; wikiId: string; spaceId: string; notionPageId?: string; wikiPath?: string }): Promise<SyncCursor | null> {
  const byPage = input.notionPageId
    ? await ctx.db.query<Record<string, unknown>>(
        `SELECT notion_page_id, wiki_path, notion_last_edited_time::text AS notion_last_edited_time,
                notion_content_hash, wiki_content_hash, origin
           FROM ${tableName(ctx.db.namespace, "notion_sync_cursors")}
          WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND notion_page_id = $4
          LIMIT 1`,
        [input.companyId, input.wikiId, input.spaceId, input.notionPageId],
      )
    : [];
  const byPath = !byPage[0] && input.wikiPath
    ? await ctx.db.query<Record<string, unknown>>(
        `SELECT notion_page_id, wiki_path, notion_last_edited_time::text AS notion_last_edited_time,
                notion_content_hash, wiki_content_hash, origin
           FROM ${tableName(ctx.db.namespace, "notion_sync_cursors")}
          WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND wiki_path = $4
          LIMIT 1`,
        [input.companyId, input.wikiId, input.spaceId, input.wikiPath],
      )
    : [];
  const row = byPage[0] ?? byPath[0];
  return row ? {
    notionPageId: String(row.notion_page_id),
    wikiPath: String(row.wiki_path),
    notionLastEditedTime: stringField(row.notion_last_edited_time),
    notionContentHash: stringField(row.notion_content_hash),
    wikiContentHash: stringField(row.wiki_content_hash),
    origin: stringField(row.origin) ?? "notion",
  } : null;
}

async function upsertCursor(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  notionPageId: string;
  wikiPath: string;
  notionLastEditedTime?: string | null;
  notionContentHash?: string | null;
  wikiContentHash?: string | null;
  origin: "notion" | "wiki";
  metadata?: Record<string, unknown>;
}) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "notion_sync_cursors")} AS notion_sync_cursors
       (id, company_id, wiki_id, space_id, notion_page_id, wiki_path, notion_last_edited_time,
        notion_content_hash, wiki_content_hash, origin, last_synced_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, now(), $11::jsonb)
     ON CONFLICT (company_id, wiki_id, space_id, notion_page_id)
     DO UPDATE SET wiki_path = EXCLUDED.wiki_path,
                   notion_last_edited_time = EXCLUDED.notion_last_edited_time,
                   notion_content_hash = EXCLUDED.notion_content_hash,
                   wiki_content_hash = EXCLUDED.wiki_content_hash,
                   origin = EXCLUDED.origin,
                   last_synced_at = now(),
                   metadata = EXCLUDED.metadata,
                   updated_at = now()`,
    [
      randomUUID(),
      input.companyId,
      input.wikiId,
      input.spaceId,
      input.notionPageId,
      input.wikiPath,
      input.notionLastEditedTime ?? null,
      input.notionContentHash ?? null,
      input.wikiContentHash ?? null,
      input.origin,
      jsonParam(input.metadata ?? {}),
    ],
  );
}

async function recordOperation(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  operationId: string;
  runId: string;
  status: "succeeded" | "failed" | "partial";
  warnings: string[];
  affectedPages: string[];
  metadata: Record<string, unknown>;
}) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_operations")}
       (id, company_id, wiki_id, space_id, operation_type, status, run_ids, cost_cents, warnings, affected_pages, metadata)
     VALUES ($1, $2, $3, $4, 'notion-sync', $5, $6::jsonb, 0, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [
      input.operationId,
      input.companyId,
      input.wikiId,
      input.spaceId,
      input.status,
      jsonParam([input.runId]),
      jsonParam(input.warnings),
      jsonParam(input.affectedPages),
      jsonParam(input.metadata),
    ],
  );
}

async function appendWikiLog(ctx: PluginContext, companyId: string, space: WikiSpace, entry: string) {
  let current = "";
  try {
    current = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, space.pathPrefix ? `${space.pathPrefix}/wiki/log.md` : "wiki/log.md");
  } catch {
    current = "# Log\n\nAppend-only chronological record of wiki operations.\n";
  }
  const path = space.pathPrefix ? `${space.pathPrefix}/wiki/log.md` : "wiki/log.md";
  await ctx.localFolders.writeTextAtomic(companyId, WIKI_ROOT_FOLDER_KEY, path, `${current.trimEnd()}\n\n- ${new Date().toISOString()} ${entry}\n`);
}

async function readExistingWikiContents(ctx: PluginContext, companyId: string, space: WikiSpace, path: string): Promise<string | null> {
  try {
    return await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, space.pathPrefix ? `${space.pathPrefix}/${path}` : path);
  } catch {
    return null;
  }
}

async function listWikiSyncPages(ctx: PluginContext, companyId: string, space: WikiSpace): Promise<Array<{ path: string; contents: string }>> {
  const prefix = space.pathPrefix ? `${space.pathPrefix}/wiki` : "wiki";
  const listing = await ctx.localFolders.list(companyId, WIKI_ROOT_FOLDER_KEY, { relativePath: prefix, recursive: true, maxEntries: 5000 });
  const pages: Array<{ path: string; contents: string }> = [];
  for (const entry of listing.entries) {
    if (entry.kind !== "file" || !entry.path.endsWith(".md")) continue;
    const relativePath = space.pathPrefix && entry.path.startsWith(`${space.pathPrefix}/`)
      ? entry.path.slice(space.pathPrefix.length + 1)
      : entry.path;
    const contents = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, entry.path);
    const { frontmatter } = parseFrontmatter(contents);
    if (frontmatter.notion_sync === true) pages.push({ path: relativePath, contents });
  }
  return pages;
}

async function syncNotionToWiki(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  space: WikiSpace;
  token: string;
  counts: SyncCounts;
  warnings: string[];
  affectedPages: string[];
}) {
  const pages = await listAccessiblePages(ctx, input.token);
  input.counts.notionPagesSeen += pages.length;
  if (pages.length === 0) {
    input.warnings.push("Notion search returned zero accessible pages; check integration share settings.");
  }
  for (const page of pages) {
    try {
      const title = titleFromPage(page);
      const path = notionPagePath(page, title);
      const cursor = await readCursor(ctx, {
        companyId: input.companyId,
        wikiId: input.wikiId,
        spaceId: input.space.id,
        notionPageId: page.id,
      });
      if (cursor?.notionLastEditedTime === page.last_edited_time) {
        input.counts.notionPagesSkipped += 1;
        continue;
      }
      const blocks = await listPageBlocks(ctx, input.token, page.id);
      const body = blocks.map(renderBlock).join("\n\n").trimEnd();
      const notionHash = contentHash(body);
      const existingWikiContents = await readExistingWikiContents(ctx, input.companyId, input.space, path);
      const existingWikiHash = existingWikiContents ? contentHash(existingWikiContents) : null;
      const contents = `${buildFrontmatter({
        title,
        pageId: page.id,
        lastEditedTime: page.last_edited_time ?? new Date().toISOString(),
        url: page.url,
        contentHash: notionHash,
      })}${body}\n`;
      const wikiHash = contentHash(contents);
      if (cursor && existingWikiHash && cursor.wikiContentHash && existingWikiHash !== cursor.wikiContentHash && cursor.notionContentHash !== notionHash && cursor.origin === "notion") {
        input.counts.conflicts += 1;
        input.warnings.push(`Conflict on ${path}: Notion changed and wiki changed since last sync; Notion authority applied.`);
        await appendWikiLog(ctx, input.companyId, input.space, `Notion sync conflict on ${path}; Notion authority applied for notion-origin page ${page.id}.`);
      }
      await writeWikiPage(ctx, {
        companyId: input.companyId,
        wikiId: input.wikiId,
        spaceSlug: input.space.slug,
        path,
        contents,
        summary: `Sync Notion page ${page.id}`,
        sourceRefs: [{ type: "notion", pageId: page.id, url: page.url ?? null, lastEditedTime: page.last_edited_time ?? null }],
        writer: "board_ui",
      });
      await upsertCursor(ctx, {
        companyId: input.companyId,
        wikiId: input.wikiId,
        spaceId: input.space.id,
        notionPageId: page.id,
        wikiPath: path,
        notionLastEditedTime: page.last_edited_time ?? null,
        notionContentHash: notionHash,
        wikiContentHash: wikiHash,
        origin: "notion",
        metadata: { title, notionUrl: page.url ?? null },
      });
      input.affectedPages.push(path);
      input.counts.notionPagesWritten += 1;
    } catch (error) {
      input.counts.failures += 1;
      input.warnings.push(`Failed Notion->Wiki page ${page.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function syncWikiToNotion(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  space: WikiSpace;
  token: string;
  tasksDatabaseId: string | null;
  counts: SyncCounts;
  warnings: string[];
  affectedPages: string[];
}) {
  const pages = await listWikiSyncPages(ctx, input.companyId, input.space);
  input.counts.wikiPagesSeen += pages.length;
  for (const page of pages) {
    try {
      const parsed = parseFrontmatter(page.contents);
      const bodyHash = contentHash(parsed.body.trimEnd());
      const notionPageId = stringField(parsed.frontmatter.notion_page_id);
      const cursor = await readCursor(ctx, {
        companyId: input.companyId,
        wikiId: input.wikiId,
        spaceId: input.space.id,
        notionPageId: notionPageId ?? undefined,
        wikiPath: page.path,
      });
      const wikiHash = contentHash(page.contents);
      if (cursor?.wikiContentHash === wikiHash) continue;
      const targetNotionPageId = notionPageId ?? (cursor?.origin === "wiki" ? cursor.notionPageId : null);

      if (targetNotionPageId) {
        if (cursor?.origin !== "wiki") {
          input.counts.conflicts += 1;
          input.warnings.push(`Conflict on ${page.path}: Notion-origin page changed in wiki; Notion remains authority and writeback skipped.`);
          await appendWikiLog(ctx, input.companyId, input.space, `Notion sync conflict on ${page.path}; skipped wiki writeback because Notion is authority for notion-origin page ${targetNotionPageId}.`);
          continue;
        }
        await replacePageBlocks(ctx, input.token, targetNotionPageId, markdownToNotionBlocks(parsed.body));
        let contentsForCursor = page.contents;
        if (!notionPageId) {
          contentsForCursor = serializeFrontmatter({
            ...parsed.frontmatter,
            notion_page_id: targetNotionPageId,
            notion_sync: true,
          }, parsed.body);
          await writeWikiPage(ctx, {
            companyId: input.companyId,
            wikiId: input.wikiId,
            spaceSlug: input.space.slug,
            path: page.path,
            contents: contentsForCursor,
            summary: `Persist Notion page id ${targetNotionPageId}`,
            sourceRefs: [{ type: "notion", pageId: targetNotionPageId }],
            writer: "board_ui",
          });
        }
        await upsertCursor(ctx, {
          companyId: input.companyId,
          wikiId: input.wikiId,
          spaceId: input.space.id,
          notionPageId: targetNotionPageId,
          wikiPath: page.path,
          notionLastEditedTime: stringField(parsed.frontmatter.notion_last_edited_time),
          notionContentHash: bodyHash,
          wikiContentHash: contentHash(contentsForCursor),
          origin: "wiki",
          metadata: { pushedFromWiki: true },
        });
      } else {
        if (!input.tasksDatabaseId) {
          input.warnings.push(`Wiki page ${page.path} has notion_sync=true but no notion_page_id and no Tasks DB id configured; create skipped.`);
          continue;
        }
        const created = await createNotionPage(ctx, input.token, input.tasksDatabaseId, String(parsed.frontmatter.title ?? page.path), parsed.body);
        const contentsWithNotionId = serializeFrontmatter({
          ...parsed.frontmatter,
          notion_page_id: created.id,
          notion_last_edited_time: created.last_edited_time ?? new Date().toISOString(),
          notion_url: created.url ?? "",
          notion_sync: true,
        }, parsed.body);
        await writeWikiPage(ctx, {
          companyId: input.companyId,
          wikiId: input.wikiId,
          spaceSlug: input.space.slug,
          path: page.path,
          contents: contentsWithNotionId,
          summary: `Persist created Notion page ${created.id}`,
          sourceRefs: [{ type: "notion", pageId: created.id, url: created.url ?? null, lastEditedTime: created.last_edited_time ?? null }],
          writer: "board_ui",
        });
        await upsertCursor(ctx, {
          companyId: input.companyId,
          wikiId: input.wikiId,
          spaceId: input.space.id,
          notionPageId: created.id,
          wikiPath: page.path,
          notionLastEditedTime: created.last_edited_time ?? null,
          notionContentHash: bodyHash,
          wikiContentHash: contentHash(contentsWithNotionId),
          origin: "wiki",
          metadata: { createdFromWiki: true, notionUrl: created.url ?? null },
        });
      }
      input.affectedPages.push(page.path);
      input.counts.wikiPagesPushed += 1;
    } catch (error) {
      input.counts.failures += 1;
      input.warnings.push(`Failed Wiki->Notion page ${page.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function syncCompany(ctx: PluginContext, company: Company, job: PluginJobContext): Promise<CompanySyncResult> {
  const config = await readConfig(ctx);
  const counts: SyncCounts = {
    companies: 1,
    notionPagesSeen: 0,
    notionPagesWritten: 0,
    notionPagesSkipped: 0,
    wikiPagesSeen: 0,
    wikiPagesPushed: 0,
    conflicts: 0,
    failures: 0,
  };
  const warnings: string[] = [];
  const affectedPages: string[] = [];
  const wikiId = config.wikiId;

  const folderStatus = await ctx.localFolders.status(company.id, WIKI_ROOT_FOLDER_KEY);
  if (!folderStatus.configured || !folderStatus.readable) {
    return {
      companyId: company.id,
      wikiId,
      spaceSlug: config.spaceSlug,
      status: "succeeded",
      counts,
      warnings: ["Skipped: wiki-root local folder is not configured for this company."],
      affectedPages,
    };
  }

  const space = await resolveSpace(ctx, { companyId: company.id, wikiId, spaceSlug: config.spaceSlug });
  const operationId = randomUUID();
  try {
    if (!config.enabled) {
      warnings.push("Notion sync disabled by plugin config.");
      await recordOperation(ctx, {
        companyId: company.id,
        wikiId,
        spaceId: space.id,
        operationId,
        runId: job.runId,
        status: "succeeded",
        warnings,
        affectedPages,
        metadata: { skipped: true, reason: "disabled" },
      });
      return { companyId: company.id, wikiId, spaceSlug: space.slug, status: "succeeded", counts, warnings, affectedPages };
    }
    const token = resolveToken(config);
    const tasksDatabaseId = resolveTasksDatabaseId(config);
    await syncNotionToWiki(ctx, { companyId: company.id, wikiId, space, token, counts, warnings, affectedPages });
    await syncWikiToNotion(ctx, { companyId: company.id, wikiId, space, token, tasksDatabaseId, counts, warnings, affectedPages });
  } catch (error) {
    counts.failures += 1;
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const status = counts.failures > 0 && (counts.notionPagesWritten > 0 || counts.wikiPagesPushed > 0) ? "partial" : counts.failures > 0 ? "failed" : "succeeded";
  await recordOperation(ctx, {
    companyId: company.id,
    wikiId,
    spaceId: space.id,
    operationId,
    runId: job.runId,
    status,
    warnings,
    affectedPages,
    metadata: { counts, scheduledAt: job.scheduledAt, trigger: job.trigger },
  });
  await ctx.metrics.write("notion_sync.run", 1, { status, trigger: job.trigger });
  return { companyId: company.id, wikiId, spaceSlug: space.slug, status, counts, warnings, affectedPages };
}

export async function runNotionWikiSync(ctx: PluginContext, job: PluginJobContext) {
  const { companyIds } = await readConfig(ctx);
  if (companyIds.length === 0) {
    ctx.logger.warn("Notion Wiki sync skipped: no notionSyncCompanyIds configured", {
      jobKey: job.jobKey,
      runId: job.runId,
    });
    return { status: "skipped", results: [] as CompanySyncResult[] };
  }
  const companies: Company[] = [];
  for (const companyId of companyIds) {
    const company = await ctx.companies.get(companyId);
    if (!company) {
      ctx.logger.warn("Notion Wiki sync: configured company not found or not authorized", {
        jobKey: job.jobKey,
        runId: job.runId,
        companyId,
      });
      continue;
    }
    companies.push(company);
  }
  const results: CompanySyncResult[] = [];
  for (const company of companies) {
    results.push(await syncCompany(ctx, company, job));
  }
  ctx.logger.info("Notion Wiki sync job completed", {
    jobKey: job.jobKey,
    runId: job.runId,
    companyCount: companies.length,
    statuses: results.map((result) => ({ companyId: result.companyId, status: result.status, counts: result.counts })),
  });
  return { status: "ok", results };
}
