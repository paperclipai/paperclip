import { describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { BOOKMARKS_FOLDER_KEY, PLUGIN_ID } from "../src/manifest.js";
import plugin, {
  type BookmarkListResult,
  type BookmarkRecord,
  deriveSlugCandidate,
  renderBookmarkMarkdown,
} from "../src/worker.js";

interface BookmarkRow {
  id: string;
  company_id: string;
  slug: string;
  url: string;
  title: string;
  notes: string;
  tags: string[];
  file_path: string;
  created_at: string;
  updated_at: string;
}

function makeInMemoryBookmarksDb() {
  const rows: BookmarkRow[] = [];
  return {
    rows,
    namespace: "plugin_bookmarks_test",
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (!sql.includes("FROM plugin_bookmarks_test.bookmarks")) return [];
      const companyId = params?.[0] as string;
      let filtered = rows.filter((row) => row.company_id === companyId);
      if (sql.includes("LIKE $2")) {
        const like = (params?.[1] as string) ?? "";
        const needle = like.replace(/%/g, "").toLowerCase();
        filtered = filtered.filter((row) =>
          row.title.toLowerCase().includes(needle) ||
          row.url.toLowerCase().includes(needle) ||
          row.notes.toLowerCase().includes(needle));
      }
      const tagParamIndex = sql.match(/\$(\d+) = ANY\(tags\)/)?.[1];
      if (tagParamIndex) {
        const tag = params?.[Number(tagParamIndex) - 1] as string;
        filtered = filtered.filter((row) => row.tags.includes(tag));
      }
      filtered = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const limitParamIndex = sql.match(/LIMIT \$(\d+)/)?.[1];
      if (limitParamIndex) {
        const limit = params?.[Number(limitParamIndex) - 1] as number;
        filtered = filtered.slice(0, limit);
      }
      return filtered as unknown as T[];
    },
    async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
      if (sql.startsWith("INSERT INTO plugin_bookmarks_test.bookmarks")) {
        const [id, companyId, slug, url, title, notes, tags, filePath, createdAt] =
          params as [string, string, string, string, string, string, string[], string, string];
        if (rows.some((row) => row.company_id === companyId && row.slug === slug)) {
          return { rowCount: 0 };
        }
        rows.push({
          id,
          company_id: companyId,
          slug,
          url,
          title,
          notes,
          tags: [...tags],
          file_path: filePath,
          created_at: createdAt,
          updated_at: createdAt,
        });
        return { rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM plugin_bookmarks_test.bookmarks")) {
        const [companyId, slug] = params as [string, string];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]!.company_id === companyId && rows[i]!.slug === slug) rows.splice(i, 1);
        }
        return { rowCount: before - rows.length };
      }
      return { rowCount: 0 };
    },
  };
}

function makeHarness() {
  const harness = createTestHarness({ manifest });
  const db = makeInMemoryBookmarksDb();
  harness.ctx.db = db;
  return { harness, db };
}

function localFolderStatus(folderKey = BOOKMARKS_FOLDER_KEY) {
  return {
    folderKey,
    configured: true,
    path: "/tmp/bookmarks",
    realPath: "/tmp/bookmarks",
    access: "readWrite" as const,
    readable: true,
    writable: true,
    requiredDirectories: [],
    requiredFiles: [],
    missingDirectories: [],
    missingFiles: [],
    healthy: true,
    problems: [],
    checkedAt: "2026-05-10T00:00:00.000Z",
  };
}

describe("plugin-bookmarks-example manifest", () => {
  it("declares the expected core surface capabilities", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.id).toBe(PLUGIN_ID);
    expect(parsed.capabilities).toEqual(
      expect.arrayContaining([
        "api.routes.register",
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
        "local.folders",
        "ui.page.register",
        "ui.dashboardWidget.register",
      ]),
    );
    expect(parsed.database).toMatchObject({
      namespaceSlug: "bookmarks",
      migrationsDir: "migrations",
    });
    expect(parsed.localFolders).toEqual([
      expect.objectContaining({
        folderKey: BOOKMARKS_FOLDER_KEY,
        access: "readWrite",
      }),
    ]);
    expect(parsed.apiRoutes).toEqual([
      expect.objectContaining({ routeKey: "list", method: "GET" }),
      expect.objectContaining({ routeKey: "create", method: "POST" }),
      expect.objectContaining({ routeKey: "delete", method: "DELETE" }),
    ]);
    expect(parsed.ui?.slots ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bookmarks-page", type: "page" }),
        expect.objectContaining({ id: "bookmarks-widget", type: "dashboardWidget" }),
      ]),
    );
  });
});

describe("deriveSlugCandidate", () => {
  it("prefers the title when one is provided", () => {
    expect(deriveSlugCandidate("https://example.com", "My Favorite Link")).toBe("my-favorite-link");
  });

  it("falls back to host + path when title is missing", () => {
    expect(deriveSlugCandidate("https://example.com/blog/my-post", null)).toBe("example-com-blog-my-post");
  });

  it("returns a default slug for invalid URLs without a title", () => {
    expect(deriveSlugCandidate("not-a-url", null)).toBe("bookmark");
  });
});

describe("renderBookmarkMarkdown", () => {
  it("emits stable YAML frontmatter and trims trailing notes whitespace", () => {
    const bookmark: BookmarkRecord = {
      id: "00000000-0000-0000-0000-000000000001",
      companyId: "11111111-1111-1111-1111-111111111111",
      slug: "example",
      url: "https://example.com/page",
      title: "Example",
      notes: "Hello\nworld\n\n",
      tags: ["docs", "demo"],
      filePath: "bookmarks/example.md",
      createdAt: "2026-05-07T10:00:00.000Z",
      updatedAt: "2026-05-07T10:00:00.000Z",
    };
    expect(renderBookmarkMarkdown(bookmark)).toBe(
      [
        "---",
        "slug: example",
        "url: https://example.com/page",
        "title: Example",
        'tags: ["docs", "demo"]',
        "created_at: 2026-05-07T10:00:00.000Z",
        "updated_at: 2026-05-07T10:00:00.000Z",
        "---",
        "",
        "Hello",
        "world\n",
      ].join("\n"),
    );
  });

  it("emits an empty body when there are no notes", () => {
    const bookmark: BookmarkRecord = {
      id: "id",
      companyId: "company",
      slug: "no-notes",
      url: "https://example.com/",
      title: "No notes",
      notes: "",
      tags: [],
      filePath: "bookmarks/no-notes.md",
      createdAt: "2026-05-07T10:00:00.000Z",
      updatedAt: "2026-05-07T10:00:00.000Z",
    };
    const rendered = renderBookmarkMarkdown(bookmark);
    expect(rendered.endsWith("---\n")).toBe(true);
    expect(rendered).toContain("tags: []");
  });
});

describe("plugin-bookmarks-example worker", () => {
  it("creates, lists, and deletes bookmarks via registered handlers", async () => {
    const companyId = "22222222-2222-2222-2222-222222222222";
    const { harness } = makeHarness();
    const writtenFiles: string[] = [];
    const deletedFiles: string[] = [];
    harness.ctx.localFolders.writeTextAtomic = vi.fn(async (_companyId, folderKey, relativePath) => {
      writtenFiles.push(relativePath);
      return localFolderStatus(folderKey);
    });
    harness.ctx.localFolders.deleteFile = vi.fn(async (_companyId, folderKey, relativePath) => {
      deletedFiles.push(relativePath);
      return localFolderStatus(folderKey);
    });
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<BookmarkRecord>("create", {
      companyId,
      url: "https://example.com/one",
      title: "Example One",
      tags: ["Docs", "Demo", "demo"],
      notes: "Initial note",
    });
    expect(created.companyId).toBe(companyId);
    expect(created.slug).toBe("example-one");
    expect(created.tags).toEqual(["docs", "demo"]);
    expect(created.filePath).toBe("bookmarks/example-one.md");
    expect(writtenFiles).toContain("bookmarks/example-one.md");

    const second = await harness.performAction<BookmarkRecord>("create", {
      companyId,
      url: "https://example.com/two",
      title: "Example Two",
      tags: ["demo"],
    });

    const allListed = await harness.getData<BookmarkListResult>("list", { companyId });
    expect(allListed.databaseNamespace).toBe("plugin_bookmarks_test");
    expect(allListed.bookmarks.map((b) => b.slug).sort()).toEqual(["example-one", "example-two"]);

    const filtered = await harness.getData<BookmarkListResult>("list", {
      companyId,
      tag: "docs",
    });
    expect(filtered.bookmarks.map((b) => b.slug)).toEqual(["example-one"]);

    const searched = await harness.getData<BookmarkListResult>("list", {
      companyId,
      search: "two",
    });
    expect(searched.bookmarks.map((b) => b.slug)).toEqual(["example-two"]);

    const deletion = await harness.performAction<{ deleted: boolean; slug: string }>("delete", {
      companyId,
      slug: second.slug,
    });
    expect(deletion).toEqual({ deleted: true, slug: "example-two" });
    expect(deletedFiles).toEqual(["bookmarks/example-two.md"]);

    const after = await harness.getData<BookmarkListResult>("list", { companyId });
    expect(after.bookmarks.map((b) => b.slug)).toEqual(["example-one"]);
  });

  it("rejects URLs without an http(s) scheme", async () => {
    const { harness } = makeHarness();
    await plugin.definition.setup(harness.ctx);
    await expect(
      harness.performAction("create", {
        companyId: "33333333-3333-3333-3333-333333333333",
        url: "ftp://example.com",
      }),
    ).rejects.toThrow(/http or https/);
  });

  it("rejects duplicate slugs for the same company", async () => {
    const companyId = "44444444-4444-4444-4444-444444444444";
    const { harness } = makeHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("create", {
      companyId,
      url: "https://example.com/one",
      title: "Example One",
    });
    await expect(
      harness.performAction("create", {
        companyId,
        url: "https://example.com/two",
        title: "Example One",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("validates malformed tags before touching the database", async () => {
    const { harness, db } = makeHarness();
    await plugin.definition.setup(harness.ctx);
    await expect(
      harness.performAction("create", {
        companyId: "55555555-5555-5555-5555-555555555555",
        url: "https://example.com",
        tags: ["good", "Bad Tag!!!"],
      }),
    ).rejects.toThrow(/lowercase letters, digits, hyphens, or underscores/);
    expect(db.rows).toHaveLength(0);
  });

  it("dispatches the scoped API routes through the same handlers", async () => {
    const companyId = "66666666-6666-6666-6666-666666666666";
    const { harness } = makeHarness();
    await plugin.definition.setup(harness.ctx);

    const created = await plugin.definition.onApiRequest?.({
      routeKey: "create",
      method: "POST",
      path: "/bookmarks",
      params: {},
      query: {},
      body: { companyId, url: "https://example.com/api" },
      actor: { actorType: "user", actorId: "board", userId: "board", agentId: null, runId: null },
      companyId,
      headers: {},
    });
    expect(created).toMatchObject({ status: 201 });
    expect(created?.body).toMatchObject({ slug: "example-com-api" });

    const listed = await plugin.definition.onApiRequest?.({
      routeKey: "list",
      method: "GET",
      path: "/bookmarks",
      params: {},
      query: { search: "api" },
      body: null,
      actor: { actorType: "user", actorId: "board", userId: "board", agentId: null, runId: null },
      companyId,
      headers: {},
    });
    expect(listed?.body).toMatchObject({
      bookmarks: [expect.objectContaining({ slug: "example-com-api" })],
    });

    const removed = await plugin.definition.onApiRequest?.({
      routeKey: "delete",
      method: "DELETE",
      path: "/bookmarks/example-com-api",
      params: { slug: "example-com-api" },
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "board", userId: "board", agentId: null, runId: null },
      companyId,
      headers: {},
    });
    expect(removed).toMatchObject({ status: 200, body: { deleted: true } });
  });
});
