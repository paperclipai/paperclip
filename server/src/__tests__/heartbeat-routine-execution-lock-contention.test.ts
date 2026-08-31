import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Regression coverage for routine execution-lock contention. A routine with
// concurrencyPolicy=always_enqueue can have a later fire's execution issue claimed
// while a prior fire's execution issue still holds the routine execution lock
// (execution_run_id set). The null->set lock stamp then collides with the
// issues_open_routine_execution_uq partial unique index. Before the fix this raised
// an unhandled 23505 ("Failed query") that killed the run and dropped the digest
// with no visible error; now the contended run is left queued and retried once the
// prior lock frees.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Routine execution-lock contention test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine execution-lock contention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat routine execution-lock contention", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-exec-lock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Routine execution-lock contention test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "issues",
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduled Sweeper",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          // Allow a free concurrency slot so claimQueuedRun actually runs for the
          // contended fire (the lock holder below is a terminal run, so it does not
          // consume a slot).
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  // Seeds an open routine-execution issue for a routine identity. When a lock
  // holder run id is provided the issue holds the routine execution lock.
  async function seedRoutineExecutionIssue(input: {
    companyId: string;
    agentId: string;
    originId: string;
    originFingerprint: string;
    lockHeldByRunId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Scheduled sweep — 3x daily",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      originKind: "routine_execution",
      originId: input.originId,
      originFingerprint: input.originFingerprint,
      executionRunId: input.lockHeldByRunId ?? null,
      executionAgentNameKey: input.lockHeldByRunId ? "scheduled-sweeper" : null,
      executionLockedAt: input.lockHeldByRunId ? new Date() : null,
    });
    return issueId;
  }

  async function seedQueuedRun(input: { companyId: string; agentId: string; issueId: string }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  // Terminal heartbeat run that a stale routine execution lock points at.
  async function seedLockHolderRun(input: { companyId: string; agentId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    return runId;
  }

  it("defers a contended routine-execution fire instead of failing it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originId = randomUUID();
    const originFingerprint = randomUUID();

    // Prior fire's execution issue still holds the routine lock.
    const holderRunId = await seedLockHolderRun({ companyId, agentId });
    const priorIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originId,
      originFingerprint,
      lockHeldByRunId: holderRunId,
    });

    // Next fire's execution issue + its queued run.
    const nextIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originId,
      originFingerprint,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId: nextIssueId,
    });

    await heartbeat.resumeQueuedRuns();
    // Give any (incorrect) background execution a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [nextIssue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, nextIssueId));
    const [priorIssue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, priorIssueId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    // Contended fire is left queued for retry, not failed/cancelled.
    expect(run?.status).toBe("queued");
    expect(run?.errorCode).toBeNull();
    // The lock was not stolen from the prior issue, and the next issue never
    // acquired it.
    expect(nextIssue?.executionRunId).toBeNull();
    expect(priorIssue?.executionRunId).toBe(holderRunId);
    // No adapter execution happened for the deferred run.
    expect(countExecuteCallsForRun(runId)).toBe(0);
    // The wakeup is still pending (queued), not skipped/failed.
    expect(wakeup?.status).toBe("queued");
  });

  it("runs the deferred fire once the prior routine lock is released", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originId = randomUUID();
    const originFingerprint = randomUUID();

    const holderRunId = await seedLockHolderRun({ companyId, agentId });
    const priorIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originId,
      originFingerprint,
      lockHeldByRunId: holderRunId,
    });
    const nextIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originId,
      originFingerprint,
    });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: nextIssueId });

    // First pass: contended, deferred (stays queued).
    await heartbeat.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [deferred] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(deferred?.status).toBe("queued");

    // Prior fire completes and releases the routine lock.
    await db
      .update(issues)
      .set({ status: "done", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, priorIssueId));

    // Second pass: the deferred run now claims the lock and executes.
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return run?.status === "succeeded";
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
