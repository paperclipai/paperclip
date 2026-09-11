import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  costEvents,
  createDb,
  deliveryRepairAttempts,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
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
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
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
          "cost_events",
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

      // Heartbeat completion can write issue-thread comments shortly after the
      // run leaves queued/running. Retry the dependent deletes once those land.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let beforeContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;
  let afterContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      beforeResolvedInteractionContinuationDispatchCheck: async (input) => {
        await beforeContinuationDispatchCheck?.(input);
      },
      afterResolvedInteractionContinuationDispatchCheck: async (input) => {
        await afterContinuationDispatchCheck?.(input);
      },
    });
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    beforeContinuationDispatchCheck = null;
    afterContinuationDispatchCheck = null;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
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
    await cleanupHeartbeatInvalidationFixture(db);
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
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("checks guarded issue status and assignee under the enqueue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parkedIssueId = randomUUID();
    const reassignedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: parkedIssueId,
        companyId,
        title: "Parked connection intent",
        status: "backlog" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
      },
      {
        id: reassignedIssueId,
        companyId,
        title: "Reassigned connection intent",
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: null,
      },
    ]);

    for (const issueId of [parkedIssueId, reassignedIssueId]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, interactionId: randomUUID() },
        contextSnapshot: { issueId, wakeReason: "issue_commented" },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
        issueStateGuard: {
          statuses: ["in_progress"],
          assigneeAgentId: agentId,
        },
      });
      expect(run).toBeNull();
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)).toEqual([
      { status: "skipped", reason: "issue_state_guard_mismatch" },
      { status: "skipped", reason: "issue_state_guard_mismatch" },
    ]);
  });

  it("cancels a resolved connection-intent wake parked before queued-run claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked after enqueue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));
    await heartbeat.resumeQueuedRuns();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("does not re-open a resolved connection-intent issue parked after claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked between claim and checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION park_connection_intent_after_claim()
      RETURNS trigger AS $trigger$
      BEGIN
        IF NEW.id = '${runId}'::uuid AND NEW.status = 'running' THEN
          UPDATE issues SET status = 'backlog' WHERE id = '${issueId}'::uuid;
        END IF;
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;

      CREATE TRIGGER park_connection_intent_after_claim
      AFTER UPDATE OF status ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION park_connection_intent_after_claim();
    `));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run, wakeup] = await Promise.all([
        db.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
      ]);
      return run?.status === "cancelled" && wakeup?.status === "skipped";
    });

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    {
      mutation: "parked",
      expectedErrorCode: "issue_not_in_progress",
      expectedError: "no longer in_progress",
    },
    {
      mutation: "reassigned",
      expectedErrorCode: "issue_assignee_changed",
      expectedError: "changed assignee",
    },
  ])(
    "cancels a resolved connection-intent wake $mutation after checkout but before adapter dispatch",
    async ({ mutation, expectedErrorCode, expectedError }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      if (mutation === "reassigned") {
        await db.insert(agents).values({
          id: replacementAgentId,
          companyId,
          name: "ReplacementCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        });
      }
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Connection intent ${mutation} at final dispatch`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      const { runId, wakeupRequestId } = await seedQueuedRun({
        companyId,
        agentId,
        issueId,
        wakeReason: "issue_commented",
        invocationSource: "automation",
        contextExtras: {
          interactionId: randomUUID(),
          interactionKind: "connection_intent",
          interactionStatus: "accepted",
          interactionResolvedAt: "2026-08-28T13:30:00.000Z",
          mutation: "interaction",
          source: "connection_intent.resolved",
        },
      });
      beforeContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
        expect(guardedRunId).toBe(runId);
        expect(guardedIssueId).toBe(issueId);
        await db
          .update(issues)
          .set(mutation === "parked"
            ? { status: "backlog", updatedAt: new Date() }
            : { assigneeAgentId: replacementAgentId, updatedAt: new Date() })
          .where(eq(issues.id, issueId));
      };

      await heartbeat.resumeQueuedRuns();
      await waitForCondition(async () => {
        const [run, wakeup] = await Promise.all([
          db.select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId))
            .then((rows) => rows[0] ?? null),
          db.select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, wakeupRequestId))
            .then((rows) => rows[0] ?? null),
        ]);
        return run?.status === "cancelled" && wakeup?.status === "skipped";
      });

      const [run, wakeup, issue] = await Promise.all([
        db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(run).toMatchObject({ status: "cancelled", errorCode: expectedErrorCode });
      expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining(expectedError) });
      expect(issue).toMatchObject(mutation === "parked"
        ? { status: "backlog", assigneeAgentId: agentId }
        : { status: "in_progress", assigneeAgentId: replacementAgentId });
      expect(countExecuteCallsForRun(runId)).toBe(0);
    },
  );

  it("releases the final continuation gate at non-process adapter dispatch", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked at the atomic dispatch gate",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    const ordering: string[] = [];
    let parkPromise: Promise<unknown> | null = null;
    afterContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
      expect(guardedRunId).toBe(runId);
      expect(guardedIssueId).toBe(issueId);
      ordering.push("validated");
      parkPromise = Promise.resolve(
        db
          .update(issues)
          .set({
            status: "backlog",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId))
          .returning({ id: issues.id }),
      ).then((rows) => {
        expect(rows).toHaveLength(1);
        ordering.push("parked");
      });
      // Give the concurrent update a chance to reach the row lock. It must
      // remain blocked until the adapter reports actual remote dispatch.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(ordering).toEqual(["validated"]);
    };
    mockAdapterExecute.mockImplementation(async (context) => {
      ordering.push("preparing");
      // Model asynchronous adapter setup before the child process exists.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(ordering).toEqual(["validated", "preparing"]);
      ordering.push("dispatched");
      context.onDispatch?.();
      await waitForCondition(async () => ordering.includes("parked"));
      expect(ordering).toEqual(["validated", "preparing", "dispatched", "parked"]);
      ordering.push("settled");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Atomic continuation dispatch test run.",
        provider: "test",
        model: "test-model",
      };
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
    await parkPromise;

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("backlog");
    expect(ordering).toEqual(["validated", "preparing", "dispatched", "parked", "settled"]);
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    { name: "pending addressed review", status: "pending", wrongRecipient: false, humanOnly: false, dispatched: true },
    { name: "resolved review", status: "accepted", wrongRecipient: false, humanOnly: false, dispatched: false },
    { name: "different recipient", status: "pending", wrongRecipient: true, humanOnly: false, dispatched: false },
    { name: "human-only review", status: "pending", wrongRecipient: false, humanOnly: true, dispatched: false },
  ])("checks persisted review authority before dispatch: $name", async ({ status, wrongRecipient, humanOnly, dispatched }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Reviewer" });
    const authorId = randomUUID();
    await db.insert(agents).values({
      id: authorId, companyId, name: "Author", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {},
    });
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review without transferring implementation",
      status: "in_review", priority: "medium", assigneeAgentId: authorId,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status,
      createdByAgentId: authorId, addresseeAgentId: wrongRecipient ? authorId : agentId,
      effectiveResolverPolicy: humanOnly ? "human_only" : "anyone",
      payload: { version: 1, prompt: "Review the committed implementation" },
    });
    const { runId } = await seedQueuedRun({
      companyId, agentId, issueId, wakeReason: "interaction_pending",
      contextExtras: { interactionId, interactionKind: "request_confirmation" },
    });
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return run?.status === "succeeded" || run?.status === "cancelled" || run?.status === "failed";
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe(dispatched ? "succeeded" : "cancelled");
    expect(countExecuteCallsForRun(runId)).toBe(dispatched ? 1 : 0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(authorId);
    expect(issue.status).toBe("in_review");
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
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
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("still runs comment-driven wakes on in_review issues even when the agent is no longer the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
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
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
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

  it("cancels queued continuation recovery when the continuation summary parks executor work for review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("continuation summary says the executor should wait");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  /**
   * A live delivery unit for this issue with one actionable repair attempt.
   * The attempt carries the candidate generation and head it was dispatched
   * for, which is what the queued-run check fences against.
   */
  async function seedDeliveryRepairIntent(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    unitStatus?: string;
    unitGeneration?: number;
    attemptGeneration?: number;
    headSha?: string;
  }) {
    const repositoryId = randomUUID();
    const unitId = randomUUID();
    const headSha = input.headSha ?? "a".repeat(40);
    const unitGeneration = input.unitGeneration ?? 2;
    await db.insert(deliveryRepositories).values({
      id: repositoryId,
      companyId: input.companyId,
      provider: "github",
      host: "github.com",
      owner: "example",
      name: `repo-${repositoryId.slice(0, 8)}`,
    });
    await db.insert(deliveryUnits).values({
      id: unitId,
      companyId: input.companyId,
      repositoryId,
      primaryIssueId: input.issueId,
      targetBranch: "main",
      sourceBranch: `delivery/${input.issueId}`,
      status: input.unitStatus ?? "blocked",
      headSha,
      candidateGeneration: unitGeneration,
      ownerAgentId: input.agentId,
    });
    await db.insert(deliveryUnitIssues).values({
      companyId: input.companyId,
      unitId,
      issueId: input.issueId,
      role: "primary",
    });
    await db.insert(deliveryRepairAttempts).values({
      companyId: input.companyId,
      unitId,
      reasonCode: "review_blocking_findings",
      attempt: 1,
      status: "dispatched",
      candidateGeneration: input.attemptGeneration ?? unitGeneration,
      headSha,
      ownerAgentId: input.agentId,
    });
    return { unitId, repositoryId, headSha };
  }

  /** The saved prose that parks executor work: "wait for reviewer feedback". */
  async function seedParkingContinuationSummary(input: {
    companyId: string;
    agentId: string;
    issueId: string;
  }) {
    await seedContinuationSummary({
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });
  }

  async function seedParkedContinuation(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    contextExtras?: Record<string, unknown>;
  }) {
    await seedParkingContinuationSummary(input);
    return await seedQueuedRun({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
        ...(input.contextExtras ?? {}),
      },
    });
  }

  async function settledRun(runId: string) {
    return await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function seedParkableIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  it("runs the parked continuation when a current delivery repair intent owns the work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    await seedDeliveryRepairIntent({ companyId, agentId, issueId });
    await seedParkingContinuationSummary({ companyId, issueId, agentId });

    // Production wake path: the continuation is queued, claimed, and only then
    // asked whether the saved prose should park it.
    const run = await heartbeat.invoke(
      agentId,
      "automation",
      {
        issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
      "system",
    );
    expect(run).not.toBeNull();
    await waitForCondition(async () => {
      const settled = await settledRun(run!.id);
      return settled !== null && !["queued", "running"].includes(settled.status);
    });

    const settled = await settledRun(run!.id);
    // The saved prose says "wait for review", but the controller has a live
    // repair wake for the current candidate: parking it would strand the issue.
    expect(settled?.errorCode).not.toBe("issue_continuation_waiting_on_review");
    expect(
      countExecuteCallsForRun(run!.id),
      `continuation did not reach the adapter (status=${settled?.status}, errorCode=${settled?.errorCode ?? "none"})`,
    ).toBe(1);
  });

  it("keeps parking the continuation when the repair attempt is from an older candidate generation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    // A -> B -> A: the unit is back at generation 2, the attempt was dispatched
    // for generation 1, so it is not the current repair intent.
    await seedDeliveryRepairIntent({ companyId, agentId, issueId, attemptGeneration: 1 });
    const { runId } = await seedParkedContinuation({ companyId, agentId, issueId });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const run = await settledRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking the continuation when the declared repair carrier is stale", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    const { unitId, headSha } = await seedDeliveryRepairIntent({ companyId, agentId, issueId });
    // The wake declares a generation the persisted unit has moved past.
    const { runId } = await seedParkedContinuation({
      companyId,
      agentId,
      issueId,
      contextExtras: {
        deliveryRepair: {
          unitId,
          candidateGeneration: 1,
          headSha,
          reasonCode: "review_blocking_findings",
          attempt: 1,
        },
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const run = await settledRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking the continuation when the linked delivery unit is terminal", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    await seedDeliveryRepairIntent({ companyId, agentId, issueId, unitStatus: "merged" });
    const { runId } = await seedParkedContinuation({ companyId, agentId, issueId });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const run = await settledRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("runs accepted-interaction continuation recovery despite a pre-acceptance review park", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approved implementation resumes",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
        mutation: "interaction",
        interactionId: randomUUID(),
        interactionResolvedAt: "2026-03-19T00:05:00.000Z",
      },
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

  async function seedReviewerAgent(companyId: string) {
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "RecoveryReviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return reviewerAgentId;
  }

  async function seedSucceededRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId?: string;
    at?: Date;
    contextExtras?: Record<string, unknown>;
    livenessState?: null;
  }) {
    const runId = input.runId ?? randomUUID();
    const at = input.at ?? new Date("2026-09-10T21:33:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: at,
      finishedAt: new Date(at.getTime() + 1_000),
      createdAt: at,
      updatedAt: new Date(at.getTime() + 1_000),
      livenessState: input.livenessState ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: "issue_comment",
        ...(input.contextExtras ?? {}),
      },
    });
    return runId;
  }

  async function seedReviewInteraction(input: {
    companyId: string;
    issueId: string;
    kind?: string;
    status?: string;
    continuationPolicy?: string;
    addresseeAgentId?: string | null;
    createdByAgentId?: string | null;
    resolvedByAgentId?: string | null;
    resolvedByRunId?: string | null;
    sourceRunId?: string | null;
    resolvedAt?: Date | null;
    createdAt?: Date;
    effectiveResolverPolicy?: string;
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: input.kind ?? "request_confirmation",
      status: input.status ?? "accepted",
      continuationPolicy: input.continuationPolicy ?? "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: input.effectiveResolverPolicy ?? "anyone",
      resolverPolicyProvenance: "explicit",
      addresseeAgentId: input.addresseeAgentId ?? null,
      addresseeUserId: null,
      createdByAgentId: input.createdByAgentId ?? null,
      resolvedByAgentId: input.resolvedByAgentId ?? null,
      resolvedByRunId: input.resolvedByRunId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      payload: {
        version: 1,
        prompt: "Independently verify the existing bounded coordination repair",
        review: {
          candidate: { workspaceKey: "recovery-repair", revision: "8cf1afb0743ca64a749d7e2bad2f1c5e2fe0e740" },
          expectedModel: "openai-codex/gpt-5.6-sol",
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: input.resolvedAt === undefined ? new Date("2026-09-10T21:33:33.000Z") : input.resolvedAt,
      createdAt: input.createdAt ?? new Date("2026-09-10T21:31:51.000Z"),
      updatedAt: input.resolvedAt === undefined ? new Date("2026-09-10T21:33:33.000Z") : input.resolvedAt ?? input.createdAt ?? new Date("2026-09-10T21:31:51.000Z"),
    });
    return interactionId;
  }

  /** One queued continuation parked by prose while the durable review state is `seed`. */
  async function seedParkedContinuationWithReview(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    seed: (ctx: { companyId: string; agentId: string; issueId: string }) => Promise<void>;
  }) {
    await seedParkingContinuationSummary(input);
    await input.seed({ companyId: input.companyId, agentId: input.agentId, issueId: input.issueId });
    return await seedQueuedRun({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: { retryReason: "issue_continuation_needed" },
    });
  }

  // COD-204: accepted interaction c422c611 accepted at 21:33:33 by the addressed
  // reviewer, then the 21:36 continuation was cancelled for the summary's
  // pre-acceptance "wait for reviewer feedback" prose.
  it("resumes the parked continuation when the current review was accepted by the addressed reviewer", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const reviewedRunId = await seedSucceededRun({ companyId, agentId, issueId });
    const reviewerRunId = await seedSucceededRun({ companyId, agentId: reviewerAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          addresseeAgentId: reviewerAgentId,
          createdByAgentId: agentId,
          resolvedByAgentId: reviewerAgentId,
          resolvedByRunId: reviewerRunId,
          sourceRunId: reviewedRunId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "succeeded");

    const settled = await settledRun(runId);
    expect(settled?.errorCode).not.toBe("issue_continuation_waiting_on_review");
    expect(settled?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(runId)).toBe(1);

    const [claimed] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(claimed?.contextSnapshot).toMatchObject({
      acceptedReviewResume: {
        source: "queued_run_staleness_gate",
        resolverKind: "agent",
        resolvedByAgentId: reviewerAgentId,
      },
    });
  });

  it("keeps parking the continuation while a pending review request supersedes the accepted one", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const reviewerRunId = await seedSucceededRun({ companyId, agentId: reviewerAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: reviewerAgentId,
          resolvedByRunId: reviewerRunId,
          createdAt: new Date("2026-09-10T21:20:00.000Z"),
          resolvedAt: new Date("2026-09-10T21:21:00.000Z"),
        });
        await seedReviewInteraction({
          companyId,
          issueId,
          status: "pending",
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: null,
          resolvedAt: null,
          createdAt: new Date("2026-09-10T21:35:00.000Z"),
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking when the newest review request ended non-accepted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const reviewerRunId = await seedSucceededRun({ companyId, agentId: reviewerAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: reviewerAgentId,
          resolvedByRunId: reviewerRunId,
          createdAt: new Date("2026-09-10T21:07:56.000Z"),
          resolvedAt: new Date("2026-09-10T21:28:33.380Z"),
          status: "expired",
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking when the acceptance did not come from the addressed reviewer", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const otherAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const otherRunId = await seedSucceededRun({ companyId, agentId: otherAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: otherAgentId,
          resolvedByRunId: otherRunId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking when a run's own agent resolved the review of its own evidence", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    const evidenceRunId = await seedSucceededRun({ companyId, agentId, issueId });
    const selfResolveRunId = await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      at: new Date("2026-09-10T21:32:00.000Z"),
    });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          createdByAgentId: agentId,
          sourceRunId: evidenceRunId,
          resolvedByAgentId: agentId,
          resolvedByRunId: selfResolveRunId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking when a legacy self-addressed review was resolved by the evidence run's agent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedParkableIssue(companyId, agentId);
    const evidenceRunId = await seedSucceededRun({ companyId, agentId, issueId });
    const selfResolveRunId = await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      at: new Date("2026-09-10T21:32:00.000Z"),
    });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          // Legacy row: the evidence run's own agent is also the addressee. The
          // addressee match must not launder self-review into acceptance.
          addresseeAgentId: agentId,
          createdByAgentId: agentId,
          sourceRunId: evidenceRunId,
          resolvedByAgentId: agentId,
          resolvedByRunId: selfResolveRunId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking while a linked approval is still pending", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const reviewerRunId = await seedSucceededRun({ companyId, agentId: reviewerAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: reviewerAgentId,
          resolvedByRunId: reviewerRunId,
        });
        const approvalId = randomUUID();
        await db.insert(approvals).values({
          id: approvalId,
          companyId,
          type: "issue_delivery",
          status: "pending",
          payload: { title: "Approve the delivery" },
        });
        await db.insert(issueApprovals).values({
          companyId,
          issueId,
          approvalId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("keeps parking when the resolver policy excludes the agent that resolved the review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const reviewerRunId = await seedSucceededRun({ companyId, agentId: reviewerAgentId, issueId });

    const { runId } = await seedParkedContinuationWithReview({
      companyId,
      agentId,
      issueId,
      seed: async () => {
        await seedReviewInteraction({
          companyId,
          issueId,
          effectiveResolverPolicy: "human_only",
          addresseeAgentId: reviewerAgentId,
          resolvedByAgentId: reviewerAgentId,
          resolvedByRunId: reviewerRunId,
        });
      },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await settledRun(runId))?.status === "cancelled");

    const settled = await settledRun(runId);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("does not dispatch a second continuation for the review acceptance that already resumed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = await seedReviewerAgent(companyId);
    const issueId = await seedParkableIssue(companyId, agentId);
    const interactionId = await seedReviewInteraction({
      companyId,
      issueId,
      addresseeAgentId: reviewerAgentId,
      resolvedByAgentId: reviewerAgentId,
    });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      at: new Date("2026-09-10T21:34:00.000Z"),
      livenessState: null,
      contextExtras: {
        retryReason: "issue_continuation_needed",
        acceptedReviewResume: {
          interactionId,
          source: "queued_run_staleness_gate",
          resolvedAt: "2026-09-10T21:33:33.000Z",
        },
      },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    const interactionWakes = await db
      .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.status, "queued"),
      ));
    expect(
      interactionWakes.filter((wake) =>
        (wake.payload as Record<string, unknown>)?.source === "issue.interaction_continuation_recovery",
      ),
    ).toHaveLength(0);
  });
});
