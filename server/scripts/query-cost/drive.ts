import "./instrument.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import express from "express";
import { completionContracts, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase } from "../../../packages/db/src/index.js";
import { countStatements, diff, format, setEnabled, snapshot } from "./instrument.js";
import { seedReviewAttentionFixture } from "../../src/__tests__/helpers/review-attention-fixture.js";
import { seedAttentionSummaryVolume } from "../../src/__tests__/helpers/attention-summary-fixture.js";

process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
const only = (process.env.UNITS ?? "board,event").split(",");
const TASKS = Number(process.env.TASKS ?? 1500), AGENTS = Number(process.env.AGENTS ?? 40), REPEAT = Number(process.env.REPEAT ?? 3);
const keepAlive = setInterval(() => {}, 1_000);
const temporary = await startEmbeddedPostgresTestDatabase("query-cost-");
const db = createDb(temporary.connectionString);
countStatements(db as never);
const report: string[] = [];
const out = process.env.OUT ?? "query-cost.md";

async function measure(label: string, units: number, action: () => Promise<void>) {
  await action();
  (globalThis as { gc?: () => void }).gc?.();
  const plain = snapshot();
  for (let i = 0; i < units; i++) await action();
  const uninstrumented = diff(plain);
  setEnabled(true);
  const before = snapshot();
  for (let i = 0; i < units; i++) await action();
  const result = diff(before);
  setEnabled(false);
  const text = `uninstrumented: statements ${(uninstrumented.statements / units).toFixed(1)}, allocated ${(uninstrumented.allocated / 1024 / units).toFixed(1)} KB, wall ${(uninstrumented.wallMs / units).toFixed(1)} ms per unit\n` + format(label, units, result);
  report.push(text);
  console.log(text + "\n");
  writeFileSync(out, report.join("\n\n") + "\n");
}

try {
  const fixture = await seedReviewAttentionFixture(db, { tasks: TASKS, agents: AGENTS, prefix: "SYN" });
  await seedAttentionSummaryVolume(db, fixture);
  const { companyId, userId } = fixture;
  const agentId = fixture.agentIds[0]!;

  if (only.includes("calibrate")) {
    const { sql } = await import("drizzle-orm");
    const v8 = await import("node:v8");
    const alloc = () => (v8.getHeapStatistics() as unknown as { total_allocated_bytes: number }).total_allocated_bytes;
    const lines = ["## read calibration (prepared, build excluded): KB allocated per execution", "| rows | fields | bytes/value | KB/exec | wire KB | bytes alloc per wire byte |", "| --- | --- | --- | --- | --- | --- |"];
    for (const [rows, fields, width] of [[1, 1, 8], [1, 20, 8], [1, 80, 8], [50, 20, 8], [50, 20, 200], [500, 10, 40], [500, 3, 2000]] as const) {
      const fieldsObj = Object.fromEntries(Array.from({ length: fields }, (_, i) => [`c${i}`, sql<string>`repeat('x', ${sql.raw(String(width))})`.as(`c${i}`)]));
      const prepared = db.select(fieldsObj).from(sql`generate_series(1, ${sql.raw(String(rows))})`).prepare(`cal_${rows}_${fields}_${width}`);
      for (let i = 0; i < 5; i++) await prepared.execute();
      const start = alloc();
      for (let i = 0; i < 30; i++) await prepared.execute();
      const kb = (alloc() - start) / 30 / 1024, wire = rows * fields * (width + 4) / 1024;
      lines.push(`| ${rows} | ${fields} | ${width} | ${kb.toFixed(1)} | ${wire.toFixed(1)} | ${(kb / wire).toFixed(1)} |`);
    }
    report.push(lines.join("\n")); console.log(lines.join("\n"));
  }

  if (only.includes("board")) {
    const { attentionRoutes } = await import("../../src/routes/attention.js");
    const { issueRoutes } = await import("../../src/routes/issues.js");
    const { agentRoutes } = await import("../../src/routes/agents.js");
    const { errorHandler } = await import("../../src/middleware/index.js");
    const runIds: string[] = [];
    for (const [index, issueId] of fixture.taskIds.slice(0, 12).entries()) {
      const id = randomUUID();
      runIds.push(id);
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: fixture.agentIds[index % fixture.agentIds.length]!, status: "running",
        issueId, contextSnapshot: { issueId }, startedAt: new Date() });
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    app.use("/api", attentionRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", agentRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const get = async (route: string) => {
      const response = await fetch(`${base}${route}`);
      const body = await response.text();
      assert.equal(response.status, 200, `${route}: ${body.slice(0, 300)}`);
      return body.length;
    };
    const ids = fixture.taskIds.slice(0, 50).join(",");
    const routes: Record<string, string> = {
      "attention/summary": `/companies/${companyId}/attention/summary`,
      "issues list": `/companies/${companyId}/issues`,
      "issues list view=index": `/companies/${companyId}/issues?view=index`,
      "issues list view=rows": `/companies/${companyId}/issues?view=rows`,
      "issues/summaries (50 ids)": `/companies/${companyId}/issues/summaries?ids=${ids}`,
      "issues/summaries (10 ids)": `/companies/${companyId}/issues/summaries?ids=${fixture.taskIds.slice(0, 10).join(",")}`,
      "live-runs": `/companies/${companyId}/live-runs`,
      "agents list": `/companies/${companyId}/agents`,
      "issue detail": `/issues/${fixture.taskIds[3]}`,
      "heartbeat run detail": `/heartbeat-runs/${runIds[0]}`,
    };
    if (only.includes("fields")) {
      const read = async (route: string) => JSON.parse(await (await fetch(`${base}${route}`)).text()) as Array<Record<string, unknown>>;
      const full = await read(`/companies/${companyId}/issues`);
      const index = await read(`/companies/${companyId}/issues?view=index`);
      const rows = await read(`/companies/${companyId}/issues?view=rows&sortField=updated&sortDir=desc&limit=10`);
      const fields = ["id", "identifier", "title", "status", "priority", "createdAt", "updatedAt", "assigneeAgentId", "displayStatus", "externalConversationState", "blockerAttention"];
      const byId = new Map(full.map(row => [row.id, row]));
      const diffs: Record<string, number> = {};
      for (const [label, set] of [["index", index], ["rows10", rows]] as const) {
        for (const row of set) for (const field of fields) {
          const a = JSON.stringify(byId.get(row.id)?.[field] ?? null), b = JSON.stringify(row[field] ?? null);
          if (a !== b) diffs[`${label}.${field}`] = (diffs[`${label}.${field}`] ?? 0) + 1;
        }
      }
      const recentFull = [...full].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt))).slice(0, 10).map(row => row.id);
      console.log(JSON.stringify({ full: full.length, index: index.length, rows: rows.length,
        sameIds: JSON.stringify(full.map(r => r.id).sort()) === JSON.stringify(index.map(r => r.id).sort()),
        sameRecent: JSON.stringify(recentFull) === JSON.stringify(rows.map(r => r.id)), diffs,
        fullHasDisplayStatus: full.filter(r => r.displayStatus !== undefined).length, fullBlocker: full.filter(r => r.blockerAttention).length }));
    }
    for (const [name, route] of Object.entries(routes).filter(([name]) => !process.env.ROUTES || process.env.ROUTES.split(",").includes(name))) {
      try {
        const bytes = await get(route);
        await measure(`GET ${name} (body ${Math.round(bytes / 1024)} KB)`, REPEAT, async () => { await get(route); });
      } catch (error) { console.log(`skip ${name}: ${(error as Error).message.slice(0, 300)}`); }
    }
    server.close();
  }

  if (only.includes("recovery")) {
    const { assignedWorkSweep } = await import("../../src/services/recovery/assigned-work-sweep.js");
    const sweep = assignedWorkSweep(db, { enqueueWakeup: async () => null, proveOwner: async () => ({ kind: "alive" }) as never });
    const suspects = await sweep.listSuspects({ companyId }, null, 100);
    console.log(`suspects ${suspects.length}`);
    await measure("assigned-work sweep load (listSuspects page of 100)", 5, async () => { await sweep.listSuspects({ companyId }, null, 100); });
    await measure("assigned-work sweep check of one task (checkIssue)", 25, async () => {
      for (const suspect of suspects.slice(0, 1)) await sweep.checkIssue({ companyId, issueId: suspect.id });
    });
    const { loadNativeChatProgressScopes, reconcileNativeChatProgress } = await import("../../src/services/chat-native-progress.js");
    await measure("chat native progress load + check", 5, async () => {
      await loadNativeChatProgressScopes(db, { companyId } as never);
      await reconcileNativeChatProgress(db, { scope: { companyId, issueId: fixture.taskIds[0]! }, limit: 100 });
    });
  }

  if (only.includes("agent")) {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
    const { createLocalAgentJwt } = await import("../../src/agent-auth-jwt.js");
    const { actorMiddleware } = await import("../../src/middleware/auth.js");
    const { issueRoutes } = await import("../../src/routes/issues.js");
    const { errorHandler } = await import("../../src/middleware/index.js");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", issueId: fixture.taskIds[3]!,
      contextSnapshot: { issueId: fixture.taskIds[3]! }, startedAt: new Date() });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId);
    assert.ok(token, "agent token");
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", localAgentProcessBoundary: null }));
    app.get("/api/whoami", (req, res) => { res.json({ type: (req as unknown as { actor: { type: string } }).actor.type }); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const get = async (route: string) => {
      const response = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}`, "x-paperclip-run-id": runId } });
      const body = await response.text();
      assert.equal(response.status, 200, `${route}: ${body.slice(0, 300)}`);
      return body;
    };
    assert.match(await get("/whoami"), /agent/);
    await measure("agent request authentication only (actorMiddleware, agent JWT)", 20, async () => { await get("/whoami"); });
    await measure("agent GET issues/:id (auth + route)", 5, async () => { await get(`/issues/${fixture.taskIds[3]}`); });
    server.close();
  }

  if (only.includes("legacy")) {
    const { createAgentLifecycle, configureAgentLifecycle } = await import("../../src/services/agent-lifecycle.js");
    const { heartbeatService } = await import("../../src/services/heartbeat.js");
    const { createDeliveryWorkCoordinator } = await import("../../src/services/delivery-work-coordinator.js");
    const { enableDatabaseWorkNotifications } = await import("../../../packages/db/src/work-signals.js");
    const { eq } = await import("drizzle-orm");
    enableDatabaseWorkNotifications(db);
    const lines = Number(process.env.LINES ?? 20), gapMs = Number(process.env.GAP_MS ?? 50);
    const legacyAgentId = randomUUID(), legacyCompanyId = randomUUID();
    const { companies } = await import("../../../packages/db/src/index.js");
    await db.insert(companies).values({ id: legacyCompanyId, name: "Legacy", issuePrefix: `L${legacyCompanyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "legacy-user" });
    await createAgentLifecycle(db).requestHire(legacyCompanyId, { id: legacyAgentId, name: "Legacy process", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath,
        args: ["-e", `let i=0;const t=setInterval(()=>{console.log("output line "+(++i)+" ".padEnd(80,"x"));if(i>=${lines}){clearInterval(t);}},${gapMs});`],
        cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } }, permissions: {} }, { runnerResolved: true });
    const lifecycleWorker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    for (let i = 0; i < 4; i++) await lifecycleWorker.process(legacyAgentId);
    await lifecycleWorker.stop();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => console.log(`coordinator error ${String(error).slice(0, 200)}`) });
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: undefined } });
    const dispatch = heartbeat.registerRunDispatchWork(coordinator, () => true);
    await dispatch.ready;
    const runOnce = async () => {
      const run = await heartbeat.wakeup(legacyAgentId, { source: "on_demand", reason: "manual", requestedByActorType: "system" });
      if (!run) {
        const { agents, agentWakeupRequests } = await import("../../../packages/db/src/index.js");
        console.log(JSON.stringify({ agent: (await db.select({ status: agents.status, holds: agents.lifecycleHolds, state: agents.lifecycleState }).from(agents).where(eq(agents.id, legacyAgentId)))[0],
          wakes: await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason, error: agentWakeupRequests.error }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, legacyAgentId)) }));
      }
      assert.ok(run, "wake accepted");
      for (let i = 0; i < 600; i++) {
        const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        if (row && !["queued", "running"].includes(row.status)) {
          assert.equal(row.status, "succeeded", "a measured legacy run must succeed");
          break;
        }
        assert.ok(i < 599, "a measured legacy run must finish within 60 seconds");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await heartbeat.drainActiveRunExecutions();
    };
    await measure(`legacy process run lifecycle (wake, queue, start, ${lines} output lines ${gapMs} ms apart, finish), includes the harness's 100 ms status poll`, 3, runOnce);
    await dispatch.stop();
    await coordinator.stop();
  }

  if (only.includes("event")) {
    const { PaperclipControlPlanePort } = await import("../../src/services/native-runtime/paperclip-control-plane-port.js");
    const [issue] = await db.insert(issues).values({ companyId, title: "Streaming", status: "in_progress", assigneeAgentId: agentId }).returning();
    const contractSha = "query-cost";
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId: issue!.id, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "benchmark", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "benchmark", objective: "Benchmark", criteria: [{ id: "objective", requirement: "Append" }] },
      canonicalSha256: contractSha, createdByActorType: "system", createdByActorId: "benchmark" }).returning();
    const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issue!.id, issueId: issue!.id, nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract!.id, completionContractSha256: contractSha, contextSnapshot: { issueId: issue!.id } });
    const identity = { companyId, issueId: issue!.id, runId, agentId, sessionId };
    const port = new PaperclipControlPlanePort(db, { ...identity, completionContractId: contract!.id,
      completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `control-${runId}` });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId } as never);
    const text = randomBytes(72).toString("base64").slice(0, 96);
    let ordinal = 0;
    const next = async () => {
      ordinal += 1;
      const step = ordinal % 10;
      const base = { schema: "paperclip.prp.event.v1" as const, sourceEventId: `${runnerId}:${ordinal}`, sourceSeq: ordinal,
        sourceInstanceId: runnerId, sourceKind: "runner" as const, runId, normalizedSessionId: sessionId,
        turnId: "turn-1", schemaVersion: 1 as const, priority: 1, emittedAt: new Date().toISOString() };
      const event = step < 7 ? { ...base, itemId: "message-1", eventType: "item.delta", payload: { kind: "agentMessage", text } }
        : step === 9 ? { ...base, itemId: `command-${ordinal}`, eventType: "item.completed",
          payload: { kind: "commandExecution", item: { type: "command", id: `command-${ordinal}`, output: text } } }
        : { ...base, itemId: `tool-${ordinal}`, eventType: step === 7 ? "tool.execution.started" : "tool.execution.completed",
          payload: { schema: "paperclip.tool.execution.v1", executionId: `tool-${ordinal - (step === 7 ? 0 : 1)}`, transport: "builtin",
            operation: "execute", name: "shell", target: null, namespace: null, readOnly: true,
            status: step === 7 ? "running" : "completed", durationMs: step === 7 ? null : 12, exitCode: step === 7 ? null : 0,
            progress: null, output: text, outputBytes: text.length, outputTruncated: false, outputDigest: `sha256:${"a".repeat(64)}` } };
      await port.appendEvent(event as never);
    };
    await measure("native runner event via PaperclipControlPlanePort.appendEvent", 200, next);
  }
} finally {
  clearInterval(keepAlive);
  await db.$client.end({ timeout: 1 }).catch(() => {});
  await temporary.cleanup();
}
console.log(`report: ${out}`);
process.exit(0);
