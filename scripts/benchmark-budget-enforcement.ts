import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, budgetPolicies, companies, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";

const { eq } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm");

const ref = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(ref, "Pass --baseline-ref=<verified pre-fix commit>");
const baselineRevision = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
const baselineOnly = process.argv.includes("--baseline-only");
const sampleCount = 20;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await fs.mkdtemp(path.join(root, "server/scripts/.budget-baseline-"));
const files = ["server/src/services/budgets.ts", "server/src/services/budget-reservations.ts", "server/src/services/agent-lifecycle.ts", "server/src/services/accounting-transaction.ts",
  ...execFileSync("git", ["ls-tree", "-r", "--name-only", baselineRevision, "server/src/modules/agent-lifecycle", "server/src/modules/run-dispatch"], { encoding: "utf8" })
    .trim().split("\n").filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("/__tests__/"))];
const frozen = new Map(files.map(file => [path.join(root, file).replace(/\.ts$/, ".js"), path.join(directory, file)]));
for (const file of files) {
  const origin = path.join(root, file);
  const source = execFileSync("git", ["show", `${baselineRevision}:${file}`], { encoding: "utf8" });
  const rewritten = source.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g, (_match, prefix: string, quote: string, specifier: string) => {
    const absolute = path.resolve(path.dirname(origin), specifier);
    return `${prefix}${quote}${frozen.get(absolute) ?? absolute}${quote}`;
  });
  const target = path.join(directory, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, rewritten);
}
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  const before = await import(pathToFileURL(path.join(directory, "server/src/services/budgets.ts")).href);
  const after = baselineOnly ? null : await import("../server/src/services/budgets.js");
  const beforeReservations = await import(pathToFileURL(path.join(directory, "server/src/services/budget-reservations.ts")).href);
  const beforeDispatch = await import(pathToFileURL(path.join(directory, "server/src/modules/run-dispatch/adapters/postgres.ts")).href);
  const afterReservations = baselineOnly ? null : await import("../server/src/services/budget-reservations.js");
  const afterDispatch = baselineOnly ? null : await import("../server/src/modules/run-dispatch/adapters/postgres.js");
  database = await startEmbeddedPostgresTestDatabase("budget-enforcement-benchmark-");
  db = createDb(database.connectionString);
  // Instrument this disposable client's Drizzle sessions. Transaction sessions
  // inherit options.logger; no runtime client or production setting changes.
  let captured: Array<{ sql: string; params: unknown[] }> | null = null;
  let capturedTransactions = 0;
  const transaction = db.transaction.bind(db);
  db.transaction = ((...args: Parameters<Db["transaction"]>) => {
    if (captured) capturedTransactions++;
    return transaction(...args);
  }) as Db["transaction"];
  const session = Reflect.get(db, "session");
  const logger = { logQuery(query: string, params: unknown[]) { captured?.push({ sql: query, params }); } };
  session.logger = logger;
  session.options.logger = logger;
  const [version] = await db.$client.unsafe("select version()");
  const results = [];
  const admissionResults = [];
  let expectedTreatmentCounts: string | undefined;
  for (const count of [0, 17, 1000]) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic budget benchmark", issuePrefix: `B${companyId.slice(0, 7).replaceAll("-", "")}` });
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1_000_000, notifyEnabled: false });
    if (count) await db.$client.unsafe(`insert into agents (company_id,name,role,status,adapter_type,lifecycle_state)
      select $1::uuid, 'Idle fixture ' || n, 'engineer', 'idle', 'process', 'ready' from generate_series(1,$2::int) n`, [companyId, count]);
    await db.$client.unsafe("analyze agents");
    const measured = [];
    const entries = [["baseline", before], ["treatment", after]] as const;
    for (const [name, service] of process.argv.includes("--reverse") ? [...entries].reverse() : entries) {
      if (!service) continue;
      const samples = [];
      for (let i = 0; i < sampleCount + 2; i++) {
        const start = performance.now();
        // Real budget cost-evaluation service boundary: before this change,
        // even a charge below its limit reconciled all idle agents.
        await service.budgetService(db).evaluateCostEvent({ companyId, agentId: null, projectId: null });
        const elapsed = performance.now() - start;
        if (i >= 2) samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      captured = [];
      await service.budgetService(db).evaluateCostEvent({ companyId, agentId: null, projectId: null });
      const queries = captured;
      captured = null;
      const agentReads = queries.filter(query => /\bfrom "agents"/.test(query.sql)).length;
      const accountingLocks = queries.filter(query => query.sql.includes("for no key update")).length;
      if (name === "treatment") {
        assert.equal(agentReads, 0, "Ordinary evaluation must not read any agents");
        assert.equal(accountingLocks, 1, "Only the charge's accounting transaction may run");
      }
      const candidate = queries.find(query => name === "baseline" ? /\bfrom "agents"/.test(query.sql) : /\bfrom "budget_policies"/.test(query.sql));
      const plan = candidate ? await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate.sql}`, candidate.params as never[]) : null;
      measured.push({ name, samplesMs: samples, medianMs: samples[Math.floor(sampleCount / 2)],
        p95Ms: samples[Math.ceil(sampleCount * 0.95) - 1],
        drizzleStatementCount: queries.length, accountingTransactions: accountingLocks, agentReads,
        candidateQuery: candidate, candidatePlan: plan });
    }
    const persisted = await db.$client.unsafe("select lifecycle_state, lifecycle_holds, status from agents where company_id = $1::uuid", [companyId]);
    assert.equal(persisted.length, count);
    assert.ok(persisted.every(agent => agent.lifecycle_state === "ready" && agent.lifecycle_holds.length === 0 && agent.status === "idle"));
    results.push({ unrelatedIdleAgents: count, contractPreserved: true, measured });
    // Keep exactly one admitted operation and one responsible agent at every
    // headcount. Fixture writes and cleanup are outside the timed boundary.
    const agentId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Responsible fixture", role: "engineer",
      status: "idle", adapterType: "process", lifecycleState: "ready", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Offline dispatch fixture", status: "in_progress", assigneeAgentId: agentId });
    await db.update(budgetPolicies).set({ reservationCents: "100" }).where(eq(budgetPolicies.companyId, companyId));
    const admissionMeasured = [];
    const admissionEntries = [["baseline", beforeReservations, beforeDispatch], ["treatment", afterReservations, afterDispatch]] as const;
    for (const [name, reservations, dispatch] of process.argv.includes("--reverse") ? [...admissionEntries].reverse() : admissionEntries) {
      if (!reservations || !dispatch) continue;
      const adapter = dispatch.createPostgresRunDispatchAdapter(db);
      const samples = [];
      let queries: Array<{ sql: string; params: unknown[] }> = [], databaseTransactions = 0;
      for (let i = 0; i < sampleCount + 3; i++) {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
        let callbacks = 0;
        const probe = i === sampleCount + 2;
        if (probe) { captured = []; capturedTransactions = 0; }
        const start = performance.now();
        try {
          const reservation = await reservations.reserveRunBudget(db, companyId, runId, null);
          const outcome = await adapter.dispatchResolvedInteractionIfCurrent({ companyId, runId,
            reservationId: reservation.id, expectedStatus: "running", now: new Date(),
            dispatch: async () => { callbacks++; return "offline-provider-result"; } });
          assert.equal(outcome.dispatched, true, `${name}: current admitted run must dispatch`);
          if (outcome.dispatched) assert.equal(await outcome.resultPromise, "offline-provider-result");
          const elapsed = performance.now() - start;
          assert.equal(callbacks, 1, "Each admitted fixture calls the provider exactly once");
          if (probe) { queries = captured!; databaseTransactions = capturedTransactions; }
          else if (i >= 2) samples.push(elapsed);
        } finally {
          captured = null;
          await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        }
      }
      samples.sort((a, b) => a - b);
      const agentQueries = queries.filter(query => /\b(?:from|join) "agents"/.test(query.sql));
      const unrelatedAgentReadStatements = agentQueries.filter(query => !query.params.includes(agentId)).length;
      const accountingTransactions = queries.filter(query => query.sql.includes("for no key update")).length;
      const p95Ms = samples[Math.ceil(sampleCount * 0.95) - 1];
      if (name === "treatment") {
        assert.equal(unrelatedAgentReadStatements, 0, "Agent reads must be bound to the responsible agent");
        const counts = JSON.stringify([queries.length, databaseTransactions, accountingTransactions, agentQueries.length]);
        expectedTreatmentCounts ??= counts;
        assert.equal(counts, expectedTreatmentCounts, "Admission query and transaction counts must not grow with idle agents");
        assert.ok(p95Ms < 250, `Warm admission p95 ${p95Ms}ms exceeds 250ms`);
      }
      admissionMeasured.push({ name, samplesMs: samples, medianMs: samples[Math.floor(sampleCount / 2)], p95Ms,
        drizzleStatementCount: queries.length, databaseTransactions, accountingTransactions, agentReads: agentQueries.length,
        unrelatedAgentReadStatements, providerCallsPerSample: 1 });
    }
    const [remaining] = await db.$client.unsafe(`select (select count(*) from heartbeat_runs where company_id=$1::uuid) runs,
      (select count(*) from budget_reservations where company_id=$1::uuid) reservations`, [companyId]);
    assert.equal(Number(remaining.runs), 0); assert.equal(Number(remaining.reservations), 0);
    const unchanged = await db.$client.unsafe("select lifecycle_state, lifecycle_holds, status from agents where company_id=$1::uuid", [companyId]);
    assert.equal(unchanged.length, count + 1);
    assert.ok(unchanged.every(agent => agent.lifecycle_state === "ready" && agent.lifecycle_holds.length === 0 && agent.status === "idle"));
    admissionResults.push({ unrelatedIdleAgents: count, responsibleAgents: 1, activeRuns: 1, contractPreserved: true, measured: admissionMeasured });
    console.error(`Budget benchmark: ${count} idle agents, cost evaluation and admission complete`);
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    note: "Local service timings against disposable real PostgreSQL; no provider/network latency. Treatment may include uncommitted source changes.",
    policiesPerCompany: 1, activeRuns: 0, node: process.version, nodeArchitecture: process.arch,
    postgres: version, results, admissionResults }, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(directory, { recursive: true, force: true });
  clearInterval(keepAlive);
}
