import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-rt2-daily-report-persistence-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 daily report persistence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("RT2 daily report persistence migrations", () => {
  it(
    "creates daily report tables with the expected indexes",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

      try {
        const [tables] = await sql.unsafe<Array<{
          dailyReportCards: string | null;
          dailyWikiPages: string | null;
        }>>(`
          SELECT
            to_regclass('public.rt2_v33_daily_report_cards') AS "dailyReportCards",
            to_regclass('public.rt2_v33_daily_wiki_pages') AS "dailyWikiPages"
        `);

        expect(tables).toEqual({
          dailyReportCards: "rt2_v33_daily_report_cards",
          dailyWikiPages: "rt2_v33_daily_wiki_pages",
        });

        const indexRows = await sql.unsafe<
          Array<{
            indexName: string;
            isUnique: boolean;
          }>
        >(`
          SELECT
            c.relname AS "indexName",
            i.indisunique AS "isUnique"
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN (
            'rt2_v33_daily_report_cards_company_project_todo_day_uq',
            'rt2_v33_daily_wiki_pages_company_recent_idx'
          )
          ORDER BY c.relname
        `);

        expect(indexRows).toEqual([
          {
            indexName: "rt2_v33_daily_report_cards_company_project_todo_day_uq",
            isUnique: true,
          },
          {
            indexName: "rt2_v33_daily_wiki_pages_company_recent_idx",
            isUnique: false,
          },
        ]);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );
});
