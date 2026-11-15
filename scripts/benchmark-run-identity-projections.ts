import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { captureRunIdentity } from "../server/src/services/run-identity.js";
import { captureIdentityQueries, seedIdentityProjection, type IdentityQuery } from "../server/src/__tests__/helpers/run-identity-projection-fixture.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const baselineRevision = git(["rev-parse", "--verify", `${baselineRef}^{commit}`]).trim();
const modulePath = "server/src/services/run-identity.ts";
const unchangedHelpers = ["run-task-binding.ts", "task-retry.ts", "issue-queued-comment-queue.ts"];
for (const name of unchangedHelpers) {
  const helper = `server/src/services/${name}`;
  assert.equal(git(["show", `${baselineRevision}:${helper}`]), await fs.readFile(path.join(root, helper), "utf8"),
    `Baseline helper ${name} changed; isolate it before benchmarking`);
}
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let baselineDir: string | undefined;
try {
  const oldSource = git(["show", `${baselineRevision}:${modulePath}`]);
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.identity-projection-baseline-"));
  const baselineFile = path.join(baselineDir, "run-identity.ts");
  await fs.writeFile(baselineFile, oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/run-identity.js");
  const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (externalUrl) {
    const parsed = new URL(externalUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname) && /_test$/.test(parsed.pathname),
      "External benchmark database must be a disposable local *_test database");
    await applyPendingMigrations(externalUrl);
    db = createDb(externalUrl);
  } else {
    temporary = await startEmbeddedPostgresTestDatabase("identity-projection-benchmark-");
    db = createDb(temporary.connectionString);
  }
  const f = await seedIdentityProjection(db);
  await db.$client.unsafe("ANALYZE");
  const beforeQueries: IdentityQuery[] = [];
  const before = await baseline.captureRunIdentity(captureIdentityQueries(db, beforeQueries), f);
  const findRunQuery = (queries: IdentityQuery[]) => {
    const query = queries.find(query => query.sql.includes('from "heartbeat_runs"') && query.sql.includes("for no key update"));
    assert.ok(query, "Capture the actual locked identity query");
    return query;
  };
  const beforeQuery = findRunQuery(beforeQueries);
  const dataRowBytes = async (query: IdentityQuery) => {
    const rows = await db!.$client.unsafe(query.sql, query.params as never[]).raw();
    return rows.reduce((total, row) => total + 7 + 4 * row.length + row.reduce((bytes, value) => bytes + (value?.byteLength ?? 0), 0), 0);
  };
  const baselineBytes = await dataRowBytes(beforeQuery);
  async function plan(query: IdentityQuery) {
    const [result] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    return result!["QUERY PLAN"];
  }
  const results = [];
  for (const readScope of ["identity", "task_authorization", "token_broker", "project_execution"] as const) {
    const afterQueries: IdentityQuery[] = [];
    const after = await captureRunIdentity(captureIdentityQueries(db, afterQueries), f, { readScope });
    assert.deepEqual(after.context, before.context);
    for (const [key, value] of Object.entries(after.run)) {
      if (key === "runnerProfileJson") assert.deepEqual(value, { nativeExecutionInput: before.run.runnerProfileJson?.nativeExecutionInput });
      else if (key !== "contextSnapshot") assert.deepEqual(value, before.run[key as keyof typeof before.run], `Retained ${key}`);
      else {
        const snapshot = value as Record<string, unknown>;
        for (const [name, selected] of Object.entries(snapshot)) {
          if (name !== "paperclipIssue") assert.deepEqual(selected, before.run.contextSnapshot?.[name] ?? null, `Retained context ${name}`);
          else for (const [nested, item] of Object.entries(selected as Record<string, unknown>))
            assert.deepEqual(item, (before.run.contextSnapshot?.paperclipIssue as Record<string, unknown>)?.[nested] ?? null, `Retained nested ${nested}`);
        }
      }
    }
    const afterQuery = findRunQuery(afterQueries), afterBytes = await dataRowBytes(afterQuery);
    assert.ok(afterBytes < baselineBytes * (readScope === "project_execution" ? 0.5 : 0.05),
      "Fixture acceptance: remove at least 95% of authority bytes or 50% while preserving complete execution input");
    assert.equal(afterQueries.length, beforeQueries.length, "No queries added or removed from identity reconciliation");
    const samples = { baseline: [] as number[], treatment: [] as number[] };
    for (let n = 0; n < 9; n++) {
      for (const version of n % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
        const start = performance.now();
        if (version === "baseline") await baseline.captureRunIdentity(db, f);
        else await captureRunIdentity(db, f, { readScope });
        if (n >= 2) samples[version].push(performance.now() - start);
      }
    }
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { samplesMs: values, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
    };
    results.push({ readScope, baselineBytes, treatmentBytes: afterBytes, reductionPercent: 100 * (1 - afterBytes / baselineBytes),
      retainedColumnsAndContextEqual: true, identityContextEqual: true, queryCount: afterQueries.length,
      generatedSql: { baseline: beforeQuery, treatment: afterQuery },
      timings: { scope: "complete captureRunIdentity service transaction", warmups: 2, samples: 7, order: "alternating",
        baseline: stats(samples.baseline), treatment: stats(samples.treatment) },
      plans: { baseline: await plan(beforeQuery), treatment: await plan(afterQuery) } });
  }
  assert.deepEqual((await captureRunIdentity(db, f)).run, before.run, "Complete stored run unchanged");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: git(["rev-parse", "HEAD"]).trim(),
    treatmentDiff: git(["diff", "HEAD", "--", "server/src"]), unchangedHelpers,
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    settings: await db.$client.unsafe("SELECT name, setting FROM pg_settings WHERE name IN ('block_size','shared_buffers','work_mem','jit') ORDER BY name"),
    fixture: { runs: 1, synthetic: true, contextBytes: Buffer.byteLength(JSON.stringify(f.payloads.contextSnapshot)),
      profileBytes: Buffer.byteLength(JSON.stringify(f.payloads.runnerProfileJson)) },
    measurement: "PostgreSQL DataRow messages from raw text-format buffers; excludes metadata, TLS and TCP", results,
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
