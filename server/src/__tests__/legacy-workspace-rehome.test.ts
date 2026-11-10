import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, executionWorkspaces,
  heartbeatRuns, issueRecoveryActions, issueRelations, issues, statusDecisions } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE } from "../services/remote-workspace-writer-hold.js";
import { LEGACY_WORKSPACE_REHOME_OUTCOME, rehomeStrandedLegacyWorkspaceTasks } from "../services/recovery/legacy-workspace-rehome.js";
import { recoveryActionSweepCondition } from "../services/recovery/blocker-stall-wakeups.js";
import { recoveryService } from "../services/recovery/service.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping legacy workspace rehome tests: ${recoveryPostgresSupport.reason}`);

// Recovery text never asks a person to inspect or fix a sandbox.
const adminText = /sandbox|environment|administrator|board member|board operator|owner must|inspect the/i;

/**
 * The staging shape (Nov 4-5): a parent task and three children that an older
 * release bound to the parent's remote workspace (before #19860). One child's
 * ended run still holds that workspace with unsaved files. The other two
 * children's runs failed setup on that hold before any provider work, and
 * stranded-work recovery blocked them with a board-owned escalation.
 */
describePostgres("stranded subtasks bound to a parent's held workspace", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "legacy_rehome_test";
  const dispatched: Array<{ issueId: string; context: Record<string, unknown> }> = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("legacy-workspace-rehome-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-legacy-rehome-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        const issueId = String(input.context.issueId);
        dispatched.push({ issueId, context: input.context as Record<string, unknown> });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seedSharedFamily() {
    const companyId = randomUUID(), agentId = randomUUID(), userId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Legacy family", defaultResponsibleUserId: userId, issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType, status: "idle", adapterConfig: {} });
    const [parent] = await db.insert(issues).values({ companyId, title: "Landing page", status: "blocked", assigneeAgentId: agentId,
      responsibleUserId: userId, executionWorkspacePreference: "reuse_existing", issueNumber: 1 }).returning();
    const writerRunId = randomUUID();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: parent.id, name: "Parent workspace",
      mode: "shared_workspace", strategyType: "project_primary", status: "active", providerType: "cloud_sandbox",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId: randomUUID(),
        source: { kind: "empty" }, writerRunId, dirty: true, location: null } } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, parent.id));
    const child = async (title: string, issueNumber: number) => (await db.insert(issues).values({ companyId, title, parentId: parent.id,
      status: "blocked", assigneeAgentId: agentId, responsibleUserId: userId, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      issueNumber, createdAt: new Date("2026-11-04T23:56:00Z") }).returning())[0];
    const [hero, pricing, writer] = [await child("Hero copy", 2), await child("Pricing table", 3), await child("FAQ", 4)];
    for (const blocker of [hero, pricing, writer])
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: parent.id, type: "blocks" });
    // The writer child's ended run holds the workspace (its save is still pending).
    await db.insert(heartbeatRuns).values({ id: writerRunId, companyId, agentId, issueId: writer.id, status: "failed",
      finishedAt: new Date(Date.now() - 4 * 86_400_000), contextSnapshot: { issueId: writer.id } });
    const strand = async (issueId: string, error = REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE) => {
      const finishedAt = new Date(Date.now() - 4 * 86_400_000);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "failed", errorCode: "setup_failed",
        error, startedAt: new Date(finishedAt.getTime() - 90_000), finishedAt,
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: { issueId, wakeReason: "workspace_busy_retry" } }).returning();
      const blockedAt = new Date(finishedAt.getTime() + 900);
      await db.update(issues).set({ blockedTransitionAt: blockedAt, statusVersion: 2 }).where(eq(issues.id, issueId));
      const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "stranded_assigned_issue",
        status: "active", ownerType: "board", previousOwnerAgentId: agentId, returnOwnerAgentId: agentId, cause: "stranded_assigned_issue",
        fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue`,
        nextAction: "Board operator: inspect the evidence, repair the runtime if appropriate, then explicitly retry the original owner, reassign, or intentionally resolve the task.",
        evidence: { latestRunId: run.id, retryReason: "workspace_busy", recoveryCause: "stranded_assigned_issue",
          routingPolicy: "board_escalation_no_takeover_v1", sourceIssueId: issueId, previousStatus: "in_progress",
          latestRunStatus: "failed", latestIssueStatus: "in_progress", latestRunErrorCode: "setup_failed" },
        createdAt: blockedAt, updatedAt: blockedAt }).returning();
      return { runId: run.id, actionId: action.id };
    };
    return { companyId, agentId, workspaceId: workspace.id, parent, hero, pricing, writer, strand };
  }

  /** The pass the scheduled issue-recovery worker runs for a company with active recovery actions. */
  async function scheduledRecoveryPass(companyId: string) {
    const [selected] = await db.selectDistinct({ companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions)
      .where(and(recoveryActionSweepCondition(), eq(issueRecoveryActions.companyId, companyId)));
    if (!selected) return false;
    await recoveryService(db, { enqueueWakeup: (agentId, options) => heartbeat.wakeup(agentId, options as never) })
      .reconcileActiveRecoveryActions({ companyId });
    return true;
  }

  const issue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;

  it("moves each stranded child to its own workspace and continues it, leaving the parent's workspace alone", async () => {
    const f = await seedSharedFamily();
    const hero = await f.strand(f.hero.id), pricing = await f.strand(f.pricing.id);
    const workspaceBefore = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0];

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    for (const [child, stranded] of [[f.hero, hero], [f.pricing, pricing]] as const) {
      const moved = await issue(child.id);
      // Its next run realizes its own workspace from the project base; nothing of the parent's is carried over.
      expect(moved).toMatchObject({ executionWorkspacePreference: null, workspaceBindingRevision: child.workspaceBindingRevision + 1 });
      expect(moved.executionWorkspaceId).not.toBe(f.workspaceId);
      const resolved = await action(stranded.actionId);
      expect(resolved).toMatchObject({ status: "resolved", outcome: "restored", ownerType: "system",
        resolutionNote: LEGACY_WORKSPACE_REHOME_OUTCOME, returnOwnerAgentId: f.agentId });
      expect(resolved.evidence).toMatchObject({
        legacyWorkspaceRehome: { previousExecutionWorkspaceId: f.workspaceId, runId: stranded.runId } });
      expect(String(resolved.nextAction)).not.toMatch(adminText);
    }
    // The parent keeps its own workspace, and the writer child keeps its saved-work binding.
    expect(await issue(f.parent.id)).toMatchObject({ executionWorkspaceId: f.workspaceId, status: "blocked" });
    expect(await issue(f.writer.id)).toMatchObject({ executionWorkspaceId: f.workspaceId, status: "blocked" });
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]).toEqual(workspaceBefore);
    const rehomed = await db.select().from(activityLog).where(eq(activityLog.action, "issue.legacy_workspace_rehomed"));
    expect(rehomed.filter(row => row.companyId === f.companyId).map(row => row.entityId).sort())
      .toEqual([f.hero.id, f.pricing.id].sort());

    // Each moved child is woken exactly once, with a fresh session, and runs outside the shared workspace.
    await heartbeat.drainActiveRunExecutions();
    for (const child of [f.hero, f.pricing]) {
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.reason, "issue_recovery_action_restored")));
      expect(wakes.filter(wake => wake.payload?.issueId === child.id)).toHaveLength(1);
      const turns = dispatched.filter(turn => turn.issueId === child.id);
      expect(turns).toHaveLength(1);
      expect(turns[0].context).toMatchObject({ forceFreshSession: true, wakeReason: "issue_recovery_action_restored" });
      expect(turns[0].context.executionWorkspaceId ?? null).not.toBe(f.workspaceId);
      expect((await issue(child.id)).status).toBe("done");
    }
    // Nothing ran for the parent or the writer child in the shared workspace.
    expect(dispatched.filter(turn => [f.parent.id, f.writer.id].includes(turn.issueId))).toEqual([]);
    // A later pass changes nothing.
    expect((await rehomeStrandedLegacyWorkspaceTasks(db, null, { companyId: f.companyId })).rehomed).toEqual([]);
    expect((await issue(f.hero.id)).executionWorkspaceId).not.toBe(f.workspaceId);
  }, 60_000);

  it("delivers a move's wake that a crash left pending", async () => {
    const f = await seedSharedFamily();
    const hero = await f.strand(f.hero.id);
    // The move commits, then the process stops before it wakes the assignee.
    expect((await rehomeStrandedLegacyWorkspaceTasks(db, null, { companyId: f.companyId })).rehomed).toEqual([f.hero.id]);
    expect((await action(hero.actionId)).evidence).toMatchObject({ legacyWorkspaceRehome: { wake: "pending" } });
    expect(await issue(f.hero.id)).toMatchObject({ status: "todo", executionWorkspaceId: null });

    // The scheduled worker still selects the company and delivers the owed wake once.
    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    expect((await action(hero.actionId)).evidence).toMatchObject({ legacyWorkspaceRehome: { wake: "delivered" } });
    expect(dispatched.filter(turn => turn.issueId === f.hero.id)).toHaveLength(1);
    expect((await issue(f.hero.id)).status).toBe("done");
  }, 60_000);

  it("keeps a refused or failing wake pending and backs it off without holding up the others", async () => {
    const f = await seedSharedFamily();
    const hero = await f.strand(f.hero.id), pricing = await f.strand(f.pricing.id);
    expect((await rehomeStrandedLegacyWorkspaceTasks(db, null, { companyId: f.companyId })).rehomed.sort()).toEqual([f.hero.id, f.pricing.id].sort());
    const woken: string[] = [];
    // The heartbeat refuses the hero's wake (it returns null, as for disabled on-demand wakes).
    const refusing = async (_agentId: string, options: { payload: Record<string, unknown> }) => {
      if (options.payload.issueId === f.hero.id) return null;
      woken.push(String(options.payload.issueId));
      return { id: randomUUID() };
    };

    const first = await rehomeStrandedLegacyWorkspaceTasks(db, refusing as never, { companyId: f.companyId });
    expect(woken).toEqual([f.pricing.id]);
    const backedOff = (await action(hero.actionId)).evidence.legacyWorkspaceRehome as Record<string, unknown>;
    expect(backedOff).toMatchObject({ wake: "pending", wakeFailures: 1 });
    expect(Number(backedOff.wakeRetryAt)).toBeGreaterThan(Date.now());
    // The pass reports that deadline to the worker, so the retry is scheduled.
    expect(first.nextWakeRetryAt).toBe(Number(backedOff.wakeRetryAt));
    expect((await action(pricing.actionId)).evidence).toMatchObject({ legacyWorkspaceRehome: { wake: "delivered" } });
    // The company stays selected by the scheduled worker while a wake is owed, also after a restart.
    const [selected] = await db.selectDistinct({ companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions)
      .where(and(recoveryActionSweepCondition(), eq(issueRecoveryActions.companyId, f.companyId)));
    expect(selected).toBeDefined();

    // Not retried before its time, and a thrown wake backs off too.
    await rehomeStrandedLegacyWorkspaceTasks(db, refusing as never, { companyId: f.companyId });
    expect(woken).toEqual([f.pricing.id]);
    await db.update(issueRecoveryActions).set({ evidence: { ...(await action(hero.actionId)).evidence,
      legacyWorkspaceRehome: { ...backedOff, wakeRetryAt: Date.now() - 1 } } }).where(eq(issueRecoveryActions.id, hero.actionId));
    await rehomeStrandedLegacyWorkspaceTasks(db, (async () => { throw new Error("enqueue failed"); }) as never, { companyId: f.companyId });
    expect((await action(hero.actionId)).evidence).toMatchObject({ legacyWorkspaceRehome: { wake: "pending", wakeFailures: 2 } });

    // Once due and accepted, the wake settles.
    await db.update(issueRecoveryActions).set({ evidence: { ...(await action(hero.actionId)).evidence,
      legacyWorkspaceRehome: { ...backedOff, wakeFailures: 2, wakeRetryAt: Date.now() - 1 } } }).where(eq(issueRecoveryActions.id, hero.actionId));
    const last = await rehomeStrandedLegacyWorkspaceTasks(db, (async (_agentId: string, options: { payload: Record<string, unknown> }) => {
      woken.push(String(options.payload.issueId)); return { id: randomUUID() }; }) as never, { companyId: f.companyId });
    expect(woken).toEqual([f.pricing.id, f.hero.id]);
    expect((await action(hero.actionId)).evidence).toMatchObject({ legacyWorkspaceRehome: { wake: "delivered" } });
    expect(last.nextWakeRetryAt).toBeNull();
  }, 60_000);

  it("pages past escalations the guards reject", async () => {
    const f = await seedSharedFamily();
    // Thirty escalations that match the query but fail a guard (another setup error).
    for (let index = 0; index < 30; index++) {
      const [other] = await db.insert(issues).values({ companyId: f.companyId, title: `Other ${index}`, parentId: f.parent.id,
        status: "blocked", assigneeAgentId: f.agentId, executionWorkspaceId: f.workspaceId, issueNumber: 100 + index }).returning();
      await f.strand(other.id, "Project access denied");
    }
    const hero = await f.strand(f.hero.id);
    // The eligible escalation sorts after every rejected one.
    await db.update(issueRecoveryActions).set({ id: "ffffffff-ffff-4fff-bfff-ffffffffffff" }).where(eq(issueRecoveryActions.id, hero.actionId));
    expect((await rehomeStrandedLegacyWorkspaceTasks(db, null, { companyId: f.companyId })).rehomed).toEqual([f.hero.id]);
  }, 60_000);

  it("keeps a stranded child whose dependency still forbids work", async () => {
    const f = await seedSharedFamily();
    const stranded = await f.strand(f.hero.id);
    const [cancelled] = await db.insert(issues).values({ companyId: f.companyId, title: "Cancelled prerequisite", status: "cancelled",
      issueNumber: 9 }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: cancelled.id, relatedIssueId: f.hero.id, type: "blocks" });

    await scheduledRecoveryPass(f.companyId);

    expect(await issue(f.hero.id)).toMatchObject({ status: "blocked", executionWorkspaceId: f.workspaceId });
    expect(await action(stranded.actionId)).toMatchObject({ status: "active", ownerType: "board" });
  }, 60_000);

  it("moves a child whose last status decision came before the block, and keeps one decided after it", async () => {
    const f = await seedSharedFamily();
    const earlier = await f.strand(f.hero.id), later = await f.strand(f.pricing.id);
    const decide = async (issueId: string, at: Date) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId, status: "succeeded",
        finishedAt: at, contextSnapshot: { issueId } }).returning();
      // Only the decision's time matters here; its assessment chain is out of scope.
      const decisionId = randomUUID();
      await db.transaction(async tx => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.insert(statusDecisions).values({ id: decisionId, companyId: f.companyId, issueId, runId: run.id,
          assessmentId: randomUUID(), decisionVersion: 1, policyVersion: "test", fromStatus: "todo", toStatus: "in_progress",
          reasonCode: "test", decisionJson: {}, decisionDigest: "test", createdAt: at });
      });
      await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
    };
    const blockedAt = (await issue(f.hero.id)).blockedTransitionAt!.getTime();
    await decide(f.hero.id, new Date(blockedAt - 86_400_000));
    await decide(f.pricing.id, new Date(blockedAt + 5_000));

    await scheduledRecoveryPass(f.companyId);

    expect((await issue(f.hero.id)).executionWorkspaceId).not.toBe(f.workspaceId);
    expect(await action(earlier.actionId)).toMatchObject({ status: "resolved" });
    expect(await issue(f.pricing.id)).toMatchObject({ status: "blocked", executionWorkspaceId: f.workspaceId });
    expect(await action(later.actionId)).toMatchObject({ status: "active" });
    await heartbeat.drainActiveRunExecutions();
  }, 60_000);

  it("keeps a stranded child whose setup failed for another reason", async () => {
    const f = await seedSharedFamily();
    const other = await f.strand(f.hero.id, "Project access denied");

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(await issue(f.hero.id)).toMatchObject({ status: "blocked", executionWorkspaceId: f.workspaceId });
    expect(await action(other.actionId)).toMatchObject({ status: "active", ownerType: "board" });
  }, 60_000);

  it("keeps a task bound to its own workspace", async () => {
    const f = await seedSharedFamily();
    // The parent itself created the workspace; it never moves.
    const own = await f.strand(f.parent.id);
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, f.parent.id));

    expect(await scheduledRecoveryPass(f.companyId)).toBe(true);

    expect(await issue(f.parent.id)).toMatchObject({ status: "blocked", executionWorkspaceId: f.workspaceId });
    expect(await action(own.actionId)).toMatchObject({ status: "active" });
  }, 60_000);
});
