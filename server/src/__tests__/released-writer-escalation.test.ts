import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, executionWorkspaces,
  heartbeatRuns, issueRecoveryActions, issueRelations, issues, statusDecisions } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE } from "../services/remote-workspace-writer-hold.js";
import { continueTasksAfterWorkspaceWriterReleased, RELEASED_WORKSPACE_WRITER_OUTCOME }
  from "../services/recovery/released-writer-escalation.js";
import { recoveryActionSweepCondition } from "../services/recovery/blocker-stall-wakeups.js";
import { recoveryService } from "../services/recovery/service.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping released-writer escalation tests: ${recoveryPostgresSupport.reason}`);

// Recovery text never asks a person to inspect or fix anything, and never shows internal names.
const adminText = /sandbox|environment|administrator|board member|board operator|owner must|inspect the|epoch|writer run/i;

/**
 * The staging shape (Nov 12). The task's own remote workspace was
 * held by its ended native run (its superseded export never saved the files).
 * The task's queued runs then failed setup on that hold before any provider
 * work, stranded-work recovery blocked the task with a board-owned escalation
 * at 16:00:56.667Z, and a late native status decision 1.4 s later only kept
 * that block ("prior_status_terminal_preserved"). Hours later the retained-file
 * recovery released the hold (it continued from the last save and abandoned
 * the run's workspace epoch), but the escalation and the Blocked status stayed.
 */
describePostgres("a task stranded behind its own workspace's ended writer", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;
  const wakes: Array<{ agentId: string; options: Record<string, unknown> }> = [];
  const enqueueWakeup = async (agentId: string, options: unknown) => {
    wakes.push({ agentId, options: options as Record<string, unknown> });
    return { id: randomUUID() };
  };

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("released-writer-escalation-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-released-writer-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seedStrandedTask(options: { laterDecision?: { fromStatus: string; toStatus: string } | null } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), userId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Writer hold", defaultResponsibleUserId: userId, issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "idle", adapterConfig: {} });
    const [task] = await db.insert(issues).values({ companyId, title: "Ship the page", status: "blocked", assigneeAgentId: agentId,
      responsibleUserId: userId, executionWorkspacePreference: "reuse_existing", issueNumber: 1 }).returning();
    const hour = 3_600_000, base = Date.now() - 9 * hour;
    // The ended native run that still writes the task's own workspace.
    const writerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: writerRunId, companyId, agentId, issueId: task.id, nativeIssueId: task.id,
      runtimeMode: "native", status: "failed", errorCode: "native_finalization_superseded",
      createdAt: new Date(base - 4 * hour), finishedAt: new Date(base), contextSnapshot: { issueId: task.id } });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: task.id, name: "Task workspace",
      mode: "isolated_workspace", strategyType: "project_primary", status: "active", providerType: "cloud_sandbox",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3, snapshotId: randomUUID(),
        source: { kind: "empty" }, writerRunId, dirty: true, location: null } } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, task.id));
    // Its queued runs failed setup on that hold, the last one finishing at 16:00:52.
    let latest: typeof heartbeatRuns.$inferSelect | undefined;
    for (const minutes of [5, 30, 60]) {
      [latest] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: task.id, runtimeMode: "legacy",
        status: "failed", errorCode: "setup_failed", error: REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE,
        createdAt: new Date(base + minutes * 60_000 - 13_000), startedAt: new Date(base + minutes * 60_000 - 10_000),
        finishedAt: new Date(base + minutes * 60_000),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: { issueId: task.id } }).returning();
    }
    const blockedAt = new Date(latest!.finishedAt!.getTime() + 4_388);
    await db.update(issues).set({ blockedTransitionAt: blockedAt, statusVersion: 7 }).where(eq(issues.id, task.id));
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: task.id, kind: "stranded_assigned_issue",
      status: "active", ownerType: "board", previousOwnerAgentId: agentId, returnOwnerAgentId: agentId, cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${task.id}:stranded_assigned_issue`,
      nextAction: "Board operator: inspect the evidence, repair the runtime if appropriate, then explicitly retry the original owner, reassign, or intentionally resolve the task.",
      evidence: { latestRunId: latest!.id, retryReason: null, sourceRunId: null, recoveryCause: "stranded_assigned_issue",
        routingPolicy: "board_escalation_no_takeover_v1", sourceIssueId: task.id, previousStatus: "in_progress",
        latestRunStatus: "failed", latestIssueStatus: "in_progress", latestRunErrorCode: "setup_failed" },
      createdAt: blockedAt, updatedAt: blockedAt }).returning();
    const laterDecision = options.laterDecision === undefined ? { fromStatus: "blocked", toStatus: "blocked" } : options.laterDecision;
    if (laterDecision) {
      // A late result of an earlier run kept the Blocked status it found.
      const [earlier] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: task.id, status: "succeeded",
        createdAt: new Date(base - 5 * hour), finishedAt: new Date(base - 4 * hour), contextSnapshot: { issueId: task.id } }).returning();
      const decisionId = randomUUID();
      await db.transaction(async tx => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.insert(statusDecisions).values({ id: decisionId, companyId, issueId: task.id, runId: earlier.id,
          assessmentId: randomUUID(), decisionVersion: 1, policyVersion: "test", ...laterDecision,
          reasonCode: "prior_status_terminal_preserved", decisionJson: {}, decisionDigest: "test",
          createdAt: new Date(blockedAt.getTime() + 1_390) });
      });
      await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, task.id));
    }
    /** What the retained-file recovery leaves when it releases the hold (continue from the last save). */
    const releaseWriter = async () => {
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      const current = (row.metadata as { remoteWorkspace: Record<string, unknown> }).remoteWorkspace;
      await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, remoteWorkspace: { ...current,
        epoch: Number(current.epoch) + 1, writerRunId: null, dirty: false, location: null } } })
        .where(eq(executionWorkspaces.id, workspace.id));
    };
    return { companyId, agentId, task, workspaceId: workspace.id, writerRunId, actionId: action.id, releaseWriter };
  }

  /** The pass the scheduled issue-recovery worker runs for a company with active recovery actions. */
  async function scheduledRecoveryPass(companyId: string) {
    const [selected] = await db.selectDistinct({ companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions)
      .where(and(recoveryActionSweepCondition(), eq(issueRecoveryActions.companyId, companyId)));
    if (!selected) return false;
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileActiveRecoveryActions({ companyId });
    return true;
  }

  const issue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const wakesFor = (issueId: string) => wakes.filter(wake => (wake.options.payload as { issueId?: string }).issueId === issueId);

  it("continues the task once the hold is released, settling the board escalation", async () => {
    const f = await seedStrandedTask();
    const workspaceBefore = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0];

    // While the ended run still holds the workspace, nothing moves: a new run could only fail setup again.
    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);
    expect(await issue(f.task.id)).toMatchObject({ status: "blocked" });
    expect(await action(f.actionId)).toMatchObject({ status: "active", ownerType: "board" });
    expect(wakesFor(f.task.id)).toEqual([]);
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]).toEqual(workspaceBefore);

    await f.releaseWriter();
    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(await issue(f.task.id)).toMatchObject({ status: "todo", blockedTransitionAt: null, executionWorkspaceId: f.workspaceId });
    const resolved = await action(f.actionId);
    expect(resolved).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
      resolutionNote: RELEASED_WORKSPACE_WRITER_OUTCOME, returnOwnerAgentId: f.agentId });
    expect(resolved.evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "delivered", workspaceEpoch: 4 } });
    expect(String(resolved.nextAction)).not.toMatch(adminText);
    // The assignee is woken exactly once; its run resumes normally in the same workspace.
    expect(wakesFor(f.task.id)).toHaveLength(1);
    expect(wakesFor(f.task.id)[0]).toMatchObject({ agentId: f.agentId, options: { reason: "issue_recovery_action_restored",
      issueStateGuard: { statuses: ["todo"], assigneeAgentId: f.agentId } } });
    expect(wakesFor(f.task.id)[0].options.contextSnapshot).not.toHaveProperty("forceFreshSession");
    const notices = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.workspace_writer_released_continued")));
    expect(notices.map(row => row.entityId)).toEqual([f.task.id]);
    expect(String(notices[0].details?.note)).not.toMatch(adminText);

    // A later pass changes nothing.
    expect(await scheduledRecoveryPass(f.companyId)).toBe(false);
    expect((await continueTasksAfterWorkspaceWriterReleased(db, null, { companyId: f.companyId })).continued).toEqual([]);
    expect(wakesFor(f.task.id)).toHaveLength(1);
  }, 60_000);

  it("delivers a wake that a crash left pending, and keeps backing off a refused one", async () => {
    const f = await seedStrandedTask({ laterDecision: null });
    await f.releaseWriter();
    expect((await continueTasksAfterWorkspaceWriterReleased(db, null, { companyId: f.companyId })).continued).toEqual([f.task.id]);
    expect((await action(f.actionId)).evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "pending" } });

    const refused = await continueTasksAfterWorkspaceWriterReleased(db, (async () => null) as never, { companyId: f.companyId });
    expect((await action(f.actionId)).evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "pending", wakeFailures: 1 } });
    expect(refused.nextWakeRetryAt).toBeGreaterThan(Date.now());

    // The scheduled worker keeps selecting the company while the wake is owed.
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{releasedWorkspaceWriter,wakeRetryAt}', ${JSON.stringify(Date.now() - 1)}::jsonb)` }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);
    expect((await action(f.actionId)).evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "delivered" } });
    expect(wakesFor(f.task.id)).toHaveLength(1);
  }, 60_000);

  it("never wakes twice when a crash came after the wake created its run", async () => {
    const f = await seedStrandedTask();
    await f.releaseWriter();
    expect((await continueTasksAfterWorkspaceWriterReleased(db, null, { companyId: f.companyId })).continued).toEqual([f.task.id]);
    // The wake committed and created its run, then the process stopped before recording it as delivered.
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_recovery_action_restored", status: "completed", runId: randomUUID(),
      payload: { issueId: f.task.id, recoveryActionId: f.actionId, mutation: "recovery_action_resolution" } });
    expect((await action(f.actionId)).evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "pending" } });

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(wakesFor(f.task.id)).toEqual([]);
    expect((await action(f.actionId)).evidence).toMatchObject({ releasedWorkspaceWriter: { wake: "delivered" } });
  }, 60_000);

  it("keeps the task when a later decision chose the block, a dependency forbids work, or a newer run exists", async () => {
    const chosen = await seedStrandedTask({ laterDecision: { fromStatus: "in_progress", toStatus: "blocked" } });
    const dependent = await seedStrandedTask();
    const [cancelled] = await db.insert(issues).values({ companyId: dependent.companyId, title: "Cancelled prerequisite",
      status: "cancelled", issueNumber: 9 }).returning();
    await db.insert(issueRelations).values({ companyId: dependent.companyId, issueId: cancelled.id,
      relatedIssueId: dependent.task.id, type: "blocks" });
    const newer = await seedStrandedTask();
    await db.insert(heartbeatRuns).values({ companyId: newer.companyId, agentId: newer.agentId, issueId: newer.task.id,
      status: "queued", contextSnapshot: { issueId: newer.task.id } });

    for (const f of [chosen, dependent, newer]) {
      await f.releaseWriter();
      await scheduledRecoveryPass(f.companyId);
      expect(await issue(f.task.id)).toMatchObject({ status: "blocked" });
      expect(await action(f.actionId), f.task.title).not.toMatchObject({ resolutionNote: RELEASED_WORKSPACE_WRITER_OUTCOME });
      expect(wakesFor(f.task.id)).toEqual([]);
    }
  }, 60_000);

  it("keeps a task whose setup failed for another reason", async () => {
    const f = await seedStrandedTask();
    const latestRunId = String((await action(f.actionId)).evidence.latestRunId);
    await db.update(heartbeatRuns).set({ error: "Project access denied" }).where(eq(heartbeatRuns.id, latestRunId));
    await f.releaseWriter();

    await scheduledRecoveryPass(f.companyId);

    expect(await issue(f.task.id)).toMatchObject({ status: "blocked" });
    expect(await action(f.actionId)).toMatchObject({ status: "active" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
  }, 60_000);
});
