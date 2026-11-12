import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { sidebarBadgeService } from "../server/src/services/sidebar-badges.js";
import { captureSidebarQueries, cleanupSidebarFixture, observedSidebarFailures, seedSidebarFixture, type CapturedQuery } from "../server/src/__tests__/helpers/sidebar-badges-fixture.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass --baseline-ref=<pre-fix commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const externalUrl = process.env.PAPERCLIP_SIDEBAR_TEST_DATABASE_URL;
assert.ok(!externalUrl || new URL(externalUrl).pathname.endsWith("_test"), "Use a dedicated synthetic *_test database");
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let baselineDir: string | undefined;
let db: Db | undefined;
const fixtures: Awaited<ReturnType<typeof seedSidebarFixture>>[] = [];
let failure: unknown;
try {
  if (!externalUrl) database = await startEmbeddedPostgresTestDatabase("sidebar-benchmark-");
  db = createDb(externalUrl ?? database!.connectionString);
  const modulePath = "server/src/services/sidebar-badges.ts";
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const rewritten = source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".sidebar-baseline-"));
  const baselineFile = path.join(baselineDir, "sidebar-badges.ts");
  await fs.writeFile(baselineFile, rewritten);
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/sidebar-badges.js");
  const [{ version }] = await db.$client.unsafe("select version()");
  const settings = await db.$client.unsafe("select name, setting from pg_settings where name in ('work_mem', 'shared_buffers', 'jit', 'max_parallel_workers_per_gather')");
  const results = [];
  for (const mode of ["mixed", "all-failed", "all-succeeded", "empty"] as const) {
    const fixture = await seedSidebarFixture(db, mode);
    fixtures.push(fixture);
    await db.$client.unsafe("ANALYZE heartbeat_runs");
    await db.$client.unsafe("ANALYZE agents");
    const users = mode === "mixed" ? [undefined, null, "", "user-1", "user-2", "local-board", "nobody"] : [undefined];
    for (const currentUserId of users) {
      const queries = { baseline: [] as CapturedQuery[], treatment: [] as CapturedQuery[] };
      const before = baseline.sidebarBadgeService(captureSidebarQueries(db, queries.baseline));
      const after = sidebarBadgeService(captureSidebarQueries(db, queries.treatment));
      const options = { ...fixture.options, currentUserId };
      const baselineResponse = await before.get(fixture.companyId, options);
      const treatmentResponse = await after.get(fixture.companyId, options);
      assert.deepEqual(treatmentResponse, baselineResponse);
      assert.equal(queries.baseline.length, 1);
      assert.equal(queries.treatment.length, 1);
      const expected = await observedSidebarFailures(db, fixture.companyId, currentUserId);
      const normalize = (rows: unknown[][]) => rows.map(row => JSON.stringify(row)).sort();
      const baselineQuery = queries.baseline[0]!, treatmentQuery = queries.treatment[0]!;
      const treatmentRows = await db.$client.unsafe(treatmentQuery.sql, treatmentQuery.params as never[]).values();
      if (treatmentQuery.sql !== baselineQuery.sql) {
        assert.deepEqual(normalize(treatmentRows.map(row => [...row.slice(0, 3), new Date(String(row[3])).toISOString()])), normalize(expected.map(row => [row.id, row.scopeKind, row.issueId, row.createdAt.toISOString()])));
      }
      const samples = { baseline: [] as number[], treatment: [] as number[] };
      const rowsByVersion: Record<string, unknown[][]> = {};
      for (let iteration = 0; iteration < 9; iteration++) {
        for (const label of iteration % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
          const query = label === "baseline" ? baselineQuery : treatmentQuery;
          const start = performance.now();
          rowsByVersion[label] = await db.$client.unsafe(query.sql, query.params as never[]).values();
          if (iteration >= 2) samples[label].push(performance.now() - start);
        }
      }
      const measurements = [];
      for (const label of ["baseline", "treatment"] as const) {
        const query = label === "baseline" ? baselineQuery : treatmentQuery;
        const rows = rowsByVersion[label]!;
        const responseValueBytes = rows.flat().reduce<number>((sum, value) => sum + (value == null ? 0 : Buffer.byteLength(typeof value === "string" ? value : String(value))), 0);
        const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
        const sorted = [...samples[label]].sort((a, b) => a - b);
        measurements.push({ label, query, rows: rows.length, responseValueBytes, samplesMs: samples[label], medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6], plan: plan!["QUERY PLAN"] });
      }
      if (process.env.SIDEBAR_REQUIRE_BYTE_REDUCTION === "1" && mode !== "empty") {
        assert.ok(measurements[1]!.responseValueBytes < measurements[0]!.responseValueBytes);
      }
      results.push({ mode, currentUserId: currentUserId === undefined ? "<undefined>" : currentUserId, equalBadgeResponse: treatmentResponse, equalCandidateRows: expected.length, measurements });
    }
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    treatmentDiff: execFileSync("git", ["diff", "--", modulePath], { encoding: "utf8" }),
    dependencyPolicy: "Baseline imports unchanged current authorization, privacy, and shared helpers", version, settings,
    acceptance: "Identical complete badges and candidate bindings; fewer response-value bytes for nonempty fixtures. Timings are descriptive with no latency threshold.",
    byteBoundary: "UTF-8 non-null cell values before Drizzle decoding, excluding PostgreSQL protocol framing; not wire bytes",
    results }, null, 2));
} catch (error) {
  failure = error;
} finally {
  const errors: unknown[] = failure === undefined ? [] : [failure];
  async function cleanup(action: () => Promise<unknown> | undefined) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (db) for (const fixture of fixtures) await cleanup(() => cleanupSidebarFixture(db!, fixture));
  await cleanup(() => db?.$client.end({ timeout: 0 }));
  await cleanup(() => database?.cleanup());
  await cleanup(() => baselineDir ? fs.rm(baselineDir, { recursive: true, force: true }) : undefined);
  clearInterval(keepAlive);
  if (errors.length) throw new AggregateError(errors, "Sidebar benchmark or cleanup failed");
}
