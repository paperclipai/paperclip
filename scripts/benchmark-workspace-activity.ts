import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, applyPendingMigrations, companies, createDb, executionWorkspaces, issues, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as expiration from "../server/src/services/git-workspace-expiration.js";

type Query = { sql: string; params: unknown[] };
type Workspace = typeof executionWorkspaces.$inferSelect;
type Plan = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; "Temp Read Blocks"?: number; "Temp Written Blocks"?: number; Plans?: Plan[] };
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const gitRaw = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", cwd: repositoryRoot });
const git = (...args: string[]) => gitRaw(...args).trim();
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`);
const modulePath = "server/src/services/git-workspace-expiration.ts";
const treatmentSource = await fs.readFile(path.join(repositoryRoot, modulePath), "utf8");
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const baselineOnly = process.argv.includes("--baseline-only");
const dockerPostgres = process.argv.includes("--docker-postgres=17");
const small = process.argv.includes("--small");
const runsPerWorkspace = small ? 16 : 600;
const bindingRows = Math.max(1, Math.floor(runsPerWorkspace / 20));
const descendantsPerWorkspace = Number(process.argv.find(arg => arg.startsWith("--descendants="))?.slice(14) ?? 1);
assert.ok(Number.isInteger(descendantsPerWorkspace) && descendantsPerWorkspace >= 1 && descendantsPerWorkspace <= 500,
  "--descendants must be an integer between 1 and 500");
const measuredSamples = Number(process.argv.find(arg => arg.startsWith("--samples="))?.slice(10) ?? 5);
const warmups = Number(process.argv.find(arg => arg.startsWith("--warmups="))?.slice(10) ?? 2);
assert.ok(Number.isInteger(measuredSamples) && measuredSamples >= 1 && measuredSamples <= 10);
assert.ok(Number.isInteger(warmups) && warmups >= 0 && warmups <= 5);
const outputDir = process.argv.find(arg => arg.startsWith("--output-dir="))?.slice(13) ?? await fs.mkdtemp(path.join(os.tmpdir(), "workspace-activity-evidence-"));
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { sql } = require("drizzle-orm");
const { PgDialect } = require("drizzle-orm/pg-core");
const dialect = new PgDialect();
const now = new Date("2026-10-20T12:00:00Z");
const old = new Date("2026-10-01T12:00:00Z");
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;

async function startDatabase() {
  if (!dockerPostgres) return startEmbeddedPostgresTestDatabase("workspace-activity-benchmark-");
  const container = `paperclip-workspace-activity-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  docker("run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=paperclip", "--env", "POSTGRES_PASSWORD=paperclip", "--env", "POSTGRES_DB=paperclip", "postgres:17");
  const cleanup = async () => { docker("rm", "--force", container); };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "paperclip"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "Disposable Docker PostgreSQL did not become ready");
    const port = docker("port", container, "5432/tcp").split(":").at(-1);
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);
    return { connectionString, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

function capture(invoke: (db: Db) => Promise<unknown>): Promise<Query> {
  let captured: Query | undefined;
  const captureDb = new Proxy(db!, { get(target, key) {
    if (key === "execute") return async (query: Parameters<typeof dialect.sqlToQuery>[0]) => { captured = dialect.sqlToQuery(query); return []; };
    return Reflect.get(target, key);
  }});
  return invoke(captureDb).then(() => { assert.ok(captured); return captured; });
}
const normalize = (rows: unknown[][]) => rows.map(row => JSON.stringify(row)).sort();
const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
};
function scans(plan: Plan): unknown[] {
  const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
  return flatten(plan).filter(node => node["Relation Name"] === "heartbeat_runs" || node["Index Name"])
    .map(({ Plans: _children, ...node }) => node);
}

try {
  await fs.mkdir(outputDir, { recursive: true });
  database = await startDatabase();
  db = createDb(database.connectionString, { maxConnections: 1 });
  // Keep historical legacy bindings independent from native bindings; current
  // insert triggers would otherwise rewrite the fixture's issue_id from JSON.
  await db.$client.unsafe("ALTER TABLE heartbeat_runs DISABLE TRIGGER heartbeat_runs_set_scope_kind");
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".workspace-activity-baseline-"));
  const original = new URL(`../${modulePath}`, import.meta.url);
  const source = gitRaw("show", `${baselineRevision}:${modulePath}`);
  const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`);
  const baselinePath = path.join(baselineDir, "git-workspace-expiration.ts");
  await fs.writeFile(baselinePath, rewritten);
  await fs.writeFile(path.join(outputDir, "baseline-git-workspace-expiration.ts"), source);
  await fs.writeFile(path.join(outputDir, "treatment-git-workspace-expiration.ts"), treatmentSource);
  const baseline = await import(pathToFileURL(baselinePath).href) as typeof expiration;
  const companyId = randomUUID(), agentId = randomUUID(), otherCompanyId = randomUUID(), otherAgentId = randomUUID(), unrelatedIssueId = randomUUID();
  await db.insert(companies).values([{ id: companyId, name: "Synthetic workspace activity", issuePrefix: "WAB" }, { id: otherCompanyId, name: "Other tenant", issuePrefix: "WAO" }]);
  await db.insert(agents).values([{ id: agentId, companyId, name: "Fixture" }, { id: otherAgentId, companyId: otherCompanyId, name: "Other fixture" }]);
  await db.insert(issues).values({ id: unrelatedIssueId, companyId, title: "Unrelated", updatedAt: old });
  const workspaces: Workspace[] = [];
  for (let n = 0; n < 8; n++) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: `Target ${n}`, status: "done", completedAt: old, updatedAt: old });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: `Target ${n}`, cwd: `/tmp/synthetic-workspace-activity-${n}`, updatedAt: old }).returning();
    workspaces.push(workspace);
    await db.insert(issues).values(Array.from({ length: descendantsPerWorkspace }, (_, child) => ({ companyId, parentId: issueId,
      title: `Child ${n}/${child}`, status: "done", completedAt: old, updatedAt: old })));
  }
  const padding = randomBytes(24 * 1024).toString("base64");
  // Most history is unrelated, as in the reported scan; contexts and results are
  // incompressible and wide enough to live in TOAST. Existing indexes are retained.
  for (let n = 0; n < 8; n++) {
    const workspace = workspaces[n];
    await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, scope_kind, issue_id, native_issue_id, created_at, started_at, finished_at, context_snapshot, result_json)
      SELECT $1::uuid, $2::uuid, 'succeeded', CASE WHEN i <= ${bindingRows} THEN 'issue' ELSE 'company' END,
        CASE WHEN i <= ${bindingRows} THEN $3::uuid END, CASE WHEN i > ${bindingRows} AND i <= ${bindingRows * 2} THEN $3::uuid END,
        $6::timestamptz + i * interval '1 second', $6::timestamptz + i * interval '2 seconds', $6::timestamptz + i * interval '3 seconds',
        jsonb_build_object('issueId', CASE WHEN i > ${bindingRows * 2} AND i <= ${bindingRows * 3} THEN $3::text ELSE $5::text END,
          'taskId', CASE WHEN i > ${bindingRows * 3} AND i <= ${bindingRows * 4} THEN $3::text ELSE $5::text END,
          'executionWorkspaceId', CASE WHEN i > ${bindingRows * 4} AND i <= ${bindingRows * 5} THEN $4::text ELSE 'unrelated' END,
          'fixtureRun', ${n * runsPerWorkspace} + i, 'padding', $7::text),
        jsonb_build_object('stdout', $7::text)
      FROM generate_series(1, ${runsPerWorkspace}) i`, [companyId, agentId, workspace.sourceIssueId, workspace.id, unrelatedIssueId, old.toISOString(), padding]);
  }
  // Malformed JSON shapes and noncanonical IDs must retain ->> semantics, never
  // throw on a cast or accidentally match another tenant's run.
  const unusualContexts = [null, [], [{ issueId: workspaces[0].sourceIssueId }], [[{ issueId: workspaces[0].sourceIssueId }]], true,
    12, "string", { issueId: workspaces[0].sourceIssueId!.toUpperCase() }, { issueId: 12 }, { issueId: { value: workspaces[0].sourceIssueId } },
    { taskId: workspaces[0].sourceIssueId }, { executionWorkspaceId: workspaces[0].id }];
  for (const context of unusualContexts) {
    await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, finished_at, context_snapshot) VALUES ($1::uuid, $2::uuid, 'succeeded', $3::timestamptz, $3::timestamptz, $4::jsonb)`, [companyId, agentId, old.toISOString(), JSON.stringify(context)]);
  }
  await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot) VALUES ($1::uuid, $2::uuid, 'running', $3::timestamptz, $4::jsonb)`, [otherCompanyId, otherAgentId, now.toISOString(), JSON.stringify({ issueId: workspaces[0].sourceIssueId, executionWorkspaceId: workspaces[0].id })]);
  await db.$client.unsafe("ALTER TABLE heartbeat_runs ENABLE TRIGGER heartbeat_runs_set_scope_kind");
  await db.$client.unsafe("ANALYZE");
  const [settings] = await db.$client.unsafe("SELECT version(), current_setting('work_mem') AS work_mem, pg_total_relation_size('heartbeat_runs') AS total_run_bytes");
  const results = [];
  for (const kind of ["lastActivity", "eligibility", "idleEligibility"] as const) {
    const invoke = (implementation: typeof expiration, d: Db, workspace: Workspace) => kind === "lastActivity"
      ? implementation.gitWorkspaceLastActivityAt(d, workspace)
      : implementation.isGitWorkspaceExpirationEligible(d as never, workspace, now, kind === "idleEligibility" ? now : undefined);
    const beforeQueries = await Promise.all(workspaces.map(workspace => capture(d => invoke(baseline, d, workspace))));
    const afterQueries = baselineOnly ? beforeQueries : await Promise.all(workspaces.map(workspace => capture(d => invoke(expiration, d, workspace))));
    await fs.writeFile(path.join(outputDir, `${kind}-queries.json`), JSON.stringify({ beforeQueries, afterQueries }, null, 2));
    if (process.argv.includes("--reject-new-jit")) {
      const [beforePlan] = await db.$client.unsafe(`EXPLAIN (FORMAT JSON) ${beforeQueries[0].sql}`, beforeQueries[0].params as never[]);
      const [afterPlan] = await db.$client.unsafe(`EXPLAIN (FORMAT JSON) ${afterQueries[0].sql}`, afterQueries[0].params as never[]);
      await fs.writeFile(path.join(outputDir, `${kind}-preflight-plans.json`), JSON.stringify({ beforePlan, afterPlan }, null, 2));
      assert.ok(!afterPlan["QUERY PLAN"][0].JIT || beforePlan["QUERY PLAN"][0].JIT,
        `${kind}: reject new JIT compilation before repeating a known expensive planner shape`);
    }
    const execute = async (queries: Query[]) => {
      const rows = [];
      const start = performance.now();
      for (const query of queries) rows.push(await db!.$client.unsafe(query.sql, query.params as never[]).values());
      return { ms: performance.now() - start, rows };
    };
    const beforeSamples: number[] = [], afterSamples: number[] = [];
    for (let n = 0; n < (baselineOnly ? 1 : warmups + measuredSamples); n++) {
      const order = n % 2 === 0 ? ["before", "after"] : ["after", "before"];
      const iteration: Record<string, Awaited<ReturnType<typeof execute>>> = {};
      for (const treatment of order) iteration[treatment] = await execute(treatment === "before" ? beforeQueries : afterQueries);
      assert.deepEqual(iteration.after.rows, iteration.before.rows, `${kind}: complete ordered positional results differ`);
      if (baselineOnly || n >= warmups) { beforeSamples.push(iteration.before.ms); afterSamples.push(iteration.after.ms); }
    }
    const [beforeExplain] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${beforeQueries[0].sql}`, beforeQueries[0].params as never[]);
    const [afterExplain] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${afterQueries[0].sql}`, afterQueries[0].params as never[]);
    const before = summarize(beforeSamples), after = summarize(afterSamples);
    results.push({ kind, workspaceCount: workspaces.length, equalCompleteResults: true, before, after, speedup: before.medianMs / after.medianMs,
      baselinePlan: beforeExplain["QUERY PLAN"], treatmentPlan: afterExplain["QUERY PLAN"] });
    await fs.writeFile(path.join(outputDir, "partial-results.json"), JSON.stringify(results, null, 2));
  }
  for (const workspace of workspaces) {
    const projection = sql`SELECT id, status, created_at, started_at, finished_at, controller_lease_expires_at FROM relevant_runs`;
    const before = dialect.sqlToQuery(sql`${baseline.expirationScope(workspace)} ${projection}`);
    const after = dialect.sqlToQuery(sql`${expiration.expirationScope(workspace)} ${projection}`);
    const beforeRows = await db.$client.unsafe(before.sql, before.params as never[]).values();
    const afterRows = await db.$client.unsafe(after.sql, after.params as never[]).values();
    assert.deepEqual(normalize(afterRows), normalize(beforeRows), "Complete relevant-run multisets differ");
  }
  assert.equal(await fs.readFile(path.join(repositoryRoot, modulePath), "utf8"), treatmentSource, "Treatment source changed during measurement");
  const report = { baselineRevision, treatmentRevision: git("rev-parse", "HEAD"),
    baselineSourceSha256: sha256(source), treatmentSourceSha256: sha256(treatmentSource),
    treatmentDiff: gitRaw("diff", "--", modulePath), baselineDependencies: "Unchanged current imports; only git-workspace-expiration.ts is loaded from baseline",
    settings, fixture: { runRows: runsPerWorkspace * 8 + unusualContexts.length + 1, workspaceCount: 8, descendantsPerWorkspace, contextPaddingBytes: Buffer.byteLength(padding), synthetic: true, small },
    acceptanceCriterion: "Complete result equality and materially lower stress-fixture medians; report small-control overhead separately",
    measurement: { baselineOnly, measuredSamples: baselineOnly ? 1 : measuredSamples, warmups: baselineOnly ? 0 : warmups, alternatingOrder: true },
    safety: { exactRelevantRunMultisets: true, completeOrderedCallerResults: true }, results };
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir, baselineRevision, settings, safety: report.safety, results: results.map(({ baselinePlan, treatmentPlan, ...result }) => ({ ...result,
    beforeScans: scans(baselinePlan[0].Plan), afterScans: scans(treatmentPlan[0].Plan) })) }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
