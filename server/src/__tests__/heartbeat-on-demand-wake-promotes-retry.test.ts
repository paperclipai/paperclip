import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "fresh-session" },
  sessionDisplayId: "fresh-session",
  summary: "On-demand wake promotion test run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres on-demand wake promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("on-demand wake promotes parked scheduled retries", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-on-demand-promote-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 5) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await db.delete(agentTaskSessions);
    await db.delete(executionWorkspaces);
    await db.delete(issueComments);
    await db.delete(issues);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(workspaceOperations);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedParkedRetry() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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

    // Agent-scoped failure (no issueId): e.g. a provider quota error on a
    // timer heartbeat. The bounded retry parks a scheduled_retry run whose
    // backoff outlives the underlying problem once the operator fixes it.
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      error: "You've hit your usage limit.",
      errorCode: "codex_transient_upstream",
      finishedAt: now,
      resultJson: { errorFamily: "transient_upstream" },
      contextSnapshot: { wakeReason: "heartbeat" },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("expected scheduled retry");
    expect(scheduled.dueAt.getTime()).toBeGreaterThan(Date.now());

    return { companyId, agentId, retryRunId: scheduled.run.id };
  }

  it("keeps the retry parked when an automation wake coalesces into it", async () => {
    const { agentId, retryRunId } = await seedParkedRetry();

    const returned = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
    });
    expect(returned?.id).toBe(retryRunId);

    const parked = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))
      .then((rows) => rows[0] ?? null);
    expect(parked?.status).toBe("scheduled_retry");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("promotes the parked retry when an on-demand wake coalesces into it", async () => {
    const { agentId, retryRunId } = await seedParkedRetry();

    const returned = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "operator-1",
    });
    expect(returned?.id).toBe(retryRunId);
    expect(returned?.status).not.toBe("scheduled_retry");

    const wakeupRow = await db
      .select({
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.source, "on_demand"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeupRow).toMatchObject({ status: "coalesced", runId: retryRunId });

    // The run leaves scheduled_retry immediately and executes to completion.
    await vi.waitFor(async () => {
      const latest = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId))
        .then((rows) => rows[0] ?? null);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 10_000 });
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const promotionEvent = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, retryRunId))
      .then((rows) => rows.map((row) => row.message));
    expect(promotionEvent).toContain("Scheduled retry was promoted by an on-demand wake");
  });

  it("promotes an issue-scoped parked retry when an on-demand wake coalesces into it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date();
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
      name: "CodexCoder",
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
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "You've hit your usage limit.",
      errorCode: "codex_transient_upstream",
      finishedAt: now,
      resultJson: { errorFamily: "transient_upstream" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry after quota renewal",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    const retryRunId = scheduled.run.id;

    const returned = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
    });
    expect(returned?.id).toBe(retryRunId);
    expect(returned?.status).not.toBe("scheduled_retry");

    await vi.waitFor(async () => {
      const latest = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId))
        .then((rows) => rows[0] ?? null);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 10_000 });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not re-promote when the retry was already promoted to queued", async () => {
    const { agentId, retryRunId } = await seedParkedRetry();

    await db
      .update(heartbeatRuns)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryRunId));

    const returned = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });
    expect(returned?.id).toBe(retryRunId);
    expect(returned?.status).toBe("queued");
  });
});
