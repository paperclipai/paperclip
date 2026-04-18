import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat process-adapter done tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat process-adapter done lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-process-adapter-done-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    issueStatus?: "in_progress" | "done" | "cancelled";
    issueCompletedAt?: Date | null;
    runStatus?: "succeeded" | "failed";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessBot",
      role: "engineer",
      status: "idle",
      adapterType: input?.adapterType ?? "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const runStatus = input?.runStatus ?? "succeeded";

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "finalized",
      runId,
      claimedAt: now,
      finishedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: runStatus,
      wakeupRequestId,
      contextSnapshot: { issueId },
      processPid: null,
      processGroupId: null,
      processLossRetryCount: 0,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
    });

    const issueStatus = input?.issueStatus ?? "in_progress";
    const issueCompletedAt = input?.issueCompletedAt !== undefined
      ? input.issueCompletedAt
      : issueStatus === "done"
        ? now
        : null;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test process adapter done transition",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "processbot",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
      completedAt: issueCompletedAt,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function loadRun(runId: string) {
    const row = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error(`run ${runId} not found`);
    return row;
  }

  async function loadIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  it("transitions issue to done on successful process-adapter run", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "process", runStatus: "succeeded" });
    const heartbeat = heartbeatService(db);
    const run = await loadRun(runId);

    await heartbeat.releaseIssueExecutionAndPromote(run);

    const issue = await loadIssue(issueId);
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();
  });

  it("does NOT transition issue when adapterType is not process (claude-code)", async () => {
    // CEO non-negotiable #2: the done-gate MUST be scoped to adapterType === "process".
    // Any other adapter (including claude_local/claude_code) must leave the issue untouched.
    const { runId, issueId } = await seedRunFixture({ adapterType: "claude_local", runStatus: "succeeded" });
    const heartbeat = heartbeatService(db);
    const run = await loadRun(runId);

    await heartbeat.releaseIssueExecutionAndPromote(run);

    const issue = await loadIssue(issueId);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.completedAt).toBeNull();
  });

  it("does NOT transition when process run failed", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "process", runStatus: "failed" });
    const heartbeat = heartbeatService(db);
    const run = await loadRun(runId);

    await heartbeat.releaseIssueExecutionAndPromote(run);

    const issue = await loadIssue(issueId);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.completedAt).toBeNull();
  });

  it("is idempotent — does not overwrite already-done/cancelled issues", async () => {
    const doneCompletedAt = new Date("2026-03-19T00:00:00.000Z");
    const { runId, issueId } = await seedRunFixture({
      adapterType: "process",
      runStatus: "succeeded",
      issueStatus: "done",
      issueCompletedAt: doneCompletedAt,
    });
    const heartbeat = heartbeatService(db);
    const run = await loadRun(runId);

    await heartbeat.releaseIssueExecutionAndPromote(run);

    const issue = await loadIssue(issueId);
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt?.toISOString()).toBe(doneCompletedAt.toISOString());
  });

  it("still releases the execution lock regardless of the done gate", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "process", runStatus: "succeeded" });
    const heartbeat = heartbeatService(db);
    const run = await loadRun(runId);

    await heartbeat.releaseIssueExecutionAndPromote(run);

    const issue = await loadIssue(issueId);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionAgentNameKey).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();
  });
});
