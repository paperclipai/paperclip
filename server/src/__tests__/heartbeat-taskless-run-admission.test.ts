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
  instanceSettings,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat taskless admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Every run of an agent resolves the same workspace directory, so a taskless
// run admitted while an issue-bound run is live is a second process in one
// tree that holds no checkout on what it edits. These cases pin the admission
// rule that keeps them from overlapping.
describeEmbeddedPostgres("heartbeat taskless run admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-taskless-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(activityLog);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  // maxConcurrentRuns is pinned to 2 in every case below: with a single running
  // run that leaves exactly one free slot, which is the shape that admitted the
  // second process in the field.
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
      name: "Admission Agent",
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
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function insertRunningRun(input: {
    companyId: string;
    agentId: string;
    issueId?: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.issueId ? "assignment" : "timer",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      responsibleUserId: "responsible-user",
      contextSnapshot: input.issueId
        ? { issueId: input.issueId, wakeReason: "issue_assigned" }
        : { wakeReason: "heartbeat_timer" },
    });
    return runId;
  }

  async function insertQueuedTasklessRun(input: { companyId: string; agentId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });
    return runId;
  }

  async function readRun(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function countRunning() {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function waitForRunToLeaveQueued(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await readRun(runId);
      if (run && run.status !== "queued") return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readRun(runId);
  }

  it("leaves a taskless queued run queued while an issue-bound run is live", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    await insertRunningRun({ companyId, agentId, issueId });
    const tasklessRunId = await insertQueuedTasklessRun({ companyId, agentId });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await heartbeat.resumeQueuedRuns();

    const tasklessRun = await readRun(tasklessRunId);
    expect(tasklessRun).toMatchObject({ status: "queued", startedAt: null });
    expect(await countRunning()).toBe(1);
  }, 10_000);

  it("admits the taskless queued run when no issue-bound run is live", async () => {
    const { companyId, agentId } = await insertAgentAndIssue();
    await insertRunningRun({ companyId, agentId });
    const tasklessRunId = await insertQueuedTasklessRun({ companyId, agentId });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await heartbeat.resumeQueuedRuns();

    const tasklessRun = await waitForRunToLeaveQueued(tasklessRunId);
    expect(tasklessRun?.status).not.toBe("queued");
  }, 10_000);

  it("still admits an issue-bound run while an issue-bound run is live", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    await insertRunningRun({ companyId, agentId, issueId });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const boundRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });

    expect(boundRun).not.toBeNull();
    const claimed = await waitForRunToLeaveQueued(boundRun!.id);
    expect(claimed?.status).not.toBe("queued");
  }, 10_000);
});
