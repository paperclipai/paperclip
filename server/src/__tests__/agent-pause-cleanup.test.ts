import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent pause cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent pause clears checkout and wakeups", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssueWithRun(input: { agentStatusBeforePause: "active" | "paused" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-16T12:00:00.000Z");

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
      status: input.agentStatusBeforePause,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work in progress",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("clears checkoutRunId when cancelActiveForAgent releases execution", async () => {
    const { agentId, runId, issueId } = await seedCompanyAgentIssueWithRun({ agentStatusBeforePause: "active" });

    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelActiveForAgent(agentId);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    expect(row?.executionRunId).toBeNull();
    expect(row?.checkoutRunId).toBeNull();
    expect(row?.status).toBe("in_progress");

    const runRow = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(runRow?.status).toBe("cancelled");
    expect(runRow?.errorCode).toBe("cancelled");
  });

  it("cancels queued agent wakeups with null runId when pausing", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssueWithRun({ agentStatusBeforePause: "active" });

    const pendingWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: pendingWakeId,
      companyId: (await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!)).companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assignment_recovery",
      payload: { issueId },
      status: "queued",
      runId: null,
      requestedAt: new Date(),
    });

    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelActiveForAgent(agentId);

    const wake = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, pendingWakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("cancelled");
    expect(wake?.error).toContain("Cancelled due to agent pause");
  });

  it("cancels deferred_issue_execution wakeups with null runId when pausing", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssueWithRun({ agentStatusBeforePause: "active" });

    const deferredWakeId = randomUUID();
    const companyIdRow = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0]!);

    // Use a payload issueId distinct from the seeded checkout issue so releaseIssueExecutionAndPromote
    // does not promote/fail this row while draining deferred wakes for the run being cancelled.
    const deferredIssueId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId: companyIdRow.companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId: deferredIssueId,
        _paperclipWakeContext: { issueId: deferredIssueId, wakeReason: "mention_wake" },
      },
      status: "deferred_issue_execution",
      runId: null,
      requestedAt: new Date(),
    });

    expect(issueId).not.toBe(deferredIssueId);

    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelActiveForAgent(agentId);

    const wake = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("cancelled");
    expect(wake?.error).toContain("Cancelled due to agent pause");
  });

  it("does not create stranded recovery children when operational pause cancels the checkout run", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssueWithRun({ agentStatusBeforePause: "active" });

    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelActiveForAgent(agentId);

    const strandedChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, issueId), eq(issues.originKind, "stranded_issue_recovery")));

    expect(strandedChildren).toHaveLength(0);

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow?.status).toBe("in_progress");
  });

  it("passes custom cancel reason for termination-style shutdown", async () => {
    const { agentId } = await seedCompanyAgentIssueWithRun({ agentStatusBeforePause: "active" });
    const pendingWakeId = randomUUID();
    const companyRow = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!);

    await db.insert(agentWakeupRequests).values({
      id: pendingWakeId,
      companyId: companyRow.companyId,
      agentId,
      source: "automation",
      reason: "heartbeat_timer",
      payload: {},
      status: "queued",
      runId: null,
      requestedAt: new Date(),
    });

    await db.update(agents).set({ status: "paused", pausedAt: new Date() }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelActiveForAgent(agentId, "Cancelled due to agent termination");

    const wake = await db
      .select({ error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, pendingWakeId))
      .then((rows) => rows[0]);
    expect(wake?.error).toBe("Cancelled due to agent termination");
  });
});

describeEmbeddedPostgres("clearExecutionRunIfTerminal clears checkoutRunId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clear-exec-terminal-checkout-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears checkoutRunId when it matches the terminal execution run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "cancelled",
      errorCode: "cancelled",
      error: "operator cancelled",
      finishedAt: new Date(),
      contextSnapshot: { issueId },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale locks",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const issuesApi = issueService(db);
    const cleared = await issuesApi.clearExecutionRunIfTerminal(issueId);
    expect(cleared).toBe(true);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    expect(row?.executionRunId).toBeNull();
    expect(row?.checkoutRunId).toBeNull();
  });
});
