import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { admitExplicitNativeContinuation } from "../server/src/services/explicit-native-continuation.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";

type Query = { sql: string; params: unknown[] };
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const treatmentDiff = execFileSync("git", ["diff", "HEAD", "--", "server/src/services/explicit-native-continuation.ts"], { cwd: repoRoot, encoding: "utf8" });
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
try {
  const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CONTINUATION_BENCHMARK_DATABASE_URL");
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    database = { connectionString: externalUrl, cleanup: async () => {} };
  } else database = await startEmbeddedPostgresTestDatabase("continuation-read-benchmark-");
  db = createDb(database.connectionString);
  const original = new URL("../server/src/services/explicit-native-continuation.ts", import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".continuation-baseline-"));
  const baselineSource = execFileSync("git", ["show", `${baselineRevision}:server/src/services/explicit-native-continuation.ts`], { cwd: repoRoot, encoding: "utf8" });
  await fs.writeFile(path.join(baselineDir, "continuation.ts"), baselineSource.replace(/(from |import\()"(\.{1,2}\/[^\"]+)"/g,
    (_match, prefix: string, specifier: string) => `${prefix}${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`));
  const baseline = await import(pathToFileURL(path.join(baselineDir, "continuation.ts")).href) as { admitExplicitNativeContinuation: typeof admitExplicitNativeContinuation };
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic continuation", issuePrefix: `B${companyId.replaceAll("-", "")}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Continue", status: "blocked", assigneeAgentId: agentId });
  const contextBytes = randomBytes(144 * 1024).toString("base64");
  const profileBytes = randomBytes(72 * 1024).toString("base64");
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
    status: "failed", runtimeMode: "native", processPid: 999999999,
    finishedAt: new Date("2020-01-01T00:00:00Z"), contextSnapshot: { issueId, prompt: contextBytes },
    runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { instructions: profileBytes } },
      nativeExecutionInput: { task: { description: profileBytes } } },
  });
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", attempt: 3 });
  await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    cause: "uncertain_external_action", fingerprint: runId, status: "resolved", outcome: "blocked", nextAction: "Inspect",
    evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
  await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board",
    body: "Continue with new instructions.", createdAt: new Date("2020-01-01T01:00:00Z") });
  await db.$client.unsafe("ANALYZE");
  async function capture(invoke: typeof admitExplicitNativeContinuation) {
    const queries: Query[] = [];
    const reads: Array<Array<Record<string, unknown>>> = [];
    const recorded = new Proxy(db!, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          if (args[0] === heartbeatRuns) query.execute = async (...executeArgs: Parameters<typeof execute>) => {
            const statement = query.toSQL();
            const admissionRead = statement.sql.includes('"id"::text') || statement.sql.endsWith("for update");
            if (admissionRead) queries.push(statement);
            const rows = await execute(...executeArgs);
            if (admissionRead) reads.push(rows);
            return rows;
          };
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    const blocked: string[] = [];
    const result = await invoke({ db: recorded, companyId, agentId, issueId, commentId,
      actorType: "user", actorId: "board", reason: "issue_commented", successorRunId: randomUUID(), dryRun: true,
      onBlocked: reason => blocked.push(reason) });
    assert.equal(queries.length, 2);
    return { queries, reads, result, blocked };
  }
  const before = await capture(baseline.admitExplicitNativeContinuation), after = await capture(admitExplicitNativeContinuation);
  assert.ok(before.result);
  assert.deepEqual(after.result, before.result);
  assert.deepEqual(after.blocked, before.blocked);
  for (let index = 0; index < before.reads.length; index++) {
    assert.equal(after.reads[index].length, before.reads[index].length);
    for (const [key, value] of Object.entries(after.reads[index][0])) {
      if (key === "contextSnapshot") assert.deepEqual(value, { issueId });
      else if (key === "runnerProfileJson" && index === 0) assert.deepEqual(value, { adapterDispatch: { adapterType: "paperclip_runner" } });
      else assert.deepEqual(value, before.reads[index][0][key], `Changed selected column ${key}`);
    }
  }
  const measurements = [];
  for (let index = 0; index < 2; index++) {
    const pair = [before.queries[index], after.queries[index]];
    const samples: number[][] = [[], []];
    const bytes: number[] = [];
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const variant of iteration % 2 ? [1, 0] : [0, 1]) {
        const query = pair[variant], start = performance.now();
        const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
        if (iteration >= 2) samples[variant].push(performance.now() - start);
        bytes[variant] = rows.reduce((sum, row) => sum + 7 + row.reduce((n: number, value: Buffer | null) => n + 4 + (value?.length ?? 0), 0), 0);
      }
    }
    const plans = [];
    for (const query of pair) {
      const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
      plans.push(plan["QUERY PLAN"]);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    measurements.push({ name: index === 0 ? "preflight" : "locked", baseline: pair[0], treatment: pair[1],
      baselineDataRowBytes: bytes[0], treatmentDataRowBytes: bytes[1], reduction: 1 - bytes[1] / bytes[0],
      baselineMedianMs: median(samples[0]), treatmentMedianMs: median(samples[1]), samples, plans });
  }
  const baselineBytes = measurements.reduce((sum, row) => sum + row.baselineDataRowBytes, 0);
  const treatmentBytes = measurements.reduce((sum, row) => sum + row.treatmentDataRowBytes, 0);
  assert.ok(treatmentBytes < baselineBytes / 2, "The fixture must remove more than half of the two reads' DataRow bytes");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, treatmentDiff,
    byteBoundary: "Exact text-format DataRow frames; excludes RowDescription, command metadata, TLS and TCP",
    acceptance: { equalSelectedColumns: true, equalAdmission: true, lessThanHalfDataRowBytes: true },
    postgres: await db.$client.unsafe("select version()"),
    fixture: { contextBytes: Buffer.byteLength(contextBytes), profileCopies: 2, profileCopyBytes: Buffer.byteLength(profileBytes) },
    equalAdmission: true, measurements }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 }); await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
