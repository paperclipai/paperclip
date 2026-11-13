import assert from "node:assert/strict";
import { SQL } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { readInheritedGitHubReviewWait } from "../../server/src/services/chat-channels/github/review-wait.js";
import { captureReviewWaitQueries, seedGitHubReviewWait,
  revokeReviewWaitConnection, type CapturedReviewWaitQuery } from "../../server/src/__tests__/helpers/github-review-wait.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/chat-channels/github/review-wait.ts";
const helperPath = "server/src/services/chat-channels/run-origin.ts";
const root = fileURLToPath(new URL("../../", import.meta.url));
assert.equal(execFileSync("git", ["show", `${baselineRevision}:${helperPath}`], { encoding: "utf8" }),
  await fs.readFile(path.join(root, helperPath), "utf8"), "Baseline provenance helper must be unchanged");
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let baselineDir: string | undefined;
try {
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const moduleUrl = new URL(`../../${modulePath}`, import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.review-wait-baseline-"));
  const baselineFile = path.join(baselineDir, "review-wait.ts");
  await fs.writeFile(baselineFile, oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../../server/src/services/chat-channels/github/review-wait.js");
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
  async function capture(reader: typeof readInheritedGitHubReviewWait) {
    const queries: CapturedReviewWaitQuery[] = [];
    const result = await reader(captureReviewWaitQueries(db!, queries), f.run);
    return { result, queries };
  }
  const before = await capture(baseline.readInheritedGitHubReviewWait);
  const after = await capture(readInheritedGitHubReviewWait);
  assert.deepEqual(after, before, "Complete service output, SQL, bound parameters and query count must match");
  assert.equal(before.result?.kind, "published");

  async function compilations(reader: typeof readInheritedGitHubReviewWait) {
    const original = SQL.prototype.toQuery;
    let joined = 0;
    SQL.prototype.toQuery = function (...args: Parameters<typeof original>) {
      const query = original.apply(this, args);
      if (query.sql.includes('join "chat_github_reviews"')) joined++;
      return query;
    };
    try {
      for (let i = 0; i < 10; i++) await reader(db!, f.run);
    } finally { SQL.prototype.toQuery = original; }
    return joined;
  }
  const buildCounts = { baseline: await compilations(baseline.readInheritedGitHubReviewWait),
    treatment: await compilations(readInheritedGitHubReviewWait) };
  buildCounts.treatment = await compilations(readInheritedGitHubReviewWait);
  assert.equal(buildCounts.baseline, 10);
  assert.equal(buildCounts.treatment, 0);

  await revokeReviewWaitConnection(db, f);
  assert.deepEqual(await readInheritedGitHubReviewWait(db, f.run), { kind: "revoked" });
  assert.deepEqual(await baseline.readInheritedGitHubReviewWait(db, f.run), { kind: "revoked" });
  await db.$client.unsafe("UPDATE tool_connections SET enabled = true WHERE id = $1::uuid", [f.connectionId]);

  const iterations = Number(process.env.REVIEW_WAIT_BENCH_ITERATIONS ?? 100);
  assert.ok(Number.isInteger(iterations) && iterations > 0);
  const readers = { baseline: baseline.readInheritedGitHubReviewWait, treatment: readInheritedGitHubReviewWait };
  const samples = { baseline: [] as { cpuMs: number; wallMs: number }[], treatment: [] as { cpuMs: number; wallMs: number }[] };
  for (const reader of Object.values(readers)) for (let i = 0; i < 500; i++) await reader(db, f.run);
  for (let pair = 0; pair < 9; pair++) {
    for (const version of pair % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
      const cpu = process.cpuUsage(), wall = performance.now();
      for (let i = 0; i < iterations; i++) await readers[version](db, f.run);
      const elapsed = process.cpuUsage(cpu);
      samples[version].push({ cpuMs: (elapsed.user + elapsed.system) / 1_000, wallMs: performance.now() - wall });
    }
  }
  const stats = (values: typeof samples.baseline) => {
    const cpu = values.map(value => value.cpuMs / iterations).sort((a, b) => a - b);
    const wall = values.map(value => value.wallMs / iterations).sort((a, b) => a - b);
    return { samples: values, medianCpuMsPerRead: cpu[Math.floor(cpu.length / 2)],
      minCpuMsPerRead: cpu[0], maxCpuMsPerRead: cpu.at(-1), medianWallMsPerRead: wall[Math.floor(wall.length / 2)] };
  };
  console.log(JSON.stringify({ baselineRevision, treatmentRevision,
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", modulePath], { cwd: root, encoding: "utf8" }),
    runtime: process.version, platform: process.platform, arch: process.arch,
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    fixture: { reviews: 1, synthetic: true }, correctness: { completeOutputEqual: true,
      everyGeneratedQueryAndParameterEqual: true, currentConnectionRevocationEqual: true },
    generatedQueries: before.queries, compilationCountsPerTenWarmReads: buildCounts,
    measurement: "Complete actual service, sequential real PostgreSQL reads; process CPU includes client work, excludes database process CPU",
    timings: { iterations, warmups: 500, pairs: 9, order: "alternating", baseline: stats(samples.baseline), treatment: stats(samples.treatment) },
  }, null, 2));
} finally {
  try {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
