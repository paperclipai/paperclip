import { budgetService } from "../src/services/budgets.js";
import { sql } from "drizzle-orm";
/** Reproducible synthetic PostgreSQL benchmark. Never reads DATABASE_URL or
 * provider credentials; startEmbeddedPostgresTestDatabase owns all data. */
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agents, companies, projects, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { costService } from "../src/services/costs.js";
import { withAccountingTransaction } from "../src/services/accounting-transaction.js";
import { accountingIntegrityService } from "../src/services/accounting-integrity.js";
import { reconcileRunCosts } from "../src/services/run-cost-accounting.js";
const count = Number(process.env.PAPERCLIP_ACCOUNTING_BENCH_ROWS ?? 1_000_000);
if (!Number.isInteger(count) || count < 1000 || count > 10_000_000) throw new Error("Benchmark row count must be 1,000–10,000,000");
const database = await startEmbeddedPostgresTestDatabase("accounting-scale-");
const db = createDb(database.connectionString);
const started = performance.now();
function distribution(values: number[]) {
  const sorted = [...values].sort((a,b) => a-b);
  const pick = (p: number) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2));
  return { samples: sorted.length, p50Ms: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99), maxMs: pick(1) };
}
async function time(work: () => Promise<unknown>) { const start = performance.now(); await work(); return performance.now() - start; }
try {
  const [company] = await db.insert(companies).values({ name: "Scale fixture", issuePrefix: "SCALE" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Hot project" }).returning();
  const seedMs = await time(async () => {
    await db.$client`insert into cost_events (company_id,agent_id,project_id,provider,biller,model,cost_cents,input_tokens,cached_input_tokens,output_tokens,occurred_at)
      select ${company.id},${agent.id}, case when i % 100 = 0 then ${project.id}::uuid else null end, 'fixture','fixture','fixture', 0.1234567,7,11,3,
        date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' - (i % 12) * interval '1 month'
      from generate_series(1,${count}) i`;
    await db.$client`analyze cost_events`;
    // Seed projections through an explicit reviewed repair, not benchmark-only SQL.
    const integrity = accountingIntegrityService(db); const review = await integrity.inspect(company.id);
    await integrity.repair(company.id, review.fingerprint, "Initialize synthetic benchmark projections", "benchmark");
  });
  const reports: number[] = [], projectReports: number[] = [];
  for (let i = 0; i < 20; i++) {
    reports.push(await time(() => costService(db).summary(company.id, { allTime: true })));
    projectReports.push(await time(() => costService(db).byProject(company.id, { allTime: true })));
  }
  const writes: number[] = []; const concurrency = 8; const writeStarted = performance.now();
  for (let batch = 0; batch < 8; batch++) await Promise.all(Array.from({ length: concurrency }, (_, index) => time(() => costService(db).createEvent(company.id, {
    agentId: agent.id, provider: "fixture", model: "fixture", costCents: "0.0000001", idempotencyKey: `bench:${batch}:${index}`, occurredAt: new Date(),
  })).then(ms => writes.push(ms))));
  const writeMs = performance.now() - writeStarted;
  await budgetService(db).upsertPolicy(company.id, { scopeType: "company", scopeId: company.id, amount: 2_000_000_000 }, "benchmark");
  await budgetService(db).upsertPolicy(company.id, { scopeType: "agent", scopeId: agent.id, amount: 2_000_000_000 }, "benchmark");
  const budgetedWrites: number[] = [];
  const budgetedStart = performance.now();
  for (let batch = 0; batch < 4; batch++) await Promise.all(Array.from({ length: concurrency }, (_, index) => time(() => costService(db).createEvent(company.id, {
    agentId: agent.id, provider: "fixture", model: "fixture", costCents: "0.0000001", idempotencyKey: `budgeted:${batch}:${index}`, occurredAt: new Date(),
  })).then(ms => budgetedWrites.push(ms))));
  const budgetedMs = performance.now() - budgetedStart;
  const waits: number[] = [];
  await Promise.all(Array.from({ length: concurrency }, () => {
    const start = performance.now();
    return withAccountingTransaction(db, company.id, async tx => { waits.push(performance.now() - start); await tx.execute(sql`select pg_sleep(0.005)`); });
  }));
  await db.$client`insert into heartbeat_runs (company_id,agent_id,status,cost_accounting_pending,usage_json,finished_at)
    select ${company.id},${agent.id},'failed',true,'{"accountingReceiptReady":true,"costUsdExact":"0.000000001","inputTokens":1}'::jsonb, now() from generate_series(1,250)`;
  const recovery: Array<{ milliseconds: number; scanned: number; accounted: number }> = [];
  for (let i = 0; i < 3; i++) {
    const before = performance.now(); const result = await reconcileRunCosts(db); recovery.push({ milliseconds: performance.now()-before, ...result });
  }
  if (recovery.reduce((sum, r) => sum+r.accounted,0) !== 250) throw new Error("Benchmark recovery did not conserve receipt count");
  const integrity = await accountingIntegrityService(db).inspect(company.id);
  if (integrity.findings.length) throw new Error(`Benchmark violated accounting integrity: ${JSON.stringify(integrity.findings)}`);
  const plan = await db.$client`explain (analyze,buffers,format json) select sum(cost_cents) from cost_events where company_id = ${company.id} and project_id = ${project.id}
    and occurred_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'`;
  const report = { generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, node: process.version,
    seedRows: count, seedMs, concurrency, allTimeSummary: distribution(reports), allTimeProjects: distribution(projectReports),
    hotCompanyWrites: { activePolicies: 0, ...distribution(writes), writesPerSecond: writes.length / (writeMs / 1000) }, companyLockAcquisition: distribution(waits),
    budgetedCompanyWrites: { activePolicies: 2, ...distribution(budgetedWrites), writesPerSecond: budgetedWrites.length / (budgetedMs / 1000) },
    recovery, projectBudgetQueryPlan: plan, integrityFindings: integrity.findings.length, totalMs: performance.now()-started };
  const output = path.resolve("coverage/accounting/scale.json"); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify({ ...report, projectBudgetQueryPlan: "see coverage/accounting/scale.json" },null,2)+"\n");
} finally { await db.$client.end(); await database.cleanup(); }
