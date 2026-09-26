import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const RUN_LOAD_TEST = process.env.PAPERCLIP_HEARTBEAT_MEMORY_LOAD_TEST === "true";
const ROW_COUNT = 24_205;
const RESULT_PAYLOAD_CHARS = 53_300;
const CONCURRENT_LISTS = 8;
const MAX_RSS_GROWTH_BYTES = 384 * 1024 * 1024;

const embeddedPostgresSupport = RUN_LOAD_TEST
  ? await getEmbeddedPostgresTestSupport()
  : { supported: false, reason: "opt-in load test disabled" };
const describeLoad = embeddedPostgresSupport.supported ? describe : describe.skip;

describeLoad("heartbeat list representative load", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-load-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LoadVerifier",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.execute(sql`
      insert into heartbeat_runs (
        id,
        company_id,
        agent_id,
        invocation_source,
        status,
        result_json,
        created_at,
        updated_at
      )
      select
        gen_random_uuid(),
        ${companyId}::uuid,
        ${agentId}::uuid,
        'assignment',
        'succeeded',
        jsonb_build_object(
          'summary', 'synthetic representative run ' || series,
          'stdout', repeat('x', ${RESULT_PAYLOAD_CHARS})
        ),
        now() - (series || ' milliseconds')::interval,
        now()
      from generate_series(1, ${ROW_COUNT}) as series
    `);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps concurrent default list traffic bounded without materializing full results", async () => {
    const payloadProfile = await db.execute(sql<{ rowCount: number; logicalChars: number }>`
      select
        count(*)::integer as "rowCount",
        sum(length(result_json::text))::double precision as "logicalChars"
      from heartbeat_runs
      where company_id = ${companyId}::uuid
    `);
    const profile = Array.from(payloadProfile)[0];

    expect(profile?.rowCount).toBe(ROW_COUNT);
    expect(Number(profile?.logicalChars)).toBeGreaterThan(1_290_000_000);

    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);

    try {
      const resultSets = await Promise.all(
        Array.from({ length: CONCURRENT_LISTS }, () =>
          heartbeatService(db).list(companyId),
        ),
      );

      for (const runs of resultSets) {
        expect(runs).toHaveLength(200);
        expect(runs.every((run) => {
          const result = run.resultJson as Record<string, unknown> | null;
          return typeof result?.summary === "string" && !("stdout" in result);
        })).toBe(true);
      }
    } finally {
      clearInterval(sampler);
    }

    const rssGrowthBytes = peakRss - baselineRss;
    console.info(JSON.stringify({
      rowCount: profile?.rowCount,
      logicalChars: Number(profile?.logicalChars),
      concurrentLists: CONCURRENT_LISTS,
      rowsPerResponse: 200,
      baselineRssBytes: baselineRss,
      peakRssBytes: peakRss,
      rssGrowthBytes,
    }));
    expect(rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  }, 120_000);
});
