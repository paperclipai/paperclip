import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
