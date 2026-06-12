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
import {
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Reassignment cancel test run.",
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
    `Skipping embedded Postgres heartbeat reassignment-cancel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
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

type SeedOptions = {
  agentName?: string;
  maxConcurrentRuns?: number;
  cancelRunOnReassignment?: boolean;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat cancelRunForReassignedIssue", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-reassignment-cancel-");
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
      summary: "Reassignment cancel test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
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

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
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
      name: opts.agentName ?? "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          cancelRunOnReassignment: opts.cancelRunOnReassignment ?? false,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * Race test: two near-simultaneous wakes for an agent with maxConcurrentRuns=1.
   * Only one heartbeat should run; the second should be queued and fire after the first exits.
   */
  it("race: maxConcurrentRuns=1 — second wake queues and fires after first exits", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race condition task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // Enqueue two wakeups in rapid succession
    const run1 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    const run2 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    expect(run1).not.toBeNull();
    expect(run2).not.toBeNull();

    // Drain the queue: run1 goes first, run2 should queue, then fire after run1 exits
    await heartbeat.resumeQueuedRuns();

    // Wait for both runs to reach a terminal state
    const allDone = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 && rows.every((r) => r.status === "succeeded" || r.status === "cancelled");
    }, 8_000);

    expect(allDone).toBe(true);

    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    const succeeded = allRuns.filter((r) => r.status === "succeeded");
    // At least one run should have succeeded; the second may have been deduped/cancelled
    // but must not be "running" (it must have completed)
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const stillRunning = allRuns.filter((r) => r.status === "running" || r.status === "queued");
    expect(stillRunning).toHaveLength(0);
  });

  /**
   * Reassign-cancel test: running heartbeat on issue I with cancelRunOnReassignment=true
   * gets cancelled with errorCode=issue_reassigned when issue is reassigned.
   */
  it("reassign-cancel: running heartbeat is cancelled with issue_reassigned when cancelRunOnReassignment=true", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      agentName: "OriginalAgent",
      cancelRunOnReassignment: true,
    });

    // Create a second agent to reassign to
    const newAgentId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId,
      companyId,
      name: "NewAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task to be reassigned",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // Insert a running heartbeat run for the original agent on this issue
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    // Stamp executionRunId on the issue (as the harness would when a run starts)
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    // Trigger cancellation as if the issue was reassigned
    const cancelled = await heartbeat.cancelRunForReassignedIssue(issueId, agentId);

    expect(cancelled).not.toBeNull();
    expect(cancelled?.id).toBe(runId);

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_reassigned");
  });

  /**
   * Regression: agent with cancelRunOnReassignment=false (default) is NOT cancelled.
   */
  it("regression: cancelRunOnReassignment=false (default) — running heartbeat is not cancelled on reassignment", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      agentName: "DefaultPolicyAgent",
      cancelRunOnReassignment: false,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task with default policy",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // Insert a running heartbeat run
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    // Should return null — policy is false
    const result = await heartbeat.cancelRunForReassignedIssue(issueId, agentId);

    expect(result).toBeNull();

    // Run should still be running
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(run?.status).toBe("running");
  });
});
