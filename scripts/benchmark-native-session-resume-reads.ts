import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { findNativeSessionResumeRun } from "../server/src/services/native-runtime/native-session-resume.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";

type Query = { sql: string; params: unknown[] };
const root = fileURLToPath(new URL("../", import.meta.url));
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const sourcePath = "server/src/services/native-runtime/native-session-resume.ts";
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const treatmentDiff = execFileSync("git", ["diff", "HEAD", "--", sourcePath], { cwd: root, encoding: "utf8" });
const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_SESSION_RESUME_BENCHMARK_DATABASE_URL");
const database = externalUrl ? { connectionString: externalUrl, cleanup: async () => {} } : await startEmbeddedPostgresTestDatabase("native-session-resume-benchmark-");
const db = createDb(database.connectionString);
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.session-resume-baseline-"));
const companyIds: string[] = [];
try {
  if (externalUrl) await applyPendingMigrations(externalUrl);
  const moduleUrl = new URL(`../${sourcePath}`, import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:${sourcePath}`], { cwd: root, encoding: "utf8" });
  await fs.writeFile(path.join(baselineDir, "resume.ts"), source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
  const baseline = await import(pathToFileURL(path.join(baselineDir, "resume.ts")).href) as { findNativeSessionResumeRun: typeof findNativeSessionResumeRun };
  async function capture(invoke: typeof findNativeSessionResumeRun, input: Parameters<typeof findNativeSessionResumeRun>[1]) {
    const queries: Query[] = [];
    const wrap = (target: Db): Db => new Proxy(target, { get(target, key) {
      if (key === "with") return (...args: Parameters<Db["with"]>) => wrap(target.with(...args) as Db);
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          query.execute = async (...executeArgs: Parameters<typeof execute>) => {
            queries.push(query.toSQL());
            return execute(...executeArgs);
          };
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    return { result: await invoke(wrap(db), input), queries };
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const measurements = [];
  for (const scenario of ["wide_history", "unused_history", "small_selected"] as const) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), normalizedSessionId = randomUUID();
    companyIds.push(companyId);
    await db.insert(companies).values({ id: companyId, name: "Synthetic resume benchmark", issuePrefix: `B${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic runner", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retain canonical task" });
    const runCount = scenario === "small_selected" ? 1 : 15;
    const prompt = randomBytes(scenario === "small_selected" ? 16 : 144 * 1024).toString("base64");
    const profilePadding = randomBytes(scenario === "small_selected" ? 16 : 72 * 1024).toString("base64");
    const neededInput = { task: { title: "Prior task", description: "Canonical description", prompt: profilePadding }, runtimeContext: { instructions: "Keep complete input" } };
    const checkpoint = { sessionId: normalizedSessionId, state: randomBytes(4096).toString("base64") };
    await db.insert(heartbeatRuns).values(Array.from({ length: runCount }, (_, n) => ({
      id: randomUUID(), companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId,
      runtimeMode: "native", status: "failed", createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, n)),
      runnerProfileJson: { padding: "Unused profile metadata", nativeExecutionInput: neededInput, nativeToolContractFingerprint: "fixture",
        ...(scenario !== "unused_history" && n === 0 ? { sessionCheckpoint: checkpoint } : {}) },
      contextSnapshot: { prompt, paperclipWake: { externalChatProvider: "slack", githubReviewConfigurations: [{ key: "review" }] },
        paperclipIssue: { id: issueId, title: "Prior canonical title", description: "Prior canonical description" } },
    })));
    await db.$client.unsafe("ANALYZE heartbeat_runs");
    const input = { companyId, agentId, issueId, normalizedSessionId, currentRunId: randomUUID(), beforeCreatedAt: new Date("2026-09-09T00:00:00Z") };
    const before = await capture(baseline.findNativeSessionResumeRun, input), after = await capture(findNativeSessionResumeRun, input);
    const contract = (run: typeof after.result) => run && ({ ...run,
      runnerProfileJson: { nativeExecutionInput: run.runnerProfileJson?.nativeExecutionInput ?? null,
        nativeToolContractFingerprint: run.runnerProfileJson?.nativeToolContractFingerprint ?? null,
        sessionCheckpoint: run.runnerProfileJson?.sessionCheckpoint ?? null },
      contextSnapshot: { paperclipWake: run.contextSnapshot?.paperclipWake ?? null, paperclipIssue: run.contextSnapshot?.paperclipIssue ?? null } });
    assert.deepEqual(contract(after.result), contract(before.result));
    const variants = [before.queries, after.queries], samples: number[][] = [[], []], dataRowBytes = [0, 0], resultRows = [0, 0];
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const variant of iteration % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        let bytes = 0, count = 0;
        for (const query of variants[variant]) {
          const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
          count += rows.length;
          bytes += rows.reduce((total, row) => total + 7 + row.reduce((size: number, value: Buffer | null) => size + 4 + (value?.length ?? 0), 0), 0);
        }
        if (iteration >= 2) samples[variant].push(performance.now() - start);
        dataRowBytes[variant] = bytes; resultRows[variant] = count;
      }
    }
    const plans = [];
    for (const queries of variants) {
      const variantPlans = [];
      for (const query of queries) {
        const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
        variantPlans.push(plan["QUERY PLAN"]);
      }
      plans.push(variantPlans);
    }
    if (!process.argv.includes("--baseline-only") && scenario !== "small_selected") assert.ok(dataRowBytes[1] < dataRowBytes[0] / 10);
    measurements.push({ scenario, runCount, equalConsumerFields: true, baselineQueryCount: before.queries.length, treatmentQueryCount: after.queries.length,
      dataRowBytes, resultRows, baselineMedianMs: median(samples[0]), treatmentMedianMs: median(samples[1]), samples, queries: variants, plans });
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, treatmentDiff,
    acceptance: "Equal selected consumer fields; wide and unused histories remove at least 90% of DataRow bytes; no timing threshold",
    byteBoundary: "Exact text-format PostgreSQL DataRow frames (7 bytes framing + 4 bytes length per column + raw field bytes); excludes RowDescription, command metadata, TLS and TCP",
    postgres: await db.$client.unsafe("select version()"), measurements }, null, 2));
} finally {
  try {
    for (const companyId of companyIds) {
      await db.$client.unsafe("DELETE FROM heartbeat_runs WHERE company_id = $1::uuid", [companyId]);
      await db.$client.unsafe("DELETE FROM issues WHERE company_id = $1::uuid", [companyId]);
      await db.$client.unsafe("DELETE FROM agents WHERE company_id = $1::uuid", [companyId]);
      await db.$client.unsafe("DELETE FROM companies WHERE id = $1::uuid", [companyId]);
    }
  } finally {
    try { await db.$client.end({ timeout: 0 }); }
    finally {
      try { await database.cleanup(); }
      finally { await fs.rm(baselineDir, { recursive: true, force: true }); }
    }
  }
}
