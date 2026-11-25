import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { protectedVersions, skillRunNeedsFilesSql } from "../services/skill-version-cache.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skill pin read tests require Postgres: ${support.reason}`);

describePostgres("skill version pin reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-version-pin-read-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("reads held native run snapshots once when collecting protected versions", async () => {
    const companyId = randomUUID();
    const versionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pin reads", issuePrefix: "PIN" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Cache reader", role: "engineer", adapterType: "process" }).returning();
    await db.insert(heartbeatRuns).values(Array.from({ length: 100 }, () => ({
      companyId, agentId: agent!.id, status: "running", runtimeMode: "native",
      contextSnapshot: { skillVersions: { saved: versionId }, padding: randomBytes(20_000).toString("hex") },
    })));
    let statement: { query: string; parameters: unknown[] } | undefined;
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => { statement = { query, parameters }; };
    try {
      expect((await protectedVersions(db, companyId)).versions).toEqual(new Set([versionId]));
    } finally { db.$client.options.debug = debug; }
    expect(statement).toBeDefined();
    const baseline = db.select({ pins: sql`${heartbeatRuns.contextSnapshot}->'skillVersions'` })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), skillRunNeedsFilesSql())).toSQL();
    const reference = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${baseline.sql}`, baseline.params as never[]);
    const actual = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement!.query}`, statement!.parameters as never[]);
    const referencePlan = reference[0]!["QUERY PLAN"][0].Plan;
    const actualPlan = actual[0]!["QUERY PLAN"][0].Plan;
    const referenceBuffers = Number(referencePlan["Shared Hit Blocks"]) + Number(referencePlan["Shared Read Blocks"]);
    const actualBuffers = Number(actualPlan["Shared Hit Blocks"]) + Number(actualPlan["Shared Read Blocks"]);
    expect(referencePlan["Actual Rows"]).toBe(100);
    expect(actualPlan["Actual Rows"]).toBe(100);
    expect(actualBuffers).toBeLessThan(referenceBuffers * 1.2);
  });
});
