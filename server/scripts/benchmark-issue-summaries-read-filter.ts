/**
 * Local proof for the batched task-read filter of `GET /companies/:id/issues/summaries`.
 *
 * The route reads up to 50 task summaries and then decides, task by task,
 * whether the actor may read each one. The pre-fix route asked for one
 * authorization decision per task at the same time, so a request for N tasks
 * sent N task-row reads and N copies of the >1 KB task-privacy statement (plus
 * N membership reads for a cloud tenant user) on every pool connection at
 * once. The fix asks for all decisions in one batched authorization read.
 *
 * The pre-fix route module is loaded from --baseline-ref and mounted beside
 * the working tree's route on the same database. The script fails unless both
 * return the same summaries for every actor.
 *
 *   pnpm --filter @paperclipai/server exec tsx scripts/benchmark-issue-summaries-read-filter.ts --baseline-ref=<pre-fix commit>
 *
 * Optional sizes: IDS (default 50, the route maximum), NOISE_ISSUES (5000),
 * POOL (10), REQUESTS (40), CONCURRENT (8), WAVES (10).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../../packages/db/src/index.js";
import { ISSUE_SUMMARIES_MAX_IDS } from "../../packages/shared/src/index.js";
import { errorHandler } from "../src/middleware/index.js";
import { issueRoutes } from "../src/routes/issues.js";
import type { AuthorizationActor } from "../src/services/authorization.js";
import {
  seedIssueReadVisibilityFixture, type IssueReadVisibilityActorName,
} from "../src/__tests__/helpers/issue-read-visibility-fixture.js";

const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const IDS = size("IDS", ISSUE_SUMMARIES_MAX_IDS), NOISE_ISSUES = size("NOISE_ISSUES", 5_000), POOL = size("POOL", 10);
const REQUESTS = size("REQUESTS", 40), CONCURRENT = size("CONCURRENT", 8), WAVES = size("WAVES", 10);
for (const [name, value] of Object.entries({ IDS, NOISE_ISSUES, POOL, REQUESTS, CONCURRENT, WAVES })) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}
assert.ok(IDS <= ISSUE_SUMMARIES_MAX_IDS, `IDS must be at most ${ISSUE_SUMMARIES_MAX_IDS}`);
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-fix --baseline-ref=<commit>");
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const routeFile = "server/src/routes/issues.ts";
/** The actors measured: a cloud tenant person, a self-hosted person, agent runs and a low-trust agent. */
const ACTORS = [
  "cloud tenant owner", "board operator", "agent run for operator", "agent authorized by operator",
  "low-trust agent bounded to a subtree",
] as const satisfies readonly IssueReadVisibilityActorName[];
type Arm = "baseline" | "treatment";

process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
const servers: Array<{ close: () => void }> = [];
try {
  // A pre-fix copy of the route module. Its relative imports resolve to the
  // current tree. The fix also touches the authorization service, but only
  // inside a batched read, which the pre-fix route never asks for.
  baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.issue-summaries-baseline-"));
  const resolveImport = (specifier: string) => JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, routeFile)))));
  const source = git("show", `${baselineRevision}:${routeFile}`)
    .replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => `from ${resolveImport(specifier)}`)
    .replace(/import\("(\.{1,2}\/[^"]+)"\)/g, (_match, specifier: string) => `import(${resolveImport(specifier)})`);
  await fs.writeFile(path.join(baselineDir, "issues.ts"), source);
  const baselineRoutes = (await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as
    { issueRoutes: typeof issueRoutes }).issueRoutes;
  const routes: Record<Arm, typeof issueRoutes> = { baseline: baselineRoutes, treatment: issueRoutes };

  temporary = await startEmbeddedPostgresTestDatabase("issue-summaries-benchmark-");
  db = createDb(temporary.connectionString, { maxConnections: POOL });
  const sql = db.$client;
  const loadStart = performance.now();
  const f = await seedIssueReadVisibilityFixture(db, { publicCount: Math.max(IDS, 8) });
  // The rest of the company's task history, a third of it private to other people.
  await sql.unsafe(`insert into issues (id, company_id, title, status, visibility, privacy_root_issue_id, created_by_user_id)
    select id, $1::uuid, 'History ' || n, 'done', case when n % 3 = 0 then 'private' else 'open' end,
      case when n % 3 = 0 then id end, $3
    from (select gen_random_uuid() id, n from generate_series(1, $2::int) n) history`,
  [f.companyId, NOISE_ISSUES, f.strangerUserId]);
  await sql.unsafe("vacuum analyze");
  const loadMs = performance.now() - loadStart;

  // What one screen asks for: mostly open tasks, private tasks the actor may and
  // may not read (roots and descendants), a blocked task, and IDs of another
  // company and of nothing, which must be omitted.
  const special = [
    ...f.ownedPrivateIds, ...f.grantedPrivateIds, ...f.assignedPrivateIds, ...f.unreadablePrivateIds,
    ...f.privateProjectIssueIds, ...f.blockedIds, ...f.foreignIds, ...f.missingIds,
  ].slice(0, Math.floor(IDS / 2));
  const ids = [...special, ...f.publicIds].slice(0, IDS);
  assert.equal(new Set(ids).size, IDS);

  // One HTTP server per arm and actor; the handler time is taken inside the process.
  const handlerMs: number[] = [];
  async function listen(arm: Arm, actor: AuthorizationActor, target: Db) {
    const app = express();
    app.use((req, res, next) => {
      const start = performance.now();
      res.on("finish", () => handlerMs.push(performance.now() - start));
      req.actor = { ...actor } as Express.Request["actor"];
      next();
    });
    app.use("/api", routes[arm](target, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${f.companyId}/issues/summaries?ids=${ids.join(",")}`;
    return async () => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      return await response.json() as Array<{ id: string }>;
    };
  }
  const statements: string[] = [];
  const recorded = drizzle(sql, { schema: db._.fullSchema, logger: { logQuery: query => statements.push(query) } }) as unknown as Db;

  const round = (value: number) => Number(value.toFixed(2));
  const stats = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { medianMs: round(sorted[Math.floor(sorted.length / 2)]!), p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
      maxMs: round(sorted.at(-1)!) };
  };
  /** Main-thread and process CPU spent while `run` executes. */
  async function measure(run: () => Promise<unknown>) {
    const loop = performance.eventLoopUtilization(), cpu = process.cpuUsage(), start = performance.now();
    handlerMs.length = 0;
    await run();
    const used = process.cpuUsage(cpu), busy = performance.eventLoopUtilization(loop);
    return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, mainThreadMs: busy.active, handlerMs: [...handlerMs] };
  }

  const report: Record<string, unknown> = {};
  for (const name of ACTORS) {
    const actor = f.actors[name];
    const request = { baseline: await listen("baseline", actor, db), treatment: await listen("treatment", actor, db) };
    const counted = { baseline: await listen("baseline", actor, recorded), treatment: await listen("treatment", actor, recorded) };
    const bodies = { baseline: await request.baseline(), treatment: await request.treatment() };
    assert.deepEqual(bodies.treatment, bodies.baseline, `${name}: both versions must return the same summaries`);
    const returned = new Set(bodies.baseline.map(row => row.id));
    for (const id of [...f.unreadablePrivateIds, ...f.foreignIds, ...f.missingIds]) assert.ok(!returned.has(id), `${name}: ${id} must be omitted`);
    assert.ok(returned.size > 0 && returned.size < IDS, `${name}: the request must mix readable and unreadable tasks`);

    const perArm: Record<Arm, Record<string, unknown>> = { baseline: {}, treatment: {} };
    for (const arm of ["baseline", "treatment"] as const) {
      statements.length = 0;
      await counted[arm]();
      const privacy = statements.filter(statement => /^select "id" from "issues" where \("issues"\."id" = \$1 and "issues"\."company_id" = \$2 and \(*exists/.test(statement));
      perArm[arm].statementsPerRequest = statements.length;
      perArm[arm].perTaskPrivacyStatements = privacy.length;
      perArm[arm].statementBytesPerRequest = statements.reduce((sum, statement) => sum + Buffer.byteLength(statement), 0);
    }
    for (const arm of ["baseline", "treatment"] as const) for (let warm = 0; warm < 5; warm++) await request[arm]();
    const samples: Record<Arm, { handler: number[]; cpu: number[]; main: number[]; wave: number[]; waveHandler: number[]; waveCpu: number[] }> = {
      baseline: { handler: [], cpu: [], main: [], wave: [], waveHandler: [], waveCpu: [] },
      treatment: { handler: [], cpu: [], main: [], wave: [], waveHandler: [], waveCpu: [] },
    };
    const blocks = 4, perBlock = Math.ceil(REQUESTS / blocks);
    for (let block = 0; block < blocks; block++) {
      for (const arm of (block % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"]) as Arm[]) {
        const result = await measure(async () => { for (let index = 0; index < perBlock; index++) await request[arm](); });
        samples[arm].handler.push(...result.handlerMs);
        samples[arm].cpu.push(result.cpuMs / perBlock);
        samples[arm].main.push(result.mainThreadMs / perBlock);
      }
    }
    for (let wave = 0; wave < WAVES; wave++) {
      for (const arm of (wave % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"]) as Arm[]) {
        const result = await measure(() => Promise.all(Array.from({ length: CONCURRENT }, () => request[arm]())));
        samples[arm].wave.push(result.wallMs);
        samples[arm].waveHandler.push(...result.handlerMs);
        samples[arm].waveCpu.push(result.cpuMs / CONCURRENT);
      }
    }
    const mean = (values: number[]) => round(values.reduce((sum, value) => sum + value, 0) / values.length);
    for (const arm of ["baseline", "treatment"] as const) {
      Object.assign(perArm[arm], {
        oneAtATime: { serverTime: stats(samples[arm].handler), processCpuMsPerRequest: mean(samples[arm].cpu),
          mainThreadBusyMsPerRequest: mean(samples[arm].main) },
        concurrent: { serverTime: stats(samples[arm].waveHandler), waveWallTime: stats(samples[arm].wave),
          processCpuMsPerRequest: mean(samples[arm].waveCpu) },
      });
    }
    report[name] = { summariesReturned: returned.size, idsRequested: IDS, ...perArm };
  }

  console.log(JSON.stringify({
    baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDirty: git("status", "--porcelain", "--", routeFile, "server/src/services").trim().length > 0,
    postgresVersion: (await sql.unsafe("select version()"))[0]!.version, node: process.version,
    fixture: { synthetic: true, idsPerRequest: IDS, companyTasks: f.companyIssueIds.length + NOISE_ISSUES, pool: POOL,
      requestsPerArm: REQUESTS, concurrentRequests: CONCURRENT, waves: WAVES, loadMs: Math.round(loadMs) },
    correctness: { sameSummariesForEveryActor: true },
    results: report,
  }, null, 2));
} finally {
  try {
    for (const server of servers) server.close();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
