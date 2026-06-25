import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
    resultJson: { summary: "Stale-queue invalidation test run." },
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

// Wait until `fn()` returns true, polling every 50ms up to `timeoutMs`. The
// default is 15s, not 3s, because each await chain here goes:
//   queued → dispatcher poll → adapter execute → status running → postRun
//   write → status succeeded
// which is a few hundred ms in isolation but bursts to 2-5s under CI load
// (embedded-postgres warm-up after a fork-pool reset, shared-runner I/O
// contention, etc.). The 3s default was the direct cause of intermittent
// 'expected running to be succeeded' failures on verify_canary — see
// run 26258560789 job 77286814262 on PR #129.
//
// Throws on deadline expiry so the timeout surfaces directly instead of
// being masked by a downstream `expect(...).toBe(...)` symptom.
async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await fn()) return true;
  throw new Error(`waitForCondition: predicate did not become true within ${timeoutMs}ms`);
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

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
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
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
      resultJson: { summary: "Stale-queue invalidation test run." },
    }));
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
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

  it("runs generic timer wakes by default for proactive agents without assigned issue work", async () => {
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
    expect(mockAdapterExecute).not.toHaveBeenCalled();
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
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels non-interaction queued runs when the issue execution lock cannot be acquired", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const historicalRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: historicalRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      errorCode: "process_lost",
      error: "Historical failed run",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked by historical run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: historicalRunId,
      executionLockedAt: new Date(),
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
    expect(run?.errorCode).toBe("issue_execution_lock_not_acquired");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_not_acquired" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("could not acquire the issue execution lock");
    expect(issue?.executionRunId).toBe(historicalRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
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
    expect(mockAdapterExecute).not.toHaveBeenCalled();
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

  it("runs source_scoped_recovery_action wakes even when the issue assignee is a different agent (recovery owner ≠ assignee)", async () => {
    // Regression test for BLO-8299: the recovery owner is intentionally
    // different from the source issue's current assignee, so the pre-claim
    // staleness guard must NOT cancel these wakes via issue_assignee_changed.
    // Pre-fix, 284/289 (98%) of source_scoped_recovery_action wakes in a 7d
    // window were cancelled on arrival because of this bug.
    const { companyId, agentId: recoveryOwnerAgentId } = await seedCompanyAndAgent({
      agentName: "CTO-RecoveryOwner",
      agentRole: "cto",
    });
    const failedAssigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: failedAssigneeAgentId,
      companyId,
      name: "ReleaseEngineer-Stranded",
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
      title: "Stranded issue awaiting recovery owner inspection",
      status: "blocked",
      priority: "high",
      // Source issue is still assigned to the failed engineer; the recovery
      // wake's run.agentId is the recovery owner (CTO). These intentionally
      // disagree — that's the whole point of a wake_owner recovery policy.
      assigneeAgentId: failedAssigneeAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId: recoveryOwnerAgentId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
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

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    // Wakeup is `claimed` once the staleness gate has admitted the run and the
    // dispatcher has handed off to the adapter; the wake completed → no skipped
    // status, no issue_assignee_changed error. The pre-fix behavior was
    // `status=skipped` / `error="…assignee changed…"` here.
    expect(wakeup?.status).not.toBe("skipped");
    expect(wakeup?.error ?? "").not.toContain("assignee changed");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("still runs source_scoped_recovery_action wakes when the issue assignee has been re-set to the recovery owner mid-flight (idempotent)", async () => {
    // Sanity check: if the issue's assignee transitions to the recovery
    // owner before the queued wake is claimed (e.g. an operator manually
    // re-pointed the issue), the recovery wake must still run, not be
    // cancelled by some other guard.
    const { companyId, agentId: recoveryOwnerAgentId } = await seedCompanyAndAgent({
      agentName: "CTO-RecoveryOwner-Idempotent",
      agentRole: "cto",
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue re-assigned to recovery owner before wake claim",
      status: "blocked",
      priority: "high",
      assigneeAgentId: recoveryOwnerAgentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId: recoveryOwnerAgentId,
      issueId,
      wakeReason: "source_scoped_recovery_action",
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
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
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
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });
});
