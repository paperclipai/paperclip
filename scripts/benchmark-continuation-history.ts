import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { buildExecutionContinuation } from "../server/src/services/execution-continuation.js";
import { hasConversationContinuationPolicy } from "../server/src/services/conversation-continuation.js";
import { resolveExternalTestDatabaseUrl } from "../server/src/__tests__/helpers/external-test-database.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref");
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const baselineOnly = process.argv.includes("--baseline-only");
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDir: string | undefined;
try {
  const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CONTINUATION_HISTORY_BENCHMARK_DATABASE_URL");
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    database = { connectionString: externalUrl, cleanup: async () => {} };
  } else database = await startEmbeddedPostgresTestDatabase("continuation-history-benchmark-");
  db = createDb(database.connectionString);
  const original = new URL("../server/src/services/execution-continuation.ts", import.meta.url);
  baselineDir = await fs.mkdtemp(path.join(repoRoot, "server/scripts/.history-baseline-"));
  const source = git("show", `${baselineRevision}:server/src/services/execution-continuation.ts`);
  const baselinePath = path.join(baselineDir, "continuation.ts");
  await fs.writeFile(baselinePath, source.replace(/(from |import\()"(\.{1,2}\/[^\"]+)"/g,
    (_match, prefix: string, specifier: string) => `${prefix}${JSON.stringify(fileURLToPath(new URL(specifier, original)))}`));
  const baseline = await import(pathToFileURL(baselinePath).href) as { buildExecutionContinuation: typeof buildExecutionContinuation };
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const receipts = (value: unknown) => Object.entries(object(object(value).apiToolReceipts)).flatMap(([id, entry]) => {
    const receipt = object(entry);
    return receipt.state === "completed" && typeof receipt.operationId === "string" ? [{ id, operationId: receipt.operationId, result: receipt.result }] : [];
  });
  const results = [];
  for (const receiptHeavy of [false, true]) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic history", issuePrefix: `B${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue", status: "in_progress", assigneeAgentId: agentId });
    const runCount = receiptHeavy ? 1 : 25;
    const requiredResult = receiptHeavy ? randomBytes(1536 * 1024).toString("base64") : { receipt: "required output" };
    for (let index = 0; index < runCount; index++) await db.insert(heartbeatRuns).values({ companyId, agentId,
      contextSnapshot: { issueId }, status: "failed", errorCode: "adapter_failed", runtimeMode: "legacy",
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)),
      resultJson: { nativeResult: { output: receiptHeavy ? "small" : randomBytes(144 * 1024).toString("base64") },
        conversationContinuation: "continue_conversation_v1",
        apiToolReceipts: { saved: { state: "completed", operationId: "save_document", result: requiredResult,
          request: receiptHeavy ? "small" : randomBytes(24 * 1024).toString("base64") }, pending: { state: "started", operationId: "unfinished", result: "not a completed action" } } },
    });
    await db.$client.unsafe("ANALYZE");
    async function capture(invoke: typeof buildExecutionContinuation) {
      let query: { sql: string; params: unknown[] } | undefined;
      let history: Array<Record<string, unknown>> | undefined;
      const recorded = new Proxy(db!, { get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = target.select(...fields), from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const selection = from(...args), execute = selection.execute.bind(selection);
            if (args[0] === heartbeatRuns) selection.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const statement = selection.toSQL(), rows = await execute(...executeArgs);
              if (statement.sql.includes('order by "heartbeat_runs"."created_at" asc')) { query = statement; history = rows; }
              return rows;
            };
            return selection;
          }) as typeof builder.from;
          return builder;
        };
      }});
      const envelope = await invoke({ db: recorded, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: false });
      assert.ok(query); assert.ok(history);
      return { query, history, envelope };
    }
    const before = await capture(baseline.buildExecutionContinuation);
    const after = await capture(baselineOnly ? baseline.buildExecutionContinuation : buildExecutionContinuation);
    assert.deepEqual(after.envelope, before.envelope);
    assert.equal(after.history.length, before.history.length);
    for (let index = 0; index < before.history.length; index++) {
      const oldRow = before.history[index], newRow = after.history[index];
      for (const [key, value] of Object.entries(oldRow)) if (key !== "result") assert.deepEqual(newRow[key], value);
      assert.deepEqual(receipts(newRow.result), receipts(oldRow.result));
      assert.equal(hasConversationContinuationPolicy(newRow.result as Record<string, unknown>), hasConversationContinuationPolicy(oldRow.result as Record<string, unknown>));
    }
    const queries = [before.query, after.query], bytes: number[] = [], samples: number[][] = [[], []];
    for (let iteration = 0; iteration < 9; iteration++) for (const variant of iteration % 2 ? [1, 0] : [0, 1]) {
      const query = queries[variant], start = performance.now();
      const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
      if (iteration >= 2) samples[variant].push(performance.now() - start);
      bytes[variant] = rows.reduce((sum, row) => sum + 7 + row.reduce((n: number, value: Buffer | null) => n + 4 + (value?.length ?? 0), 0), 0);
    }
    if (!baselineOnly && !receiptHeavy) assert.ok(bytes[1] < bytes[0] / 10, "Wide unused-result fixture must remove more than 90% of DataRow bytes");
    if (receiptHeavy) {
      assert.ok(after.envelope.completedActions);
      assert.deepEqual(after.envelope.completedActions[0].result, requiredResult);
    }
    const plans = [];
    for (const query of queries) {
      const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
      plans.push(plan["QUERY PLAN"]);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    results.push({ fixture: receiptHeavy ? "required-receipt-result" : "wide-unused-output", runCount, rows: after.history.length,
      equalEnvelope: true, equalRetainedColumnsAndReceipts: true, baselineDataRowBytes: bytes[0], treatmentDataRowBytes: bytes[1],
      reduction: 1 - bytes[1] / bytes[0], baselineMedianMs: median(samples[0]), treatmentMedianMs: median(samples[1]), samples, queries, plans });
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
    treatmentDiff: git("diff", "HEAD", "--", "server/src/services/execution-continuation.ts"), baselineOnly,
    byteBoundary: "Exact text-format PostgreSQL DataRow frames, excluding metadata, TLS and TCP", postgres: await db.$client.unsafe("select version()"), results }, null, 2));
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup();
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
