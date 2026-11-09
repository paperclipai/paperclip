import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, applyPendingMigrations, companies, companyMemberships, createDb,
  environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, subscribeDatabaseWork,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { hasNativeLocalProcessStop, PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";

const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CONFIRM_RUN_STOPPED_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("confirming that an unidentified local run stopped", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-confirm-run-stopped-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }
  const board = (companyId: string, membershipRole: "admin" | "viewer" = "admin"): Express.Request["actor"] => ({
    type: "board", userId: "board-user", companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }], isInstanceAdmin: false, source: "session",
  });

  async function seed(options: { hostname?: string; launch?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `S${companyId.slice(0, 5).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user",
      status: "active", membershipRole: "admin" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex", role: "engineer", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chaos A1 brief", status: "blocked", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `CHA-${issueId.slice(0, 8)}` });
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode: "adapter_failed", invocationSource: "assignment",
      startedAt: new Date(finishedAt.getTime() - 90_000), finishedAt, contextSnapshot: { issueId } });
    if (options.launch !== false) await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: PROCESS_START_REQUESTED,
      stream: "system", level: "info", message: "launch requested", payload: { hostname: options.hostname ?? os.hostname() } });
    const wakeId = randomUUID();
    const [wake] = await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1", generationId: wakeId, actorId: "board-user", sourceRunId: runId, strategy: "continue" },
        executionWait: { reason: "process_identity_missing", message: "The previous run has no verified stop record." } },
    }).returning();
    return { companyId, agentId, issueId, runId, wakeId: wake!.id };
  }

  it("shows a board action instead of an endless wait, then records the confirmed stop (storage chaos ST1)", async () => {
    const f = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const before = (await taskInterruptionPresentations(db, f.companyId, [issue!])).get(f.issueId);
    expect(before).toMatchObject({ responsibility: "user", state: "waiting_for_user", canRetry: false,
      userAction: "confirm_run_stopped", observedRunId: f.runId, retryWait: { reason: "process_identity_missing" } });
    expect(before?.retryWait?.message).toContain("a board operator can confirm");

    const accountingWakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.accounting, event => { accountingWakes.push(event); });
    const res = await request(app(board(f.companyId))).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`)
      .send({ runId: f.runId, stopEvidence: "No codex process for this task is running on the server host." })
      .then(response => { unsubscribe(); return response; }, error => { unsubscribe(); throw error; });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ runId: f.runId, alreadyStopped: false });
    expect(accountingWakes).toContain("settled");
    expect(await hasNativeLocalProcessStop(db, f.companyId, f.runId)).toBe(true);
    const [wakeAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    expect(wakeAfter!.status).toBe("coalesced");
    expect(wakeAfter!.runId).toBeTruthy();
    expect(wakeAfter!.runId).not.toBe(f.runId);
    const [started] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakeAfter!.runId!));
    expect(started).toMatchObject({ agentId: f.agentId });
    await vi.waitFor(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, started!.id));
      expect(["queued", "running"]).not.toContain(run!.status);
    }, { timeout: 30_000, interval: 200 });
    const [stop] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "native.local_process_stopped")));
    expect(stop!.payload).toMatchObject({ basis: "operator_attested", attestedByUserId: "board-user" });
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.run_stop_confirmed"));
    expect(logged).toMatchObject({ entityId: f.issueId, actorId: "board-user", runId: f.runId,
      details: expect.objectContaining({ stopEvidence: "No codex process for this task is running on the server host." }) });
  });

  it("refuses to confirm while a runner for the run is still running on this host", async () => {
    const f = await seed();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--run-id", f.runId], { stdio: "ignore" });
    try {
      await once(child, "spawn");
      const res = await request(app(board(f.companyId))).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`)
        .send({ runId: f.runId, stopEvidence: "I believe the previous agent has stopped working." });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await hasNativeLocalProcessStop(db, f.companyId, f.runId)).toBe(false);
    } finally {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  });

  it.each([
    ["no_unidentified_launch", () => seed({ launch: false })],
    ["launch_on_other_host", () => seed({ hostname: "another-server" })],
    ["process_identity_recorded", async () => {
      const f = await seed();
      await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.runId));
      return f;
    }],
    ["remote_environment", async () => {
      const f = await seed();
      const environmentId = randomUUID();
      await db.insert(environments).values({ id: environmentId, name: "Sandbox", driver: "sandbox",
        status: "active", config: { provider: "fake" } });
      await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId, issueId: f.issueId,
        heartbeatRunId: f.runId, status: "released", provider: "daytona", providerLeaseId: "sandbox-1", releasedAt: new Date() });
      return f;
    }],
  ] as const)("keeps the verification wait and refuses the confirmation when it cannot clear it (%s)", async (code, arrange) => {
    const f = await arrange();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const presentation = (await taskInterruptionPresentations(db, f.companyId, [issue!])).get(f.issueId);
    expect(presentation).toMatchObject({ userAction: null, canRetry: true, retryWait: { reason: "process_identity_missing" } });
    expect(presentation?.retryWait?.message).not.toContain("a board operator can confirm");
    const res = await request(app(board(f.companyId))).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`)
      .send({ runId: f.runId, stopEvidence: "No codex process for this task is running on the server host." });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ details: { code } });
    expect(await hasNativeLocalProcessStop(db, f.companyId, f.runId)).toBe(false);
  });

  it("judges every parked task on a list page together", async () => {
    const [a, b, c] = [await seed(), await seed(), await seed({ hostname: "another-server" })];
    const tasks = await db.select().from(issues).where(inArray(issues.id, [a.issueId, b.issueId, c.issueId]));
    const byCompany = await Promise.all([a, b, c].map(f => taskInterruptionPresentations(db, f.companyId,
      tasks.filter(task => task.companyId === f.companyId))));
    expect(byCompany.map((presentations, index) => presentations.get([a, b, c][index]!.issueId)?.userAction))
      .toEqual(["confirm_run_stopped", "confirm_run_stopped", null]);
  });

  it("reports a stop that was already recorded without recording another", async () => {
    const f = await seed();
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId, eventType: LOCAL_PROCESS_STOPPED,
      stream: "system", level: "info", message: "stopped", payload: { processPid: null, processGroupId: null, processStartedAt: null } });
    const res = await request(app(board(f.companyId))).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`)
      .send({ runId: f.runId, stopEvidence: "No codex process for this task is running on the server host." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ runId: f.runId, alreadyStopped: true });
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, LOCAL_PROCESS_STOPPED)))).toHaveLength(1);
  });

  it("lets only a board member with change access confirm the stop", async () => {
    const f = await seed();
    const body = { runId: f.runId, stopEvidence: "No codex process for this task is running on the server host." };
    const agent: Express.Request["actor"] = { type: "agent", agentId: f.agentId, companyId: f.companyId, runId: randomUUID(), source: "agent_jwt" };
    expect((await request(app(agent)).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`).send(body)).status).toBe(403);
    expect((await request(app(board(f.companyId, "viewer"))).post(`/api/issues/${f.issueId}/recovery-actions/confirm-run-stopped`)
      .send(body)).status).toBe(403);
    expect(await hasNativeLocalProcessStop(db, f.companyId, f.runId)).toBe(false);
  });
});
