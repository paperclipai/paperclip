import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockPublishLiveEvent = vi.hoisted(() => vi.fn());

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

vi.mock("../services/live-events.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/live-events.ts")>(
    "../services/live-events.ts",
  );
  return {
    ...actual,
    publishLiveEvent: mockPublishLiveEvent,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dequeue-status-check tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("claimQueuedRun dequeue-time issue-status check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dequeue-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Allow async side-effects from executeRun to settle before cleanup
    await new Promise((r) => setTimeout(r, 200));
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(issueStatus: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-10T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
      startedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("cancels a queued run when the issue is done", async () => {
    const { runId } = await seedFixture("done");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("already done");
  }, 15_000);

  it("cancels a queued run when the issue is cancelled", async () => {
    const { runId } = await seedFixture("cancelled");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("already cancelled");
  }, 15_000);

  it("does NOT cancel a queued run when the issue is in_progress", async () => {
    const { runId } = await seedFixture("in_progress");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    // The run should have been claimed (transitioned to running), not cancelled.
    // It may fail later due to adapter not being available, but the claim itself should succeed.
    expect(run?.status).not.toBe("cancelled");
  }, 15_000);

  it("does NOT publish a live event when cancelling a run for a done issue", async () => {
    const { runId } = await seedFixture("done");
    const heartbeat = heartbeatService(db);
    mockPublishLiveEvent.mockClear();

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");

    // The dequeue-time cancel should be silent — no heartbeat.run.status event
    // for cancelled runs with "already done" errors (internal cleanup, not user-facing).
    const cancelEvents = mockPublishLiveEvent.mock.calls.filter(
      (call: unknown[]) =>
        call[0]?.type === "heartbeat.run.status" &&
        call[0]?.payload?.runId === runId &&
        call[0]?.payload?.status === "cancelled",
    );
    expect(cancelEvents).toHaveLength(0);
  }, 15_000);
});
