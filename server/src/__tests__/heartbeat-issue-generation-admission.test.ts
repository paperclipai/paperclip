import { randomUUID } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  boardTokenExceptions,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  issueThreadInteractions,
  toolCallEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER_TYPE = "issue_generation_admission_test";
const executeAdapter = vi.fn(async (context: AdapterExecutionContext) => {
  await context.onLog("stdout", `${JSON.stringify({
    type: "item.started",
    item: { id: `tool-${context.runId}`, type: "command_execution", command: "deterministic check" },
  })}\n`);
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
    usageBasis: "per_run" as const,
    resultJson: { disposition: { status: "done", hasBlocker: false } },
  };
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-generation admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue generation pre-dispatch admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-generation-admission-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: ADAPTER_TYPE,
      execute: executeAdapter,
      testEnvironment: async () => ({
        adapterType: ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  async function seedScopedTarget(sequence: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Admission ${sequence}`,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Admission agent ${sequence}`,
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Admission target ${sequence}`,
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: sequence,
      identifier: `${issuePrefix}-${sequence}`,
    });
    return { companyId, agentId, issueId };
  }

  async function invokeAndRead(agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { issueId, taskId: issueId, wakeReason: "bounded_acceptance" },
      "manual",
    );
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    return heartbeat.getRun(run!.id);
  }

  it("rejects the run past the generation-run ceiling before the adapter is called", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(1);
    const now = new Date();
    const priorAgentIds = Array.from({ length: 25 }, () => randomUUID());
    await db.insert(agents).values(priorAgentIds.map((id, index) => ({
      id,
      companyId: target.companyId,
      name: `Prior generation agent ${index + 1}`,
      role: "engineer",
      status: "idle" as const,
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(heartbeatRuns).values(
      priorAgentIds.map((agentId) => ({
        companyId: target.companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded" as const,
        startedAt: now,
        finishedAt: now,
        contextSnapshot: { issueId: target.issueId, taskId: target.issueId },
      })),
    );

    const rejected = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).not.toHaveBeenCalled();
    expect(rejected).toMatchObject({
      status: "cancelled",
      errorCode: "issue_generation_ceiling_exceeded",
      resultJson: {
        reason: "generation_run_ceiling",
        priorGenerationRuns: 25,
        modelDispatched: false,
      },
    });
  });

  it("admits past the run ceiling after a board/user comment (TSMC-20820: supervision resets the counter)", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(5);
    const runStarted = new Date(Date.now() - 60_000);
    const priorAgentIds = Array.from({ length: 12 }, () => randomUUID());
    await db.insert(agents).values(priorAgentIds.map((id, index) => ({
      id,
      companyId: target.companyId,
      name: `Churned generation agent ${index + 1}`,
      role: "engineer",
      status: "idle" as const,
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(heartbeatRuns).values(
      priorAgentIds.map((agentId) => ({
        companyId: target.companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded" as const,
        startedAt: runStarted,
        finishedAt: runStarted,
        contextSnapshot: { issueId: target.issueId, taskId: target.issueId },
      })),
    );
    // The supervision event the deny message demands: a board/user comment
    // NEWER than the churned runs must reset the ceiling counter.
    await db.insert(issueComments).values({
      companyId: target.companyId,
      issueId: target.issueId,
      authorType: "user",
      authorUserId: "local-board",
      body: "Board: verified state; continue the work.",
      createdAt: new Date(),
    });

    const admitted = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).toHaveBeenCalledTimes(1);
    expect(admitted?.status).toBe("succeeded");
  });

  it("preserves a credential unblock descriptor when aggregate admission denies the run", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(2);
    const credentialDescriptor = {
      owner: { userId: "operator" },
      action: "Re-authenticate the Substack cookie before the task can resume.",
    };
    await db.update(issues)
      .set({ status: "blocked", unblockDescriptor: credentialDescriptor })
      .where(eq(issues.id, target.issueId));
    // 250K fresh + 37.5M cached * 0.02 = 1,000,000 weighted. Cache reads are
    // budget-weighted (K36 / TSMC-20864, weight lowered to 0.02 by TSMC-21552-A):
    // resident context re-read across resumes must not exhaust a ceiling that
    // bounds real burn.
    await db.insert(costEvents).values({
      companyId: target.companyId,
      agentId: target.agentId,
      issueId: target.issueId,
      provider: "test",
      biller: "test",
      billingType: "subscription",
      model: "test-model",
      inputTokens: 250_000,
      cachedInputTokens: 37_500_000,
      outputTokens: 0,
      costCents: 0,
      occurredAt: new Date(),
    });

    const rejected = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).not.toHaveBeenCalled();
    expect(rejected).toMatchObject({
      status: "cancelled",
      errorCode: "issue_generation_ceiling_exceeded",
      resultJson: {
        reason: "aggregate_input_ceiling",
        aggregateInputTokens: 1_000_000,
        modelDispatched: false,
        generationAdmissionBlock: {
          reason: "aggregate_input_ceiling",
          aggregateInputTokens: 1_000_000,
        },
      },
    });
    const issueAfterDeny = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, target.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueAfterDeny).toEqual({
      status: "blocked",
      unblockDescriptor: credentialDescriptor,
    });
  });

  it("keeps a near-ceiling issue stopped without an exception, then admits it under a scoped board exception", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(6);
    const aggregateInputTokens = 990_000;
    await db.insert(costEvents).values({
      companyId: target.companyId,
      agentId: target.agentId,
      issueId: target.issueId,
      provider: "test",
      biller: "test",
      billingType: "subscription",
      model: "test-model",
      inputTokens: aggregateInputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      occurredAt: new Date(),
    });

    const denied = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).not.toHaveBeenCalled();
    expect(denied).toMatchObject({
      status: "cancelled",
      errorCode: "issue_generation_ceiling_exceeded",
      resultJson: {
        reason: "aggregate_input_ceiling",
        aggregateInputTokens,
        modelDispatched: false,
      },
    });
    expect(await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, target.issueId)))
      .toEqual([]);

    await db.insert(boardTokenExceptions).values({
      companyId: target.companyId,
      issueId: target.issueId,
      capTokens: 1_100_000,
      reason: "Bounded recovery after the useful-run floor stopped the issue.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdByUserId: "local-board",
    });

    const admitted = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).toHaveBeenCalledTimes(1);
    expect(admitted?.status).toBe("succeeded");
  });

  it("admits a cache-heavy issue whose weighted aggregate is under the ceiling", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(4);
    // The TSM-6044 shape: raw aggregate far past 1M, but almost all cache.
    // 40K fresh + 6M cached * 0.02 = 160,000 weighted — must dispatch.
    await db.insert(costEvents).values({
      companyId: target.companyId,
      agentId: target.agentId,
      issueId: target.issueId,
      provider: "test",
      biller: "test",
      billingType: "subscription",
      model: "test-model",
      inputTokens: 40_000,
      cachedInputTokens: 6_000_000,
      outputTokens: 0,
      costCents: 0,
      occurredAt: new Date(),
    });

    const admitted = await invokeAndRead(target.agentId, target.issueId);

    expect(executeAdapter).toHaveBeenCalledTimes(1);
    expect(admitted?.status).toBe("succeeded");
  });

  it("persists one native tool ledger row with run and issue attribution", async () => {
    executeAdapter.mockClear();
    const target = await seedScopedTarget(3);

    const completed = await invokeAndRead(target.agentId, target.issueId);

    expect(completed?.status).toBe("succeeded");
    expect(executeAdapter).toHaveBeenCalledTimes(1);
    const rows = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.runId, completed!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: target.companyId,
      agentId: target.agentId,
      issueId: target.issueId,
      toolName: "command_execution",
      reasonCode: "adapter_native_tool_call",
    });
  });
});
