import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { taskInterruptionPresentations } from "../server/src/services/task-interruption-presentation.js";
import { captureInterruptionQuery, seedInterruptionFixture, type CapturedQuery } from "../server/src/__tests__/helpers/task-interruption-fixture.js";

const startedAt = performance.now();
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/task-interruption-presentation.ts";
const changedRuntime = execFileSync("git", ["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
assert.deepEqual(changedRuntime.filter(file => file !== modulePath), [], "Changed baseline dependency requires explicit isolation");
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined, baselineDir: string | undefined;
try {
  const oldSource = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
  const source = oldSource.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) =>
    `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`);
  baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".interruption-baseline-"));
  const baselineFile = path.join(baselineDir, "task-interruption.ts");
  await fs.writeFile(baselineFile, source);
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("../server/src/services/task-interruption-presentation.js");
  database = await startEmbeddedPostgresTestDatabase("interruption-benchmark-");
  db = createDb(database.connectionString);
  const settings = await db.$client.unsafe("select version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit') jit");
  const setupMs = performance.now() - startedAt;
  const results = [];
  for (const fixture of [
    { selected: 1, history: 1, unrelated: 0, payloadBytes: 128 },
    { selected: 100, history: 1, unrelated: 1200, payloadBytes: 24 * 1024 },
    { selected: 100, history: 12, unrelated: 1200, payloadBytes: 24 * 1024 },
    { selected: 1, history: 120, unrelated: 1200, payloadBytes: 24 * 1024 },
    { selected: 100, history: 40, unrelated: 1200, payloadBytes: 12 * 1024 },
    { selected: 100, history: 40, unrelated: 1200, payloadBytes: 12 * 1024, preserveLegacyBindings: false },
    { selected: 1000, history: 1, unrelated: 1200, payloadBytes: 12 * 1024, preserveLegacyBindings: false },
  ]) {
    await db.$client.begin(async client => {
      await client.unsafe("set local client_min_messages = warning");
      await client.unsafe("truncate heartbeat_runs cascade");
    });
    const seedStart = performance.now();
    const f = await seedInterruptionFixture(db, fixture);
    const seedMs = performance.now() - seedStart;
    const before = await captureInterruptionQuery(db, baseline.taskInterruptionPresentations, f.companyId, f.input);
    const after = await captureInterruptionQuery(db, taskInterruptionPresentations, f.companyId, f.input);
    const execute = async (query: CapturedQuery) => db!.$client.unsafe(query.sql, query.params as never[]).values();
    const beforeRows = await execute(before), afterRows = await execute(after);
    assert.deepEqual(afterRows, beforeRows, "Every positional SQL field and row order must match");
    assert.deepEqual(await taskInterruptionPresentations(db, f.companyId, f.input),
      await baseline.taskInterruptionPresentations(db, f.companyId, f.input), "Full service output must match");
    const samples = { baseline: [] as number[], treatment: [] as number[] };
    for (let round = 0; round < 7; round++) {
      for (const arm of round % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
        const start = performance.now();
        await execute(arm === "baseline" ? before : after);
        if (round >= 2) samples[arm].push(performance.now() - start);
      }
    }
    const explain = async (query: CapturedQuery) => (await db!.$client.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params as never[]))[0]!["QUERY PLAN"];
    const summarize = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[2], minMs: sorted[0], maxMs: sorted[4], samplesMs: values }; };
    const baselineTiming = summarize(samples.baseline), treatmentTiming = summarize(samples.treatment);
    results.push({ fixture, seedMs, returnedRows: afterRows.length, positionalEquality: true, serviceEquality: true,
      baseline: { ...baselineTiming, query: before, plan: await explain(before) },
      treatment: { ...treatmentTiming, query: after, plan: await explain(after) },
      speedup: baselineTiming.medianMs! / treatmentTiming.medianMs! });
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    treatmentSourceSha256: createHash("sha256").update(await fs.readFile(fileURLToPath(new URL(`../${modulePath}`, import.meta.url)))).digest("hex"),
    changedRuntime, settings, node: process.version, setupMs, totalMs: performance.now() - startedAt, warmupsPerArm: 2, measuredSamplesPerArm: 5, results }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
