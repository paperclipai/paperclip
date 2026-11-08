/** Disposable PostgreSQL repro. Run: pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-slow-queries.ts */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const { and, eq, or, sql } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm");
import {
  agents, agentWakeupRequests, chatActions, chatConversations, chatEndpoints,
  companies, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase,
  toolApplications, toolConnections, type Db,
} from "../packages/db/src/index.js";
import { issueService } from "../server/src/services/issues.js";
import { issueReadSqlCondition } from "../server/src/services/authorization.js";
import { createInboundWakeNotices } from "../server/src/services/chat-channels/inbound/wakeup-notices.js";

console.error("[benchmark] imports complete");

const migration = await fs.readFile(new URL("../packages/db/src/migrations/0345_luxuriant_carmella_unuscione.sql", import.meta.url), "utf8");
const indexes = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
const baselineRef = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length) ?? "origin/master";
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
// The database helper uses unreferenced retry/cleanup timers. A standalone
// benchmark must stay alive until startup succeeds or reports its real error.
const keepAlive = setInterval(() => {}, 1000);
const database = await startEmbeddedPostgresTestDatabase("slow-query-benchmark-");
console.error("[benchmark] database ready");
const db = createDb(database.connectionString);
let baselineModuleDir: string | undefined;
type Query = { sql: string; params: unknown[] };

// Capture the real service SQL before execution; never dispatch notices or runs.
async function captureQuery(invoke: (captureDb: Db) => Promise<unknown>): Promise<Query> {
  let captured: Query | undefined;
  const stop = new Error("query captured");
  const captureDb = new Proxy(db, {
    get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = db.select(...fields);
        const from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args);
          query.execute = async () => { captured = query.toSQL(); throw stop; };
          return query;
        }) as typeof builder.from;
        return builder;
      };
    },
  });
  try { await invoke(captureDb); } catch (error) { if (error !== stop) throw error; }
  assert.ok(captured, "service must produce a SQL query");
  return captured;
}

async function measure(query: Query) {
  const samples: number[] = [];
  let rows: unknown[] = [];
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now();
    // Positional rows retain every column, including unnamed SQL projections
    // whose duplicate names would overwrite one another in object results.
    rows = await db.$client.unsafe(query.sql, query.params as never[]).values();
    if (sample > 1) samples.push(performance.now() - start);
  }
  const [explain] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
  samples.sort((a, b) => a - b);
  return { medianMs: samples[2], rows, explain: explain["QUERY PLAN"] };
}

try {
  // Load only the old query module against current dependencies. Keep it in a
  // temporary server folder so bare package imports resolve within the worktree.
  const noticeModulePath = "server/src/services/chat-channels/inbound/wakeup-notices.ts";
  const noticeModuleUrl = new URL(`../${noticeModulePath}`, import.meta.url);
  const oldModule = execFileSync("git", ["show", `${baselineRevision}:${noticeModulePath}`], { encoding: "utf8" });
  const rewritten = oldModule.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, noticeModuleUrl)))}`);
  baselineModuleDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".slow-query-baseline-"));
  const baselineModuleFile = path.join(baselineModuleDir, "wakeup-notices.ts");
  await fs.writeFile(baselineModuleFile, rewritten);
  const { createInboundWakeNotices: baselineNotices } = await import(pathToFileURL(baselineModuleFile).href) as typeof import("../server/src/services/chat-channels/inbound/wakeup-notices.js");
  console.error("[benchmark] baseline module ready");
  const companyId = randomUUID();
  const agentId = randomUUID();
  const sourceId = randomUUID();
  const endpointId = randomUUID();
  const conversationId = randomUUID();
  const applicationId = randomUUID();
  const connectionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Query benchmark", issuePrefix: "BENCH" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: sourceId, companyId, title: "Source", identifier: "BENCH-1", assigneeAgentId: agentId });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Fixture", type: "native" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Fixture", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, status: "active" });
  await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId: sourceId, externalConversationId: "fixture", externalThreadId: "fixture", externalLabel: "Fixture", state: "waiting" });

  // Similar row counts to the investigation. Every context has 192 KiB of
  // incompressible synthetic prompt text, so JSON filtering must visit TOAST.
  const prompt = randomBytes(144 * 1024).toString("base64");
  await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, native_issue_id, created_at, context_snapshot)
    SELECT $1::uuid, $2::uuid, 'succeeded', CASE WHEN n = 3 THEN $3::uuid END, now() + n * interval '1 millisecond',
      jsonb_build_object('prompt', $4::text) || CASE
        WHEN n = 1 THEN jsonb_build_object('issueId', $3::text, 'paperclipSecretRedactions', jsonb_build_array(jsonb_build_object('fixture', 'top-level')))
        WHEN n = 2 THEN jsonb_build_object('paperclipIssue', jsonb_build_object('id', $3::text), 'paperclipSecretRedactions', jsonb_build_array(jsonb_build_object('fixture', 'nested')))
        WHEN n = 3 THEN jsonb_build_object('issueId', gen_random_uuid()::text)
        WHEN n = 4 THEN jsonb_build_object('taskId', $3::text)
        WHEN n = 5 THEN jsonb_build_object('taskKey', 'BENCH-1')
        ELSE jsonb_build_object('issueId', gen_random_uuid()::text) END
    FROM generate_series(1, 1400) n`, [companyId, agentId, sourceId, prompt]);
  const originatingRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).limit(5);
  await db.insert(issues).values(Array.from({ length: 334 }, (_, n) => ({
    companyId, title: `Candidate ${n}`, createdByUserId: "fixture",
    originRunId: originatingRuns[n % originatingRuns.length].id,
  })));
  const wakes = Array.from({ length: 13000 }, (_, n) => ({
    id: randomUUID(), companyId, agentId, source: "chat", status: n < 50 ? "deferred_issue_execution" : "succeeded",
  }));
  for (let offset = 0; offset < wakes.length; offset += 500) await db.insert(agentWakeupRequests).values(wakes.slice(offset, offset + 500));
  await db.insert(chatActions).values(wakes.slice(0, 377).map((wake, n) => ({
    id: wake.id, companyId, endpointId, conversationId, kind: "inbound_wakeup", providerActionId: wake.id,
    status: "processed", payload: n % 3 === 0 ? { coalesced: true } : {},
  })));
  // Cover coalesced ownership as well as ordinary receipts.
  for (let n = 1; n < 50; n += 2) await db.update(agentWakeupRequests)
    .set({ payload: { coalescedIntoWakeupRequestId: wakes[n - 1].id } }).where(eq(agentWakeupRequests.id, wakes[n].id));
  for (const [n, ownerId] of [[51, "not-a-uuid"], [52, wakes[0].id.toUpperCase()], [53, ""], [54, null]] as const) {
    await db.update(agentWakeupRequests).set({ payload: { coalescedIntoWakeupRequestId: ownerId } }).where(eq(agentWakeupRequests.id, wakes[n].id));
  }
  const noticeQuery = (factory: typeof createInboundWakeNotices) => captureQuery(async (captureDb) => factory(captureDb, {
    isShuttingDown: () => false, enqueueFailedChatRetryPublications: async () => 0,
  } as never).enqueueInboundWakeupPublications(200));
  const notice = await noticeQuery(baselineNotices);
  const fixedNotice = await noticeQuery(createInboundWakeNotices);
  const list = await captureQuery(async (captureDb) => issueService(captureDb).list(companyId, {
    createdFromIssueId: sourceId, sortField: "id", sortDir: "asc", limit: 200,
    readCondition: await issueReadSqlCondition(db, { type: "board", userId: "fixture", source: "cloud_tenant" }),
  }));
  const redactions = db.select({ contextSnapshot: sql`jsonb_build_object('paperclipSecretRedactions', ${heartbeatRuns.contextSnapshot}->'paperclipSecretRedactions')` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), or(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${sourceId}`,
      sql`${heartbeatRuns.contextSnapshot}->'paperclipIssue'->>'id' = ${sourceId}`,
    ))).toSQL();

  // The summary history query projects these eight context fields. Keep its
  // projection as a control: these indexes do not remove per-row JSON work.
  const runHistory = db.select({ id: heartbeatRuns.id,
    contextIssueId: sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    ...Object.fromEntries(["taskId", "taskKey", "commentId", "wakeCommentId", "wakeReason", "wakeSource", "wakeTriggerDetail"]
      .map((key) => [key, sql`${heartbeatRuns.contextSnapshot}->>${key}`])),
  }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(sql`${heartbeatRuns.createdAt} desc`).limit(200).toSQL();
  const queries = { chatNotice: notice, createdFromIssueList: list, issueRedactions: redactions, runHistory };
  // Remove only these candidate indexes from this disposable fixture. This
  // also permits repeatable comparisons after the migration is installed.
  for (const definition of indexes) await db.$client.unsafe(`DROP INDEX IF EXISTS ${definition.match(/"([^"]+)"/)![0]}`);
  await db.$client.unsafe("ANALYZE");
  const baseline: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  for (const [name, query] of Object.entries(queries)) baseline[name] = await measure(query);
  for (const definition of indexes) await db.$client.unsafe(definition);
  await db.$client.unsafe("ANALYZE");
  const results = [];
  for (const [name, query] of Object.entries(queries)) {
    const treatment = await measure(name === "chatNotice" ? fixedNotice : query);
    // Unordered SQL returns a set, not a guaranteed order. Compare full rows.
    const normalize = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(normalize(treatment.rows), normalize(baseline[name].rows));
    results.push({ name, baselineMs: baseline[name].medianMs, treatmentMs: treatment.medianMs,
      speedup: baseline[name].medianMs / treatment.medianMs, equalRows: treatment.rows.length,
      baselinePlan: baseline[name].explain, treatmentPlan: treatment.explain });
  }
  console.log(JSON.stringify({ baselineRevision, postgres: (await db.$client`SELECT version()`)[0].version,
    fixture: { issues: 335, runs: 1400, wakes: 13000, actions: 377, promptBytes: Buffer.byteLength(prompt) }, results }, null, 2));
} finally {
  try {
    await db.$client.end({ timeout: 0 });
    await database.cleanup();
    if (baselineModuleDir) await fs.rm(baselineModuleDir, { recursive: true, force: true });
  } finally {
    clearInterval(keepAlive);
  }
}
