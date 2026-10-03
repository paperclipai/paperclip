import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  closeRegisteredClients,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shutdown admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat shutdown admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-shutdown-admission-");
  }, 60_000);

  beforeEach(() => { db = createDb(tempDb!.connectionString); });

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    stopTaskDrain();
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await closeRegisteredClients(tempDb!.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Drain Race Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work claimed just before a drain trips",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedQueuedRun() {
    const { companyId, agentId, issueId } = await seedAgentAndIssue();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId };
  }

  it.each([false, true])("keeps a real child from starting through a service created before or after shutdown (new service: %s)", async (newService) => {
    const { agentId, issueId } = await seedAgentAndIssue();
    const folder = await mkdtemp(path.join(tmpdir(), "shutdown-admission-child-"));
    const marker = path.join(folder, "started");
    await db.update(agents).set({ adapterConfig: {
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    } }).where(eq(agents.id, agentId));
    const owner = heartbeatService(db);
    let route = heartbeatService(db);
    try {
      await owner.prepareHotRestartShutdown("SIGTERM");
      if (newService) route = heartbeatService(db);
      await route.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system", requestedByActorId: "issue_assignment",
      });
      await route.resumeQueuedRuns();
      await owner.drainActiveRunExecutions();
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", startedAt: null });
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "queued", claimedAt: null });
      // A fresh server lifetime can consume the persisted request exactly once.
      const nextDb = createDb(tempDb!.connectionString);
      const nextServer = heartbeatService(nextDb);
      await nextServer.resumeQueuedRuns();
      await nextServer.drainActiveRunExecutions();
      expect(await readFile(marker, "utf8")).toBe("started");
      const finished = await nextDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[0].id));
      expect(finished).toHaveLength(1);
      expect(finished[0].status).toBe("succeeded");
    } finally {
      await owner.drainActiveRunExecutions();
      await rm(folder, { recursive: true, force: true });
    }
  }, 20_000);

  it("releases a claim when shutdown starts between queue admission and execution", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
    const heartbeat = heartbeatService(db);
    let preparation: Promise<unknown> | null = null;
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === runId && payload.status === "running") {
        preparation = heartbeat.prepareHotRestartShutdown("SIGTERM");
      }
    });
    try {
      await heartbeat.resumeQueuedRuns();
      await preparation;
      await heartbeat.drainActiveRunExecutions();
    } finally { unsubscribe(); }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(wake).toMatchObject({ status: "queued", claimedAt: null });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
  }, 20_000);
  it("cannot reopen shutdown admission through operator task-drain controls", async () => {
    const owner = heartbeatService(db);
    owner.closeRunAdmissionForShutdown();
    startTaskDrain({});
    stopTaskDrain();
    expect(await heartbeatService(db).resolveSchedulingSuppression()).toEqual({
      suppressed: true, reason: "server_shutdown",
    });
  });
  it("preserves database-restore quarantine during shutdown", async () => {
    const owner = heartbeatService(db);
    owner.closeRunAdmissionForShutdown();
    const restored = heartbeatService(db, { runtimeEnv: { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" } });
    expect(await restored.resolveSchedulingSuppression()).toEqual({
      suppressed: true, reason: "database_restore_in_progress",
    });
  });
  it("does not launch a child when shutdown starts during asynchronous preparation", async () => {
    const { agentId, issueId } = await seedAgentAndIssue();
    const folder = await mkdtemp(path.join(tmpdir(), "shutdown-preparation-child-"));
    const marker = path.join(folder, "started");
    await db.update(agents).set({ adapterConfig: {
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    } }).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    let unlock!: () => void;
    let ready!: () => void;
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const preparation = db.transaction(async (tx) => {
      await tx.execute(sql`lock table company_skills in access exclusive mode`);
      ready();
      await release;
    });
    let wake: Promise<unknown> | null = null;
    try {
      await locked;
      wake = heartbeat.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system", requestedByActorId: "issue_assignment",
      });
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%company_skills%'
          and pid <> pg_backend_pid()
        ) as blocked`);
        if (rows[0]?.blocked === true) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      const [preparing] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(preparing.status).toBe("running");
      heartbeat.closeRunAdmissionForShutdown();
      unlock();
      await preparation;
      await wake;
      await heartbeat.drainActiveRunExecutions();
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, preparing.id));
      expect(run).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
      const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
      expect(request).toMatchObject({ status: "queued", claimedAt: null });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.executionRunId).toBeNull();
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent.status).toBe("idle");
    } finally {
      unlock();
      await preparation;
      await wake;
      await heartbeat.drainActiveRunExecutions();
      await rm(folder, { recursive: true, force: true });
    }
  }, 20_000);

});
