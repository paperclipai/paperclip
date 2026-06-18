import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
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

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Routine-execution lock-conflict test run.",
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
    `Skipping embedded Postgres routine-execution lock-conflict tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describeEmbeddedPostgres("heartbeat routine-execution lock conflict (TWB-748)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-routine-lock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Routine-execution lock-conflict test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(maxConcurrentRuns = 2) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RoutineRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRoutineExecutionIssue(input: {
    companyId: string;
    agentId: string;
    routineId: string;
    fingerprint: string;
    title: string;
    createdAt: Date;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      originKind: "routine_execution",
      originId: input.routineId,
      originFingerprint: input.fingerprint,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return issueId;
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      createdAt: input.createdAt,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: "issue_assigned",
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  it("resolves two concurrent same-fingerprint always_enqueue fires without an unhandled 23505", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(2);
    const routineId = randomUUID();
    const fingerprint = "same-dispatch-fingerprint";

    const firstIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      routineId,
      fingerprint,
      title: "Routine fire #1",
      createdAt: new Date("2026-06-14T10:00:00.000Z"),
    });
    const secondIssueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      routineId,
      fingerprint,
      title: "Routine fire #2 (duplicate fingerprint)",
      createdAt: new Date("2026-06-14T10:00:01.000Z"),
    });

    const first = await seedQueuedRun({
      companyId,
      agentId,
      issueId: firstIssueId,
      createdAt: new Date("2026-06-14T10:00:02.000Z"),
    });
    const second = await seedQueuedRun({
      companyId,
      agentId,
      issueId: secondIssueId,
      createdAt: new Date("2026-06-14T10:00:03.000Z"),
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const rows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [first.runId, second.runId]));
      const winner = rows.find((row) => row.status === "succeeded");
      const loser = rows.find((row) => row.status === "cancelled");
      return Boolean(winner && loser);
    });

    const runRows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [first.runId, second.runId]));

    // No run may end up "failed" — that is the regressed 23505 path that red-checked CI.
    expect(runRows.every((run) => run.status !== "failed")).toBe(true);

    const succeeded = runRows.filter((run) => run.status === "succeeded");
    const cancelledDuplicates = runRows.filter(
      (run) => run.status === "cancelled" && run.errorCode === "routine_execution_lock_conflict",
    );
    expect(succeeded).toHaveLength(1);
    expect(cancelledDuplicates).toHaveLength(1);
    expect(cancelledDuplicates[0]?.resultJson).toMatchObject({
      stopReason: "routine_execution_lock_conflict",
    });

    // The duplicate run never invoked the adapter.
    expect(countExecuteCallsForRun(cancelledDuplicates[0]!.id)).toBe(0);

    // The wakeup for the cancelled duplicate is skipped, not failed.
    const dupWakeup = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.runId,
          cancelledDuplicates[0]!.id,
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(dupWakeup?.status).toBe("skipped");

    // The duplicate routine-execution issue is cancelled so it does not orphan.
    // Once the winner reaches a terminal status, finalization may already have
    // released its lock; the invariant is that the cancelled duplicate never
    // retains an execution lock.
    const issueRows = await db
      .select({ id: issues.id, status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(inArray(issues.id, [firstIssueId, secondIssueId]));
    const cancelledIssues = issueRows.filter((issue) => issue.status === "cancelled");
    expect(cancelledIssues).toHaveLength(1);
    const lockedIssues = issueRows.filter((issue) => issue.executionRunId !== null);
    expect(lockedIssues.every((issue) => issue.executionRunId === succeeded[0]?.id)).toBe(true);
    expect(issueRows.filter((issue) => issue.executionRunId === cancelledDuplicates[0]?.id)).toHaveLength(0);
  });

  it("baseline: a single routine-execution fire claims the lock and runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(2);
    const routineId = randomUUID();
    const issueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      routineId,
      fingerprint: "solo-fingerprint",
      title: "Routine fire (solo)",
      createdAt: new Date("2026-06-14T11:00:00.000Z"),
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      createdAt: new Date("2026-06-14T11:00:02.000Z"),
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
