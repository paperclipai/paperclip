import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  workspaceOperations,
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
    summary: "Deferred handoff staleness test run.",
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
    `Skipping embedded Postgres deferred handoff staleness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

const DEFERRED_CONTEXT_KEY = "_paperclipWakeContext";

describeEmbeddedPostgres("heartbeat deferred handoff wake staleness", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-deferred-handoff-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
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
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Deferred handoff staleness test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    const producerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [agentId, name] of [
      [producerId, "Producer"],
      [reviewerId, "Reviewer"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      });
    }
    return { companyId, producerId, reviewerId };
  }

  it("promotes a changes-requested handoff wake past a stale deferred reviewer wake", async () => {
    const { companyId, producerId, reviewerId } = await seedCompanyAndAgents();
    const issueId = randomUUID();
    const stageId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Packet under review",
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerId,
      responsibleUserId: "responsible-user",
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: producerId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        reviewRequest: null,
      },
    });

    // Leftover reviewer wake from a previous cycle: the stage has since moved on,
    // so promoting it can only produce a run that is immediately stale-cancelled.
    const staleWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: staleWakeId,
      companyId,
      agentId: reviewerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedAt: new Date(Date.now() - 60 * 60_000),
      payload: {
        issueId,
        mutation: "update",
        [DEFERRED_CONTEXT_KEY]: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_review_requested",
          source: "issue.execution_stage",
        },
      },
    });

    // The reviewer run requests changes mid-run: the issue flips to the producer
    // and the producer's handoff wake is parked behind the stale head.
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({
          status: "in_progress",
          assigneeAgentId: producerId,
          executionState: {
            status: "changes_requested",
            currentStageId: null,
            currentStageType: "review",
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: producerId, userId: null },
            completedStageIds: [],
            lastDecisionId: randomUUID(),
            lastDecisionOutcome: "changes_requested",
            reviewRequest: null,
          },
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      const handoffWake = await heartbeat.wakeup(producerId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage: {
            stageId,
            wakeRole: "executor",
            stageType: "review",
            allowedActions: ["address_changes", "resubmit"],
          },
        },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
        },
      });
      expect(handoffWake).toBeNull();

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Reviewer requested changes.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.wakeup(reviewerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId, mutation: "update" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "execution_review_requested",
        source: "issue.execution_stage",
      },
    });

    const producerRan = await waitForCondition(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, producerId), eq(heartbeatRuns.companyId, companyId)));
      return runs.some((run) => run.status === "succeeded" || run.status === "running");
    });
    expect(producerRan).toBe(true);

    const staleWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, staleWakeId))
      .then((rows) => rows[0]);
    expect(staleWake.status).toBe("skipped");
    expect(staleWake.runId).toBeNull();
    expect(staleWake.error).toContain("assignee changed");

    const staleRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, staleWakeId));
    expect(staleRuns).toHaveLength(0);

    const handoffWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, producerId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .then((rows) => rows[0]);
    expect(handoffWake.status).not.toBe("deferred_issue_execution");
  }, 30_000);

  it("promotes a resubmission review wake past a stale deferred executor wake", async () => {
    const { companyId, producerId, reviewerId } = await seedCompanyAndAgents();
    const issueId = randomUUID();
    const stageId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Packet being remediated",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: producerId,
      responsibleUserId: "responsible-user",
      executionState: {
        status: "changes_requested",
        currentStageId: null,
        currentStageType: "review",
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: producerId, userId: null },
        completedStageIds: [],
        lastDecisionId: randomUUID(),
        lastDecisionOutcome: "changes_requested",
        reviewRequest: null,
      },
    });

    // Stale executor wake from the earlier changes_requested cycle.
    const staleWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: staleWakeId,
      companyId,
      agentId: producerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedAt: new Date(Date.now() - 60 * 60_000),
      payload: {
        issueId,
        mutation: "update",
        [DEFERRED_CONTEXT_KEY]: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
        },
      },
    });

    // The producer resubmits mid-run: issue flips back to in_review with the
    // reviewer as participant, and the reviewer wake is parked behind the stale head.
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({
          status: "in_review",
          assigneeAgentId: reviewerId,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
            returnAssignee: { type: "agent", agentId: producerId, userId: null },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
            reviewRequest: null,
          },
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      const reviewWake = await heartbeat.wakeup(reviewerId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "execution_review_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage: {
            stageId,
            wakeRole: "reviewer",
            stageType: "review",
            allowedActions: ["approve", "request_changes"],
          },
        },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_review_requested",
          source: "issue.execution_stage",
        },
      });
      expect(reviewWake).toBeNull();

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Producer resubmitted.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.wakeup(producerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
    });

    const reviewerRan = await waitForCondition(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, reviewerId), eq(heartbeatRuns.companyId, companyId)));
      return runs.some((run) => run.status === "succeeded" || run.status === "running");
    });
    expect(reviewerRan).toBe(true);

    const staleWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, staleWakeId))
      .then((rows) => rows[0]);
    expect(staleWake.status).toBe("skipped");
    expect(staleWake.runId).toBeNull();

    const staleRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, staleWakeId));
    expect(staleRuns).toHaveLength(0);
  }, 30_000);
});
