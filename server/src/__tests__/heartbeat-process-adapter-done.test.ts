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
import { runningProcesses } from "../adapters/index.ts";

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

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { getServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat process-adapter done tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
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
    runningProcesses.clear();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (runs.every((run) => run.status !== "queued" && run.status !== "running")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    issueStatus?: "in_progress" | "done" | "cancelled";
    issueCompletedAt?: Date | null;
    runStatus?: "queued" | "running";
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
      status: input?.agentStatus ?? "idle",
      adapterType: input?.adapterType ?? "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const runStatus = input?.runStatus ?? "queued";
    const wakeupStatus = runStatus === "queued" ? "queued" : "claimed";

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: wakeupStatus,
      runId,
      claimedAt: runStatus === "running" ? now : null,
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
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
      completedAt: issueCompletedAt,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("transitions issue to done on successful process-adapter run", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "process" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();
  });

  it("does NOT transition issue when adapterType is not process (claude-code)", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "claude_local" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("in_progress");
    expect(issue?.completedAt).toBeNull();
  });

  it("does NOT transition when process run failed", async () => {
    // executeRun calls getServerAdapter twice per run (once for session codec
    // lookup, once for adapter invocation), so stub both calls to the
    // failing-exit adapter for this test.
    const failingAdapter = {
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "process exited with code 1",
        provider: "test",
        model: "test-model",
      })),
    } as unknown as ReturnType<typeof getServerAdapter>;
    vi.mocked(getServerAdapter)
      .mockReturnValueOnce(failingAdapter)
      .mockReturnValueOnce(failingAdapter);

    const { runId, issueId } = await seedRunFixture({ adapterType: "process" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("in_progress");
    expect(issue?.completedAt).toBeNull();
  });

  it("is idempotent — does not overwrite already-done/cancelled issues", async () => {
    const doneCompletedAt = new Date("2026-03-19T00:00:00.000Z");
    const { runId, issueId } = await seedRunFixture({
      adapterType: "process",
      runStatus: "running",
      issueStatus: "done",
      issueCompletedAt: doneCompletedAt,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();
  });

  it("still releases the execution lock regardless of the done gate", async () => {
    const { runId, issueId } = await seedRunFixture({ adapterType: "process" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBeNull();
  });
});
