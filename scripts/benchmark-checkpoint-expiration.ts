// Synthetic local PostgreSQL startup cleanup; never connect to a serving instance.
// node --import ./server/node_modules/tsx/dist/loader.mjs scripts/benchmark-checkpoint-expiration.ts --baseline-ref=<pre-fix SHA>
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as schema from "../packages/db/src/index.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture, withDatabaseOperation } from "../packages/db/src/response-capture.js";
import { startRecoveryPostgres } from "../server/src/__tests__/helpers/recovery-postgres.js";
// Use source entry points, as the server Vitest configuration does. No runner build is needed.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@paperclipai/paperclip-runner") return nextResolve(new URL("../packages/paperclip-runner/src/index.ts", import.meta.url).href, context);
  if (specifier === "@paperclipai/paperclip-runner/live") return nextResolve(new URL("../packages/paperclip-runner/src/live/index.ts", import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { nativeHarnessBackupExpirationService } = await import("../server/src/services/native-runtime/native-harness-backup-expiration.js");

const root = fileURLToPath(new URL("../", import.meta.url));
const ref = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(ref, "Supply --baseline-ref=<pre-fix commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/native-runtime/native-harness-backup-expiration.ts";
const moduleUrl = new URL(`../${modulePath}`, import.meta.url);
const tempDir = await fs.mkdtemp(path.join(root, "server/scripts/.checkpoint-expiration-baseline-"));
const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
await fs.writeFile(path.join(tempDir, "baseline.ts"), source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
  (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
const baseline = (await import(pathToFileURL(path.join(tempDir, "baseline.ts")).href)).nativeHarnessBackupExpirationService as typeof nativeHarnessBackupExpirationService;
const probePath = path.join(tempDir, "probe.cjs");
await fs.writeFile(probePath, `
let timer, next, pending = 0, stopped = false;
const samples = [], lateness = [];
const finish = () => { if (stopped && !pending) { process.send({ samples, lateness }); process.disconnect(); } };
process.on('message', message => {
  if (message.kind === 'start') {
    next = performance.now() + 5;
    timer = setInterval(async () => {
      const due = next; next += 5; const sent = performance.now(); pending++;
      lateness.push(sent - due);
      try { const r = await fetch(message.url); if (r.status !== 200 || await r.text() !== 'ok') throw Error('probe failed');
        samples.push(performance.now() - due); }
      catch (error) { process.send({ error: String(error) }); }
      finally { pending--; finish(); }
    }, 5);
    process.send({ started: true });
  } else { clearInterval(timer); stopped = true; finish(); }
});
process.send({ ready: true });
`);
const keepAlive = setInterval(() => {}, 1000);
let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>> | undefined;
let db: ReturnType<typeof schema.createDb> | undefined;
let foregroundDb: ReturnType<typeof schema.createDb> | undefined;
const server = createServer(async (_request, response) => {
  try { await foregroundDb!.$client.unsafe("select 1"); response.end("ok"); }
  catch { response.statusCode = 500; response.end("failed"); }
});
try {
  temporary = await startRecoveryPostgres("checkpoint-expiration-benchmark-");
  db = schema.createDb(temporary.connectionString);
  foregroundDb = schema.createDb(temporary.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), now = new Date("2026-11-02T12:00:00Z");
  const old = new Date(now.getTime() - 10 * 86400000);
  await db.insert(schema.companies).values({ id: companyId, name: "Synthetic expiration", issuePrefix: "EXP" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Synthetic" });
  const entries = Array.from({ length: 800 }, (_, i) => ({ i, issueId: randomUUID(), runId: randomUUID(), sessionId: randomUUID() }));
  await db.insert(schema.issues).values(entries.map(e => ({ id: e.issueId, companyId, title: "Synthetic",
    status: e.i < 240 ? "in_progress" : "done", completedAt: e.i >= 240 && e.i < 480 ? now : old })));
  await db.insert(schema.heartbeatRuns).values(entries.map(e => ({ id: e.runId, companyId, agentId,
    issueId: e.issueId, nativeIssueId: e.issueId, nativeSessionId: e.sessionId, status: "succeeded", finishedAt: old,
    runnerProfileJson: e.i >= 720 && e.i % 8 === 6
      ? { nativeControllerRecovery: { schema: "paperclip.native-controller-recovery.v1", checkpoint: null } } : null })));
  await db.insert(schema.nativeRunFinalizations).values(entries.map(e => ({ runId: e.runId, companyId,
    issueId: e.issueId, phase: e.i >= 720 && e.i % 8 === 7 ? "pending" : "committed" })));
  for (const e of entries.slice(480, 720)) await db.update(schema.issues).set({ executionRunId: e.runId }).where(schemaEq(schema.issues.id, e.issueId));
  await db.insert(schema.environmentLeases).values(entries.filter(e => e.i >= 720 && e.i % 8 === 2)
    .map(e => ({ companyId, issueId: e.issueId, status: "retained" })));
  await db.insert(schema.agentTaskSessions).values(entries.filter(e => e.i >= 720 && e.i % 8 === 3)
    .map(e => ({ companyId, agentId, adapterType: "paperclip_runner", taskKey: e.issueId, lastRunId: e.runId, sessionParamsJson: { sessionId: e.sessionId } })));
  for (const e of entries.filter(e => e.i >= 720 && [4, 5].includes(e.i % 8))) {
    const issueId = randomUUID();
    await db.insert(schema.issues).values({ id: issueId, companyId, title: "Other session issue", status: e.i % 8 === 4 ? "in_progress" : "done", completedAt: old });
    await db.insert(schema.heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId,
      nativeSessionId: e.sessionId, status: e.i % 8 === 5 ? "running" : "succeeded", finishedAt: e.i % 8 === 5 ? null : old });
  }
  const parts = entries.flatMap(e => ["header", "event:1"].map(part => ({ companyId, issueId: e.issueId, runId: e.runId, part,
    material: { synthetic: true, payload: part === "header" ? "header" : "x".repeat(4096) } })));
  const reset = async () => {
    await db!.delete(schema.nativeRunnerCheckpoints);
    for (let i = 0; i < parts.length; i += 200) await db!.insert(schema.nativeRunnerCheckpoints).values(parts.slice(i, i + 200));
    await db!.update(schema.nativeRunFinalizations).set({ controllerGeneration: 0 });
  };
  await reset(); await db.$client.unsafe("ANALYZE");
  async function run(factory: typeof baseline, handle = db!) {
    const service = factory(handle, { now, maxEntries: 200, maxRemovals: 50 });
    let removed = 0, passes = 0;
    while (true) {
      const result = await service.tickCheckpoints();
      assert.equal(result.failed, 0); removed += result.expiredCheckpoints; passes++;
      assert.ok(passes < 20, "Startup pass must finish");
      if (!result.truncated) return { removed, passes };
    }
  }
  async function output() {
    return { checkpoints: await db!.$client.unsafe("select run_id, part from native_runner_checkpoints order by run_id, part"),
      generations: await db!.$client.unsafe("select run_id, controller_generation from native_run_finalizations order by run_id") };
  }
  async function counted(factory: typeof baseline) {
    await reset();
    const handle = schema.createDb(temporary!.connectionString), events: Record<string, unknown>[] = [];
    const start = Date.now(), capture = createDatabaseResponseCapture({ start, end: start + 60000 }, event => events.push(event));
    installDatabaseResponseCapture(handle, schema, capture);
    try {
      const result = await withDatabaseOperation("benchmark.checkpoint_expiration", () => run(factory, handle));
      capture.flush();
      const summary = events.find(e => e.event === "paperclip.db_response_capture.summary.v2")!;
      assert.equal(summary.inFlightAtEnd, 0); assert.equal(summary.overflowCalls, 0);
      return { result, queries: summary.completedQueries, rows: summary.rows, state: await output() };
    } finally { capture.flush(); await handle.$client.end(); }
  }
  const before = await counted(baseline), after = await counted(nativeHarnessBackupExpirationService);
  assert.deepEqual(after.state, before.state, "Retained checkpoints and writer generations must match exactly");
  assert.equal(before.result.removed, 20);
  assert.ok(Number(after.queries) < Number(before.queries) * 0.3);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const samples = { baseline: [] as Record<string, unknown>[], treatment: [] as Record<string, unknown>[] };
  async function timed(factory: typeof baseline, probe: boolean) {
    await reset();
    const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
    await new Promise(resolve => setTimeout(resolve, 5));
    let child: ReturnType<typeof fork> | undefined;
    const message = () => new Promise<any>((resolve, reject) => {
      child!.once("message", value => value && typeof value === "object" && "error" in value ? reject(new Error(String(value.error))) : resolve(value));
      child!.once("error", reject);
    });
    if (probe) {
      child = fork(probePath, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      assert.ok((await message()).ready);
      const started = message(); child.send({ kind: "start", url }); assert.ok((await started).started);
    }
    const cpu = process.cpuUsage(), start = performance.now();
    const result = await run(factory);
    const wallMs = performance.now() - start, usage = process.cpuUsage(cpu);
    let responses: number[] = [], lateness: number[] = [];
    if (child) { const finished = message(); child.send({ kind: "stop" }); ({ samples: responses, lateness } = await finished); }
    delay.disable();
    const sorted = [...responses].sort((a, b) => a - b);
    return { ...result, wallMs, nodeCpuMs: (usage.user + usage.system) / 1000,
      eventLoopDelayMaxMs: delay.max / 1e6, foregroundResponses: responses.length, foregroundGeneratorMaxLatenessMs: lateness.length ? Math.max(...lateness) : null,
      foregroundP95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null, foregroundMaxMs: sorted.at(-1) ?? null };
  }
  for (let i = 0; i < 7; i++) {
    for (const version of i % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
      const sample = await timed(version === "baseline" ? baseline : nativeHarnessBackupExpirationService, false);
      if (i >= 2) samples[version].push(sample);
    }
  }
  const foreground = { baseline: await timed(baseline, true), treatment: await timed(nativeHarnessBackupExpirationService, true) };
  const { state: _beforeState, ...countsBefore } = before, { state: _afterState, ...countsAfter } = after;
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", modulePath], { encoding: "utf8" }),
    nodeVersion: process.version, postgresVersion: (await db.$client.unsafe("select version()"))[0]!.version,
    fixture: { checkpoints: 800, parts: 1600, obviouslyBlockedIssues: 720, deletableSessions: 20,
      otherBlockers: ["lease", "resume", "other open issue", "other live run", "incomplete recovery", "pending finalization"], synthetic: true },
    correctness: { identicalRetainedPartsAndWriterGenerations: true },
    counts: { baseline: countsBefore, treatment: countsAfter, boundary: "Drizzle result queries; excludes transaction control" },
    timings: { warmups: 2, samplesPerVersion: 5, alternating: true, samples,
      cpuBoundary: "Node process user+system CPU, excludes PostgreSQL child; no foreground probe in CPU samples" },
    foreground: { ...foreground, boundary: "Independent Node process offers HTTP request every 5ms; server runs real SELECT 1 on independent client; latency includes generator lateness", samplesPerVersion: 1 },
    limitation: "Finite startup maintenance only; this does not prove steady-state or hosted improvement. Event-loop delay measures timer delay, not a direct longest contiguous JS stack." }, null, 2));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await foregroundDb?.$client.end({ timeout: 1 }); await db?.$client.end({ timeout: 1 });
  await temporary?.cleanup(); await fs.rm(tempDir, { recursive: true, force: true }); clearInterval(keepAlive);
}

// Import kept outside schema: it is a query operator, not a database export.
import { eq as schemaEq } from "../server/node_modules/drizzle-orm/index.js";
