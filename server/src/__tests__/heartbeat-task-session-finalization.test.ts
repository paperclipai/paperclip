import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { finalizeRunningRunWithTaskSession } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat task-session finalization tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat task-session finalization", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let observerDb!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-session-finalization-");
    db = createDb(tempDb.connectionString);
    observerDb = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await observerDb?.$client?.end?.({ timeout: 0 });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("never exposes a terminal run before its resumable task session", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const taskKey = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Session Finalizer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
      contextSnapshot: { issueId: taskKey, taskId: taskKey },
    });

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_delay_task_session_insert()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.5);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_delay_task_session_insert_trigger
      BEFORE INSERT ON agent_task_sessions
      FOR EACH ROW EXECUTE FUNCTION test_delay_task_session_insert();
    `));

    const finalization = finalizeRunningRunWithTaskSession(db, {
      runId,
      status: "succeeded",
      patch: { finishedAt: new Date(), sessionIdAfter: "session-atomic" },
      taskSessionMutation: {
        kind: "upsert",
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey,
        sessionParamsJson: { sessionId: "session-atomic" },
        sessionDisplayId: "session-atomic",
        lastRunId: runId,
        lastError: null,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const duringRun = await observerDb
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const duringSessions = await observerDb
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey));

    expect(duringRun?.status).toBe("running");
    expect(duringSessions).toHaveLength(0);

    const result = await finalization;
    expect(result.updated).toBe(true);
    expect(result.run?.status).toBe("succeeded");

    const finalRun = await observerDb
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const finalSession = await observerDb
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey))
      .then((rows) => rows[0]);

    expect(finalRun?.status).toBe("succeeded");
    expect(finalSession).toMatchObject({
      sessionDisplayId: "session-atomic",
      lastRunId: runId,
      lastError: null,
    });
  }, 20_000);

  it("does not expose a terminal run before an invalid task session is cleared", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const taskKey = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Session Clear Finalizer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
      contextSnapshot: { issueId: taskKey, taskId: taskKey },
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "session-to-clear" },
      sessionDisplayId: "session-to-clear",
      lastRunId: runId,
      lastError: null,
    });
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_delay_task_session_clear_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.5);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER test_delay_task_session_clear_update_trigger
      BEFORE UPDATE ON agent_task_sessions
      FOR EACH ROW EXECUTE FUNCTION test_delay_task_session_clear_update();
    `));

    const finalization = finalizeRunningRunWithTaskSession(db, {
      runId,
      status: "succeeded",
      patch: { finishedAt: new Date(), sessionIdAfter: null },
      taskSessionMutation: {
        kind: "clear",
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const duringRun = await observerDb
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const duringSession = await observerDb
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey))
      .then((rows) => rows[0]);

    expect(duringRun?.status).toBe("running");
    expect(duringSession?.sessionDisplayId).toBe("session-to-clear");

    const result = await finalization;
    expect(result.updated).toBe(true);
    expect(result.run?.status).toBe("succeeded");
    const finalSession = await observerDb
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey))
      .then((rows) => rows[0]);
    expect(finalSession).toMatchObject({
      sessionParamsJson: null,
      sessionDisplayId: null,
      lastRunId: runId,
      lastError: null,
    });
  }, 20_000);

  it("keeps a newer clear authoritative over an older first session insert", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Session Clear Finalizer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date("2026-07-21T11:00:00.000Z"),
        createdAt: new Date("2026-07-21T11:00:00.000Z"),
        contextSnapshot: { issueId: taskKey, taskId: taskKey },
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date("2026-07-21T11:01:00.000Z"),
        createdAt: new Date("2026-07-21T11:01:00.000Z"),
        contextSnapshot: { issueId: taskKey, taskId: taskKey },
      },
    ]);

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_delay_older_first_session_insert()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.last_run_id = '${olderRunId}'::uuid THEN
          PERFORM pg_sleep(0.5);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER test_delay_older_first_session_insert_trigger
      BEFORE INSERT ON agent_task_sessions
      FOR EACH ROW EXECUTE FUNCTION test_delay_older_first_session_insert();
    `));

    const olderFinalization = finalizeRunningRunWithTaskSession(db, {
      runId: olderRunId,
      status: "succeeded",
      patch: { finishedAt: new Date(), sessionIdAfter: "stale-older" },
      taskSessionMutation: {
        kind: "upsert",
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey,
        sessionParamsJson: { sessionId: "stale-older" },
        sessionDisplayId: "stale-older",
        lastRunId: olderRunId,
        lastError: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const newerClear = await finalizeRunningRunWithTaskSession(db, {
      runId: newerRunId,
      status: "succeeded",
      patch: { finishedAt: new Date(), sessionIdAfter: null },
      taskSessionMutation: {
        kind: "clear",
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey,
      },
    });
    const olderResult = await olderFinalization;

    expect(olderResult.updated).toBe(true);
    expect(newerClear.updated).toBe(true);
    const session = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey))
      .then((rows) => rows[0]);
    expect(session).toMatchObject({
      sessionParamsJson: null,
      sessionDisplayId: null,
      lastRunId: newerRunId,
      lastError: null,
    });
  }, 20_000);

  it("does not let an older overlapping run overwrite a newer task session", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Overlapping Session Finalizer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date("2026-07-21T10:00:00.000Z"),
        createdAt: new Date("2026-07-21T10:00:00.000Z"),
        contextSnapshot: { issueId: taskKey, taskId: taskKey },
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "on_demand",
        startedAt: new Date("2026-07-21T10:01:00.000Z"),
        finishedAt: new Date("2026-07-21T10:02:00.000Z"),
        createdAt: new Date("2026-07-21T10:01:00.000Z"),
        contextSnapshot: { issueId: taskKey, taskId: taskKey },
      },
    ]);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "session-newer" },
      sessionDisplayId: "session-newer",
      lastRunId: newerRunId,
      lastError: null,
    });

    const result = await finalizeRunningRunWithTaskSession(db, {
      runId: olderRunId,
      status: "succeeded",
      patch: { finishedAt: new Date(), sessionIdAfter: "session-older" },
      taskSessionMutation: {
        kind: "upsert",
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey,
        sessionParamsJson: { sessionId: "session-older" },
        sessionDisplayId: "session-older",
        lastRunId: olderRunId,
        lastError: null,
      },
    });

    expect(result.updated).toBe(true);
    const session = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey))
      .then((rows) => rows[0]);
    expect(session).toMatchObject({
      sessionDisplayId: "session-newer",
      lastRunId: newerRunId,
    });
  }, 20_000);
});
