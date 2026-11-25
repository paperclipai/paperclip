import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environments,
  environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issueRelations, issues, nativeRunFinalizations,
  nativeRunResults, projects, projectWorkspaces, statusDecisions, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { createReusableLeaseHandoff } from "../services/environment-lease-handoff.js";
import { heartbeatService } from "../services/heartbeat.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { readRemoteWorkspaceWriterHold, REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE, remoteWorkspaceHoldRefusesStart }
  from "../services/remote-workspace-writer-hold.js";
import { REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA } from "../services/remote-workspace-epoch-abandonment.js";
import { reserveRemoteWorkspace } from "../services/remote-workspaces.js";
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("abandons a superseded ended writer's stale epoch and continues the stranded task", async () => {
    const f = await seedStrandedTask();
    const leaseId = randomUUID();
    const location = { environmentId: randomUUID(), leaseId, providerLeaseId: randomUUID(),
      remoteCwd: `/work/.paperclip-workspaces/${f.workspaceId}-3-${leaseId}` };
    const [wsBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const currentAuthority = readRemoteWorkspaceAuthority(wsBefore!.metadata)!;
    await db.update(executionWorkspaces).set({ metadata: { ...wsBefore!.metadata,
      remoteWorkspace: { ...currentAuthority, location } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const successorId = randomUUID();
    const [writerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.writerRunId));
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation" })
      .where(eq(heartbeatRuns.id, f.writerRunId));
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.task.id, nativeIssueId: f.task.id, runtimeMode: "native", status: "failed",
      errorCode: "controller_lease_lost",
      createdAt: new Date(writerRun!.finishedAt!.getTime() + 60_000),
      finishedAt: new Date(writerRun!.finishedAt!.getTime() + 5 * 60_000),
      contextSnapshot: { issueId: f.task.id } });
    await db.insert(nativeRunFinalizations).values({ runId: f.writerRunId, companyId: f.companyId,
      issueId: f.task.id, phase: "terminal_failure", attempt: 1,
      failureCode: "native_continuation_requires_reconciliation",
      failureDetail: { successorRunId: successorId } });

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(await issue(f.task.id)).toMatchObject({ status: "todo", blockedTransitionAt: null, executionWorkspaceId: f.workspaceId });
    expect(await action(f.actionId)).toMatchObject({ status: "resolved", outcome: "restored",
      resolutionNote: RELEASED_WORKSPACE_WRITER_OUTCOME });
    const [wsAfter] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(readRemoteWorkspaceAuthority(wsAfter!.metadata)).toMatchObject({
      epoch: 4, writerRunId: null, dirty: false, location: null, snapshotId: currentAuthority.snapshotId,
    });
    expect(wsAfter!.metadata?.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({
      schema: REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA, epoch: 3, runId: f.writerRunId, location,
    })]);
    expect(wakesFor(f.task.id)).toHaveLength(1);
  }, 60_000);

  it("keeps a stranded task blocked when the writer holds unsaved files for a board-owned export recovery", async () => {
    const f = await seedStrandedTask();
    const leaseId = randomUUID();
    const location = { environmentId: randomUUID(), leaseId, providerLeaseId: randomUUID(),
      remoteCwd: `/work/.paperclip-workspaces/${f.workspaceId}-3-${leaseId}` };
    const [wsBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const currentAuthority = readRemoteWorkspaceAuthority(wsBefore!.metadata)!;
    const heldMetadata = { ...wsBefore!.metadata, remoteWorkspace: { ...currentAuthority, location } };
    await db.update(executionWorkspaces).set({ metadata: heldMetadata }).where(eq(executionWorkspaces.id, f.workspaceId));
    const [contract] = await db.insert(completionContracts).values({
      companyId: f.companyId, issueId: f.task.id, revision: 1,
      schemaVersion: "paperclip.completion-contract/v1", policyVersion: "v1", risk: "low",
      completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "a".repeat(64),
      createdByActorType: "system", createdByActorId: "test",
    }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "native_workspace_sync_out_retry_exhausted", completionContractId: contract!.id })
      .where(eq(heartbeatRuns.id, f.writerRunId));
    const [res] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.task.id,
      runId: f.writerRunId, completionContractId: contract!.id, serverFingerprint: `fp-${f.writerRunId}`,
      schemaStatus: "accepted", resultJson: { terminalState: "succeeded" }, canonicalSha256: "b".repeat(64) }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: f.writerRunId, companyId: f.companyId,
      issueId: f.task.id, phase: "terminal_failure", attempt: 3, resultId: res!.id,
      failureCode: "native_workspace_sync_out_retry_exhausted" });

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(await issue(f.task.id)).toMatchObject({ status: "blocked" });
    expect(await action(f.actionId)).toMatchObject({ status: "active", ownerType: "board" });
    const [wsAfter] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(readRemoteWorkspaceAuthority(wsAfter!.metadata)).toEqual({ ...currentAuthority, location });
    expect(wakesFor(f.task.id)).toEqual([]);
  }, 60_000);

  async function seedReservationWorkspace() {
    vi.stubEnv("DATABASE_URL", temporary.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    const [company] = await db.insert(companies).values({ name: "Writer hold reservation", issuePrefix: `R${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker", adapterType: "paperclip_runner" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Source project" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: company!.id, projectId: project!.id,
      name: "Task files", sourceType: "empty" }).returning();
    const [environment] = await db.insert(environments).values({ name: `Reservation ${randomUUID()}`, driver: "sandbox", config: {} }).returning();
    const [task] = await db.insert(issues).values({ companyId: company!.id, projectId: project!.id,
      projectWorkspaceId: source!.id, title: "Continue saved work", status: "todo", assigneeAgentId: agent!.id }).returning();
    const snapshotId = randomUUID();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 3, snapshotId,
      source: { kind: "empty" as const }, location: null, writerRunId: null, dirty: false };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company!.id, sourceIssueId: task!.id,
      projectId: project!.id, projectWorkspaceId: source!.id, name: "Task files", mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "cloud_sandbox", cwd: `/workspaces/${randomUUID()}`,
      metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, task!.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id,
      issueId: task!.id, status: "running", runtimeMode: "legacy" }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(home, company!.id))), provider: "s3" as const };
    const input = { db, storage, companyId: company!.id, issueId: task!.id, runId: run!.id, agentId: agent!.id,
      environmentId: environment!.id, projectId: project!.id, projectWorkspaceId: source!.id,
      existingWorkspaceId: workspace!.id, source: authority.source };
    const readWorkspace = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id)))[0]!;
    return { input, company: company!, agent: agent!, task: task!, workspace: workspace!, authority, run: run!, readWorkspace };
  }

  it.each(["destroyed-tip", "stopped-tip", "active-tip"] as const)
  ("resolves an expired reusable lease through its destroyed tip before holding an unused reservation (%s)", async mode => {
    const f = await seedReservationWorkspace();
    const endedAt = new Date(Date.now() - 2 * 60 * 60_000);
    const handoffAt = new Date(endedAt.getTime() + 60_000);
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.task.id, status: "failed", finishedAt: endedAt }).returning();
    const [tipRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.task.id, status: mode === "active-tip" ? "running" : "succeeded",
      finishedAt: mode === "active-tip" ? null : new Date(handoffAt.getTime() + 60_000) }).returning();
    const providerLeaseId = randomUUID();
    const [expiredLease] = await db.insert(environmentLeases).values({ companyId: f.company.id, environmentId: f.input.environmentId,
      executionWorkspaceId: f.workspace.id, heartbeatRunId: writer!.id, issueId: f.task.id, provider: "daytona", providerLeaseId,
      status: "expired", cleanupStatus: "success", leasePolicy: "reuse_by_environment",
      acquiredAt: new Date(endedAt.getTime() - 60_000), releasedAt: handoffAt,
      metadata: { agentId: f.agent.id } }).returning();
    const [tipLease] = await db.insert(environmentLeases).values({ companyId: f.company.id, environmentId: f.input.environmentId,
      executionWorkspaceId: f.workspace.id, heartbeatRunId: tipRun!.id, issueId: f.task.id, provider: "daytona", providerLeaseId,
      status: mode === "active-tip" ? "active" : "released",
      cleanupStatus: mode === "active-tip" ? null : "success",
      leasePolicy: "reuse_by_environment",
      acquiredAt: handoffAt, releasedAt: mode === "active-tip" ? null : new Date(handoffAt.getTime() + 60_000),
      metadata: { agentId: f.agent.id } }).returning();
    const handoff = createReusableLeaseHandoff(expiredLease!, tipLease!);
    await db.update(environmentLeases).set({ metadata: { agentId: f.agent.id, reusableLeaseSuccessor: handoff } })
      .where(eq(environmentLeases.id, expiredLease!.id));
    const tipTermination = mode === "destroyed-tip"
      ? remoteTerminationReceipt(tipLease!, { providerLeaseId, state: "destroyed" })
      : mode === "stopped-tip"
        ? remoteTerminationReceipt(tipLease!, { providerLeaseId, state: "stopped" })
        : undefined;
    await db.update(environmentLeases).set({ metadata: {
      agentId: f.agent.id, reusableLeasePredecessor: handoff,
      ...(tipTermination ? { remoteExecutionTermination: tipTermination } : {}),
    } }).where(eq(environmentLeases.id, tipLease!.id));
    const held = { ...f.authority, writerRunId: writer!.id, dirty: false };
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: held } }).where(eq(executionWorkspaces.id, f.workspace.id));

    const hold = await readRemoteWorkspaceWriterHold(db, { companyId: f.company.id, authority: held, runId: f.run.id });
    if (mode === "destroyed-tip") {
      expect(hold).toEqual({ kind: "free" });
      await expect(reserveRemoteWorkspace(f.input)).resolves.toMatchObject({ id: f.workspace.id });
      expect(readRemoteWorkspaceAuthority((await f.readWorkspace()).metadata)).toMatchObject({ writerRunId: f.run.id, epoch: 4 });
    } else {
      expect(hold.kind).toBe("held");
      await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("unfinished writer");
    }
  });

  async function seedDirtyEndedWriter(options: {
    supersession: "coordinator" | "explicit_continuation" | "reconciliation" | "none";
    writerStatus?: "failed" | "succeeded";
    successorStatus?: "failed" | "running" | "queued";
    uncommittedAcceptedResult?: boolean;
    openRecoveryAction?: boolean;
    pendingSystemRecovery?: boolean;
    unsettledNoReplayHold?: boolean;
    unsafeArchiveHold?: boolean;
    runningSnapshotOp?: boolean;
    liveControllerLease?: boolean;
    liveFinalizerLease?: boolean;
  }) {
    const f = await seedReservationWorkspace();
    const endedAt = new Date(Date.now() - 2 * 60 * 60_000);
    const leaseId = randomUUID();
    const location = { environmentId: f.input.environmentId, leaseId, providerLeaseId: randomUUID(),
      remoteCwd: `/work/.paperclip-workspaces/${f.workspace.id}-3-${leaseId}` };
    let contractId: string | null = null;
    if (options.uncommittedAcceptedResult) {
      const [contract] = await db.insert(completionContracts).values({
        companyId: f.company.id, issueId: f.task.id, revision: 1,
        schemaVersion: "paperclip.completion-contract/v1", policyVersion: "v1", risk: "low",
        completionAuthority: "agent", incompleteCriteriaPolicy: "block",
        contractJson: {}, canonicalSha256: "a".repeat(64),
        createdByActorType: "system", createdByActorId: "test",
      }).returning();
      contractId = contract!.id;
    }
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.task.id, nativeIssueId: f.task.id, completionContractId: contractId, runtimeMode: "native",
      status: options.writerStatus ?? "failed",
      errorCode: options.uncommittedAcceptedResult ? "native_workspace_sync_out_retry_exhausted" : "native_continuation_requires_reconciliation",
      createdAt: new Date(endedAt.getTime() - 10 * 60_000), startedAt: new Date(endedAt.getTime() - 9 * 60_000),
      finishedAt: endedAt,
      controllerLeaseExpiresAt: options.liveControllerLease ? new Date(Date.now() + 10 * 60_000) : null,
      contextSnapshot: { issueId: f.task.id },
      runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId: f.workspace.id,
        leaseId, providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd,
        epoch: f.authority.epoch, state: "prepared", snapshotId: f.authority.snapshotId } } }).returning();
    const [successor] = options.supersession !== "none" ? await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.agent.id, issueId: f.task.id, nativeIssueId: f.task.id,
      runtimeMode: "native", status: options.successorStatus ?? "failed", errorCode: options.successorStatus ? null : "controller_lease_lost",
      createdAt: new Date(endedAt.getTime() + 60_000),
      finishedAt: (options.successorStatus ?? "failed") === "failed" ? new Date(endedAt.getTime() + 5 * 60_000) : null,
      contextSnapshot: { issueId: f.task.id } }).returning() : [];
    const held = { ...f.authority, writerRunId: writer!.id, dirty: true, location };
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: held } }).where(eq(executionWorkspaces.id, f.workspace.id));
    let resultId: string | null = null;
    if (options.uncommittedAcceptedResult && contractId) {
      const [res] = await db.insert(nativeRunResults).values({ companyId: f.company.id, issueId: f.task.id,
        runId: writer!.id, completionContractId: contractId, serverFingerprint: `fp-${writer!.id}`,
        schemaStatus: "accepted", resultJson: { terminalState: "succeeded" }, canonicalSha256: "b".repeat(64) }).returning();
      resultId = res!.id;
    }
    await db.insert(nativeRunFinalizations).values({
      runId: writer!.id, companyId: f.company.id, issueId: f.task.id,
      phase: "terminal_failure", attempt: 1, resultId,
      leaseOwner: options.liveFinalizerLease ? "native-finalizer:live" : null,
      leaseExpiresAt: options.liveFinalizerLease ? new Date(Date.now() + 10 * 60_000) : null,
      failureCode: options.uncommittedAcceptedResult ? "native_workspace_sync_out_retry_exhausted" : "native_continuation_requires_reconciliation",
      failureDetail: options.supersession === "coordinator" && successor ? { successorRunId: successor.id } : {},
    });
    if (options.supersession === "explicit_continuation" && successor) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "resolved", outcome: "cancelled", ownerType: "system",
        cause: "native_continuation_requires_reconciliation", fingerprint: `explicit:${writer!.id}`,
        nextAction: "User started a fresh continuation.",
        evidence: { runId: writer!.id, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "explicit_user_continuation", runId: writer!.id },
          explicitUserContinuation: { previousRunId: writer!.id, runId: successor.id,
            readiness: { mode: "fresh_isolated_workspace", retryIntentId: randomUUID(), sourceRunId: writer!.id, retainedSourceIds: [] } } } });
    }
    if (options.supersession === "reconciliation" && successor) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
        cause: "native_continuation_requires_reconciliation", fingerprint: `reconciled:${writer!.id}`,
        nextAction: "Continued in a fresh run.",
        evidence: { runId: writer!.id, executionReconciliation: { runId: writer!.id, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: "continued" },
          continuationDelivery: "delivered", continuationRunId: successor.id } });
    }
    if (options.openRecoveryAction) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "active", ownerType: "board",
        cause: options.uncommittedAcceptedResult ? "native_workspace_sync_out_retry_exhausted" : "native_continuation_requires_reconciliation",
        fingerprint: `open:${writer!.id}`, nextAction: "Retry to save files.", evidence: { runId: writer!.id } });
    }
    if (options.pendingSystemRecovery) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "system",
        cause: "native_continuation_requires_reconciliation", fingerprint: `sysrec:${writer!.id}`,
        nextAction: "Saving files.",
        evidence: { runId: writer!.id, systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1,
          sourceRunId: writer!.id, revision: 1, generationId: randomUUID(), intentId: null, phase: "preserve_files",
          state: "running", attemptId: randomUUID(), attempts: 1, retriesUsed: 0, firstFailureAt: null,
          nextAttemptAt: null, deadlineAt: null, providerCooldownAt: null, failure: null,
          preservationOperationIds: [], freshAttemptRunId: null } } });
    }
    if (options.unsettledNoReplayHold) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
        cause: "native_continuation_requires_reconciliation", fingerprint: `noreplay:${writer!.id}`,
        nextAction: "Stopped.",
        evidence: { runId: writer!.id, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: writer!.id } } });
    }
    if (options.unsafeArchiveHold) {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.task.id,
        kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
        cause: "native_continuation_requires_reconciliation", fingerprint: `unsafe:${writer!.id}`,
        nextAction: "Archive refused.",
        evidence: { runId: writer!.id, workspaceRestoreFailure: "restore_unsafe_archive" } });
    }
    if (options.runningSnapshotOp) {
      await db.insert(workspaceOperations).values({ companyId: f.company.id, issueId: f.task.id, heartbeatRunId: writer!.id,
        executionWorkspaceId: f.workspace.id, phase: "remote_workspace_snapshot", status: "running",
        metadata: { epoch: String(f.authority.epoch), boundary: "final" } });
    }
    return { ...f, writer: writer!, successor, held, location };
  }

  it.each(["coordinator", "explicit_continuation", "reconciliation"] as const)
  ("abandons a superseded ended writer's dirty epoch on reservation once its successor has ended (%s)", async supersession => {
    const f = await seedDirtyEndedWriter({ supersession });
    const reserved = await reserveRemoteWorkspace(f.input);
    expect(reserved.id).toBe(f.workspace.id);
    // Epoch advances once for abandonment (3 -> 4) and once for reservation (4 -> 5),
    // clearing dirty and location so the next run restores the last committed snapshot into a new root.
    expect(readRemoteWorkspaceAuthority(reserved.metadata)).toEqual({
      ...f.authority, epoch: 5, writerRunId: f.run.id, dirty: false, location: null,
    });
    const abandoned = (reserved.metadata?.remoteWorkspaceAbandonedEpochs ?? []) as Array<Record<string, unknown>>;
    expect(abandoned).toEqual([expect.objectContaining({
      schema: REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA,
      epoch: 3, runId: f.writer.id, snapshotId: f.authority.snapshotId, location: f.location,
    })]);
  });

  it("abandons a succeeded superseded dirty writer's epoch once its successor has ended", async () => {
    const f = await seedDirtyEndedWriter({ supersession: "coordinator", writerStatus: "succeeded" });
    const reserved = await reserveRemoteWorkspace(f.input);
    expect(readRemoteWorkspaceAuthority(reserved.metadata)).toEqual({
      ...f.authority, epoch: 5, writerRunId: f.run.id, dirty: false, location: null,
    });
  });

  it("keeps a board-owned unsaved-files export hold fenced during reservation", async () => {
    const f = await seedDirtyEndedWriter({ supersession: "none", uncommittedAcceptedResult: true, openRecoveryAction: true });
    const hold = await readRemoteWorkspaceWriterHold(db, { companyId: f.company.id, authority: f.held, runId: f.run.id });
    expect(hold.kind).toBe("held");
    expect(remoteWorkspaceHoldRefusesStart(hold)).toBe(true);
    await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("unfinished writer");
    expect(readRemoteWorkspaceAuthority((await f.readWorkspace()).metadata)).toEqual(f.held);
  });

  it.each([
    ["live successor running", { supersession: "explicit_continuation" as const, successorStatus: "running" as const }],
    ["live successor queued", { supersession: "explicit_continuation" as const, successorStatus: "queued" as const }],
    ["open recovery action", { supersession: "coordinator" as const, openRecoveryAction: true }],
    ["pending system recovery", { supersession: "coordinator" as const, pendingSystemRecovery: true }],
    ["unsettled no-replay hold", { supersession: "coordinator" as const, unsettledNoReplayHold: true }],
    ["unsafe archive hold", { supersession: "coordinator" as const, unsafeArchiveHold: true }],
    ["uncommitted accepted result", { supersession: "coordinator" as const, uncommittedAcceptedResult: true }],
    ["running snapshot save", { supersession: "coordinator" as const, runningSnapshotOp: true }],
    ["live controller lease", { supersession: "coordinator" as const, liveControllerLease: true }],
    ["live finalizer lease", { supersession: "coordinator" as const, liveFinalizerLease: true }],
  ])("refuses to abandon a superseded writer while safety guard holds (%s)", async (_label, opts) => {
    const f = await seedDirtyEndedWriter(opts);
    await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("unfinished writer");
    expect(readRemoteWorkspaceAuthority((await f.readWorkspace()).metadata)).toEqual(f.held);
  });
});
