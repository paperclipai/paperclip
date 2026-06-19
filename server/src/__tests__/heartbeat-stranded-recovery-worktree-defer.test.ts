/**
 * Tests for FUL-11071: defer parent/source retries when a child reset run still
 * holds the shared execution workspace (worktree).
 *
 * Scenario:
 *   1. Parent issue (e.g. FUL-11055) is stranded with no active run.
 *   2. A child reset/recovery issue (e.g. FUL-11070) shares the same
 *      executionWorkspaceId and still has an active executionRunId.
 *   3. reconcileStrandedAssignedIssues() must skip the parent retry to
 *      avoid the adapter_failed worktree-held loop.
 *   4. Once the child run finishes (executionRunId cleared), the next
 *      reconcile cycle queues the parent retry normally.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping worktree-defer tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileStrandedAssignedIssues — child worktree hold deferral", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-defer-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds the minimal fixture for the worktree-hold race:
   *   - company + agent
   *   - project + executionWorkspace (shared between parent and child)
   *   - parent issue (stranded: todo/in_progress, no active executionRunId)
   *   - child issue with an active executionRunId on the same workspace
   */
  async function seedWorktreeHoldFixture(opts: {
    parentStatus?: "todo" | "in_progress";
    childRunStatus?: "running" | "queued" | "scheduled_retry";
    childHasSameWorkspace?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const parentRunId = randomUUID();
    const parentWakeId = randomUUID();
    const childRunId = randomUUID();
    const childWakeId = randomUUID();
    const now = new Date("2026-06-13T10:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Help2day",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Lead",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip Runtime",
    });

    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared",
      strategyType: "git_worktree",
      name: "worktree-branch",
    });

    // Parent stalled run (already finished — no active execution path)
    await db.insert(agentWakeupRequests).values({
      id: parentWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: parentIssueId },
      status: "failed",
      runId: parentRunId,
      claimedAt: new Date("2026-06-13T09:00:00.000Z"),
      finishedAt: new Date("2026-06-13T09:05:00.000Z"),
      error: "worktree locked by sibling run",
    });
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId: parentWakeId,
      contextSnapshot: { issueId: parentIssueId, taskId: parentIssueId, wakeReason: "issue_assigned" },
      errorCode: "adapter_failed",
      error: "worktree locked by sibling run",
      startedAt: new Date("2026-06-13T09:00:00.000Z"),
      finishedAt: new Date("2026-06-13T09:05:00.000Z"),
      updatedAt: new Date("2026-06-13T09:05:00.000Z"),
    });

    // Active child run still holding the workspace
    await db.insert(agentWakeupRequests).values({
      id: childWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: childIssueId },
      status: "claimed",
      runId: childRunId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: childRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.childRunStatus ?? "running",
      wakeupRequestId: childWakeId,
      contextSnapshot: { issueId: childIssueId, taskId: childIssueId, wakeReason: "issue_assigned" },
      startedAt: now,
      updatedAt: now,
    });

    // Parent issue — stranded, no executionRunId
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "FUL-11055 Source issue — stranded",
      status: opts.parentStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      projectId,
      executionWorkspaceId: workspaceId,
      checkoutRunId: parentRunId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-06-13T09:00:00.000Z"),
    });

    // Child reset issue — still running, holds executionRunId
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "FUL-11070 Reset child — active run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      projectId,
      // Share the same workspace as the parent when testing the hold scenario
      executionWorkspaceId: opts.childHasSameWorkspace === false ? null : workspaceId,
      executionRunId: childRunId,
      parentId: parentIssueId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      startedAt: now,
    });

    return {
      companyId,
      agentId,
      projectId,
      workspaceId,
      parentIssueId,
      childIssueId,
      parentRunId,
      childRunId,
    };
  }

  it("skips parent retry when child reset run still holds the shared execution workspace (running)", async () => {
    const { companyId, parentIssueId, childIssueId, childRunId } = await seedWorktreeHoldFixture({
      childRunStatus: "running",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    // No new wakeup queued for the parent
    const parentWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    const parentWake = parentWakes.find(
      (w) => typeof w.payload === "object" && (w.payload as Record<string, unknown>)?.issueId === parentIssueId,
    );
    expect(parentWake).toBeUndefined();

    // Activity log records the skip
    const skipActivities = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.recovery.stranded_workspace_held_skip"),
          eq(activityLog.entityId, parentIssueId),
        ),
      );
    expect(skipActivities).toHaveLength(1);
    expect(skipActivities[0]?.details).toMatchObject({
      heldByIssueId: childIssueId,
      heldByRunId: childRunId,
    });
  });

  it("skips parent retry when child reset run is queued on the shared workspace", async () => {
    const { parentIssueId, childIssueId, childRunId } = await seedWorktreeHoldFixture({
      childRunStatus: "queued",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.continuationRequeued).toBe(0);
  });

  it("skips parent retry when child reset run is in scheduled_retry on the shared workspace", async () => {
    const { parentIssueId } = await seedWorktreeHoldFixture({
      childRunStatus: "scheduled_retry",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.continuationRequeued).toBe(0);
  });

  it("queues parent retry once child run releases the workspace (executionRunId cleared)", async () => {
    const { companyId, childIssueId, childRunId } = await seedWorktreeHoldFixture({
      childRunStatus: "running",
    });

    // Simulate child run completing: clear its executionRunId
    await db
      .update(issues)
      .set({ executionRunId: null, updatedAt: new Date() })
      .where(eq(issues.id, childIssueId));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, childRunId));

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Parent should now be scheduled for retry
    expect(result.continuationRequeued + result.dispatchRequeued).toBeGreaterThanOrEqual(1);

    // The wakeup may be "claimed" or beyond if startNextQueuedRunForAgent fires immediately;
    // verify at least one non-skipped wakeup was created for this company by the reconciler.
    const newWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.source, "automation"),
        ),
      );
    expect(newWakes.length).toBeGreaterThanOrEqual(1);
  });

  it("does not suppress parent retry when child uses a different execution workspace", async () => {
    const { companyId } = await seedWorktreeHoldFixture({
      childRunStatus: "running",
      childHasSameWorkspace: false,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Parent should still get queued since child is on a different workspace
    expect(result.continuationRequeued + result.dispatchRequeued).toBeGreaterThanOrEqual(1);
  });

  it("does not suppress parent retry when parent has no executionWorkspaceId", async () => {
    const { companyId, parentIssueId } = await seedWorktreeHoldFixture({
      childRunStatus: "running",
    });

    // Remove the workspace link from the parent to simulate a non-workspace issue
    await db
      .update(issues)
      .set({ executionWorkspaceId: null, updatedAt: new Date() })
      .where(eq(issues.id, parentIssueId));

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued + result.dispatchRequeued).toBeGreaterThanOrEqual(1);
  });
});
