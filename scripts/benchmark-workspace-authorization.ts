import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const { and, eq } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm");
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, issues,
  startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as authorization from "../server/src/services/authorization.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15) ?? "HEAD";
const baselineRevision = execFileSync("git", ["rev-parse", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
try {
  database = await startEmbeddedPostgresTestDatabase("workspace-authorization-benchmark-");
  db = createDb(database.connectionString);
  baselineDir = await fs.mkdtemp(fileURLToPath(new URL("../server/scripts/.workspace-auth-baseline-", import.meta.url)));
  const original = new URL("../server/src/services/authorization.ts", import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:server/src/services/authorization.ts`], { encoding: "utf8" });
  const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`);
  const baselinePath = path.join(baselineDir, "authorization.ts");
  await fs.writeFile(baselinePath, rewritten);
  const baseline = await import(pathToFileURL(baselinePath).href) as typeof authorization;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic workspace authorization", issuePrefix: "BENCH" });
  await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
  await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, name: "Shared source", mode: "shared_workspace", strategyType: "operator_directory" });
  await db.$client.unsafe(`insert into issues (company_id, title) select $1, 'Historical task ' || n from generate_series(1, 13428) n`, [companyId]);
  const [sourceIssue] = await db.insert(issues).values({ companyId, title: "Retained source after unrelated history" }).returning({ id: issues.id });
  await db.update(executionWorkspaces).set({ sourceIssueId: sourceIssue.id }).where(eq(executionWorkspaces.id, workspaceId));
  await db.$client.unsafe("ANALYZE");
  const actor: authorization.AuthorizationActor = { type: "agent", source: "agent_jwt", agentId, companyId, onBehalfOfUserId: userId };
  const queries = await Promise.all([baseline, authorization].map(async module => db!.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    await module.executionWorkspaceReadSqlCondition(db!, actor),
  )).toSQL()));
  const samples: number[][] = [[], []];
  let expected: unknown;
  for (let n = 0; n < 7; n++) {
    for (const variant of n % 2 ? [1, 0] : [0, 1]) {
      const query = queries[variant];
      const start = performance.now();
      const rows = await db.$client.unsafe(query.sql, query.params as never[]).values();
      if (n >= 2) samples[variant].push(performance.now() - start);
      assert.equal(rows.length, 1);
      if (expected === undefined) expected = rows;
      else assert.deepEqual(rows, expected);
    }
  }
  const results = [];
  for (const [variant, query] of queries.entries()) {
    const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    results.push({ variant: variant ? "treatment" : "baseline", samplesMs: samples[variant],
      medianMs: [...samples[variant]].sort((a, b) => a - b)[2], sql: query.sql, params: query.params, plan: plan["QUERY PLAN"] });
  }
  console.log(JSON.stringify({ baselineRevision, tasks: 13429, retainedSources: 1, equalCompleteRows: true,
    fixtureIds: { companyId, agentId, userId, workspaceId },
    postgres: (await db.$client.unsafe("select version()"))[0].version, results }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
