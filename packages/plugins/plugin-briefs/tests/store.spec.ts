import { describe, expect, it } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

import {
  buildDeterministicBriefCard,
  type BriefsIssueInput,
  type BriefsSourceBundle,
} from "../src/deterministic-card-service.js";
import { createBriefsStore } from "../src/store.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const userId = "user-1";
const rootIssueId = "22222222-2222-4222-8222-222222222222";

function ids() {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
}

function issue(overrides: Partial<BriefsIssueInput> = {}): BriefsIssueInput {
  return {
    id: rootIssueId,
    companyId,
    parentId: null,
    title: "Dismissed card source",
    identifier: "PAP-1",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: userId,
    createdAt: "2026-05-22T10:00:00.000Z",
    updatedAt: "2026-05-22T11:00:00.000Z",
    ...overrides,
  };
}

function bundle(): BriefsSourceBundle {
  return {
    companyId,
    userId,
    rootIssueId,
    title: "Dismissed card source",
    groupingDescription: "Issue tree rooted at PAP-1: Dismissed card source",
    issues: [issue()],
    relations: {},
    activeRuns: {},
    runs: [],
    comments: [],
    documents: [],
    interactions: [],
    approvals: [],
    workProducts: [],
    relevantAgentIds: [],
  };
}

type CardRow = {
  id: string;
  company_id: string;
  user_id: string;
  slug: string;
  pinned: boolean;
  hidden: boolean;
};

const cardId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";

function createFakeDb(): PluginDatabaseClient {
  const cards = new Map<string, CardRow>();
  const key = (company: unknown, user: unknown, slug: unknown) => `${company}:${user}:${slug}`;

  return {
    namespace: "plugin_briefs_test",
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("SELECT id, pinned, hidden FROM plugin_briefs_test.briefs_cards")) {
        const row = cards.get(key(params[0], params[1], params[2]));
        return (row ? [{ id: row.id, pinned: row.pinned, hidden: row.hidden }] : []) as T[];
      }
      return [];
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      if (sql.includes("INSERT INTO plugin_briefs_test.briefs_cards")) {
        const rowKey = key(params[1], params[2], params[3]);
        const existing = cards.get(rowKey);
        cards.set(rowKey, {
          id: existing?.id ?? String(params[0]),
          company_id: String(params[1]),
          user_id: String(params[2]),
          slug: String(params[3]),
          pinned: Boolean(existing?.pinned || params[9]),
          hidden: Boolean(existing?.hidden || params[10]),
        });
      }
      if (sql.includes("SET hidden = true, pinned = false")) {
        for (const [rowKey, row] of cards) {
          if (row.company_id === params[0] && row.user_id === params[1] && row.id === params[2]) {
            cards.set(rowKey, { ...row, hidden: true, pinned: false });
          }
        }
      }
      return { rowCount: 1 };
    },
  };
}

function createListFakeDb(): { db: PluginDatabaseClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    db: {
      namespace: "plugin_briefs_test",
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("FROM plugin_briefs_test.briefs_cards")) {
          return [{
            id: cardId,
            company_id: companyId,
            user_id: userId,
            slug: "pap-1",
            title: "Briefs plugin planning",
            grouping_description: "Issue tree rooted at PAP-1",
            root_issue_id: rootIssueId,
            state: "live",
            summary_status: "ok",
            pinned: false,
            hidden: false,
            stale_at: "2026-05-22T12:00:00.000Z",
            expires_at: null,
            latest_snapshot_id: snapshotId,
            last_meaningful_event_at: "2026-05-22T12:00:00.000Z",
          }] as T[];
        }
        if (sql.includes("FROM plugin_briefs_test.briefs_card_snapshots")) {
          return [{
            id: snapshotId,
            company_id: companyId,
            user_id: userId,
            card_id: cardId,
            summary_paragraph: "The work is moving.",
            summary_status: "ok",
            summary_model: "test",
            summary_tokens_in: 10,
            summary_tokens_out: 20,
            summary_failure_reason: null,
            task_rows: [],
            evidence_source_ids: [],
            generated_by_agent_id: null,
            generated_by_run_id: null,
            deterministic_state_inputs: {},
            created_at: "2026-05-22T12:00:00.000Z",
          }] as T[];
        }
        if (sql.includes("WITH ranked_sources AS")) {
          return [
            {
              id: "55555555-5555-4555-8555-555555555555",
              company_id: companyId,
              user_id: userId,
              card_id: cardId,
              source_kind: "issue",
              source_id: rootIssueId,
              issue_id: rootIssueId,
              identifier: "PAP-1",
              title_line: "Briefs plugin planning",
              right_tag: "live",
              link_path: "/PAP/issues/PAP-1",
              is_intra_tree_blocked: false,
              event_at: "2026-05-22T12:00:00.000Z",
              metadata: {},
              total_source_count: 250,
            },
            {
              id: "66666666-6666-4666-8666-666666666666",
              company_id: companyId,
              user_id: userId,
              card_id: cardId,
              source_kind: "run",
              source_id: "run-1",
              issue_id: rootIssueId,
              identifier: "PAP-1",
              title_line: "Agent run",
              right_tag: "queued",
              link_path: "/PAP/issues/PAP-1",
              is_intra_tree_blocked: false,
              event_at: "2026-05-22T11:59:00.000Z",
              metadata: {},
              total_source_count: 250,
            },
          ] as T[];
        }
        return [];
      },
      async execute(): Promise<{ rowCount: number }> {
        return { rowCount: 0 };
      },
    },
  };
}

describe("Briefs store", () => {
  it("keeps dismissed cards hidden when the same card is regenerated", async () => {
    const store = createBriefsStore(createFakeDb());
    const first = await store.saveCard(buildDeterministicBriefCard(bundle(), {
      now: "2026-05-22T12:00:00.000Z",
      idFactory: ids(),
      summaryStatus: "ok",
      summaryParagraph: "The source area is being prepared for follow-up. Next action is to finish the implementation pass.",
      summaryModel: "test",
      allowGeneratedSummary: true,
    }));

    await store.dismissCard({ companyId, userId, cardId: first.id });

    const regenerated = await store.saveCard(buildDeterministicBriefCard(bundle(), {
      now: "2026-05-22T13:00:00.000Z",
      idFactory: ids(),
      summaryStatus: "ok",
      summaryParagraph: "A newer generated summary should not resurrect the dismissed card. Next action is still hidden from the dashboard.",
      summaryModel: "test",
      allowGeneratedSummary: true,
    }));

    expect(regenerated.id).toBe(first.id);
    expect(regenerated.hidden).toBe(true);
    expect(regenerated.pinned).toBe(false);
  });

  it("loads card snapshots and capped sources in batches", async () => {
    const { db, queries } = createListFakeDb();
    const store = createBriefsStore(db);

    const cards = await store.listCards({ companyId, userId });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sources).toHaveLength(2);
    expect(cards[0]?.moreSourceCount).toBe(250);
    expect(queries.filter((query) => query.sql.includes("FROM plugin_briefs_test.briefs_card_snapshots"))).toHaveLength(1);
    const sourceQuery = queries.find((query) => query.sql.includes("WITH ranked_sources AS"));
    expect(sourceQuery?.params[2]).toEqual([cardId]);
    expect(sourceQuery?.params[3]).toBe(200);
    expect(sourceQuery?.sql).toContain("row_number() OVER (PARTITION BY card_id");
  });
});
