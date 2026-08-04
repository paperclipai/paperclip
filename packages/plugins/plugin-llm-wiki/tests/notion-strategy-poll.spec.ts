import { describe, expect, it } from "vitest";
import type { Company, Issue, PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { isNotionStrategyPage, runNotionStrategyPoll } from "../src/notion-strategy-poll.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";

type CursorRow = {
  notionPageId: string;
  notionPageIdNormalized: string;
  notionLastEditedTime: string;
  emittedIssueId: string;
  emittedIssueIdentifier: string | null;
};

function makeJob(): PluginJobContext {
  return {
    jobKey: "notion-strategy-poll",
    runId: "test-run",
    trigger: "manual",
    scheduledAt: "2026-07-03T00:00:00.000Z",
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makePage(input: {
  id?: string;
  title?: string;
  status?: string;
  tags?: string[];
  lastEditedTime?: string;
}) {
  const id = input.id ?? "26a3a489-a9ca-8033-8b5c-e8b7e5a2fba0";
  return {
    id,
    object: "page",
    url: `https://notion.test/${id}`,
    last_edited_time: input.lastEditedTime ?? "2026-07-03T00:00:00.000Z",
    properties: {
      "Task name": { type: "title", title: [{ plain_text: input.title ?? "BTC strategy idea" }] },
      Status: { type: "status", status: { name: input.status ?? "In progress" } },
      Tags: { type: "multi_select", multi_select: (input.tags ?? ["Research", "BTC"]).map((name) => ({ name })) },
    },
  };
}

function makeContext(input: {
  notionPages?: Array<Record<string, unknown>>;
  companyIds?: string[];
}) {
  const cursors: CursorRow[] = [];
  const operations: Array<Record<string, unknown>> = [];
  const issues: Issue[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const company = {
    id: COMPANY_ID,
    name: "Test Company",
    slug: "test-company",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  } as unknown as Company;

  const ctx = {
    manifest: {},
    config: {
      async get() {
        return {
          notionStrategyPollToken: "test-token",
          notionStrategyPollTasksDatabaseId: "tasks-db",
          notionStrategyPollCroAgentId: "cro-agent-id",
          notionStrategyPollCompanyIds: input.companyIds ?? [COMPANY_ID],
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
        if (parsed.pathname === "/v1/databases/tasks-db/query") {
          return jsonResponse({ results: input.notionPages ?? [], has_more: false, next_cursor: null });
        }
        return jsonResponse({ ok: true });
      },
    },
    localFolders: {
      async status() {
        return { configured: true, readable: true };
      },
    },
    issues: {
      async create(issueInput: Record<string, unknown>) {
        const issue = {
          id: `issue-${issues.length + 1}`,
          identifier: `PILA-T${issues.length + 1}`,
          title: String(issueInput.title),
          description: String(issueInput.description ?? ""),
          status: issueInput.status,
          priority: issueInput.priority,
          assigneeAgentId: issueInput.assigneeAgentId,
          companyId: issueInput.companyId,
        } as unknown as Issue;
        issues.push(issue);
        return issue;
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
        if (sql.includes("max(notion_last_edited_time)")) {
          const latest = cursors
            .map((cursor) => cursor.notionLastEditedTime)
            .sort()
            .at(-1);
          return [{ watermark: latest ?? null }] as T[];
        }
        if (sql.includes("FROM test_llm_wiki.notion_strategy_poll_cursors")) {
          const normalized = String(params?.[3] ?? "");
          const edited = String(params?.[4] ?? "");
          return cursors.some((cursor) =>
            cursor.notionPageIdNormalized === normalized &&
            cursor.notionLastEditedTime === edited
          ) ? [{ "?column?": 1 }] as T[] : [];
        }
        return [];
      },
      async execute(sql: string, params?: unknown[]) {
        if (sql.includes("INTO test_llm_wiki.notion_strategy_poll_cursors")) {
          cursors.push({
            notionPageId: String(params?.[4]),
            notionPageIdNormalized: String(params?.[5]),
            notionLastEditedTime: String(params?.[6]),
            emittedIssueId: String(params?.[7]),
            emittedIssueIdentifier: params?.[8] == null ? null : String(params[8]),
          });
        }
        if (sql.includes("INTO test_llm_wiki.wiki_operations")) {
          operations.push({
            status: params?.[4],
            runIds: params?.[5],
            warnings: params?.[6],
            metadata: params?.[7],
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

  return { ctx, cursors, issues, operations, requests };
}

describe("Notion Strategy Poll", () => {
  it("ports the legacy strategy heuristic", () => {
    expect(isNotionStrategyPage(makePage({ title: "Template strategy page", tags: [] }) as never)).toMatchObject({
      match: false,
      reason: "no tags (likely template sub-page)",
    });
    expect(isNotionStrategyPage(makePage({ title: "BTC idea", tags: ["Research", "Metrics"] }) as never)).toMatchObject({
      match: true,
    });
    expect(isNotionStrategyPage(makePage({ title: "Strategy draft", status: "Done", tags: ["Research", "BTC"] }) as never)).toMatchObject({
      match: false,
    });
  });

  it("records an operation but creates zero Paperclip issues on an empty poll", async () => {
    const { ctx, issues, operations } = makeContext({ notionPages: [] });

    await runNotionStrategyPoll(ctx, makeJob());

    expect(issues).toHaveLength(0);
    expect(operations).toHaveLength(1);
    expect(JSON.parse(String(operations[0].metadata))).toMatchObject({
      counts: expect.objectContaining({ pagesFetched: 0, issuesCreated: 0 }),
      emittedIssues: [],
    });
  });

  it("fails closed without an explicit company allowlist", async () => {
    const { ctx, issues, operations, requests } = makeContext({ companyIds: [] });

    const result = await runNotionStrategyPoll(ctx, makeJob());

    expect(result).toEqual({ status: "skipped", results: [] });
    expect(issues).toHaveLength(0);
    expect(operations).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("creates one CRO issue for a matching delta and suppresses unchanged re-polls by full normalized page id", async () => {
    const page = makePage({
      id: "26a3a489-a9ca-8033-8b5c-e8b7e5a2fba0",
      title: "BTC Strategy: metrics breakout",
      tags: ["Research", "BTC"],
    });
    const { ctx, cursors, issues, requests } = makeContext({ notionPages: [page] });

    await runNotionStrategyPoll(ctx, makeJob());
    await runNotionStrategyPoll(ctx, { ...makeJob(), runId: "test-run-2" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      assigneeAgentId: "cro-agent-id",
      title: "Research: BTC Strategy: metrics breakout",
    });
    expect(issues[0].description).toContain("**Notion id:** `26a3a489-a9ca-8033-8b5c-e8b7e5a2fba0`");
    expect(cursors).toHaveLength(1);
    expect(cursors[0].notionPageIdNormalized).toBe("26a3a489a9ca80338b5ce8b7e5a2fba0");
    expect(cursors[0].notionPageIdNormalized).toHaveLength(32);
    expect(requests.filter((request) => request.method === "POST" && request.path === "/v1/databases/tasks-db/query")).toHaveLength(2);
  });
});
