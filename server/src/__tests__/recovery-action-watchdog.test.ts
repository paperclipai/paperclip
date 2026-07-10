import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bounded recovery action watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedBoundedAction(input: {
    timeoutAt: Date | null;
    runStatus?: "queued" | "running" | "succeeded";
    recoveryAttempt?: number;
    legacyDelivery?: boolean;
    legacyWakeReason?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const actionId = randomUUID();
    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recovery Coordinator",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Source work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const recoveryAttempt = input.recoveryAttempt ?? 1;
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      cause: "terminated_owner",
      fingerprint: `terminated_owner:${issueId}`,
      evidence: {},
      nextAction: "Accept or reassign the handoff.",
      wakePolicy: { type: "wake_owner", maxAttempts: 1 },
      attemptCount: recoveryAttempt,
      maxAttempts: 1,
      timeoutAt: input.timeoutAt,
      lastAttemptAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "automation",
      reason: input.legacyWakeReason ?? "source_scoped_recovery_action",
      status: input.runStatus === "queued" || input.runStatus === "running" ? "queued" : "completed",
      runId,
      payload: {
        issueId,
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        recoveryCause: "terminated_owner",
        ...(!input.legacyDelivery ? { recoveryAttempt } : {}),
      },
      ...(input.runStatus === "succeeded" ? { finishedAt: new Date() } : {}),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: input.runStatus ?? "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        sourceIssueId: issueId,
        recoveryActionId: actionId,
        ...(!input.legacyDelivery ? { recoveryAttempt } : {}),
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: input.legacyWakeReason ?? "source_scoped_recovery_action",
      },
      ...(input.runStatus === "succeeded"
        ? { startedAt: new Date(), finishedAt: new Date() }
        : {}),
    });
    return { companyId, agentId, issueId, actionId, wakeupId, runId };
  }

  it("replaces a queued legacy delivery with the action's explicit recovery generation", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() + 60 * 60 * 1000),
      runStatus: "queued",
      recoveryAttempt: 1,
      legacyDelivery: true,
      legacyWakeReason: "bounded_transient_retry",
    });
    const cancelRun = vi.fn();
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      cancelledLegacyRunIds: [seeded.runId],
      failed: 0,
    });
    expect(result.replacementRunIds).toHaveLength(1);
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
      failed: 0,
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "active",
          attemptCount: 1,
          evidence: expect.objectContaining({
            legacyRecoveryGenerationMigration: expect.objectContaining({
              recoveryAttempt: 1,
              legacyRunIds: [seeded.runId],
              replacementRunId: result.replacementRunIds[0],
            }),
          }),
        }),
      ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "legacy_recovery_generation_migrated",
        }),
      ]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);

    const replacementRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, result.replacementRunIds[0]!))
      .then((rows) => rows[0]);
    expect(replacementRun).toMatchObject({
      status: "queued",
      agentId: seeded.agentId,
      contextSnapshot: expect.objectContaining({
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        sourceIssueId: seeded.issueId,
        recoveryActionId: seeded.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        wakeReason: "source_scoped_recovery_action",
        source: "issue_recovery_action",
      }),
    });
    await expect(
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, replacementRun!.wakeupRequestId!)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "queued",
        runId: replacementRun!.id,
        payload: expect.objectContaining({
          issueId: seeded.issueId,
          sourceIssueId: seeded.issueId,
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
        }),
      }),
    ]);
  });

  it("replaces a terminal delivery that predates explicit attempts even when timeout is unbounded", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 1,
      legacyDelivery: true,
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun: vi.fn(),
    });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      cancelledLegacyRunIds: [],
      failed: 0,
    });
    expect(result.replacementRunIds).toHaveLength(1);
    const [replacement] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, result.replacementRunIds[0]!));
    expect(replacement).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        recoveryActionId: seeded.actionId,
        recoveryAttempt: 1,
      }),
    });
    const [actionAfterMigration] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seeded.actionId));
    expect(actionAfterMigration).toMatchObject({
      status: "active",
      timeoutAt: null,
      evidence: expect.objectContaining({
        legacyRecoveryGenerationMigration: expect.objectContaining({
          recoveryAttempt: 1,
          consumedTerminalRunIds: [seeded.runId],
          replacementRunId: replacement!.id,
        }),
      }),
    });

    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
      failed: 0,
    });
    const [actionAfterRepeat] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seeded.actionId));
    expect(actionAfterRepeat!.updatedAt.getTime()).toBe(actionAfterMigration!.updatedAt.getTime());
    expect(actionAfterRepeat!.evidence).toEqual(actionAfterMigration!.evidence);
  });

  it("replaces a terminal stale attempt with the current explicit attempt when timeout is unbounded", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 2,
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          sourceIssueId: seeded.issueId,
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
          source: "issue_recovery_action",
          wakeReason: "source_scoped_recovery_action",
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          sourceIssueId: seeded.issueId,
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeupId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      cancelledLegacyRunIds: [],
      failed: 0,
    });
    expect(result.replacementRunIds).toHaveLength(1);
    await expect(
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result.replacementRunIds[0]!)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "queued",
        contextSnapshot: expect.objectContaining({
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 2,
        }),
      }),
    ]);
    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      replacementRunIds: [],
    });
  });

  it("escalates an unbounded terminal legacy delivery when its owner is not invokable", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 1,
      legacyDelivery: true,
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.agentId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      replacementRunIds: [],
      failed: 0,
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "escalated",
          ownerType: "board",
          ownerAgentId: null,
          timeoutAt: null,
          evidence: expect.objectContaining({
            boundedRecoveryEscalation: expect.objectContaining({
              reason: "recovery_owner_not_invokable",
              terminalRunId: seeded.runId,
            }),
            legacyRecoveryGenerationMigration: expect.objectContaining({
              disposition: "escalated_owner_unavailable",
              consumedTerminalRunIds: [seeded.runId],
            }),
          }),
        }),
      ]);
    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
    });
  });

  it("resolves a terminal legacy delivery when its source issue is already done", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 1,
      legacyDelivery: true,
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      replacementRunIds: [],
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "resolved",
          outcome: "restored",
          timeoutAt: null,
          evidence: expect.objectContaining({
            legacyRecoveryGenerationMigration: expect.objectContaining({
              disposition: "source_resolved",
              consumedTerminalRunIds: [seeded.runId],
            }),
          }),
        }),
      ]);
  });

  it("reconciles terminal-source actions without delivery evidence and stays repeat-safe", async () => {
    const doneStranded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const cancelledStranded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const doneMissingDisposition = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const seeded = [doneStranded, cancelledStranded, doneMissingDisposition];
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, seeded.map((entry) => entry.runId)));
    await db.delete(agentWakeupRequests).where(
      inArray(agentWakeupRequests.id, seeded.map((entry) => entry.wakeupId)),
    );
    await db.update(issues).set({ status: "done" }).where(
      inArray(issues.id, [doneStranded.issueId, doneMissingDisposition.issueId]),
    );
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, cancelledStranded.issueId));
    await db
      .update(issueRecoveryActions)
      .set({
        status: "escalated",
        ownerType: "board",
        ownerAgentId: null,
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, cancelledStranded.actionId));
    await db
      .update(issueRecoveryActions)
      .set({
        kind: "missing_disposition",
        cause: "successful_run_missing_state",
        fingerprint: `successful_run_missing_state:${doneMissingDisposition.issueId}`,
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, doneMissingDisposition.actionId));
    await db.update(agents).set({ status: "terminated" }).where(
      inArray(agents.id, [doneStranded.agentId, doneMissingDisposition.agentId]),
    );
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result).toMatchObject({
      terminalSourceRecoveryActionsReconciled: 3,
      terminalSourceRecoveryActionsResolved: 2,
      terminalSourceRecoveryActionsCancelled: 1,
      terminalSourceRecoveryActionReconciliationFailed: 0,
      legacyRecoveryDeliveriesMigrated: 0,
    });
    expect(result.terminalSourceRecoveryActionIds).toEqual(expect.arrayContaining([
      doneStranded.actionId,
      cancelledStranded.actionId,
      doneMissingDisposition.actionId,
    ]));
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, doneStranded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "resolved",
          outcome: "restored",
          evidence: expect.objectContaining({
            terminalSourceReconciliation: expect.objectContaining({
              sourceIssueStatus: "done",
              cancelledRunIds: [],
              cancelledWakeupIds: [],
            }),
          }),
        }),
      ]);
    await expect(
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, cancelledStranded.actionId)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "cancelled",
        outcome: "cancelled",
        evidence: expect.objectContaining({
          terminalSourceReconciliation: expect.objectContaining({
            sourceIssueStatus: "cancelled",
            previousActionStatus: "escalated",
          }),
        }),
      }),
    ]);
    await expect(
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, doneMissingDisposition.actionId)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "resolved",
        cause: "successful_run_missing_state",
      }),
    ]);
    const afterFirstPass = await db
      .select({ id: issueRecoveryActions.id, updatedAt: issueRecoveryActions.updatedAt })
      .from(issueRecoveryActions)
      .where(inArray(issueRecoveryActions.id, seeded.map((entry) => entry.actionId)));

    await expect(recovery.reconcileTerminalSourceRecoveryActions()).resolves.toMatchObject({
      reconciled: 0,
      actionIds: [],
      failed: 0,
    });
    const afterRepeat = await db
      .select({ id: issueRecoveryActions.id, updatedAt: issueRecoveryActions.updatedAt })
      .from(issueRecoveryActions)
      .where(inArray(issueRecoveryActions.id, seeded.map((entry) => entry.actionId)));
    expect(afterRepeat).toEqual(afterFirstPass);
  });

  it("closes a terminal source before legacy migration and preserves terminal delivery history", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const historicalWakeupId = randomUUID();
    const historicalRunId = randomUUID();
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: historicalWakeupId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      reason: "source_scoped_recovery_action",
      status: "completed",
      runId: historicalRunId,
      payload: {
        issueId: seeded.issueId,
        sourceIssueId: seeded.issueId,
        recoveryActionId: seeded.actionId,
        recoveryCause: "terminated_owner",
      },
      finishedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: historicalRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "succeeded",
      wakeupRequestId: historicalWakeupId,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        sourceIssueId: seeded.issueId,
        recoveryActionId: seeded.actionId,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
      },
      startedAt: finishedAt,
      finishedAt,
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result).toMatchObject({
      terminalSourceRecoveryActionsReconciled: 1,
      terminalSourceRecoveryActionsResolved: 1,
      legacyRecoveryDeliveriesMigrated: 0,
      legacyRecoveryReplacementRunIds: [],
    });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "recovery_source_issue_terminal",
        }),
      ]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, historicalRunId)))
      .resolves.toEqual([expect.objectContaining({ status: "succeeded", finishedAt })]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, historicalWakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "completed", finishedAt })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "resolved",
          evidence: expect.objectContaining({
            terminalSourceReconciliation: expect.objectContaining({
              cancelledRunIds: [seeded.runId],
              cancelledWakeupIds: [seeded.wakeupId],
            }),
          }),
        }),
    ]);
  });

  it("cancels a malformed legacy run through its authoritative linked recovery wake before closing the action", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileTerminalSourceRecoveryActions();

    expect(result).toMatchObject({
      reconciled: 1,
      resolved: 1,
      cancelledRunIds: [seeded.runId],
      cancelledWakeupIds: [seeded.wakeupId],
      failed: 0,
    });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([expect.objectContaining({
        status: "cancelled",
        errorCode: "recovery_source_issue_terminal",
      })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "resolved", outcome: "restored" })]);
  });

  it("stops a running delivery before cancelling recovery for a cancelled source", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "running",
    });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, seeded.issueId));
    const cancelRun = vi.fn(async (runId: string) => {
      await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
        .resolves.toEqual([expect.objectContaining({ status: "active" })]);
      const finishedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt,
          errorCode: "recovery_source_issue_terminal",
          updatedAt: finishedAt,
        })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt, updatedAt: finishedAt })
        .where(eq(agentWakeupRequests.id, seeded.wakeupId));
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileTerminalSourceRecoveryActions();

    expect(cancelRun).toHaveBeenCalledWith(seeded.runId, expect.objectContaining({
      reason: "Cancelled because the recovery source issue is terminal",
      suppressImmediateRecovery: true,
      force: true,
      errorCode: "recovery_source_issue_terminal",
    }));
    expect(result).toMatchObject({
      reconciled: 1,
      resolved: 0,
      cancelled: 1,
      actionIds: [seeded.actionId],
      cancelledRunIds: [seeded.runId],
      cancelledWakeupIds: [seeded.wakeupId],
      failed: 0,
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          outcome: "cancelled",
          evidence: expect.objectContaining({
            terminalSourceReconciliation: expect.objectContaining({
              sourceIssueStatus: "cancelled",
              cancelledRunIds: [seeded.runId],
            }),
          }),
        }),
    ]);
  });

  it("does not report a naturally completed run as cancelled when completion wins the control race", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "running",
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    const cancelRun = vi.fn(async (runId: string) => {
      const finishedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt, error: null, errorCode: null, updatedAt: finishedAt })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(agentWakeupRequests)
        .set({ status: "completed", finishedAt, error: null, updatedAt: finishedAt })
        .where(eq(agentWakeupRequests.id, seeded.wakeupId));
      return { status: "succeeded" };
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileTerminalSourceRecoveryActions();

    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      reconciled: 1,
      resolved: 1,
      cancelledRunIds: [],
      cancelledWakeupIds: [],
      failed: 0,
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([expect.objectContaining({
        status: "resolved",
        evidence: expect.objectContaining({
          terminalSourceReconciliation: expect.objectContaining({
            cancelledRunIds: [],
            cancelledWakeupIds: [],
          }),
        }),
      })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "succeeded" })]);
  });

  it("preserves ordinary carrier runs when recovery or manager wakes were only coalesced into them", async () => {
    const recoveryCarrier = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const managerCarrier = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    const seeded = [recoveryCarrier, managerCarrier];
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, seeded.map((entry) => entry.runId)));
    await db.delete(agentWakeupRequests).where(
      inArray(agentWakeupRequests.id, seeded.map((entry) => entry.wakeupId)),
    );

    const ordinaryWakeupIds = [randomUUID(), randomUUID()];
    const carrierRunIds = [randomUUID(), randomUUID()];
    const coalescedWakeupIds = [randomUUID(), randomUUID()];
    for (const [index, entry] of seeded.entries()) {
      await db.insert(agentWakeupRequests).values({
        id: ordinaryWakeupIds[index]!,
        companyId: entry.companyId,
        agentId: entry.agentId,
        source: "assignment",
        reason: "issue_assigned",
        status: "claimed",
        runId: carrierRunIds[index]!,
        payload: { issueId: entry.issueId },
      });
      await db.insert(heartbeatRuns).values({
        id: carrierRunIds[index]!,
        companyId: entry.companyId,
        agentId: entry.agentId,
        invocationSource: "assignment",
        status: "running",
        wakeupRequestId: ordinaryWakeupIds[index]!,
        contextSnapshot: index === 0
          ? {
              issueId: entry.issueId,
              taskId: entry.issueId,
              sourceIssueId: entry.issueId,
              recoveryActionId: entry.actionId,
              recoveryAttempt: 1,
              source: "issue_recovery_action",
              wakeReason: "source_scoped_recovery_action",
            }
          : {
              issueId: entry.issueId,
              taskId: entry.issueId,
              sourceIssueId: entry.issueId,
              recoveryActionId: entry.actionId,
              source: "issue.comment",
              wakeReason: "issue_commented",
            },
        startedAt: new Date(),
      });
      await db.insert(agentWakeupRequests).values({
        id: coalescedWakeupIds[index]!,
        companyId: entry.companyId,
        agentId: entry.agentId,
        source: "automation",
        reason: index === 0 ? "source_scoped_recovery_action" : "issue_execution_same_name",
        status: "coalesced",
        runId: carrierRunIds[index]!,
        payload: {
          issueId: entry.issueId,
          sourceIssueId: entry.issueId,
          recoveryActionId: entry.actionId,
          ...(index === 1 ? { managerEscalation: true } : {}),
        },
        finishedAt: new Date(),
      });
    }
    await db.update(issues).set({ status: "done" }).where(
      inArray(issues.id, seeded.map((entry) => entry.issueId)),
    );
    const cancelRun = vi.fn();
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileTerminalSourceRecoveryActions();

    expect(result).toMatchObject({
      reconciled: 2,
      resolved: 2,
      cancelled: 0,
      cancelledRunIds: [],
      cancelledWakeupIds: [],
      failed: 0,
    });
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, carrierRunIds)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: carrierRunIds[0], status: "running" }),
        expect.objectContaining({ id: carrierRunIds[1], status: "running" }),
      ]));
    await expect(db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, ordinaryWakeupIds)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ordinaryWakeupIds[0], status: "claimed" }),
        expect.objectContaining({ id: ordinaryWakeupIds[1], status: "claimed" }),
      ]));
    await expect(db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, coalescedWakeupIds)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: coalescedWakeupIds[0], status: "coalesced" }),
        expect.objectContaining({ id: coalescedWakeupIds[1], status: "coalesced" }),
    ]));
  });

  it("preserves an unlinked carrier whose mutable context looks recovery-scoped", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
    });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupId));
    const carrierRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: carrierRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "assignment",
      status: "running",
      wakeupRequestId: null,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        sourceIssueId: seeded.issueId,
        recoveryActionId: seeded.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
      },
      startedAt: new Date(),
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    const cancelRun = vi.fn();
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    await expect(recovery.reconcileTerminalSourceRecoveryActions()).resolves.toMatchObject({
      reconciled: 1,
      resolved: 1,
      cancelledRunIds: [],
      cancelledWakeupIds: [],
    });
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, carrierRunId)))
      .resolves.toEqual([expect.objectContaining({ status: "running", wakeupRequestId: null })]);
  });

  it("escalates a timed-out action without cancelling an ordinary coalesced carrier", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() - 60_000),
      runStatus: "running",
    });
    await db
      .update(agentWakeupRequests)
      .set({
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId: seeded.issueId },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeupId));
    const coalescedWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: coalescedWakeupId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      reason: "source_scoped_recovery_action",
      status: "coalesced",
      runId: seeded.runId,
      payload: {
        issueId: seeded.issueId,
        sourceIssueId: seeded.issueId,
        recoveryActionId: seeded.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
      finishedAt: new Date(),
    });
    const cancelRun = vi.fn();
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result.exhaustedRecoveryActionsEscalated).toBe(1);
    expect(result.exhaustedRecoveryActionIds).toContain(seeded.actionId);
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "running" })]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "queued", reason: "issue_assigned" })]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, coalescedWakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "coalesced" })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "escalated", ownerType: "board" })]);
  });

  it("keeps a valid terminal predecessor as history when an exact live current delivery exists", async () => {
    const current = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "queued",
      recoveryAttempt: 2,
    });
    const predecessorWakeupId = randomUUID();
    const predecessorRunId = randomUUID();
    const predecessorFinishedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: predecessorWakeupId,
      companyId: current.companyId,
      agentId: current.agentId,
      source: "automation",
      reason: "source_scoped_recovery_action",
      status: "completed",
      runId: predecessorRunId,
      payload: {
        issueId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
      finishedAt: predecessorFinishedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId: current.companyId,
      agentId: current.agentId,
      invocationSource: "automation",
      status: "succeeded",
      wakeupRequestId: predecessorWakeupId,
      contextSnapshot: {
        issueId: current.issueId,
        taskId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
      },
      startedAt: predecessorFinishedAt,
      finishedAt: predecessorFinishedAt,
    });
    const [actionBefore] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, current.actionId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
    });
    const [actionAfter] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, current.actionId));
    expect(actionAfter!.updatedAt.getTime()).toBe(actionBefore!.updatedAt.getTime());
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, predecessorRunId)))
      .resolves.toEqual([expect.objectContaining({ status: "succeeded" })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("contains a malformed live delivery without dispositioning an action that still has exact live authority", async () => {
    const current = await seedBoundedAction({
      timeoutAt: new Date(Date.now() - 60_000),
      runStatus: "queued",
      recoveryAttempt: 2,
    });
    const legacyWakeupId = randomUUID();
    const legacyRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: legacyWakeupId,
      companyId: current.companyId,
      agentId: current.agentId,
      source: "automation",
      reason: "bounded_transient_retry",
      status: "queued",
      runId: legacyRunId,
      payload: {
        issueId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryCause: "terminated_owner",
      },
    });
    await db.insert(heartbeatRuns).values({
      id: legacyRunId,
      companyId: current.companyId,
      agentId: current.agentId,
      invocationSource: "automation",
      status: "queued",
      wakeupRequestId: legacyWakeupId,
      contextSnapshot: {
        issueId: current.issueId,
        taskId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "bounded_transient_retry",
      },
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, current.agentId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [current.actionId],
      replacementRunIds: [],
      cancelledLegacyRunIds: [legacyRunId],
    });
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, current.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "active",
          ownerType: "agent",
          ownerAgentId: current.agentId,
          evidence: expect.objectContaining({
            legacyRecoveryGenerationMigration: expect.objectContaining({
              disposition: "current_delivery_preserved",
              cancelledQueuedRunIds: [legacyRunId],
            }),
          }),
        }),
      ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "queued", errorCode: null })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, legacyRunId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          errorCode: "legacy_recovery_generation_migrated",
        }),
      ]);
  });

  it("leaves an exact-current terminal delivery for bounded watchdog escalation", async () => {
    const current = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 2,
    });
    const predecessorWakeupId = randomUUID();
    const predecessorRunId = randomUUID();
    const predecessorFinishedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: predecessorWakeupId,
      companyId: current.companyId,
      agentId: current.agentId,
      source: "automation",
      reason: "source_scoped_recovery_action",
      status: "completed",
      runId: predecessorRunId,
      payload: {
        issueId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
      },
      finishedAt: predecessorFinishedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId: current.companyId,
      agentId: current.agentId,
      invocationSource: "automation",
      status: "succeeded",
      wakeupRequestId: predecessorWakeupId,
      contextSnapshot: {
        issueId: current.issueId,
        taskId: current.issueId,
        sourceIssueId: current.issueId,
        recoveryActionId: current.actionId,
        recoveryAttempt: 1,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
      },
      startedAt: predecessorFinishedAt,
      finishedAt: predecessorFinishedAt,
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
    });
    const watchdogResult = await recovery.reconcileIssueGraphLiveness({ force: true });
    expect(watchdogResult.exhaustedRecoveryActionIds).toContain(current.actionId);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, current.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "escalated",
          ownerType: "board",
          evidence: expect.objectContaining({
            boundedRecoveryEscalation: expect.objectContaining({
              reason: "terminal_run_without_disposition",
              terminalRunId: current.runId,
            }),
          }),
        }),
      ]);
  });

  it("stops a running explicit stale generation through heartbeat control before replacing it", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() + 60 * 60 * 1000),
      runStatus: "running",
      recoveryAttempt: 2,
      legacyDelivery: false,
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          sourceIssueId: seeded.issueId,
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
          source: "issue_recovery_action",
          wakeReason: "source_scoped_recovery_action",
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db
      .update(agentWakeupRequests)
      .set({
        payload: {
          issueId: seeded.issueId,
          sourceIssueId: seeded.issueId,
          recoveryActionId: seeded.actionId,
          recoveryAttempt: 1,
          recoveryCause: "terminated_owner",
        },
      })
      .where(eq(agentWakeupRequests.id, seeded.wakeupId));
    const cancelRun = vi.fn(async (runId: string) => {
      await expect(db.select({ attemptCount: issueRecoveryActions.attemptCount })
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, seeded.actionId)))
        .resolves.toEqual([{ attemptCount: 2 }]);
      const finishedAt = new Date();
      await db.update(heartbeatRuns).set({
        status: "cancelled",
        finishedAt,
        errorCode: "legacy_recovery_generation_migrated",
        updatedAt: finishedAt,
      }).where(eq(heartbeatRuns.id, runId));
      await db.update(agentWakeupRequests).set({
        status: "cancelled",
        finishedAt,
        updatedAt: finishedAt,
      }).where(eq(agentWakeupRequests.id, seeded.wakeupId));
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileLegacySourceScopedRecoveryDeliveries();

    expect(cancelRun).toHaveBeenCalledWith(seeded.runId, expect.objectContaining({
      suppressImmediateRecovery: true,
      force: true,
      errorCode: "legacy_recovery_generation_migrated",
    }));
    expect(result).toMatchObject({
      migrated: 1,
      actionIds: [seeded.actionId],
      cancelledLegacyRunIds: [seeded.runId],
      failed: 0,
    });
    expect(result.replacementRunIds).toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result.replacementRunIds[0]!)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "queued",
          contextSnapshot: expect.objectContaining({ recoveryAttempt: 2 }),
        }),
      ]);
  });

  it("escalates an expired action to the board and cancels its durable queued delivery", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() - 60_000),
      runStatus: "queued",
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result.exhaustedRecoveryActionsEscalated).toBe(1);
    expect(result.exhaustedRecoveryActionIds).toEqual([seeded.actionId]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "escalated",
          ownerType: "board",
          ownerAgentId: null,
          evidence: expect.objectContaining({
            boundedRecoveryEscalation: expect.objectContaining({ reason: "timeout" }),
          }),
        }),
      ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled", errorCode: "recovery_action_escalated" })]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    await expect(issueService(db).list(seeded.companyId, { awaitingDecisionForUserId: "board-user" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: seeded.issueId }),
      ]));
  });

  it("escalates a terminal no-op recovery run after restart but preserves a live bounded action", async () => {
    const terminal = await seedBoundedAction({
      timeoutAt: new Date(Date.now() + 60 * 60 * 1000),
      runStatus: "succeeded",
    });
    const live = await seedBoundedAction({
      timeoutAt: new Date(Date.now() + 60 * 60 * 1000),
      runStatus: "queued",
    });
    const firstRecoveryInstance = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const terminalResult = await firstRecoveryInstance.reconcileIssueGraphLiveness({ force: true });
    expect(terminalResult.exhaustedRecoveryActionIds).toContain(terminal.actionId);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, terminal.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "escalated",
          ownerType: "board",
          evidence: expect.objectContaining({
            boundedRecoveryEscalation: expect.objectContaining({
              reason: "terminal_run_without_disposition",
              terminalRunId: terminal.runId,
              terminalRunStatus: "succeeded",
            }),
          }),
        }),
      ]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, live.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "active", ownerType: "agent" })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, live.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("escalates a legacy exact-current terminal action that predates bounded metadata", async () => {
    const legacy = await seedBoundedAction({
      timeoutAt: null,
      runStatus: "succeeded",
      recoveryAttempt: 1,
    });
    await db
      .update(issueRecoveryActions)
      .set({
        maxAttempts: null,
        timeoutAt: null,
        wakePolicy: { type: "wake_owner", reason: "source_scoped_recovery_action" },
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, legacy.actionId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await expect(recovery.reconcileLegacySourceScopedRecoveryDeliveries()).resolves.toMatchObject({
      migrated: 0,
      actionIds: [],
      replacementRunIds: [],
    });
    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(result.exhaustedRecoveryActionIds).toContain(legacy.actionId);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, legacy.actionId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: "escalated",
          ownerType: "board",
          ownerAgentId: null,
          maxAttempts: null,
          timeoutAt: null,
          evidence: expect.objectContaining({
            boundedRecoveryEscalation: expect.objectContaining({
              reason: "terminal_run_without_disposition",
              terminalRunId: legacy.runId,
              terminalRunStatus: "succeeded",
            }),
          }),
        }),
      ]);
  });

  it("ignores terminal evidence from an older attempt while the current generation is live", async () => {
    const previous = await seedBoundedAction({
      timeoutAt: new Date(Date.now() + 60 * 60 * 1000),
      runStatus: "succeeded",
      recoveryAttempt: 1,
    });
    const currentWakeupId = randomUUID();
    const currentRunId = randomUUID();
    await db
      .update(issueRecoveryActions)
      .set({ attemptCount: 2, lastAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(issueRecoveryActions.id, previous.actionId));
    await db.insert(agentWakeupRequests).values({
      id: currentWakeupId,
      companyId: previous.companyId,
      agentId: previous.agentId,
      source: "automation",
      reason: "source_scoped_recovery_action",
      status: "queued",
      runId: currentRunId,
      payload: {
        issueId: previous.issueId,
        sourceIssueId: previous.issueId,
        recoveryActionId: previous.actionId,
        recoveryAttempt: 2,
        recoveryCause: "terminated_owner",
      },
    });
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId: previous.companyId,
      agentId: previous.agentId,
      invocationSource: "automation",
      status: "queued",
      wakeupRequestId: currentWakeupId,
      contextSnapshot: {
        issueId: previous.issueId,
        taskId: previous.issueId,
        sourceIssueId: previous.issueId,
        recoveryActionId: previous.actionId,
        recoveryAttempt: 2,
        recoveryCause: "terminated_owner",
        source: "issue_recovery_action",
        wakeReason: "source_scoped_recovery_action",
      },
    });

    const result = await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) })
      .reconcileIssueGraphLiveness({ force: true });

    expect(result.exhaustedRecoveryActionIds).not.toContain(previous.actionId);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, previous.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "active", attemptCount: 2 })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, currentRunId)))
      .resolves.toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("stops a timed-out running recovery through the heartbeat cancellation dependency before escalation", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() - 60_000),
      runStatus: "running",
    });
    const cancelRun = vi.fn(async (runId: string) => {
      const finishedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt,
          errorCode: "recovery_action_escalated",
          updatedAt: finishedAt,
        })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt, updatedAt: finishedAt })
        .where(eq(agentWakeupRequests.id, seeded.wakeupId));
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
      cancelRun,
    });

    const result = await recovery.reconcileIssueGraphLiveness({ force: true });

    expect(cancelRun).toHaveBeenCalledWith(seeded.runId, expect.objectContaining({
      suppressImmediateRecovery: true,
      force: true,
    }));
    expect(result.exhaustedRecoveryActionIds).toContain(seeded.actionId);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "escalated", ownerType: "board" })]);
  });

  it("serializes watchdog expiry with recovery-owner termination without deadlocking", async () => {
    const seeded = await seedBoundedAction({
      timeoutAt: new Date(Date.now() - 60_000),
      runStatus: "queued",
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const concurrentWork = Promise.all([
      recovery.reconcileIssueGraphLiveness({ force: true }),
      agentService(db).terminate(seeded.agentId),
    ]);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await expect(Promise.race([
        concurrentWork,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("concurrent recovery operations deadlocked")),
            5_000,
          );
        }),
      ])).resolves.toBeTruthy();
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    await expect(db.select().from(agents).where(eq(agents.id, seeded.agentId)))
      .resolves.toEqual([expect.objectContaining({ status: "terminated" })]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.actionId)))
      .resolves.toEqual([expect.objectContaining({ status: "escalated", ownerType: "board" })]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))
      .resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});
