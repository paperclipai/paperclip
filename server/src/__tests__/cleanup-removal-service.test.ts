import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentConfigRevisions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issueRecoveryActions,
  issues,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agentApiKeys);
    await db.delete(agentConfigRevisions);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRecoveryActions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
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
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  async function waitForBlockedAgentRowLock(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%agents%'
          and query ilike '%for update%'
      `) as unknown as Array<{ waiting: number }>;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the competing agent update to block on the row lock");
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("atomically contains routines, triggers, and API keys on explicit termination", async () => {
    const { agentId, companyId } = await seedFixture();
    const activeRoutineId = randomUUID();
    const pausedRoutineId = randomUUID();
    const activeTriggerId = randomUUID();
    const pausedTriggerId = randomUUID();
    const activeKeyId = randomUUID();
    const alreadyRevokedKeyId = randomUUID();
    const alreadyRevokedAt = new Date("2026-07-01T00:00:00.000Z");
    const nextRunAt = new Date("2026-07-11T01:00:00.000Z");

    await db.insert(routines).values([
      {
        id: activeRoutineId,
        companyId,
        title: "Active health check",
        status: "active",
        assigneeAgentId: agentId,
      },
      {
        id: pausedRoutineId,
        companyId,
        title: "Paused health check",
        status: "paused",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(routineTriggers).values([
      {
        id: activeTriggerId,
        companyId,
        routineId: activeRoutineId,
        kind: "schedule",
        enabled: true,
        nextRunAt,
      },
      {
        id: pausedTriggerId,
        companyId,
        routineId: pausedRoutineId,
        kind: "schedule",
        enabled: true,
        nextRunAt,
      },
    ]);
    await db.insert(agentApiKeys).values([
      {
        id: activeKeyId,
        companyId,
        agentId,
        name: "active",
        keyHash: `active-${activeKeyId}`,
      },
      {
        id: alreadyRevokedKeyId,
        companyId,
        agentId,
        name: "already-revoked",
        keyHash: `revoked-${alreadyRevokedKeyId}`,
        revokedAt: alreadyRevokedAt,
      },
    ]);

    const terminated = await agentService(db).terminate(agentId, {
      actorType: "user",
      actorId: "board-user",
      source: "agent_detail",
    });

    expect(terminated?.status).toBe("terminated");
    await expect(db.select().from(routines).where(eq(routines.id, activeRoutineId)))
      .resolves.toEqual([expect.objectContaining({ status: "paused" })]);
    await expect(db.select().from(routines).where(eq(routines.id, pausedRoutineId)))
      .resolves.toEqual([expect.objectContaining({ status: "paused" })]);
    for (const triggerId of [activeTriggerId, pausedTriggerId]) {
      await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, triggerId)))
        .resolves.toEqual([expect.objectContaining({ enabled: false, nextRunAt: null })]);
    }
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.id, activeKeyId)))
      .resolves.toEqual([expect.objectContaining({ revokedAt: expect.any(Date) })]);
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.id, alreadyRevokedKeyId)))
      .resolves.toEqual([expect.objectContaining({ revokedAt: alreadyRevokedAt })]);

    const routineRecoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`))
      .then((rows) => rows[0]);
    expect(routineRecoveryIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: null,
      originKind: "harness_liveness_escalation",
      executionContract: expect.objectContaining({
        contractType: "routine_termination_handoff",
        routineRecovery: expect.objectContaining({
          terminatedAgentId: agentId,
          routines: expect.arrayContaining([
            expect.objectContaining({ id: activeRoutineId, status: "active" }),
            expect.objectContaining({ id: pausedRoutineId, status: "paused" }),
          ]),
          triggers: expect.arrayContaining([
            expect.objectContaining({ id: activeTriggerId, enabled: true, nextRunAt: nextRunAt.toISOString() }),
            expect.objectContaining({ id: pausedTriggerId, enabled: true, nextRunAt: nextRunAt.toISOString() }),
          ]),
        }),
      }),
    });
    await expect(
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, routineRecoveryIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        cause: "terminated_routine_owner",
        status: "escalated",
        ownerType: "board",
      }),
    ]);

    const auditRows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
        action: "agent.termination_invariant_applied",
        entityId: agentId,
        details: expect.objectContaining({
          source: "agent_detail",
          pausedRoutineCount: 1,
          disabledTriggerCount: 2,
          revokedApiKeyCount: 1,
        }),
      }),
      expect.objectContaining({ action: "routine.updated", entityId: activeRoutineId }),
      expect.objectContaining({ action: "routine.trigger_updated", entityId: activeTriggerId }),
      expect.objectContaining({ action: "routine.trigger_updated", entityId: pausedTriggerId }),
      expect.objectContaining({ action: "agent.key_revoked", entityId: activeKeyId }),
    ]));
  });

  it("opens bounded recovery handoffs without routing source execution to a manager", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const subordinateId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-07-12T00:00:00.000Z");
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "LifecycleManager",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: subordinateId,
        companyId,
        name: "LifecycleSubordinate",
        role: "engineer",
        status: "idle",
        reportsTo: agentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Monitored work owned by retiring agent",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 0,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: nextCheckAt.toISOString(),
          maxAttempts: 2,
          scheduledBy: "board",
        },
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: 0,
          notes: null,
          scheduledBy: "board",
          kind: null,
          serviceName: null,
          externalRef: null,
          timeoutAt: null,
          maxAttempts: 2,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
    });

    const driveQueuedRunsForAgent = vi.fn(async () => undefined);
    await agentService(db, { driveQueuedRunsForAgent }).terminate(agentId, {
      actorType: "system",
      actorId: "lifecycle-test",
      source: "lifecycle_test",
    });

    const [quiescedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(quiescedIssue).toMatchObject({
      assigneeAgentId: agentId,
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      executionState: expect.objectContaining({
        monitor: expect.objectContaining({
          status: "cleared",
          clearReason: "invalid_assignee",
        }),
      }),
    });
    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: subordinateId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: null,
      cause: "terminated_owner",
      maxAttempts: 1,
      timeoutAt: expect.any(Date),
      evidence: expect.objectContaining({
        terminationContainment: expect.objectContaining({
          monitorQuiesced: true,
          recoveryOwnerSelection: "exact_role_capability_peer",
        }),
      }),
    });
    const recoveryWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, subordinateId))
      .then((rows) => rows.find((row) =>
        row.reason === "source_scoped_recovery_action" && row.payload?.issueId === issueId
      ));
    expect(recoveryWake).toMatchObject({
      status: "queued",
      runId: expect.any(String),
      payload: expect.objectContaining({ recoveryActionId: action.id, issueId }),
    });
    expect(driveQueuedRunsForAgent).toHaveBeenCalledTimes(1);
    expect(driveQueuedRunsForAgent).toHaveBeenCalledWith(subordinateId);
    await expect(db.select().from(agents).where(eq(agents.id, subordinateId)))
      .resolves.toEqual([expect.objectContaining({ reportsTo: managerId })]);
    const auditRows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent.termination_invariant_applied",
        details: expect.objectContaining({
          affectedOpenIssueCount: 2,
          recoveryActionCount: 2,
          quiescedIssueMonitorCount: 1,
          reparentedAgentCount: 1,
          reportingReplacementAgentId: managerId,
          recoveryCoordinatorAgentId: subordinateId,
        }),
      }),
      expect.objectContaining({
        action: "issue.recovery_action_opened",
        entityId: issueId,
        details: expect.objectContaining({
          recoveryActionId: action.id,
          recoveryOwnerAgentId: subordinateId,
          monitorQuiesced: true,
        }),
      }),
      expect.objectContaining({
        action: "agent.reporting_line_migrated",
        entityId: subordinateId,
        details: expect.objectContaining({ reportsTo: managerId }),
      }),
    ]));
  });

  it("prefers an invokable exact-role/capability peer for recovery coordination", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    const managerId = randomUUID();
    const exactPeerId = randomUUID();
    const wrongCapabilityPeerId = randomUUID();
    await db.update(agents).set({ capabilities: "TypeScript orchestration" }).where(eq(agents.id, agentId));
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CapabilityManager",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: exactPeerId,
        companyId,
        name: "ExactCapabilityPeer",
        role: "engineer",
        capabilities: "  typescript   ORCHESTRATION ",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: wrongCapabilityPeerId,
        companyId,
        name: "WrongCapabilityPeer",
        role: "engineer",
        capabilities: "Python data analysis",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));

    await agentService(db).terminate(agentId);

    await expect(db.select().from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: agentId, status: "todo" })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .resolves.toEqual([
        expect.objectContaining({
          ownerAgentId: exactPeerId,
          ownerType: "agent",
          evidence: expect.objectContaining({
            terminationContainment: expect.objectContaining({
              recoveryOwnerSelection: "exact_role_capability_peer",
            }),
          }),
        }),
      ]);
    const recoveryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, exactPeerId));
    expect(recoveryRuns).toEqual([
      expect.objectContaining({
        status: "queued",
        contextSnapshot: expect.objectContaining({
          issueId,
          wakeReason: "source_scoped_recovery_action",
        }),
      }),
    ]);
  });

  it("migrates source-scoped actions owned by a terminating recovery coordinator", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const sourceIssueId = randomUUID();
    const actionId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Recovery Manager",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Source owned elsewhere",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerId,
    });
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `legacy-owner:${sourceIssueId}`,
      evidence: {},
      nextAction: "Restore the execution path.",
      wakePolicy: { type: "wake_owner", ownerAgentId: agentId },
      attemptCount: 1,
      maxAttempts: null,
    });

    await agentService(db).terminate(agentId);

    await expect(db.select().from(issues).where(eq(issues.id, sourceIssueId)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: managerId, status: "todo" })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "active",
          ownerType: "agent",
          ownerAgentId: managerId,
          maxAttempts: 1,
          attemptCount: 2,
          evidence: expect.objectContaining({
            terminationContainment: expect.objectContaining({ terminatedAgentId: agentId }),
          }),
        }),
      ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, managerId)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "queued",
          contextSnapshot: expect.objectContaining({
            sourceIssueId,
            recoveryActionId: actionId,
            recoveryAttempt: 2,
            recoveryCause: "stranded_assigned_issue",
          }),
        }),
      ]));
  });

  it("reconciles legacy terminated-agent drift idempotently without duplicating recovery work", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Legacy Recovery Manager",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Legacy automation",
      status: "active",
      assigneeAgentId: agentId,
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextRunAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    await agentService(db).terminate(agentId);
    const firstRoutineIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`));
    const firstActionCount = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    const firstManagerWakeCount = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, managerId));
    expect(firstRoutineIssues).toHaveLength(1);

    const legacyKeyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: legacyKeyId,
      companyId,
      agentId,
      name: "legacy-stale-key",
      keyHash: `legacy-${legacyKeyId}`,
    });
    await db
      .update(routineTriggers)
      .set({
        enabled: true,
        nextRunAt: new Date("2026-07-12T01:00:00.000Z"),
        updatedByUserId: "legacy-board",
      })
      .where(eq(routineTriggers.id, triggerId));

    await agentService(db).terminate(agentId);

    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.id, legacyKeyId)))
      .resolves.toEqual([expect.objectContaining({ revokedAt: expect.any(Date) })]);
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, triggerId)))
      .resolves.toEqual([
        expect.objectContaining({
          enabled: false,
          nextRunAt: null,
          updatedByAgentId: null,
          updatedByUserId: null,
        }),
      ]);
    await expect(
      db.select().from(issues).where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`)),
    ).resolves.toHaveLength(1);
    await expect(
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)),
    ).resolves.toHaveLength(firstActionCount.length);
    await expect(
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, managerId)),
    ).resolves.toHaveLength(firstManagerWakeCount.length);
  });

  it("refreshes an open routine handoff when legacy drift adds routines after termination", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const firstRoutineId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Inventory Recovery Manager",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(routines).values({
      id: firstRoutineId,
      companyId,
      title: "Original routine inventory",
      status: "active",
      assigneeAgentId: agentId,
    });

    await agentService(db).terminate(agentId);
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`))
      .then((rows) => rows[0]);
    const originalAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, recoveryIssue.id))
      .then((rows) => rows[0]);
    expect(originalAction.attemptCount).toBe(1);

    const driftRoutineId = randomUUID();
    const driftTriggerId = randomUUID();
    await db.insert(routines).values({
      id: driftRoutineId,
      companyId,
      title: "Late legacy routine",
      status: "active",
      assigneeAgentId: agentId,
    });
    await db.insert(routineTriggers).values({
      id: driftTriggerId,
      companyId,
      routineId: driftRoutineId,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextRunAt: new Date("2026-07-12T02:00:00.000Z"),
    });

    await agentService(db).terminate(agentId);

    const [refreshedIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssue.id));
    expect(refreshedIssue.executionContract).toMatchObject({
      routineRecovery: expect.objectContaining({
        inventoryGeneration: 2,
        routines: expect.arrayContaining([
          expect.objectContaining({ id: firstRoutineId }),
          expect.objectContaining({ id: driftRoutineId }),
        ]),
        triggers: expect.arrayContaining([
          expect.objectContaining({ id: driftTriggerId }),
        ]),
      }),
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, originalAction.id)))
      .resolves.toEqual([
        expect.objectContaining({
          attemptCount: 2,
          ownerAgentId: managerId,
          evidence: expect.objectContaining({
            inventoryRefresh: expect.objectContaining({
              addedRoutineIds: [driftRoutineId],
              addedTriggerIds: [driftTriggerId],
              recoveryAttempt: 2,
            }),
          }),
        }),
      ]);
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, driftTriggerId)))
      .resolves.toEqual([expect.objectContaining({ enabled: false, nextRunAt: null })]);
    const refreshedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, managerId));
    expect(refreshedRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "queued",
        contextSnapshot: expect.objectContaining({
          recoveryActionId: originalAction.id,
          recoveryAttempt: 2,
          routineIds: expect.arrayContaining([firstRoutineId, driftRoutineId]),
        }),
      }),
    ]));
    await expect(
      db.select().from(issues).where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`)),
    ).resolves.toHaveLength(1);
  });

  it("repairs a generic active action on an open routine handoff before refreshing late inventory", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const executiveId = randomUUID();
    const firstRoutineId = randomUUID();
    await db.insert(agents).values([
      {
        id: executiveId,
        companyId,
        name: "Recovery Executive",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: managerId,
        companyId,
        name: "Original Routine Coordinator",
        role: "cto",
        status: "idle",
        reportsTo: executiveId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(routines).values({
      id: firstRoutineId,
      companyId,
      title: "Original typed routine",
      status: "active",
      assigneeAgentId: agentId,
    });

    await agentService(db).terminate(agentId);
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`))
      .then((rows) => rows[0]);
    const specializedAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, recoveryIssue.id))
      .then((rows) => rows[0]);
    await db
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "restored",
        resolutionNote: "Historical specialized attempt completed.",
        resolvedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, specializedAction.id));

    await agentService(db).terminate(managerId);
    const genericAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, recoveryIssue.id))
      .then((rows) => rows.find((row) => row.status === "active"));
    expect(genericAction).toMatchObject({
      cause: "terminated_owner",
      ownerAgentId: executiveId,
      attemptCount: 1,
    });
    const priorGenerationRun = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${genericAction!.id}`)
      .then((rows) => rows[0]);
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, priorGenerationRun.id));
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, priorGenerationRun.wakeupRequestId!));

    const lateRoutineId = randomUUID();
    await db.insert(routines).values({
      id: lateRoutineId,
      companyId,
      title: "Late typed routine",
      status: "active",
      assigneeAgentId: agentId,
    });
    const cancelRecoveryRun = vi.fn(async (runId: string) => {
      const finishedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt,
          errorCode: "recovery_generation_superseded",
          updatedAt: finishedAt,
        })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt, updatedAt: finishedAt })
        .where(eq(agentWakeupRequests.id, priorGenerationRun.wakeupRequestId!));
    });
    await agentService(db, { cancelRecoveryRun }).terminate(agentId);

    expect(cancelRecoveryRun).toHaveBeenCalledTimes(1);
    expect(cancelRecoveryRun).toHaveBeenCalledWith(priorGenerationRun.id);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, priorGenerationRun.id)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "recovery_generation_superseded",
        }),
      ]);

    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, genericAction!.id)))
      .resolves.toEqual([
        expect.objectContaining({
          cause: "terminated_routine_owner",
          previousOwnerAgentId: agentId,
          ownerAgentId: executiveId,
          attemptCount: 2,
          nextAction: expect.stringContaining("routine inventory"),
          evidence: expect.objectContaining({
            inventoryRefresh: expect.objectContaining({
              addedRoutineIds: [lateRoutineId],
              typedAuthorityRepaired: true,
            }),
          }),
        }),
      ]);
    const repairedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, executiveId));
    expect(repairedRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "queued",
        contextSnapshot: expect.objectContaining({
          recoveryActionId: genericAction!.id,
          recoveryAttempt: 2,
          recoveryCause: "terminated_routine_owner",
          terminatedAgentId: agentId,
          routineIds: expect.arrayContaining([firstRoutineId, lateRoutineId]),
        }),
      }),
    ]));
  });

  it("cancels every running prior recovery generation before advancing termination actions", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Multi-action Recovery Manager",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));

    const fixtures = Array.from({ length: 4 }, () => ({
      issueId: randomUUID(),
      actionId: randomUUID(),
      wakeupId: randomUUID(),
      runId: randomUUID(),
    }));
    for (const fixture of fixtures) {
      await db.insert(issues).values({
        id: fixture.issueId,
        companyId,
        title: `Concurrent recovery ${fixture.issueId}`,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      });
      await db.insert(issueRecoveryActions).values({
        id: fixture.actionId,
        companyId,
        sourceIssueId: fixture.issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: managerId,
        previousOwnerAgentId: agentId,
        cause: "terminated_owner",
        fingerprint: `multi-running:${fixture.issueId}`,
        nextAction: "Recover the current generation.",
        attemptCount: 1,
      });
      await db.insert(agentWakeupRequests).values({
        id: fixture.wakeupId,
        companyId,
        agentId: managerId,
        source: "automation",
        reason: "source_scoped_recovery_action",
        status: "claimed",
        runId: fixture.runId,
        payload: {
          issueId: fixture.issueId,
          sourceIssueId: fixture.issueId,
          recoveryActionId: fixture.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
        },
        claimedAt: new Date(),
      });
      await db.insert(heartbeatRuns).values({
        id: fixture.runId,
        companyId,
        agentId: managerId,
        invocationSource: "automation",
        status: "running",
        wakeupRequestId: fixture.wakeupId,
        contextSnapshot: {
          issueId: fixture.issueId,
          taskId: fixture.issueId,
          sourceIssueId: fixture.issueId,
          recoveryActionId: fixture.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
          source: "issue_recovery_action",
          wakeReason: "source_scoped_recovery_action",
        },
        startedAt: new Date(),
      });
    }

    const cancelRecoveryRun = vi.fn(async (runId: string) => {
      const run = await db
        .select({ wakeupRequestId: heartbeatRuns.wakeupRequestId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      const finishedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt,
          errorCode: "recovery_generation_superseded",
          updatedAt: finishedAt,
        })
        .where(eq(heartbeatRuns.id, runId));
      if (run.wakeupRequestId) {
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt, updatedAt: finishedAt })
          .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
      }
    });

    const terminated = await agentService(db, { cancelRecoveryRun }).terminate(agentId);

    expect(terminated).toMatchObject({ id: agentId, status: "terminated" });
    expect(new Set(cancelRecoveryRun.mock.calls.map(([runId]) => runId)))
      .toEqual(new Set(fixtures.map((fixture) => fixture.runId)));
    for (const fixture of fixtures) {
      await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))
        .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
      await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.actionId)))
        .resolves.toEqual([
          expect.objectContaining({
            status: "active",
            ownerAgentId: managerId,
            attemptCount: 2,
          }),
        ]);
    }
  });

  it("preserves typed routine-recovery authority when its coordinator is later terminated", async () => {
    const { agentId, companyId } = await seedFixture();
    const managerId = randomUUID();
    const executiveId = randomUUID();
    const routineId = randomUUID();
    await db.insert(agents).values([
      {
        id: executiveId,
        companyId,
        name: "Recovery Executive",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: managerId,
        companyId,
        name: "Routine Recovery Coordinator",
        role: "cto",
        status: "idle",
        reportsTo: executiveId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Coordinator migration routine",
      status: "active",
      assigneeAgentId: agentId,
    });

    await agentService(db).terminate(agentId);
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, `agent_termination_routine_handoff:${agentId}`))
      .then((rows) => rows[0]);
    const firstAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, recoveryIssue.id))
      .then((rows) => rows[0]);
    expect(recoveryIssue).toMatchObject({ assigneeAgentId: managerId, status: "todo" });
    expect(firstAction).toMatchObject({ ownerAgentId: managerId, cause: "terminated_routine_owner" });

    const exactPeerId = randomUUID();
    await db.insert(agents).values({
      id: exactPeerId,
      companyId,
      name: "Routine Capability Successor",
      role: "engineer",
      capabilities: null,
      status: "idle",
      reportsTo: managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await agentService(db).terminate(managerId);

    await expect(db.select().from(issues).where(eq(issues.id, recoveryIssue.id)))
      .resolves.toEqual([expect.objectContaining({ assigneeAgentId: exactPeerId, status: "todo" })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, firstAction.id)))
      .resolves.toEqual([
        expect.objectContaining({
          ownerAgentId: exactPeerId,
          previousOwnerAgentId: agentId,
          cause: "terminated_routine_owner",
          attemptCount: 2,
          nextAction: expect.stringContaining("typed routine inventory"),
        }),
      ]);
    await expect(db.select().from(agents).where(eq(agents.id, exactPeerId)))
      .resolves.toEqual([expect.objectContaining({ reportsTo: executiveId })]);
    const successorRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, exactPeerId));
    expect(successorRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "queued",
        contextSnapshot: expect.objectContaining({
          sourceIssueId: recoveryIssue.id,
          recoveryActionId: firstAction.id,
          recoveryAttempt: 2,
          recoveryCause: "terminated_routine_owner",
          terminatedAgentId: agentId,
          routineRecoveryIssueId: recoveryIssue.id,
          routineIds: [routineId],
        }),
      }),
    ]));
  });

  it("escalates to a board recovery queue and avoids CEO-to-CTO reporting cycles", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    const ctoId = randomUUID();
    const blockedIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const queuedWakeId = randomUUID();
    const queuedRunId = randomUUID();
    await db.update(agents).set({ role: "ceo", name: "RootCEO" }).where(eq(agents.id, agentId));
    await db.insert(agents).values({
      id: ctoId,
      companyId,
      name: "RootCTO",
      role: "cto",
      status: "idle",
      reportsTo: agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked review participant lane",
        status: "blocked",
        priority: "high",
        assigneeAgentId: ctoId,
        executionState: {
          status: "pending",
          currentParticipant: { type: "agent", agentId },
          returnAssignee: null,
        },
      },
      {
        id: reviewIssueId,
        companyId,
        title: "Review return-owner lane",
        status: "in_review",
        priority: "high",
        assigneeAgentId: ctoId,
        executionState: {
          status: "pending",
          currentParticipant: { type: "agent", agentId: ctoId },
          returnAssignee: { type: "agent", agentId },
        },
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeId,
      companyId,
      agentId,
      source: "assignment",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      wakeupRequestId: queuedWakeId,
      contextSnapshot: { issueId },
    });
    await db.update(agentWakeupRequests).set({ runId: queuedRunId }).where(eq(agentWakeupRequests.id, queuedWakeId));
    await db
      .update(issues)
      .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    await agentService(db).terminate(agentId);

    await expect(db.select().from(agents).where(eq(agents.id, ctoId)))
      .resolves.toEqual([expect.objectContaining({ reportsTo: null })]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queuedWakeId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          finishedAt: expect.any(Date),
          error: "Cancelled due to agent termination",
        }),
      ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "agent_terminated",
          finishedAt: expect.any(Date),
        }),
      ]);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [blockedIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    const [reviewIssue] = await db.select().from(issues).where(eq(issues.id, reviewIssueId));
    expect(sourceIssue).toMatchObject({
      assigneeAgentId: agentId,
      status: "todo",
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(blockedIssue).toMatchObject({
      assigneeAgentId: ctoId,
      status: "blocked",
      executionState: expect.objectContaining({ currentParticipant: null }),
    });
    expect(reviewIssue).toMatchObject({
      assigneeAgentId: ctoId,
      status: "in_review",
      executionState: expect.objectContaining({ returnAssignee: null }),
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(actions).toHaveLength(3);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: issueId, status: "escalated", ownerType: "board" }),
      expect.objectContaining({ sourceIssueId: blockedIssueId, status: "escalated", ownerType: "board" }),
      expect.objectContaining({ sourceIssueId: reviewIssueId, status: "escalated", ownerType: "board" }),
    ]));
    const boardActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.recovery_action_escalated"));
    expect(boardActivities).toHaveLength(3);
  });

  it("serializes API key creation with termination and revalidates after the agent row unlocks", async () => {
    const { agentId } = await seedFixture();
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const createKey = agentService(db).createApiKey(agentId, "racing-key");
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(createKey).rejects.toMatchObject({
      status: 409,
      message: "Cannot create keys for terminated agents",
    });
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId)))
      .resolves.toHaveLength(0);
  });

  it("applies termination containment through generic status updates without losing config revisions", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    const keyId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Generic path health check",
      status: "active",
      assigneeAgentId: agentId,
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: true,
      nextRunAt: new Date("2026-07-11T02:00:00.000Z"),
    });
    await db.insert(agentApiKeys).values({
      id: keyId,
      companyId,
      agentId,
      name: "generic-path",
      keyHash: `generic-${keyId}`,
    });

    const terminated = await agentService(db).update(
      agentId,
      { status: "terminated", title: "Retired builder" },
      {
        recordRevision: { createdByUserId: "board-user", source: "patch" },
        terminationAudit: { actorType: "user", actorId: "board-user", source: "patch" },
      },
    );

    expect(terminated).toEqual(expect.objectContaining({ status: "terminated", title: "Retired builder" }));
    await expect(db.select().from(routines).where(eq(routines.id, routineId)))
      .resolves.toEqual([expect.objectContaining({ status: "paused" })]);
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, triggerId)))
      .resolves.toEqual([expect.objectContaining({ enabled: false, nextRunAt: null })]);
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.id, keyId)))
      .resolves.toEqual([expect.objectContaining({ revokedAt: expect.any(Date) })]);

    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    expect(revisions).toEqual([
      expect.objectContaining({
        createdByUserId: "board-user",
        source: "patch",
        changedKeys: ["title"],
      }),
    ]);
    const containment = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.termination_invariant_applied"));
    expect(containment).toEqual([
      expect.objectContaining({
        actorId: "board-user",
        entityId: agentId,
        details: expect.objectContaining({ source: "patch", previousStatus: "active" }),
      }),
    ]);
  });

  it("does not let an update that read stale state overwrite a concurrent termination", async () => {
    const { agentId } = await seedFixture();
    let releaseTermination!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminationLocked!: () => void;
    const terminationLockedPromise = new Promise<void>((resolve) => {
      terminationLocked = resolve;
    });

    const concurrentTermination = db.transaction(async (tx) => {
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for("update");
      terminationLocked();
      await releaseTerminationPromise;
      await tx
        .update(agents)
        .set({ status: "terminated", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    });

    await terminationLockedPromise;
    const staleStatusUpdate = agentService(db)
      .update(agentId, { status: "idle" })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await concurrentTermination;
    }

    await expect(staleStatusUpdate).resolves.toMatchObject({ error: { status: 409 } });
    await expect(db.select().from(agents).where(eq(agents.id, agentId)))
      .resolves.toEqual([expect.objectContaining({ status: "terminated" })]);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });
});
