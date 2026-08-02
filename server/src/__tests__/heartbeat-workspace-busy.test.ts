import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_RETRY_BASE_DELAY_MS,
  WORKSPACE_BUSY_RETRY_JITTER_MS,
  WORKSPACE_BUSY_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_WAKE_REASON,
  computeWorkspaceBusyRetryDelayMs,
  heartbeatService,
} from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const WORKSPACE_BUSY_TEST_ADAPTER = "workspace_busy_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-busy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("computeWorkspaceBusyRetryDelayMs", () => {
  it("stays within the base-delay-to-base-plus-jitter window", () => {
    expect(computeWorkspaceBusyRetryDelayMs(() => 0)).toBe(WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(computeWorkspaceBusyRetryDelayMs(() => 0.5)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS / 2,
    );
    expect(computeWorkspaceBusyRetryDelayMs(() => 1)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );
  });

  it("clamps out-of-range random sources instead of leaving the window", () => {
    expect(computeWorkspaceBusyRetryDelayMs(() => -5)).toBe(WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(computeWorkspaceBusyRetryDelayMs(() => 7)).toBe(
      WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );
  });
});

describeEmbeddedPostgres("shared-workspace run serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-workspace-busy-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-busy-"));
    registerServerAdapter({
      type: WORKSPACE_BUSY_TEST_ADAPTER,
      execute: async (input: { runId?: string }) => {
        executedRunIds.push(input.runId ?? "unknown");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          resultJson: {},
        };
      },
      testEnvironment: async () => ({
        adapterType: WORKSPACE_BUSY_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // Seeded holder runs are synthetic "running" rows with no real execution
    // behind them; cancel them first so the drain helper does not spin
    // waiting for them to finish.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
    executedRunIds.length = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(WORKSPACE_BUSY_TEST_ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  interface WorkspaceFixture {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    holderAgentId: string;
    holderIssueId: string;
    holderRunId: string;
    agentId: string;
    issueId: string;
    nonAssigneeAgentId: string;
  }

  async function seedWorkspaceFixture(input?: {
    holderIssueWorkspaceSettings?: Record<string, unknown> | null;
    holderProjectWorkspaceId?: string;
    holderActivityAt?: Date;
  }): Promise<WorkspaceFixture> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const holderAgentId = randomUUID();
    const holderIssueId = randomUUID();
    const holderRunId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nonAssigneeAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Busy Project",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: workspaceCwd,
      isPrimary: true,
    });

    const holderProjectWorkspaceId = input?.holderProjectWorkspaceId ?? projectWorkspaceId;
    if (holderProjectWorkspaceId !== projectWorkspaceId) {
      await db.insert(projectWorkspaces).values({
        id: holderProjectWorkspaceId,
        companyId,
        projectId,
        name: "Secondary workspace",
        sourceType: "local_path",
        cwd: workspaceCwd,
      });
    }

    for (const [id, name] of [
      [holderAgentId, "HolderCoder"],
      [agentId, "DeferredCoder"],
      [nonAssigneeAgentId, "CommenterCoder"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: id === holderAgentId ? "running" : "idle",
        adapterType: WORKSPACE_BUSY_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      });
    }

    const holderActivityAt = input?.holderActivityAt ?? now;
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: holderActivityAt,
      lastOutputAt: holderActivityAt,
      contextSnapshot: {
        issueId: holderIssueId,
        wakeReason: "issue_assigned",
      },
      createdAt: holderActivityAt,
      updatedAt: holderActivityAt,
    });

    await db.insert(issues).values({
      id: holderIssueId,
      companyId,
      title: "Holder issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: holderAgentId,
      projectId,
      projectWorkspaceId: holderProjectWorkspaceId,
      executionRunId: holderRunId,
      executionAgentNameKey: "holdercoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...(input?.holderIssueWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: input.holderIssueWorkspaceSettings }
        : {}),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      projectId,
      projectWorkspaceId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    return {
      companyId,
      projectId,
      projectWorkspaceId,
      holderAgentId,
      holderIssueId,
      holderRunId,
      agentId,
      issueId,
      nonAssigneeAgentId,
    };
  }

  it("defers a run whose issue targets a busy shared workspace and schedules a bounded retry", async () => {
    const fixture = await seedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    const workspaceBusy = (finishedRun?.resultJson as Record<string, unknown> | null)
      ?.workspaceBusy as Record<string, unknown> | undefined;
    expect(workspaceBusy).toMatchObject({
      projectWorkspaceId: fixture.projectWorkspaceId,
      holderRunId: fixture.holderRunId,
      holderIssueId: fixture.holderIssueId,
      deferralAttempt: 0,
    });

    // The deferred run's adapter never executed — the whole point of the gate.
    expect(executedRunIds).not.toContain(run!.id);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      WORKSPACE_BUSY_RETRY_WAKE_REASON,
    );

    // The issue execution lock moved to the retry run, so the issue keeps an
    // active execution path and stranded-issue recovery leaves it alone.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBe(retryRun!.id);

    const finishedAtMs = finishedRun?.finishedAt ? new Date(finishedRun.finishedAt).getTime() : 0;
    const dueAtMs = retryRun?.scheduledRetryAt ? new Date(retryRun.scheduledRetryAt).getTime() : 0;
    expect(dueAtMs).toBeGreaterThanOrEqual(finishedAtMs + WORKSPACE_BUSY_RETRY_BASE_DELAY_MS);
    expect(dueAtMs).toBeLessThanOrEqual(
      finishedAtMs + WORKSPACE_BUSY_RETRY_BASE_DELAY_MS + WORKSPACE_BUSY_RETRY_JITTER_MS,
    );

    // The holder was left undisturbed and the agent returned to idle rather
    // than error.
    const holderRun = await heartbeat.getRun(fixture.holderRunId);
    expect(holderRun?.status).toBe("running");
    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, fixture.agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });

    if (run!.wakeupRequestId) {
      const wakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("cancelled");
    }
  });

  it("executes the scheduled retry once the holder has finished", async () => {
    const fixture = await seedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");

    // Holder finishes; the due retry promotes, queues, and executes.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).toContain(retryRun!.id);

    await heartbeat.resumeQueuedRuns();
    const finishedRetry = await waitForRunToLeaveActiveStates(retryRun!.id);
    expect(finishedRetry?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retryRun!.id);
  });

  it("defers a non-assignee run and executes its retry despite the assignee mismatch", async () => {
    const fixture = await seedWorkspaceFixture();

    // A comment-mention wake for an agent that is NOT the issue assignee —
    // the interaction-wake shape that legitimately reaches adapter dispatch
    // without assignee-ship.
    const run = await heartbeat.invoke(
      fixture.nonAssigneeAgentId,
      "on_demand",
      {
        issueId: fixture.issueId,
        wakeReason: "issue_comment_mentioned",
        commentId: randomUUID(),
      },
      "system",
    );
    expect(run).not.toBeNull();

    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");
    expect(deferred?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });
    expect(
      (retryRun?.contextSnapshot as Record<string, unknown> | null)?.workspaceBusyDeferredWhileAssignee,
    ).toBe(false);

    // The non-assignee run never held the issue execution lock, so the
    // deferral must not have stolen or released it.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBeNull();

    // The holder finishes; the retry must survive the promotion gate even
    // though the retry's agent is not the issue assignee.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).toContain(retryRun!.id);

    await heartbeat.resumeQueuedRuns();
    const finishedRetry = await waitForRunToLeaveActiveStates(retryRun!.id);
    expect(finishedRetry?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retryRun!.id);
  });

  it("still cancels an assignee retry at promotion when the issue is reassigned", async () => {
    const fixture = await seedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    const deferred = await waitForRunToLeaveActiveStates(run!.id);
    expect(deferred?.status).toBe("cancelled");

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(
      (retryRun?.contextSnapshot as Record<string, unknown> | null)?.workspaceBusyDeferredWhileAssignee,
    ).toBe(true);

    // Ownership changes while the retry pends: the deferral was taken under
    // assignee-ship, so the reassignment protection must still cancel it.
    await db
      .update(issues)
      .set({ assigneeAgentId: fixture.nonAssigneeAgentId, executionRunId: null })
      .where(eq(issues.id, fixture.issueId));

    const afterDue = new Date(new Date(retryRun!.scheduledRetryAt!).getTime() + 1_000);
    const promotion = await heartbeat.promoteDueScheduledRetries(afterDue);
    expect(promotion.runIds).not.toContain(retryRun!.id);

    const cancelledRetry = await heartbeat.getRun(retryRun!.id);
    expect(cancelledRetry?.status).toBe("cancelled");
    expect(cancelledRetry?.errorCode).toBe("issue_reassigned");
  });

  it("does not defer when the holder issue explicitly uses an isolated workspace", async () => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      const fixture = await seedWorkspaceFixture({
        holderIssueWorkspaceSettings: { mode: "isolated_workspace" },
      });

      const run = await heartbeat.invoke(
        fixture.agentId,
        "assignment",
        { issueId: fixture.issueId, wakeReason: "issue_assigned" },
        "system",
      );
      expect(run).not.toBeNull();

      const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
      expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
      const retryRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, fixture.companyId),
            eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
          ),
        )
        .then((rows) => rows.length);
      expect(retryRuns).toBe(0);
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    }
  });

  it("does not defer when the running run holds a different project workspace", async () => {
    const fixture = await seedWorkspaceFixture({ holderProjectWorkspaceId: randomUUID() });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, fixture.companyId),
          eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        ),
      )
      .then((rows) => rows.length);
    expect(retryRuns).toBe(0);
  });

  it("does not defer when the only holder has been silent past the staleness threshold", async () => {
    const fixture = await seedWorkspaceFixture({
      holderActivityAt: new Date(Date.now() - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS - 60_000),
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    // The holder row is still "running", but it has been silent past the
    // staleness bar, so it no longer blocks the workspace.
    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).toContain(run!.id);
  });

  it("keeps deferring past earlier attempts while the holder is still live", async () => {
    const fixture = await seedWorkspaceFixture();

    // Seed the promoted continuation of a run that has already been deferred
    // many times while the holder is still live: it must defer again, not
    // dispatch alongside the live holder.
    const priorAttempts = 10;
    const priorRunId = randomUUID();
    const wakeupId = randomUUID();
    const retryRunId = randomUUID();
    const now = new Date();
    const dueAt = new Date(now.getTime() - 1_000);

    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      scheduledRetryAttempt: priorAttempts - 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
      },
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
      payload: {
        issueId: fixture.issueId,
        retryOfRunId: priorRunId,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
        scheduledRetryAttempt: priorAttempts,
      },
      status: "queued",
      requestedByActorType: "system",
    });

    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: wakeupId,
      retryOfRunId: priorRunId,
      scheduledRetryAt: dueAt,
      scheduledRetryAttempt: priorAttempts,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
        workspaceBusyDeferredWhileAssignee: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(now);
    expect(promotion.runIds).toContain(retryRunId);

    await heartbeat.resumeQueuedRuns();
    const finishedRun = await waitForRunToLeaveActiveStates(retryRunId);

    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(retryRunId);

    const nextRetry = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, retryRunId))
      .then((rows) => rows[0] ?? null);
    expect(nextRetry).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: priorAttempts + 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });

    const holderRun = await heartbeat.getRun(fixture.holderRunId);
    expect(holderRun?.status).toBe("running");
  });
});
