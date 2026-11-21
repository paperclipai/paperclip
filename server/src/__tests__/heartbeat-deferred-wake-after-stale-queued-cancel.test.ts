import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Deferred wake promotion test run.",
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

import { heartbeatService } from "../services/heartbeat.ts";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred-wake promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("deferred wake promotion after a queued holder is withdrawn before start", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-deferred-wake-stale-cancel-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_thread_interactions",
          "issue_comments",
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
      `,
      { attempts: 10, delayMs: () => 100 },
    );
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const holderWakeId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: holderWakeId,
      companyId,
      agentId: otherAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: holderWakeId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    await db.update(agentWakeupRequests).set({ runId: holderRunId }).where(eq(agentWakeupRequests.id, holderWakeId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred wake behind a withdrawn queued run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, assigneeAgentId, otherAgentId, issueId, holderRunId };
  }

  async function deferredWakesFor(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  }

  async function issueExecutionRunId(issueId: string) {
    return db.select({ id: issues.executionRunId }).from(issues).where(eq(issues.id, issueId)).then((r) => r[0]?.id ?? null);
  }

  async function assigneeRuns(agentId: string, holderRunId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => row.id !== holderRunId);
  }

  it("promotes the assignee's deferred wake when the claim gate withdraws the queued holder", async () => {
    const { companyId, assigneeAgentId, otherAgentId, issueId, holderRunId } = await seed();

    const deferredRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(deferredRun).toBeNull();
    const [deferred] = await deferredWakesFor(assigneeAgentId);
    expect(deferred).toBeDefined();
    expect(await issueExecutionRunId(issueId)).toBe(holderRunId);

    await heartbeat.resumeQueuedRunsForAgent(companyId, otherAgentId);

    const holder = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId)).then((r) => r[0]);
    expect(holder?.status).toBe("cancelled");
    expect(holder?.errorCode).toBe("issue_assignee_changed");
    expect(holder?.startedAt).toBeNull();
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, holder!)).toBe(false);

    const promoted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id)).then((r) => r[0]);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    const runs = await assigneeRuns(assigneeAgentId, holderRunId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.wakeupRequestId).toBe(deferred!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[0]!.id)))[0]?.status).toBe("succeeded");

    await db.insert(heartbeatRunEvents).values({ companyId, runId: holderRunId, agentId: otherAgentId,
      seq: 99, eventType: "adapter.invoke" });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, holder!)).toBe(true);
  });

  it("promotes an answered-question resume wake when the addressee's queued run is withdrawn after the answer", async () => {
    const { companyId, assigneeAgentId, otherAgentId, issueId, holderRunId } = await seed();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "answered",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: otherAgentId,
      resolvedByAgentId: otherAgentId,
      resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "q1", prompt: "Which window?", selectionMode: "single",
        options: [{ id: "after", label: "After the current run" }] }] },
      result: { version: 1, answers: [{ questionId: "q1", optionIds: ["after"] }] },
    });
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId, taskId: issueId, wakeReason: "interaction_pending", source: "issue.interaction.created",
        interactionId, interactionKind: "ask_user_questions", sourceCommentId: null,
      },
    }).where(eq(heartbeatRuns.id, holderRunId));

    const deferredRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId, interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered",
        sourceCommentId: null, sourceRunId: null, mutation: "interaction",
      },
      idempotencyKey: `interaction:${interactionId}:answered`,
      contextSnapshot: {
        issueId, taskId: issueId, interactionId, interactionKind: "ask_user_questions",
        interactionStatus: "answered", wakeReason: "issue_commented", source: "issue.interaction.respond",
      },
      requestedByActorType: "agent",
      requestedByActorId: otherAgentId,
    });
    expect(deferredRun).toBeNull();
    const [deferred] = await deferredWakesFor(assigneeAgentId);
    expect(deferred).toBeDefined();
    expect(await issueExecutionRunId(issueId)).toBe(holderRunId);

    await heartbeat.resumeQueuedRunsForAgent(companyId, otherAgentId);

    const holder = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId)).then((r) => r[0]);
    expect(holder?.status).toBe("cancelled");
    expect(holder?.startedAt).toBeNull();

    const promoted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id)).then((r) => r[0]);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    const runs = await assigneeRuns(assigneeAgentId, holderRunId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.wakeupRequestId).toBe(deferred!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[0]!.id)))[0]?.status).toBe("succeeded");
  });
  it("promotes the deferred wake when the claim gate withdraws the queued holder for a status change", async () => {
    const { companyId, assigneeAgentId, otherAgentId, issueId, holderRunId } = await seed();
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId, taskId: issueId, wakeReason: "issue_commented", source: "connection_intent.resolved",
        interactionId: randomUUID(), interactionKind: "connection_intent", interactionStatus: "accepted",
        interactionResolvedAt: new Date().toISOString(), mutation: "interaction",
      },
    }).where(eq(heartbeatRuns.id, holderRunId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));

    const deferredRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(deferredRun).toBeNull();
    const [deferred] = await deferredWakesFor(assigneeAgentId);
    expect(deferred).toBeDefined();
    expect(await issueExecutionRunId(issueId)).toBe(holderRunId);

    await heartbeat.resumeQueuedRunsForAgent(companyId, otherAgentId);

    const holder = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId)).then((r) => r[0]);
    expect(holder?.status).toBe("cancelled");
    expect(holder?.errorCode).toBe("issue_not_in_progress");
    expect(holder?.startedAt).toBeNull();

    const promoted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id)).then((r) => r[0]);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
    const runs = await assigneeRuns(assigneeAgentId, holderRunId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.wakeupRequestId).toBe(deferred!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[0]!.id)))[0]?.status).toBe("succeeded");
  });
});
