import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPendingMigrations, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { resolveChatOriginPublicationBindings } from "../server/src/services/issues.js";
import { captureLineageReads, chatReplyLineageFixture, cleanupChatReplyLineageFixture, expectedLineageContext, type LineageQuery, type LineageResolver } from "../server/src/__tests__/helpers/chat-reply-lineage.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const ref = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(ref, "Pass a pinned pre-fix --baseline-ref");
const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const sourcePath = "server/src/services/issues.ts";
const baselineRevision = git(["rev-parse", `${ref}^{commit}`]), treatmentRevision = git(["rev-parse", "HEAD"]);
const uncommittedChanges = git(["status", "--porcelain"]), treatmentDiff = git(["diff", "HEAD", "--", sourcePath]);
const sourceHash = () => createHash("sha256").update(readFileSync(path.join(repoRoot, sourcePath))).digest("hex");
const treatmentSourceSha256 = sourceHash();
const keepAlive = setInterval(() => {}, 1000);
let db: Db | undefined, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, baselineDirectory: string | undefined;
const companyIds: string[] = [];
let benchmarkFailure: { error: unknown } | undefined;
try {
  const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CHAT_LINEAGE_BENCHMARK_DATABASE_URL");
  if (externalUrl) await applyPendingMigrations(externalUrl);
  else temporary = await startEmbeddedPostgresTestDatabase("chat-lineage-benchmark-");
  db = createDb(externalUrl ?? temporary!.connectionString);
  baselineDirectory = await fs.mkdtemp(path.join(repoRoot, "server/scripts/.chat-lineage-baseline-"));
  const original = pathToFileURL(path.join(repoRoot, sourcePath));
  const baselineSource = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { cwd: repoRoot, encoding: "utf8" });
  await fs.writeFile(path.join(baselineDirectory, "issues.ts"), baselineSource.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g,
    (_match, prefix: string, quote: string, specifier: string) => `${prefix}${quote}${fileURLToPath(new URL(specifier, original))}${quote}`));
  const baseline = (await import(pathToFileURL(path.join(baselineDirectory, "issues.ts")).href)).resolveChatOriginPublicationBindings as LineageResolver;
  const measurements = [];
  for (const scenario of [{ name: "small", bytes: 16, hops: 0 }, { name: "wide", bytes: 192 * 1024, hops: 0 }, { name: "wide-24-continuations", bytes: 192 * 1024, hops: 24 }]) {
    const f = await chatReplyLineageFixture(db, scenario.bytes); companyIds.push(f.companyId);
    let runId = f.root.id;
    for (let hop = 0; hop < scenario.hops; hop++) runId = (await f.continueFrom(runId)).run.id;
    await db.$client.unsafe("ANALYZE");
    async function capture(resolver: LineageResolver) {
      const reads: LineageQuery[] = [];
      const result = await resolver(captureLineageReads(db!, reads), f.companyId, f.issueId, runId);
      assert.deepEqual(result, f.expected);
      assert.equal(reads.length, scenario.hops + 1);
      return { result, reads };
    }
    const before = await capture(baseline), after = await capture(resolveChatOriginPublicationBindings);
    assert.deepEqual(after.result, before.result);
    for (let index = 0; index < before.reads.length; index++) {
      const row = before.reads[index].rows[0];
      assert.deepEqual(after.reads[index].rows, [{ ...row, contextSnapshot: expectedLineageContext(row.contextSnapshot) }]);
    }
    const variants = [before, after], samples: number[][] = [[], []], bytes: number[] = [0, 0];
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const variant of iteration % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now(); let returned = 0;
        for (const query of variants[variant].reads) {
          const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
          returned += rows.reduce((sum, row) => sum + 7 + row.reduce((n: number, value: Buffer | null) => n + 4 + (value?.length ?? 0), 0), 0);
        }
        if (iteration >= 2) samples[variant].push(performance.now() - started);
        bytes[variant] = returned;
      }
    }
    const minimumSaving = Buffer.byteLength(f.context.prompt) * (scenario.hops + 1);
    assert.ok(bytes[0] - bytes[1] >= minimumSaving, "All unrelated synthetic body bytes must be removed before transfer");
    const plans = [];
    for (const variant of variants) {
      const query = variant.reads[0];
      const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
      plans.push(plan["QUERY PLAN"]);
    }
    const timing = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6], samplesMs: values }; };
    measurements.push({ scenario, bodyBytesPerRun: Buffer.byteLength(f.context.prompt), completeBindingsEqual: true, selectedColumnsEqual: true,
      baselineDataRowBytes: bytes[0], treatmentDataRowBytes: bytes[1], minimumSaving, baselineTiming: timing(samples[0]), treatmentTiming: timing(samples[1]),
      baselineQueries: before.reads.map(({ rows: _rows, ...query }) => query), treatmentQueries: after.reads.map(({ rows: _rows, ...query }) => query), plans });
  }
  assert.equal(sourceHash(), treatmentSourceSha256, "Measured service source changed during the benchmark");
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, sourcePath, treatmentSourceSha256, uncommittedChanges, treatmentDiff,
    byteBoundary: "Exact text-format PostgreSQL DataRow frames; excludes row descriptions, command metadata, TLS and TCP. Timings cover captured lineage SQL only, not the complete authorization service.",
    dependencyScope: "Only the pinned baseline issues.ts is loaded from history; imported helpers and synthetic fixtures are held identical.",
    postgres: await db.$client.unsafe("select version()"), settings: await db.$client.unsafe("select name,setting,unit from pg_settings where name in ('shared_buffers','work_mem','jit') order by name"),
    node: process.version, measurements }, null, 2));
} catch (error) {
  benchmarkFailure = { error };
  throw error;
} finally {
  try {
    try {
      if (db) for (const companyId of companyIds) await cleanupChatReplyLineageFixture(db, companyId);
    } finally {
      try {
        await db?.$client.end({ timeout: 0 });
      } finally {
        try {
          await temporary?.cleanup();
        } finally {
          try {
            if (baselineDirectory) await fs.rm(baselineDirectory, { recursive: true, force: true });
          } finally { clearInterval(keepAlive); }
        }
      }
    }
  } catch (error) {
    if (benchmarkFailure) throw new AggregateError([benchmarkFailure.error, error], "Benchmark and cleanup failed");
    throw error;
  }
}
