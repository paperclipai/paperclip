import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  createDb,
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
    `Skipping embedded Postgres dedup-window tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("enqueueWakeup dedup window for mention-wake race", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dedup-window-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
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

  async function seedAgentWithBlockedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      runtimeConfig: { heartbeat: { enabled: true, maxConcurrentRuns: 1, wakeOnDemand: true } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Insert a running run to block the queue (maxConcurrentRuns=1)
    const blockingRunId = randomUUID();
    const blockingWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: blockingWakeupId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "blocking_run",
      payload: {},
      status: "queued",
      runId: blockingRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: blockingRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId: blockingWakeupId,
      contextSnapshot: {},
    });

    return { companyId, agentId, issueId, blockingRunId };
  }

  it("coalesces a mention-wake into an existing queued run for the same issue", async () => {
    const { agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // Assignment wake — goes through lock path, creates a queued run
    // (can't start because a run is already running and maxConcurrentRuns=1)
    const assignmentRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });
    expect(assignmentRun).toBeTruthy();
    expect(assignmentRun!.status).toBe("queued");

    // Mention wake — goes through non-lock path (bypassIssueExecutionLock)
    // Should coalesce into the existing queued assignment run
    const mentionRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "mention",
      reason: "issue_comment_mentioned",
      contextSnapshot: { issueId, wakeCommentId: randomUUID() },
      payload: { issueId },
    });

    expect(mentionRun!.id).toBe(assignmentRun!.id);

    // Verify only one queued run exists for this agent+issue
    const queuedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "queued"),
        ),
      );
    expect(queuedRuns).toHaveLength(1);

    // Verify the wakeup request was recorded as coalesced
    const coalescedRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      );
    expect(coalescedRequests.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("creates a follow-up queued run when wakeCommentId is set and current run is running (not queued)", async () => {
    const { agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // Mention-wake with no prior queued run for this issue should create a new run
    const mentionRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "mention",
      reason: "issue_comment_mentioned",
      contextSnapshot: { issueId, wakeCommentId: randomUUID() },
      payload: { issueId },
    });
    expect(mentionRun).toBeTruthy();
    expect(mentionRun!.status).toBe("queued");
  }, 15_000);

  it("does not coalesce mention-wake for a different issue", async () => {
    const { companyId, agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);
    const otherIssueId = randomUUID();

    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    // Assignment-wake for issue 1
    const assignmentRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    // Mention-wake for a different issue should NOT coalesce
    const mentionRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "mention",
      reason: "issue_comment_mentioned",
      contextSnapshot: { issueId: otherIssueId, wakeCommentId: randomUUID() },
      payload: { issueId: otherIssueId },
    });

    expect(mentionRun!.id).not.toBe(assignmentRun!.id);
  }, 15_000);

  it("two issue-execution wakes for same agent+issue produce 1 run (regression guard)", async () => {
    const { agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // First assignment wake — goes through issue execution lock path
    const run1 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });
    expect(run1).toBeTruthy();
    expect(run1!.status).toBe("queued");

    // Second assignment wake — same agent+issue, goes through same lock path
    // Should coalesce into the existing queued run
    const run2 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "automation",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });
    expect(run2).toBeTruthy();
    expect(run2!.id).toBe(run1!.id);

    // Verify only one queued run exists
    const queuedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "queued"),
        ),
      );
    expect(queuedRuns).toHaveLength(1);
  }, 15_000);

  it("timer wake + issue-execution wake produce separate runs (expected)", async () => {
    const { agentId, issueId, blockingRunId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // Timer wake — no issueId, goes through non-issue path.
    // Coalesces into the blocking run (same null taskKey scope), returns running.
    const timerRun = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "heartbeat_timer",
      reason: "heartbeat_timer",
      contextSnapshot: {},
      payload: {},
    });
    expect(timerRun).toBeTruthy();
    expect(timerRun!.id).toBe(blockingRunId);

    // Assignment wake — has issueId, goes through issue execution lock path
    const assignmentRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });
    expect(assignmentRun).toBeTruthy();

    // Timer and assignment runs are separate — timer has no issueId,
    // so cross-path dedup correctly does not merge them
    expect(timerRun!.id).not.toBe(assignmentRun!.id);
  }, 15_000);

  it("cross-path dedup catches a queued run outside the 5s window", async () => {
    const { companyId, agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // Directly insert a queued run with createdAt older than 5 seconds
    // to simulate a run that the 5s dedup window would miss
    const oldRunId = randomUUID();
    const oldWakeupId = randomUUID();
    const sixSecondsAgo = new Date(Date.now() - 6_000);
    await db.insert(agentWakeupRequests).values({
      id: oldWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId: oldRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: oldWakeupId,
      contextSnapshot: { issueId },
      createdAt: sixSecondsAgo,
    });

    // Mention-wake should coalesce via the cross-path dedup check
    // (not the 5s window, since the run is older than 5s)
    const mentionRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "mention",
      reason: "issue_comment_mentioned",
      contextSnapshot: { issueId, wakeCommentId: randomUUID() },
      payload: { issueId },
    });

    expect(mentionRun!.id).toBe(oldRunId);
  }, 15_000);

  it("dedup window catches a queued run inserted directly (simulating race)", async () => {
    const { companyId, agentId, issueId } = await seedAgentWithBlockedQueue();
    const heartbeat = heartbeatService(db);

    // Directly insert a queued run (simulating the lock path's output that
    // was committed between the initial activeRuns query and the dedup check)
    const raceRunId = randomUUID();
    const raceWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: raceWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId: raceRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: raceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: raceWakeupId,
      contextSnapshot: { issueId },
    });

    // Mention-wake should coalesce into the existing queued run via either
    // the standard path or the dedup window check
    const mentionRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "mention",
      reason: "issue_comment_mentioned",
      contextSnapshot: { issueId, wakeCommentId: randomUUID() },
      payload: { issueId },
    });

    expect(mentionRun!.id).toBe(raceRunId);
  }, 15_000);
});
