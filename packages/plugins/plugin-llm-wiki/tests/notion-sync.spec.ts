import { describe, expect, it } from "vitest";
import type { Company, PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { runNotionWikiSync } from "../src/notion-sync.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";

type CursorRow = {
  notionPageId: string;
  wikiPath: string;
  notionLastEditedTime: string | null;
  notionContentHash: string | null;
  wikiContentHash: string | null;
  origin: string;
};

function makeJob(): PluginJobContext {
  return {
    jobKey: "notion-wiki-sync",
    runId: "test-run",
    trigger: "manual",
    scheduledAt: "2026-06-24T00:00:00.000Z",
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeContext(input: {
  files?: Record<string, string>;
  notionPages?: Array<Record<string, unknown>>;
  blocksByPage?: Record<string, Array<Record<string, unknown>>>;
  companyIds?: string[];
}) {
  const files = { ...(input.files ?? {}) };
  const cursors: CursorRow[] = [];
  const operations: Array<Record<string, unknown>> = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let createdCount = 0;
  const company = {
    id: COMPANY_ID,
    name: "Test Company",
    slug: "test-company",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  } as unknown as Company;

  const ctx = {
    manifest: {},
    config: {
      async get() {
        return {
          notionToken: "test-token",
          notionTasksDatabaseId: "tasks-db",
          notionSyncCompanyIds: input.companyIds ?? [COMPANY_ID],
        };
      },
    },
    companies: {
      async get(companyId: string) {
        return companyId === COMPANY_ID ? company : null;
      },
    },
    http: {
      async fetch(url: string | URL, init?: RequestInit) {
        const parsed = new URL(String(url));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
        const method = init?.method ?? "GET";
        requests.push({ method, path: parsed.pathname, body });
        if (parsed.pathname === "/v1/search") {
          return jsonResponse({ results: input.notionPages ?? [], has_more: false, next_cursor: null });
        }
        if (parsed.pathname === "/v1/databases/tasks-db") {
          return jsonResponse({ properties: { "Task name": { type: "title" } } });
        }
        if (parsed.pathname === "/v1/pages" && method === "POST") {
          createdCount += 1;
          return jsonResponse({
            id: `created-page-${createdCount}`,
            object: "page",
            url: `https://notion.test/created-page-${createdCount}`,
            last_edited_time: "2026-06-24T00:01:00.000Z",
          });
        }
        const blockChildrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(parsed.pathname);
        if (blockChildrenMatch && method === "GET") {
          return jsonResponse({ results: input.blocksByPage?.[blockChildrenMatch[1]] ?? [], has_more: false, next_cursor: null });
        }
        if (blockChildrenMatch && method === "PATCH") {
          return jsonResponse({ ok: true });
        }
        const blockPatchMatch = /^\/v1\/blocks\/([^/]+)$/.exec(parsed.pathname);
        if (blockPatchMatch && method === "PATCH") {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ ok: true });
      },
    },
    localFolders: {
      async status(_companyId: string, folderKey: string) {
        return {
          folderKey,
          configured: true,
          path: "/tmp/wiki-root",
          realPath: "/tmp/wiki-root",
          access: "readWrite",
          readable: true,
          writable: true,
          requiredDirectories: [],
          requiredFiles: [],
          missingDirectories: [],
          missingFiles: [],
          healthy: true,
          problems: [],
          checkedAt: new Date().toISOString(),
        };
      },
      async list(_companyId: string, _folderKey: string, options?: { relativePath?: string; recursive?: boolean; maxEntries?: number }) {
        const prefix = options?.relativePath ? `${options.relativePath.replace(/\/$/, "")}/` : "";
        return {
          folderKey: "wiki-root",
          relativePath: options?.relativePath ?? null,
          truncated: false,
          entries: Object.keys(files)
            .filter((path) => !prefix || path.startsWith(prefix))
            .map((path) => ({
              path,
              name: path.split("/").pop() ?? path,
              kind: "file" as const,
              size: files[path].length,
              modifiedAt: null,
            })),
        };
      },
      async readText(_companyId: string, _folderKey: string, path: string) {
        if (!(path in files)) throw new Error(`missing file ${path}`);
        return files[path];
      },
      async writeTextAtomic(_companyId: string, _folderKey: string, path: string, contents: string) {
        files[path] = contents;
        return {} as never;
      },
    },
    db: {
      namespace: "test_llm_wiki",
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
        if (sql.includes("FROM test_llm_wiki.wiki_spaces")) {
          return [{
            id: SPACE_ID,
            company_id: COMPANY_ID,
            wiki_id: "default",
            slug: "default",
            display_name: "default",
            space_type: "local_folder",
            folder_mode: "managed_subfolder",
            root_folder_key: "wiki-root",
            path_prefix: null,
            configured_root_path: null,
            access_scope: "shared",
            owner_user_id: null,
            owner_agent_id: null,
            team_key: null,
            settings: {},
            status: "active",
            created_at: null,
            updated_at: null,
          }] as T[];
        }
        if (sql.includes("FROM test_llm_wiki.notion_sync_cursors")) {
          const notionPageId = typeof params?.[3] === "string" && sql.includes("notion_page_id = $4") ? params[3] : null;
          const wikiPath = typeof params?.[3] === "string" && sql.includes("wiki_path = $4") ? params[3] : null;
          const cursor = cursors.find((row) =>
            (notionPageId && row.notionPageId === notionPageId) ||
            (wikiPath && row.wikiPath === wikiPath)
          );
          return cursor ? [{
            notion_page_id: cursor.notionPageId,
            wiki_path: cursor.wikiPath,
            notion_last_edited_time: cursor.notionLastEditedTime,
            notion_content_hash: cursor.notionContentHash,
            wiki_content_hash: cursor.wikiContentHash,
            origin: cursor.origin,
          }] as T[] : [];
        }
        return [];
      },
      async execute(sql: string, params?: unknown[]) {
        if (sql.includes("INTO test_llm_wiki.notion_sync_cursors")) {
          const next: CursorRow = {
            notionPageId: String(params?.[4]),
            wikiPath: String(params?.[5]),
            notionLastEditedTime: params?.[6] == null ? null : String(params[6]),
            notionContentHash: params?.[7] == null ? null : String(params[7]),
            wikiContentHash: params?.[8] == null ? null : String(params[8]),
            origin: String(params?.[9] ?? "notion"),
          };
          const index = cursors.findIndex((row) => row.notionPageId === next.notionPageId);
          if (index >= 0) cursors[index] = next;
          else cursors.push(next);
        }
        if (sql.includes("INTO test_llm_wiki.wiki_operations")) {
          operations.push({
            status: params?.[4],
            runIds: params?.[5],
            warnings: params?.[6],
            affectedPages: params?.[7],
            metadata: params?.[8],
          });
        }
        return { rowCount: 1 };
      },
    },
    metrics: {
      async write() {
        return undefined;
      },
    },
    logger: {
      info() {
        return undefined;
      },
      warn() {
        return undefined;
      },
      error() {
        return undefined;
      },
      debug() {
        return undefined;
      },
    },
  } as unknown as PluginContext;

  return { ctx, files, cursors, operations, requests };
}

describe("Notion Wiki sync", () => {
  it("fails closed without an explicit company allowlist", async () => {
    const { ctx, operations, requests } = makeContext({ companyIds: [] });

    const result = await runNotionWikiSync(ctx, makeJob());

    expect(result).toEqual({ status: "skipped", results: [] });
    expect(operations).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("does not fall back to a wildcard when a configured company is unavailable", async () => {
    const { ctx, operations, requests } = makeContext({ companyIds: ["unknown-company"] });

    const result = await runNotionWikiSync(ctx, makeJob());

    expect(result.results).toEqual([]);
    expect(operations).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("imports changed Notion pages into wiki/notion with cursor and operation rows", async () => {
    const { ctx, files, cursors, operations } = makeContext({
      notionPages: [{
        id: "page-1",
        object: "page",
        url: "https://notion.test/page-1",
        last_edited_time: "2026-06-24T00:00:00.000Z",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Strategy Note" }] },
        },
      }],
      blocksByPage: {
        "page-1": [{
          id: "block-1",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Imported body" }] },
        }],
      },
    });

    await runNotionWikiSync(ctx, makeJob());

    const path = Object.keys(files).find((key) => key.startsWith("wiki/notion/strategy-note-"));
    expect(path).toBeTruthy();
    expect(files[path ?? ""]).toContain("notion_page_id: \"page-1\"");
    expect(files[path ?? ""]).toContain("Imported body");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({ notionPageId: "page-1", origin: "notion" });
    expect(operations).toHaveLength(1);
    expect(JSON.parse(String(operations[0].metadata))).toMatchObject({
      counts: expect.objectContaining({ notionPagesSeen: 1, notionPagesWritten: 1 }),
    });
  });

  it("uses the full Notion page id in wiki paths so same-title pages do not collide", async () => {
    const { ctx, files, cursors, operations } = makeContext({
      notionPages: [
        {
          id: "26a3a489-a9ca-8033-8b5c-e8b7e5a2fba0",
          object: "page",
          url: "https://notion.test/page-a",
          last_edited_time: "2026-06-24T00:00:00.000Z",
          properties: {},
        },
        {
          id: "26a3a489-a9ca-8049-9bcf-c9a8794f3eec",
          object: "page",
          url: "https://notion.test/page-b",
          last_edited_time: "2026-06-24T00:00:00.000Z",
          properties: {},
        },
      ],
      blocksByPage: {
        "26a3a489-a9ca-8033-8b5c-e8b7e5a2fba0": [],
        "26a3a489-a9ca-8049-9bcf-c9a8794f3eec": [],
      },
    });

    await runNotionWikiSync(ctx, makeJob());

    expect(files["wiki/notion/notion-page-26a3a489-26a3a489a9ca80338b5ce8b7e5a2fba0.md"]).toBeTruthy();
    expect(files["wiki/notion/notion-page-26a3a489-26a3a489a9ca80499bcfc9a8794f3eec.md"]).toBeTruthy();
    expect(cursors.map((cursor) => cursor.wikiPath).sort()).toEqual([
      "wiki/notion/notion-page-26a3a489-26a3a489a9ca80338b5ce8b7e5a2fba0.md",
      "wiki/notion/notion-page-26a3a489-26a3a489a9ca80499bcfc9a8794f3eec.md",
    ]);
    expect(operations).toHaveLength(1);
    expect(JSON.parse(String(operations[0].metadata))).toMatchObject({
      counts: expect.objectContaining({ failures: 0, notionPagesWritten: 2 }),
    });
  });

  it("persists created Notion ids into wiki frontmatter and does not duplicate on later edits", async () => {
    const { ctx, files, requests } = makeContext({
      files: {
        "wiki/custom.md": [
          "---",
          "title: \"Custom Wiki Page\"",
          "notion_sync: true",
          "---",
          "",
          "Initial body",
          "",
        ].join("\n"),
      },
      notionPages: [],
      blocksByPage: {
        "created-page-1": [],
      },
    });

    await runNotionWikiSync(ctx, makeJob());

    expect(files["wiki/custom.md"]).toContain("notion_page_id: \"created-page-1\"");
    expect(requests.filter((request) => request.method === "POST" && request.path === "/v1/pages")).toHaveLength(1);

    files["wiki/custom.md"] = files["wiki/custom.md"].replace("Initial body", "Edited body");
    await runNotionWikiSync(ctx, makeJob());

    expect(requests.filter((request) => request.method === "POST" && request.path === "/v1/pages")).toHaveLength(1);
    expect(requests.some((request) => request.method === "PATCH" && request.path === "/v1/blocks/created-page-1/children")).toBe(true);
  });
});
