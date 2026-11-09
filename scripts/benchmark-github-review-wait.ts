import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { readInheritedGitHubReviewWait } from "../server/src/services/chat-channels/github/review-wait.js";
import { captureReviewWaitQueries, seedGitHubReviewWait, setGitHubReviewAssessment,
  revokeReviewWaitConnection, type CapturedReviewWaitQuery } from "../server/src/__tests__/helpers/github-review-wait.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/chat-channels/github/review-wait.ts";
const helperPath = "server/src/services/chat-channels/run-origin.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(execFileSync("git", ["show", `${baselineRevision}:${helperPath}`], { encoding: "utf8" }),
  await fs.readFile(path.join(root, helperPath), "utf8"), "Baseline provenance helper must be unchanged");
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let baselineDir: string | undefined;
try {
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.review-wait-baseline-"));
  const baselineFile = path.join(baselineDir, "review-wait.ts");
  await fs.writeFile(baselineFile, oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/chat-channels/github/review-wait.js");
  const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (externalUrl) {
    const parsed = new URL(externalUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.pathname.startsWith("/review_wait_benchmark"),
      "External benchmark database must be a disposable local review_wait_benchmark database");
    await applyPendingMigrations(externalUrl);
    db = createDb(externalUrl);
  } else {
    temporary = await startEmbeddedPostgresTestDatabase("github-review-wait-benchmark-");
    db = createDb(temporary.connectionString);
  }
  const f = await seedGitHubReviewWait(db);
  const summary = randomBytes(4_800).toString("base64");
  await setGitHubReviewAssessment(db, f.reviewId, { reviewedCommit: f.headSha, summary, findings: [] });
  await db.$client.unsafe("ANALYZE");

  async function capture(reader: typeof readInheritedGitHubReviewWait) {
    const queries: CapturedReviewWaitQuery[] = [];
    const result = await reader(captureReviewWaitQueries(db!, queries), f.run);
    const query = queries.find(query => query.sql.includes('join "chat_github_reviews"'));
    assert.ok(query, "Capture the real joined service query");
    return { result, query };
  }
  const before = await capture(baseline.readInheritedGitHubReviewWait), after = await capture(readInheritedGitHubReviewWait);
  assert.deepEqual(after.result, before.result);
  assert.equal(before.result?.kind, "published");
  const rawBefore = await db.$client.unsafe(before.query.sql, before.query.params as never[]).raw();
  const rawAfter = await db.$client.unsafe(after.query.sql, after.query.params as never[]).raw();
  assert.equal(rawBefore.length, 1);
  assert.equal(rawAfter.length, 1);
  const normalizedBefore = rawBefore[0]!.map(value => value?.toString() ?? null);
  const normalizedAfter = rawAfter[0]!.map(value => value?.toString() ?? null);
  normalizedBefore[6] = JSON.stringify(JSON.parse(normalizedBefore[6]!).reviewedCommit);
  assert.deepEqual(normalizedAfter, normalizedBefore, "Every unchanged SQL column and selected commit must match");
  const dataRowBytes = (rows: Buffer[][]) => rows.reduce((total, row) => total + 7 + 4 * row.length +
    row.reduce((bytes, value) => bytes + (value?.byteLength ?? 0), 0), 0);
  const baselineDataRowBytes = dataRowBytes(rawBefore), treatmentDataRowBytes = dataRowBytes(rawAfter);
  assert.ok(treatmentDataRowBytes < baselineDataRowBytes * 0.2, "Fixture acceptance: remove at least 80% of DataRow bytes");

  const equivalenceCases = [null, false, 123, f.headSha, [], [f.headSha], {}, { reviewedCommit: null },
    { reviewedCommit: 1 }, { reviewedCommit: true }, { reviewedCommit: [f.headSha] },
    { reviewedCommit: { value: f.headSha } }, { reviewedCommit: ` ${f.headSha}` },
    { reviewedCommit: "2".repeat(40) }, { reviewedCommit: f.headSha }];
  for (const assessment of equivalenceCases) {
    await setGitHubReviewAssessment(db, f.reviewId, assessment);
    assert.deepEqual(await readInheritedGitHubReviewWait(db, f.run), await baseline.readInheritedGitHubReviewWait(db, f.run));
  }
  await setGitHubReviewAssessment(db, f.reviewId, { reviewedCommit: f.headSha, summary, findings: [] });
  await revokeReviewWaitConnection(db, f);
  assert.deepEqual(await readInheritedGitHubReviewWait(db, f.run), { kind: "revoked" });
  assert.deepEqual(await baseline.readInheritedGitHubReviewWait(db, f.run), { kind: "revoked" });

  await db.$client.unsafe("UPDATE tool_connections SET enabled = true WHERE id = $1::uuid", [f.connectionId]);
  assert.equal((await readInheritedGitHubReviewWait(db, f.run))?.kind, "published");

  async function timed(query: CapturedReviewWaitQuery) {
    const start = performance.now();
    await db!.$client.unsafe(query.sql, query.params as never[]).values();
    return performance.now() - start;
  }
  const samples = { baseline: [] as number[], treatment: [] as number[] };
  for (let n = 0; n < 9; n++) {
    const versions = n % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const;
    for (const version of versions) {
      const elapsed = await timed(version === "baseline" ? before.query : after.query);
      if (n >= 2) samples[version].push(elapsed);
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samplesMs: values, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
  };
  async function plan(query: CapturedReviewWaitQuery) {
    const [result] = await db!.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
    return result!["QUERY PLAN"];
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", modulePath], { cwd: root, encoding: "utf8" }),
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    settings: await db.$client.unsafe("SELECT name, setting FROM pg_settings WHERE name IN ('block_size','shared_buffers','work_mem','jit') ORDER BY name"),
    fixture: { reviews: 1, assessmentSummaryBytes: Buffer.byteLength(summary), synthetic: true },
    generatedQueries: { baseline: before.query, treatment: after.query },
    correctness: { completeOutputEqual: true, unchangedColumnsEqual: true, malformedJsonCases: equivalenceCases.length,
      connectionRevocationEqual: true },
    bytes: { measurement: "PostgreSQL DataRow messages from raw text-format column buffers; excludes metadata, TLS and TCP",
      baselineDataRowBytes, treatmentDataRowBytes, reductionPercent: 100 * (1 - treatmentDataRowBytes / baselineDataRowBytes) },
    timings: { warmups: 2, samples: 7, order: "alternating", baseline: stats(samples.baseline), treatment: stats(samples.treatment) },
    plans: { baseline: await plan(before.query), treatment: await plan(after.query) },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
