import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, caseHandoffs, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { caseHandoffRoutes } from "../routes/case-handoffs.js";
import { issueRoutes } from "../routes/issues.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as runScratch from "../services/run-scratch.js";
import { hasStoppedLocalProcessTree } from "../services/heartbeat/process-settlement.js";
import type { StorageService } from "../storage/types.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const childScript = String.raw`
const base = process.env.CASE_TEST_API_URL;
const headers = { authorization: 'Bearer ' + process.env.PAPERCLIP_API_KEY, 'content-type': 'application/json', 'x-paperclip-run-id': process.env.PAPERCLIP_RUN_ID };
async function main() {
  const response = await fetch(base + '/api/cases/' + process.env.CASE_TEST_CASE_ID, { headers });
  const workflow = await response.json();
  if (!response.ok) throw new Error('case read failed ' + response.status + ': ' + JSON.stringify(workflow));
  if (process.env.CASE_TEST_ROLE === 'triage') {
    if (process.env.CASE_TEST_BACKGROUND_WRITER) {
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'write\\n'),20)",
        process.env.CASE_TEST_BACKGROUND_WRITER], {stdio:'ignore'});
      child.unref();
    }
    const handoffBody = { idempotencyKey: 'triage-to-implementation', case: { id: workflow.id },
      toAgentId: process.env.CASE_TEST_RECIPIENT_ID, phase: 'implementation', instructions: 'Implement the persisted specification canary',
      expectedHandoffVersion: workflow.handoffVersion, expectedIssueStatusVersion: workflow.workIssue.statusVersion };
    const submitted = await fetch(base + '/api/companies/' + process.env.PAPERCLIP_COMPANY_ID + '/case-handoffs', {
      method: 'POST', headers, body: JSON.stringify(handoffBody) });
    const receipt = await submitted.json();
    if (submitted.status !== 202) throw new Error('handoff failed ' + submitted.status + ': ' + JSON.stringify(receipt));
    const cancelled = await fetch(base + '/api/cases/' + workflow.id + '/handoffs/' + receipt.handoffId + '/cancel', { method: 'POST', headers, body: '{}' });
    if (cancelled.status !== 403) throw new Error('outgoing run escaped handoff fence: cancel status ' + cancelled.status);
    const replayed = await fetch(base + '/api/companies/' + process.env.PAPERCLIP_COMPANY_ID + '/case-handoffs', { method: 'POST', headers, body: JSON.stringify(handoffBody) });
    if (replayed.status !== 200) throw new Error('outgoing receipt replay failed: ' + replayed.status);
    await fetch(base + '/fixture/source-accepted', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ receipt, pid: process.pid }) });
    // An accepted HTTP response must not release a still-live process.
    await fetch(base + '/fixture/release-source');
  } else {
    await fetch(base + '/fixture/recipient-observed', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ caseId: workflow.id, taskId: workflow.workIssueId, phase: workflow.phase,
        handoffVersion: workflow.handoffVersion, fields: workflow.fields, runId: process.env.PAPERCLIP_RUN_ID }) });
    const completed = await fetch(base + '/api/issues/' + workflow.workIssueId, { method: 'PATCH', headers,
      body: JSON.stringify({ status: 'done', comment: 'Verified the assembled process handoff fixture.' }) });
    if (!completed.ok) throw new Error('completion failed ' + completed.status + ': ' + await completed.text());
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
`;

describe("case handoff through actual legacy process and HTTP boundaries", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let server: Server | undefined;
  let releaseSource: (() => void) | undefined;
  const ownedBackgroundGroups = new Set<number>();
  const fixtureDirs = new Set<string>();
  const oldJwt = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const oldApi = process.env.PAPERCLIP_API_URL;
  const oldAuthz = process.env.PAPERCLIP_AUTHZ_MODE;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "case-handoff-process-integration-secret";
    temporary = await startEmbeddedPostgresTestDatabase("case-process-integration-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  });
  afterEach(async () => {
    releaseSource?.();
    for (const group of ownedBackgroundGroups) {
      try { process.kill(-group, "SIGKILL"); } catch { /* fixture group already stopped */ }
    }
    ownedBackgroundGroups.clear();
    const live = db ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running")) : [];
    for (const run of live) await heartbeat.cancelRun(run.id).catch(() => {});
    await heartbeat?.drainActiveRunExecutions();
    if (server) { const listening = server; await new Promise<void>(resolve => listening.close(() => resolve())); }
    server = undefined;
    releaseSource = undefined;
    vi.restoreAllMocks();
    for (const dir of fixtureDirs) await rm(dir, { recursive: true, force: true });
    fixtureDirs.clear();
  });
  afterAll(async () => {
    await temporary?.cleanup();
    if (oldJwt === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldJwt;
    if (oldApi === undefined) delete process.env.PAPERCLIP_API_URL; else process.env.PAPERCLIP_API_URL = oldApi;
    if (oldAuthz === undefined) delete process.env.PAPERCLIP_AUTHZ_MODE; else process.env.PAPERCLIP_AUTHZ_MODE = oldAuthz;
  });

  it.each([false, true])("keeps the recipient stopped until the source process tree settles, then executes the same task (scratch failure=%s)", async scratchFailure => {
    const companyId = randomUUID(), triage = randomUUID(), engineer = randomUUID(), userId = randomUUID();
    const writerDir = await mkdtemp(path.join(tmpdir(), "paperclip-case-legacy-writer-"));
    fixtureDirs.add(writerDir);
    const writerFile = path.join(writerDir, "writes.txt");
    if (scratchFailure) {
      const prepare = runScratch.prepareHeartbeatRunScratch;
      vi.spyOn(runScratch, "prepareHeartbeatRunScratch").mockImplementation(input => {
        if (input.agentId === triage) throw new Error("fixture: local scratch preparation failed");
        return prepare(input);
      });
    }
    await db.insert(authUsers).values({ id: userId, name: "Factory operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Factory process proof", issuePrefix: `P${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: triage, companyId, name: "Triage process", role: "ceo", status: "idle", adapterType: "process" },
      { id: engineer, companyId, name: "Implementation process", role: "engineer", reportsTo: triage, status: "idle", adapterType: "process" },
    ]);
    let accepted: { receipt: { handoffId: string; taskId: string; state: string }; pid: number } | undefined;
    let observed: { taskId: string; caseId: string; phase: string; handoffVersion: number; runId: string } | undefined;
    const app = express(); app.use(express.json());
    app.post("/fixture/source-accepted", (req, res) => { accepted = req.body; res.json({ ok: true }); });
    app.get("/fixture/release-source", (_req, res) => { releaseSource = () => { if (!res.headersSent) res.json({ released: true }); }; });
    app.post("/fixture/recipient-observed", (req, res) => { observed = req.body; res.json({ ok: true }); });
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    const storage = { provider: "local_disk", putFile: async () => { throw new Error("unused"); }, getObject: async () => { throw new Error("unused"); },
      headObject: async () => ({ exists: false }), deleteObject: async () => {} } satisfies StorageService;
    app.use("/api", caseRoutes(db, storage)); app.use("/api", caseHandoffRoutes(db)); app.use("/api", issueRoutes(db, storage)); app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const api = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    process.env.PAPERCLIP_API_URL = api;
    const initial = await caseHandoffService(db).handoff(companyId, { type: "board", source: "local_implicit", userId }, {
      idempotencyKey: "factory-start", case: { create: { caseType: "work", title: "Process factory proof", fields: { specification: "persisted specification canary" } } },
      workflow_document_text: "Triage researches the specification and hands the same task to implementation. Implementation saves the observed evidence.",
      toAgentId: triage, phase: "triage", instructions: "Research then hand this same task to implementation",
    });
    for (const [id, role] of [[triage, "triage"], [engineer, "implementation"]] as const) {
      await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", childScript], timeoutSec: 20, graceSec: 1,
        env: { CASE_TEST_API_URL: api, CASE_TEST_CASE_ID: initial.caseId, CASE_TEST_ROLE: role, CASE_TEST_RECIPIENT_ID: engineer,
          ...(scratchFailure && role === "triage" ? { CASE_TEST_BACKGROUND_WRITER: writerFile } : {}) } } }).where(eq(agents.id, id));
    }
    const delivery = caseHandoffDeliveryService(db, { heartbeat });
    await delivery.sweepPending();
    const waitUntil = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      const runs = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error }).from(heartbeatRuns);
      throw new Error(`${label}: ${JSON.stringify(runs)}`);
    };
    await waitUntil(() => Boolean(accepted && releaseSource), "source did not call the production handoff API");
    expect(accepted!.receipt).toMatchObject({ taskId: initial.taskId, state: "awaiting_release" });
    const [outgoing] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, accepted!.receipt.handoffId));
    const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, outgoing.sourceRunId!));
    if (scratchFailure) ownedBackgroundGroups.add(sourceRun.processGroupId!);
    const intents = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRun.id),
      eq(heartbeatRunEvents.eventType, "legacy.case_handoff_cleanup_intent")));
    expect(intents.at(-1)).toMatchObject({ sourceEventId: null, payload: { controllerBootId: sourceRun.controllerBootId,
      processPid: accepted!.pid, processGroupId: sourceRun.processGroupId, processStartedAt: sourceRun.processStartedAt!.toISOString() } });
    if (scratchFailure) expect(intents.at(-1)?.payload?.scratch).toBeNull();
    process.kill(accepted!.pid, 0); // prove the provider process is still alive
    await delivery.sweepPending();
    expect(observed).toBeUndefined();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, engineer), eq(heartbeatRuns.companyId, companyId)))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, initial.taskId)))[0]!.assigneeAgentId).toBe(triage);
    releaseSource!();
    await heartbeat.drainActiveRunExecutions();
    if (scratchFailure) {
      const finished = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRun.id)))[0]!;
      expect(finished.status).toBe("succeeded");
      expect(finished).toMatchObject({ processPid: sourceRun.processPid, processGroupId: sourceRun.processGroupId });
      // The main adapter exited and closed stdio; its child can still write.
      await expect.poll(async () => (await readFile(writerFile, "utf8").catch(() => "")).length).toBeGreaterThan(0);
      const before = (await readFile(writerFile, "utf8")).length;
      expect(finished.resultJson ?? {}).not.toHaveProperty("caseHandoffExecutionReleased");
      expect(hasStoppedLocalProcessTree(finished)).toBe(false);
      await expect.poll(async () => (await readFile(writerFile, "utf8")).length).toBeGreaterThan(before);
      await caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db, { runtimeEnv: {} }),
        now: () => new Date(Date.now() + 61_000) }).sweepPending();
      expect(observed).toBeUndefined();
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, outgoing.id)))[0]?.state).toBe("awaiting_release");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, engineer))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, initial.taskId)))[0]?.assigneeAgentId).toBe(triage);
      process.kill(-sourceRun.processGroupId!, "SIGKILL");
      await expect.poll(() => hasStoppedLocalProcessTree(finished)).toBe(true);
    }
    // A fresh service instance recovers durable intent after the source settles.
    const releasedIntent = (await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, accepted!.receipt.handoffId)))[0]!;
    if (!scratchFailure) expect(releasedIntent.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(releasedIntent.leaseExpiresAt).toBeNull();
    // Retain only the process-bound preparation intent, as a controller crash
    // before cleanup's later verified receipt/final marker would do.
    await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRun.id),
      eq(heartbeatRunEvents.eventType, "legacy.case_handoff_cleanup_verified")));
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) - 'caseHandoffExecutionReleased'` })
      .where(eq(heartbeatRuns.id, sourceRun.id));
    await caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db, { runtimeEnv: {} }),
      now: () => new Date(Date.now() + 122_000) }).sweepPending();
    await waitUntil(() => Boolean(observed), "successor did not execute");
    await heartbeat.drainActiveRunExecutions();
    expect(observed).toMatchObject({ taskId: initial.taskId, caseId: initial.caseId, phase: "implementation", handoffVersion: 2,
      fields: { specification: "persisted specification canary" } });
    const successor = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, observed!.runId)))[0]!;
    expect(successor.contextSnapshot?.paperclipCase).toMatchObject({ phase: "implementation", handoffVersion: 2, taskId: initial.taskId,
      incomingHandoff: { instructions: expect.stringContaining("persisted specification canary") } });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, triage)))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, engineer), eq(agentWakeupRequests.reason, "case_handoff")))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, initial.taskId)))[0]!.status).toBe("done");
  }, 30_000);
});
