/**
 * Heartbeat queue starvation test
 *
 * Verifies that when one agent loops (rapidly re-queues runs while at its
 * maxConcurrentRuns limit), other agents' queued runs are still promoted by
 * resumeQueuedRuns() — i.e., no agent can starve the queue for other agents.
 *
 * GLA-035 / STA-110
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat queue starvation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat queue starvation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-starvation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Use TRUNCATE CASCADE to handle any FK-related tables created by async executeRun calls
    await db.execute(sql`
      TRUNCATE TABLE
        heartbeat_run_events,
        heartbeat_runs,
        agent_wakeup_requests,
        agent_runtime_state,
        company_skills,
        agents,
        companies
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed a company + agent with a given set of runs already in DB.
   */
  async function seedAgent(
    companyId: string,
    issuePrefix: string,
    opts: {
      agentName: string;
      runningRunCount?: number;
      queuedRunCount?: number;
      maxConcurrentRuns?: number;
    },
  ) {
    const agentId = randomUUID();
    const { runningRunCount = 0, queuedRunCount = 0, maxConcurrentRuns = 1 } = opts;

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { maxConcurrentRuns },
      },
      permissions: {},
    });

    const runIds: { id: string; status: "running" | "queued" }[] = [];

    // Seed already-running runs (simulating the looping agent's active slot)
    for (let i = 0; i < runningRunCount; i++) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {},
        startedAt: new Date(),
        updatedAt: new Date(),
      });
      runIds.push({ id: runId, status: "running" });
    }

    // Seed queued runs (waiting to be promoted)
    for (let i = 0; i < queuedRunCount; i++) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
        updatedAt: new Date(),
      });
      runIds.push({ id: runId, status: "queued" });
    }

    return { agentId, runIds };
  }

  it("promotes victim agent run even when looping agent fills its concurrent slot", async () => {
    // Arrange
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "StarvationTest",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Looping agent: 1 run already executing, 3 more queued (simulating a tight loop)
    const { runIds: looperRuns } = await seedAgent(companyId, issuePrefix, {
      agentName: "Looper",
      runningRunCount: 1,
      queuedRunCount: 3,
      maxConcurrentRuns: 1,
    });

    // Victim agent: 1 run waiting in queue
    const { runIds: victimRuns } = await seedAgent(companyId, issuePrefix, {
      agentName: "Victim",
      runningRunCount: 0,
      queuedRunCount: 1,
      maxConcurrentRuns: 1,
    });

    const heartbeat = heartbeatService(db);

    // Act
    await heartbeat.resumeQueuedRuns();

    // Assert: looper's queued runs stay queued (maxConcurrentRuns=1, already 1 running)
    const looperQueuedIds = looperRuns.filter((r) => r.status === "queued").map((r) => r.id);
    const looperQueuedAfter = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, looperQueuedIds));

    for (const run of looperQueuedAfter) {
      expect(run.status, `Looper queued run ${run.id} should stay queued (slot full)`).toBe("queued");
    }

    // Assert: victim run was promoted (startedAt set means it was claimed)
    const victimQueuedId = victimRuns.find((r) => r.status === "queued")!.id;
    const victimRunAfter = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, victimQueuedId))
      .then((rows) => rows[0] ?? null);

    expect(victimRunAfter, "Victim run should exist").not.toBeNull();
    expect(
      victimRunAfter!.startedAt,
      "Victim run startedAt should be set — run was promoted out of queue despite looper occupying its own slot",
    ).not.toBeNull();
  });

  it("promotes all victims before any looper second-slot run when looper has maxConcurrentRuns=2", async () => {
    // Arrange: looper has maxConcurrentRuns=2, 2 running (full), 3 queued
    // Two victim agents each have 1 queued run
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "MultiVictimTest",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Looper: fully occupied (running=2), plus 3 queued burst
    await seedAgent(companyId, issuePrefix, {
      agentName: "Looper",
      runningRunCount: 2,
      queuedRunCount: 3,
      maxConcurrentRuns: 2,
    });

    // Two victim agents
    const { runIds: victim1Runs } = await seedAgent(companyId, issuePrefix, {
      agentName: "Victim1",
      runningRunCount: 0,
      queuedRunCount: 1,
    });
    const { runIds: victim2Runs } = await seedAgent(companyId, issuePrefix, {
      agentName: "Victim2",
      runningRunCount: 0,
      queuedRunCount: 1,
    });

    const heartbeat = heartbeatService(db);

    // Act
    await heartbeat.resumeQueuedRuns();

    // Assert: both victim queued runs were promoted
    for (const [label, runs] of [
      ["Victim1", victim1Runs],
      ["Victim2", victim2Runs],
    ] as const) {
      const queuedId = runs.find((r) => r.status === "queued")!.id;
      const row = await db
        .select({ startedAt: heartbeatRuns.startedAt })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedId))
        .then((rows) => rows[0] ?? null);
      expect(
        row?.startedAt,
        `${label} queued run should have been promoted despite looper's full concurrent slots`,
      ).not.toBeNull();
    }
  });

  it("resumes looper queued run once its running run slot is empty", async () => {
    // Arrange: looper was running (slot occupied), now that run is gone (simulates it finished
    // and the in-memory record is cleaned up). The looper's queued run should now be promoted.
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "LooperResumeTest",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Looper: no running run (finished), 1 queued run (its next iteration)
    const { runIds: looperRuns } = await seedAgent(companyId, issuePrefix, {
      agentName: "Looper",
      runningRunCount: 0,
      queuedRunCount: 1,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const queuedId = looperRuns.find((r) => r.status === "queued")!.id;
    const row = await db
      .select({ startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedId))
      .then((rows) => rows[0] ?? null);

    expect(
      row?.startedAt,
      "Looper queued run should be promoted when its slot is free (simulating loop continuation)",
    ).not.toBeNull();
  });

  it("does not start more than maxConcurrentRuns for the looping agent in a single sweep", async () => {
    // Arrange: looper has maxConcurrentRuns=2 and 0 running runs, but 5 queued runs
    // Only 2 should be promoted per sweep.
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "ConcurrentCapTest",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const { agentId, runIds } = await seedAgent(companyId, issuePrefix, {
      agentName: "Looper",
      runningRunCount: 0,
      queuedRunCount: 5,
      maxConcurrentRuns: 2,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    // Exactly 2 runs should have been promoted (startedAt set); remaining 3 stay queued
    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId)));

    const promoted = allRuns.filter((r) => r.startedAt !== null);
    const stillQueued = allRuns.filter((r) => r.startedAt === null && r.status === "queued");

    expect(promoted.length).toBe(2);
    expect(stillQueued.length).toBe(3);
  });
});
