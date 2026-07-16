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
  summary: "Human comment wake promotion test run.",
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
    `Skipping embedded Postgres human comment wake promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("human comment wake promotes parked scheduled retries", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-human-wake-promote-");
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

  async function seedAgent() {
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

    return { companyId, agentId };
  }

  // Session-limit failure on an issue-scoped run: the bounded retry parks a
  // scheduled_retry run whose backoff can outlive the underlying limit by
  // hours. This mirrors the production incident where a comment posted
  // seconds after the limit reset was absorbed into the parked run.
  async function seedIssueScopedParkedRetry(issueStatus: "in_review" | "in_progress" = "in_review") {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      responsibleUserId: "responsible-user",
      error: "You've hit your session limit.",
      errorCode: "codex_transient_upstream",
      finishedAt: now,
      resultJson: { errorFamily: "transient_upstream" },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Respond to the board once the session limit lifts",
      status: issueStatus,
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("expected scheduled retry");
    expect(scheduled.dueAt.getTime()).toBeGreaterThan(Date.now());

    return { companyId, agentId, issueId, retryRunId: scheduled.run.id };
  }

  function commentWakeOptions(input: {
    issueId: string;
    commentId: string;
    requestedByActorType: "user" | "agent";
    requestedByActorId: string;
  }) {
    // Shape of the assignee wake enqueued by POST /api/issues/{id}/comments.
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_commented",
      payload: {
        issueId: input.issueId,
        commentId: input.commentId,
        mutation: "comment",
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        commentId: input.commentId,
        wakeCommentId: input.commentId,
        source: "issue.comment",
        wakeReason: "issue_commented",
      },
    };
  }

  it("keeps the retry parked when an agent comment wake coalesces into it", async () => {
    const { agentId, issueId, retryRunId } = await seedIssueScopedParkedRetry();

    const returned = await heartbeat.wakeup(agentId, commentWakeOptions({
      issueId,
      commentId: randomUUID(),
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    }));
    expect(returned?.id).toBe(retryRunId);

    const parked = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))
      .then((rows) => rows[0] ?? null);
    expect(parked?.status).toBe("scheduled_retry");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("promotes the parked retry when a human comment wake coalesces into it", async () => {
    const { agentId, issueId, retryRunId } = await seedIssueScopedParkedRetry("in_review");
    const commentId = randomUUID();

    const returned = await heartbeat.wakeup(agentId, commentWakeOptions({
      issueId,
      commentId,
      requestedByActorType: "user",
      requestedByActorId: "board-operator",
    }));
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
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeupRow).toMatchObject({ status: "coalesced", runId: retryRunId });

    // The comment lands in the promoted run's context so the agent sees it.
    const promotedSnapshot = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))
      .then((rows) => rows[0]?.contextSnapshot as Record<string, unknown> | null);
    expect(promotedSnapshot?.wakeCommentId).toBe(commentId);

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

    const eventMessages = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, retryRunId))
      .then((rows) => rows.map((row) => row.message));
    expect(eventMessages).toContain("Scheduled retry was promoted by a human-initiated wake");
  });

  it("promotes an agent-scoped parked retry when a human wake coalesces into it", async () => {
    const { companyId, agentId } = await seedAgent();
    const sourceRunId = randomUUID();
    const now = new Date();

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      responsibleUserId: "responsible-user",
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
    const retryRunId = scheduled.run.id;

    const returned = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: "board-operator",
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
    const { agentId, issueId, retryRunId } = await seedIssueScopedParkedRetry();

    await db
      .update(heartbeatRuns)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryRunId));

    const returned = await heartbeat.wakeup(agentId, commentWakeOptions({
      issueId,
      commentId: randomUUID(),
      requestedByActorType: "user",
      requestedByActorId: "board-operator",
    }));
    expect(returned?.id).toBe(retryRunId);
    expect(returned?.status).toBe("queued");
  });
});
