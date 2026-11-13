import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { protectedVersions, skillRunNeedsFilesSql } from "../services/skill-version-cache.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SKILL_CACHE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("skill pin snapshot reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("skill-pin-read-");
    db = createDb(external ?? database!.connectionString);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("reads each held native run snapshot once when collecting protected versions", async () => {
    const companyId = randomUUID(), versionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pin read", issuePrefix: companyId });
    const [agent] = await db.insert(agents).values({ companyId, name: "Pin reader", adapterType: "process" }).returning();
    await db.insert(heartbeatRuns).values(Array.from({ length: 100 }, () => ({
      companyId, agentId: agent!.id, runtimeMode: "native", status: "running",
      contextSnapshot: { skillVersions: { selected: versionId }, payload: randomBytes(16_384).toString("base64") },
    })));
    const queries: Array<{ query: string; parameters: unknown[] }> = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => { queries.push({ query, parameters: [...parameters] }); };
    try {
      expect((await protectedVersions(db, companyId)).versions).toEqual(new Set([versionId]));
    } finally { db.$client.options.debug = debug; }
    expect(queries).toHaveLength(1);
    const baseline = db.select({ pins: sql`${heartbeatRuns.contextSnapshot}->'skillVersions'` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), skillRunNeedsFilesSql())).toSQL();
    const buffers = [];
    for (const statement of [{ query: baseline.sql, parameters: baseline.params }, queries[0]!]) {
      const [result] = await db.$client.unsafe(`explain (analyze, buffers, format json) ${statement.query}`, statement.parameters as never[]);
      const plan = result!["QUERY PLAN"][0].Plan;
      expect(plan["Actual Rows"]).toBe(100);
      buffers.push(Number(plan["Shared Hit Blocks"]) + Number(plan["Shared Read Blocks"]));
    }
    expect(buffers[0]).toBeGreaterThan(500);
    expect(buffers[1]).toBeLessThan(buffers[0]! * 1.2);
  });
});
