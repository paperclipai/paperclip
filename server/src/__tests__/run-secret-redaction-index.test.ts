import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Plan = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Actual Rows"?: number; Plans?: Plan[] };
const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];

describeDatabase("issue secret redaction lookup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-secret-redaction-index-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function captureIssueLookup(companyId: string, issueId: string) {
    let captured: { sql: string; params: unknown[] } | undefined;
    const stop = new Error("query captured");
    const captureDb = new Proxy(db, {
      get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = db.select(...fields);
          const from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const query = from(...args);
            query.execute = async () => { captured = query.toSQL(); throw stop; };
            return query;
          }) as typeof builder.from;
          return builder;
        };
      },
    });
    await createRunSecretRedactionRegistry(captureDb as Db).redactForIssue(companyId, issueId, {}).catch((error) => {
      if (error !== stop) throw error;
    });
    if (!captured) throw new Error("issue redaction produced no query");
    return captured;
  }

  it("answers from the registry index without reading runs that never registered a secret", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Redaction", issuePrefix: `RD${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Redaction" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Busy task" });
    const prompt = "x".repeat(20_000);
    await db.insert(heartbeatRuns).values(Array.from({ length: 400 }, () => ({
      companyId, agentId, status: "succeeded" as const,
      contextSnapshot: { issueId, paperclipIssue: { id: issueId }, paperclipTaskMarkdown: prompt },
    })));
    await db.execute(sql`ANALYZE heartbeat_runs`);

    const query = await captureIssueLookup(companyId, issueId);
    const [explained] = await db.$client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, query.params as never[]);
    const nodes = flatten((explained["QUERY PLAN"] as Array<{ Plan: Plan }>)[0].Plan);
    const runScans = nodes.filter((node) => node["Relation Name"] === "heartbeat_runs" || node["Index Name"]?.startsWith("heartbeat_runs_"));
    expect(runScans.map((node) => node["Index Name"])).toContain("heartbeat_runs_company_secret_redactions_idx");
    expect(nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "heartbeat_runs")).toBe(false);
    expect(runScans.every((node) => (node["Actual Rows"] ?? 0) === 0)).toBe(true);
  });
});
