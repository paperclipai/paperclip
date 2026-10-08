/** Opt-in live qualification: creates an isolated database/workspace and runs a harness test and two Codex turns.
 * PATH=<pnpm-bin>:<codex-bin>:$PATH node --import tsx server/scripts/smoke-native-task-monitor.ts --run
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";

if (!process.argv.includes("--run")) throw new Error("Pass --run to authorize the live two-turn Codex smoke.");
const root = await mkdtemp(join(tmpdir(), "paperclip-live-task-monitor-"));
process.env.PAPERCLIP_HOME = join(root, "paperclip");
process.env.PAPERCLIP_INSTANCE_ID = "monitor-smoke";
process.env.PAPERCLIP_TELEMETRY_ENABLED = "false";
const { createDb, companies, agents, authUsers, companyMemberships, issues, heartbeatRuns, agentWakeupRequests, nativeRunResults, statusDecisions } = await import("@paperclipai/db");
const { startEmbeddedPostgresTestDatabase } = await import("../src/__tests__/helpers/embedded-postgres.js");
const { createAgentLifecycle, startAgentLifecycle } = await import("../src/modules/agent-lifecycle/index.js");
const { createPluginWorkerManager } = await import("../src/services/plugin-worker-manager.js");
const { heartbeatService } = await import("../src/services/heartbeat.js");
const { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } = await import("../src/realtime/runner-prp-ws.js");
const { closeIdleWarmNativeSessionsForRestart } = await import("../src/services/native-runtime/native-session-executor.js");
const temporary = await startEmbeddedPostgresTestDatabase("live-task-monitor-");
const db = createDb(temporary.connectionString);
const server = createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("TCP listener missing");
process.env.PAPERCLIP_API_URL = `http://127.0.0.1:${address.port}`;
setupRunnerPrpWebSocketServer(server, { apiUrl: process.env.PAPERCLIP_API_URL });
const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
const heartbeat = heartbeatService(db);
const lifecycle = startAgentLifecycle(db, createPluginWorkerManager(), () => true);
const readRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(heartbeatRuns.createdAt);
console.log(JSON.stringify({ root, companyId, agentId, issueId }));
try {
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await db.insert(companies).values({ id: companyId, name: "Isolated monitor smoke", issuePrefix: "MON", defaultResponsibleUserId: "monitor-smoke", requireBoardApprovalForNewAgents: false });
  await db.insert(authUsers).values({ id: "monitor-smoke", name: "Monitor smoke", email: "monitor-smoke@example.test", createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "monitor-smoke", status: "active", membershipRole: "owner" });
  await createAgentLifecycle(db).requestHire(companyId, { id: agentId, name: "Monitor verifier", status: "active", adapterType: "paperclip_runner",
    adapterConfig: { provider: "codex", cwd, lifecycleMode: "warm", idleTimeoutMs: 300_000, timeoutSeconds: 180 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
  await lifecycle.sweep();
  assert.equal((await createAgentLifecycle(db).get(agentId))?.lifecycleState, "ready");
  await db.insert(issues).values({ id: issueId, companyId, title: "Verify a one-shot native task monitor", identifier: "MON-1", status: "in_progress", assigneeAgentId: agentId,
    description: "This is an isolated two-run integration test. First run: use set_task_monitor on this task with a fresh nextCheckAt about 45 seconds in the future (compute the current UTC time if needed), notes saying to verify issue_monitor_due, and idempotencyKey monitor-live-first. Confirm the receipt. Then call paperclip_finish with yielded and continuation.kind monitor, accurately retaining the second run as blocking remaining work. End immediately after acceptance. Do not sleep or poll. Second run: if the wake reason is issue_monitor_due, the requested check succeeded. Report that reason and finish done using the current completion contract. Do not schedule another monitor or request human review. No files or other deliverables are required." });
  await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "monitor_smoke",
    requestedByActorType: "system", requestedByActorId: "monitor-smoke", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "monitor_smoke" } });
  const deadline = Date.now() + 8 * 60_000;
  let firstReleasedAt: number | null = null;
  while (Date.now() < deadline) {
    const runs = await readRuns();
    if (runs.some(run => ["failed", "timed_out", "cancelled"].includes(run.status))) {
      throw new Error(`Live run failed: ${JSON.stringify(runs.map(run => ({ id: run.id, status: run.status, error: run.error, errorCode: run.errorCode })))}`);
    }
    if (runs.length === 1 && runs[0].status === "succeeded") {
      firstReleasedAt ??= Date.now();
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      assert.equal(issue.status, "in_progress");
      assert.ok(issue.monitorNextCheckAt, "first run must leave a persisted monitor");
      assert.equal(issue.executionRunId, null);
    }
    if (runs.length >= 2 && runs[1].status === "succeeded") break;
    await heartbeat.tickTimers();
    await delay(1_000);
  }
  await heartbeat.drainActiveRunExecutions();
  const runs = await readRuns();
  assert.equal(runs.length, 2, "exactly two server runs must execute");
  assert.ok(runs.every(run => run.status === "succeeded"));
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_monitor_due")));
  assert.equal(wakes.length, 1);
  assert.equal(runs[1].contextSnapshot?.wakeReason, "issue_monitor_due");
  assert.equal(issue.status, "done");
  assert.equal(issue.monitorNextCheckAt, null);
  assert.ok(firstReleasedAt && runs[1].createdAt.getTime() - firstReleasedAt < 300_000, "wake must arrive within the configured warm window");
  const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, companyId));
  const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.companyId, companyId));
  const evidence = { companyId, issueId, agentId, configuredIdleTimeoutMs: 300_000, firstReleasedAt, status: issue.status,
    runs: runs.map(run => ({ id: run.id, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt,
      wakeReason: run.contextSnapshot?.wakeReason, nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
      processPid: run.processPid, processStartedAt: run.processStartedAt, providerSessionId: run.sessionIdAfter,
      semanticToolReceipts: run.resultJson?.semanticToolReceipts })),
    warmReuse: { sameNativeSession: runs[0].nativeSessionId === runs[1].nativeSessionId,
      sameRunnerInstance: runs[0].runnerInstanceId === runs[1].runnerInstanceId,
      sameProcess: runs[0].processPid != null && runs[0].processPid === runs[1].processPid && runs[0].processStartedAt?.getTime() === runs[1].processStartedAt?.getTime() },
    results: results.map(row => ({ runId: row.runId, result: row.resultJson })),
    decisions: decisions.map(row => ({ runId: row.runId, reasonCode: row.reasonCode, toStatus: row.toStatus })),
    monitorWakeIds: wakes.map(row => row.id) };
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: join(root, "evidence.json"), warmReuse: evidence.warmReuse }));
} finally {
  await lifecycle.stop();
  await writeFile(join(root, "run-records.json"), JSON.stringify(await readRuns(), null, 2));
  await closeIdleWarmNativeSessionsForRestart();
  runnerPrpWebSocketInternals.resetForTests();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await temporary.cleanup();
}
