import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, resolveHeartbeatSchedulingSuppression } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat worktree suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat worktree suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function isHeartbeatRunEventFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk");
  }

  async function deleteHeartbeatRunsWithEvents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunEventFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-worktree-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(activityLog);
    await deleteHeartbeatRunsWithEvents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worktree Agent",
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
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function waitForTerminalRun(runId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (run && run.status !== "queued" && run.status !== "running") return run.status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  async function waitForRuntimeStateLastRun(agentId: string, runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await db
        .select({ lastRunId: agentRuntimeState.lastRunId })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      if (state?.lastRunId === runId) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("suppresses new assignment wakes in worktree instances without creating heartbeat runs", async () => {
    const { agentId, issueId } = await insertAgentAndIssue();
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "true" },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });

    expect(run).toBeNull();

    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.scheduling_suppressed",
    });
    expect(wakeup?.payload).toMatchObject({
      issueId,
      heartbeatSkip: { reason: "worktree_instance" },
    });
  });

  it("does not replay copied queued runs or timer wakes while worktree scheduling is suppressed", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "true" },
    });

    await heartbeat.resumeQueuedRuns();
    const tick = await heartbeat.tickTimers(new Date("2026-07-07T00:10:00Z"));

    expect(tick).toEqual({ checked: 0, enqueued: 0, skipped: 0 });

    const [copiedRun] = await db
      .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(copiedRun).toMatchObject({
      status: "queued",
      startedAt: null,
    });

    const runningCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runningCount).toBe(0);
  });

  it("still creates live-plane assignment runs when suppression is not active", async () => {
    const { agentId, issueId } = await insertAgentAndIssue();
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });

    expect(run).not.toBeNull();
    const terminalStatus = await waitForTerminalRun(run!.id);
    expect(["succeeded", null]).toContain(terminalStatus);

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    await waitForRuntimeStateLastRun(agentId, run!.id);
  });

  it("recognizes explicit restore-in-progress suppression", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true",
    })).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });
});
