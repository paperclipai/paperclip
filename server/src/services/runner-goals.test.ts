import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runnerGoalActionRequestSchema,
  runnerGoalRevisionSchema,
} from "@paperclipai/shared";
import {
  agentSessionGoalActions,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  applyRunnerGoalPrpEvent,
  isRunnerGoalActionCompleted,
  blockRunnerGoalRecovery,
  failRunnerGoalAction,
  RunnerGoalConflictError,
  runnerGoalService,
} from "./runner-goals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("runner goal service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runner-goals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentSessionGoalActions);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Goal Test Company",
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Goal Agent",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `G-${Math.floor(Math.random() * 1_000_000)}`,
      title: "Pursue a durable goal",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  it.each(["codex_local", "claude_local"])("does not convert %s into another execution path for goals", async (adapterType) => {
    const binding = await seed();
    await db.update(agents).set({ adapterType, adapterConfig: { engine: "acp", mode: "persistent" } });
    const enqueueOfflineControl = vi.fn(async () => {});
    const service = runnerGoalService(db, { enqueueOfflineControl });
    const projection = await service.projection(binding.companyId, binding.issueId);
    expect(projection?.capability).toMatchObject({
      availability: "unsupported",
      reasonCode: "direct_adapter_goal_controller_unavailable",
      actions: [],
    });
    await expect(service.act(binding.companyId, binding.issueId, {
      requestId: randomUUID(), agentId: binding.agentId, expectedRevision: 0,
      action: "create", objective: "Never start an ordinary prompt",
    })).rejects.toThrow();
    expect(enqueueOfflineControl).not.toHaveBeenCalled();
    expect(await db.select().from(agentSessionGoalActions)).toHaveLength(0);
  });

  it("revisions failed goal starts and ignores repeated failure delivery", async () => {
    const binding = await seed();
    const service = runnerGoalService(db, {
      dispatchLiveControl: () => ({ runId: "run-live", completion: Promise.resolve() }),
      queueLiveCommand: () => null,
    });
    const requestId = randomUUID();
    const accepted = await service.act(binding.companyId, binding.issueId, {
      requestId,
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "Observe a failed start",
    });
    const failed = await failRunnerGoalAction(db, {
      ...binding, adapterType: "paperclip_runner",
    }, requestId, "provider_start_failed");
    expect(failed?.pendingAction).toBeNull();
    expect(failed?.revision).not.toBe(accepted.projection.revision);
    expect(failed?.revision).toMatch(/^r:[0-9a-f-]{36}$/i);
    expect(await failRunnerGoalAction(db, {
      ...binding, adapterType: "paperclip_runner",
    }, requestId, "duplicate_failure")).toBeNull();
    expect((await service.projection(binding.companyId, binding.issueId))?.revision).toBe(failed?.revision);
  });

  it("activates an opaque revision from the legacy integer maximum and replays the accepted result", async () => {
    const binding = await seed();
    await db.insert(agentTaskSessions).values({
      ...binding,
      adapterType: "paperclip_runner",
      taskKey: binding.issueId,
      goalRevision: 2_147_483_647,
    });
    const service = runnerGoalService(db, {
      dispatchLiveControl: () => ({ runId: "run-live", completion: Promise.resolve() }),
      queueLiveCommand: () => null,
    });
    expect((await service.projection(binding.companyId, binding.issueId))?.revision).toBe(2_147_483_647);
    const request = {
      requestId: randomUUID(), agentId: binding.agentId, expectedRevision: 2_147_483_647,
      action: "create" as const, objective: "Activate the opaque revision",
    };
    const accepted = await service.act(binding.companyId, binding.issueId, request);
    expect(accepted.projection.revision).toMatch(/^r:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const [sessionAfterFirstMutation] = await db.select().from(agentTaskSessions);
    expect(sessionAfterFirstMutation).toMatchObject({ goalRevision: 2_147_483_647, goalRevisionToken: accepted.projection.revision });

    await expect(service.act(binding.companyId, binding.issueId, {
      ...request, requestId: randomUUID(), action: "pause", objective: undefined,
    })).rejects.toMatchObject({ code: "stale_revision" });
    const replay = await service.act(binding.companyId, binding.issueId, request);
    expect(replay.projection).toEqual(accepted.projection);
    expect(replay.status).toBe("pending");
    const [sessionAfterReplay] = await db.select().from(agentTaskSessions);
    expect(sessionAfterReplay?.goalRevisionToken).toBe(accepted.projection.revision);
  });

  it("accepts only safe legacy numbers or exact opaque UUIDv4 revisions", () => {
    expect(runnerGoalRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(runnerGoalRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(runnerGoalRevisionSchema.safeParse("r:123e4567-e89b-42d3-a456-426614174000").success).toBe(true);
    expect(runnerGoalRevisionSchema.safeParse("r:123e4567-e89b-12d3-a456-426614174000").success).toBe(false);
    expect(runnerGoalRevisionSchema.safeParse("r:not-a-uuid").success).toBe(false);
    expect(runnerGoalActionRequestSchema.safeParse({
      requestId: "request", agentId: randomUUID(), expectedRevision: -1, action: "clear",
    }).success).toBe(false);
  });

  it("serializes concurrent compare-and-set actions against one revision", async () => {
    const binding = await seed();
    const service = runnerGoalService(db, { enqueueOfflineControl: async () => {} });
    const [first, second] = await Promise.allSettled([
      service.act(binding.companyId, binding.issueId, {
        requestId: randomUUID(), agentId: binding.agentId, expectedRevision: 0,
        action: "create", objective: "First concurrent goal",
      }),
      service.act(binding.companyId, binding.issueId, {
        requestId: randomUUID(), agentId: binding.agentId, expectedRevision: 0,
        action: "create", objective: "Second concurrent goal",
      }),
    ]);
    expect([first.status, second.status].filter((status) => status === "fulfilled")).toHaveLength(1);
    const rejected = [first, second].find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "stale_revision" } });
  });

  it("fails closed when a persisted revision token is malformed", async () => {
    const binding = await seed();
    await db.insert(agentTaskSessions).values({
      companyId: binding.companyId, agentId: binding.agentId, adapterType: "paperclip_runner",
      taskKey: binding.issueId, goalRevisionToken: "r:broken",
    });
    await expect(runnerGoalService(db).projection(binding.companyId, binding.issueId)).rejects.toThrow(/revision token is malformed/);
  });

  it("enforces revisions, correlates acknowledgements, and fences cleared goals", async () => {
    const binding = await seed();
    const service = runnerGoalService(db, {
      dispatchLiveControl: (_binding, control) => ({
        runId: "run-live",
        completion: Promise.resolve().then(() => undefined),
      }),
      queueLiveCommand: () => null,
    });
    const requestId = randomUUID();
    const accepted = await service.act(binding.companyId, binding.issueId, {
      requestId,
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "Finish the goal across turns",
      tokenBudget: 2_000,
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.projection.pendingAction).toBe("starting");
    expect(await isRunnerGoalActionCompleted(db, binding, requestId)).toBe(false);

    const repeated = await service.act(binding.companyId, binding.issueId, {
      requestId,
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "Finish the goal across turns",
      tokenBudget: 2_000,
    });
    expect(repeated.status).toBe("pending");

    await expect(service.act(binding.companyId, binding.issueId, {
      requestId,
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "Reuse the key for different work",
      tokenBudget: 2_000,
    })).rejects.toMatchObject({
      code: "idempotency_key_conflict",
      projection: { revision: accepted.projection.revision },
    });

    await expect(service.act(binding.companyId, binding.issueId, {
      requestId: randomUUID(),
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "A stale change",
    })).rejects.toBeInstanceOf(RunnerGoalConflictError);

    await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.capabilities.updated",
      sourceSeq: 1,
      payload: {
        sessionGoals: {
          availability: "available",
          actions: ["set", "pause", "resume", "clear"],
          autonomousUpdates: true,
          persistentAcrossResume: true,
          maxObjectiveChars: 4_000,
          tokenBudgetControl: true,
          usageReporting: true,
        },
      },
    });
    const updated = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.updated",
      sourceSeq: 2,
      payload: {
        requestId,
        workingNow: true,
        goal: {
          objective: "Finish the goal across turns",
          status: "active",
          tokenBudget: 2_000,
          tokensUsed: 25,
          elapsedSeconds: 3,
          iterations: 1,
          createdAt: "2026-08-28T12:00:00.000Z",
          updatedAt: "2026-08-28T12:00:03.000Z",
          completedAt: null,
        },
      },
    });
    expect(updated).toMatchObject({
      goal: { status: "active", workingNow: true },
      pendingAction: null,
    });
    expect(await isRunnerGoalActionCompleted(db, binding, requestId)).toBe(true);
    expect(await isRunnerGoalActionCompleted(db, { ...binding, issueId: randomUUID() }, requestId)).toBe(false);
    expect(await isRunnerGoalActionCompleted(db, { ...binding, agentId: randomUUID() }, requestId)).toBe(false);
    expect(await isRunnerGoalActionCompleted(db, { ...binding, companyId: randomUUID() }, requestId)).toBe(false);

    const failedClear = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.cleared",
      sourceSeq: 3,
      payload: {
        requestId: randomUUID(),
        error: "provider temporarily rejected clear",
        goal: null,
        sessionGoals: {
          availability: "available",
          actions: ["set", "pause", "resume", "clear"],
          autonomousUpdates: true,
          persistentAcrossResume: true,
          maxObjectiveChars: 4_000,
          tokenBudgetControl: true,
          usageReporting: true,
        },
      },
    });
    expect(failedClear).toBeNull();
    const afterFailedClear = await service.projection(
      binding.companyId,
      binding.issueId,
      binding.agentId,
    );
    expect(afterFailedClear).toMatchObject({
      goal: { objective: "Finish the goal across turns", status: "active" },
    });

    const clearRequestId = randomUUID();
    const clearAccepted = await service.act(binding.companyId, binding.issueId, {
      requestId: clearRequestId,
      agentId: binding.agentId,
      expectedRevision: afterFailedClear!.revision,
      action: "clear",
    });
    expect(clearAccepted.projection.pendingAction).toBe("clearing");
    const cleared = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.cleared",
      sourceSeq: 4,
      payload: { requestId: clearRequestId, goal: null, workingNow: false },
    });
    expect(cleared).toMatchObject({ goal: null, pendingAction: null });

    const stale = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.updated",
      sourceSeq: 3,
      payload: {
        goal: { objective: "Stale resurrection", status: "active" },
      },
    });
    expect(stale).toBeNull();
    await expect(service.projection(binding.companyId, binding.issueId, binding.agentId))
      .resolves.toMatchObject({ goal: null });
  });

  it("accepts a reset source sequence from a successor run of the same durable runner", async () => {
    const binding = await seed();
    const runnerId = randomUUID();
    const nativeSessionId = randomUUID();
    const priorRunId = randomUUID();
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: priorRunId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId, status: "succeeded", invocationSource: "on_demand", runnerInstanceId: runnerId, nativeSessionId },
      { id: nextRunId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId, status: "running", invocationSource: "on_demand", runnerInstanceId: runnerId, nativeSessionId },
    ]);
    const first = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.updated",
      sourceInstanceId: runnerId,
      sourceRunId: priorRunId,
      sourceSeq: 9,
      payload: {
        goal: {
          objective: "First heartbeat objective",
          status: "complete",
        },
      },
    });
    expect(first).toMatchObject({ goal: { status: "complete" } });
    await expect(applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.snapshot",
      sourceInstanceId: runnerId,
      sourceRunId: priorRunId,
      sourceSeq: 10,
      payload: { goal: null },
    })).resolves.toBeNull();
    await expect(runnerGoalService(db).projection(
      binding.companyId,
      binding.issueId,
      binding.agentId,
    )).resolves.toMatchObject({ revision: expect.stringMatching(/^r:/), goal: { status: "complete" } });

    const successorEvent = {
      eventType: "session.goal.updated",
      sourceInstanceId: runnerId,
      sourceRunId: nextRunId,
      sourceSeq: 1,
      payload: {
        goal: {
          objective: "Successor heartbeat objective",
          status: "active",
        },
      },
    };
    const eventBinding = { ...binding, adapterType: "paperclip_runner" };
    // Merely changing the source namespace is not proof of succession.
    for (const invalidOwner of [
      { nativeSessionId: randomUUID() },
      { nativeIssueId: randomUUID() },
      { runnerInstanceId: randomUUID() },
      { status: "succeeded" },
    ]) {
      await db.update(heartbeatRuns).set(invalidOwner).where(eq(heartbeatRuns.id, nextRunId));
      await expect(applyRunnerGoalPrpEvent(db, eventBinding, successorEvent)).resolves.toBeNull();
      await db.update(heartbeatRuns).set({ nativeSessionId, nativeIssueId: binding.issueId, runnerInstanceId: runnerId, status: "running" })
        .where(eq(heartbeatRuns.id, nextRunId));
    }
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, priorRunId));
    await expect(applyRunnerGoalPrpEvent(db, eventBinding, successorEvent)).resolves.toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, priorRunId));
    const successor = await applyRunnerGoalPrpEvent(db, eventBinding, successorEvent);
    expect(successor).toMatchObject({
      goal: { objective: "Successor heartbeat objective", status: "active" },
    });

    const duplicate = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.cleared",
      sourceInstanceId: runnerId,
      sourceRunId: nextRunId,
      sourceSeq: 1,
      payload: { goal: null },
    });
    expect(duplicate).toBeNull();
    const delayed = (eventType: string, sourceSeq: number) => ({
      eventType, sourceInstanceId: runnerId, sourceRunId: priorRunId, sourceSeq,
      payload: { goal: { objective: "Stale predecessor", status: "active" } },
    });
    // The predecessor cannot erase the successor's active goal.
    await expect(applyRunnerGoalPrpEvent(db, eventBinding, delayed("session.goal.cleared", 100))).resolves.toBeNull();
    await expect(runnerGoalService(db).projection(binding.companyId, binding.issueId)).resolves.toMatchObject({
      revision: expect.stringMatching(/^r:/), goal: { objective: "Successor heartbeat objective" },
    });
    await applyRunnerGoalPrpEvent(db, eventBinding, {
      eventType: "session.goal.cleared", sourceInstanceId: runnerId, sourceRunId: nextRunId, sourceSeq: 2, payload: { goal: null },
    });
    // Nor can it resurrect the cleared goal, even once the successor settles.
    await db.update(heartbeatRuns).set({ status: "succeeded" });
    await expect(applyRunnerGoalPrpEvent(db, eventBinding, delayed("session.goal.updated", 101))).resolves.toBeNull();
    await expect(applyRunnerGoalPrpEvent(db, eventBinding, {
      eventType: "session.goal.updated", sourceSeq: 102, payload: delayed("", 0).payload,
    })).resolves.toBeNull();
    await expect(runnerGoalService(db).projection(binding.companyId, binding.issueId)).resolves.toMatchObject({ revision: expect.stringMatching(/^r:/), goal: null });
    const [session] = await db.select().from(agentTaskSessions);
    expect(session).toMatchObject({ goalSourceId: `${runnerId}:${nextRunId}`, goalSourceCursor: 2 });
  });

  it("keeps a missing resumed goal blocked across restored empty snapshots", async () => {
    const binding = await seed();
    const eventBinding = { ...binding, adapterType: "paperclip_runner" };
    await applyRunnerGoalPrpEvent(db, eventBinding, {
      eventType: "session.goal.updated",
      sourceSeq: 1,
      payload: {
        goal: {
          objective: "Recover the durable provider goal",
          status: "active",
        },
      },
    });

    const blocked = await applyRunnerGoalPrpEvent(db, eventBinding, {
      eventType: "session.goal.snapshot",
      sourceSeq: 2,
      payload: { goal: null },
    });
    expect(blocked).toMatchObject({
      revision: expect.stringMatching(/^r:/),
      goal: {
        objective: "Recover the durable provider goal",
        status: "blocked",
        lastReason: "provider_session_goal_missing_after_resume",
      },
    });

    await expect(applyRunnerGoalPrpEvent(db, eventBinding, {
      eventType: "session.goal.snapshot",
      sourceSeq: 3,
      payload: { goal: null },
    })).resolves.toBeNull();
    const [session] = await db.select({
      revision: agentTaskSessions.goalRevision,
      revisionToken: agentTaskSessions.goalRevisionToken,
      sourceCursor: agentTaskSessions.goalSourceCursor,
      desiredState: agentTaskSessions.goalDesiredState,
      goal: agentTaskSessions.goalJson,
    }).from(agentTaskSessions);
    expect(session).toMatchObject({
      revision: 0,
      revisionToken: expect.stringMatching(/^r:/),
      sourceCursor: 3,
      desiredState: "paused",
      goal: {
        objective: "Recover the durable provider goal",
        status: "blocked",
        lastReason: "provider_session_goal_missing_after_resume",
      },
    });
  });

  it("projects committed capability and goal events exactly once across duplicate delivery", async () => {
    const binding = await seed();
    const eventBinding = {
      ...binding,
      adapterType: "paperclip_runner",
    };
    const source = {
      sourceInstanceId: "native-runner",
      sourceRunId: "goal-heartbeat",
    };
    const capabilityEvent = {
      ...source,
      eventType: "session.capabilities.updated",
      sourceSeq: 1,
      payload: {
        sessionGoals: {
          availability: "available",
          actions: ["set", "pause", "resume", "clear"],
          autonomousUpdates: true,
          persistentAcrossResume: true,
          maxObjectiveChars: 4_000,
          tokenBudgetControl: true,
          usageReporting: true,
        },
      },
    };
    const goalEvent = {
      ...source,
      eventType: "session.goal.updated",
      sourceSeq: 2,
      payload: {
        workingNow: true,
        goal: {
          objective: "Project the durable provider goal",
          status: "active",
          tokenBudget: 4_000,
          tokensUsed: 50,
          elapsedSeconds: 2,
          iterations: 1,
        },
      },
    };

    const capability = await applyRunnerGoalPrpEvent(db, eventBinding, capabilityEvent);
    expect(capability).toMatchObject({
      capability: { availability: "available", verified: true },
      revision: expect.stringMatching(/^r:/),
    });
    await expect(
      applyRunnerGoalPrpEvent(db, eventBinding, capabilityEvent),
    ).resolves.toBeNull();

    const goal = await applyRunnerGoalPrpEvent(db, eventBinding, goalEvent);
    expect(goal).toMatchObject({
      goal: {
        objective: "Project the durable provider goal",
        status: "active",
        workingNow: true,
      },
      revision: expect.stringMatching(/^r:/),
    });
    await expect(
      applyRunnerGoalPrpEvent(db, eventBinding, goalEvent),
    ).resolves.toBeNull();
    await expect(
      applyRunnerGoalPrpEvent(db, eventBinding, {
        ...goalEvent,
        sourceSeq: 3,
      }),
    ).resolves.toBeNull();

    const [session] = await db.select({
      revision: agentTaskSessions.goalRevision,
      revisionToken: agentTaskSessions.goalRevisionToken,
      sourceCursor: agentTaskSessions.goalSourceCursor,
      capability: agentTaskSessions.goalCapabilityJson,
      goal: agentTaskSessions.goalJson,
    }).from(agentTaskSessions);
    expect(session).toMatchObject({
      revision: 0,
      revisionToken: expect.stringMatching(/^r:/),
      sourceCursor: 3,
      capability: { availability: "available" },
      goal: {
        objective: "Project the durable provider goal",
        status: "active",
        workingNow: true,
      },
    });
  });

  it("blocks an unrecoverable active goal with a stable resumable reason", async () => {
    const binding = await seed();
    await applyRunnerGoalPrpEvent(db, { ...binding, adapterType: "paperclip_runner" }, {
      eventType: "session.goal.updated",
      sourceSeq: 1,
      payload: {
        goal: {
          objective: "Recover this goal after restart",
          status: "active",
          tokensUsed: 10,
          elapsedSeconds: 5,
          iterations: 1,
        },
      },
    });

    const blocked = await blockRunnerGoalRecovery(db, {
      ...binding,
      adapterType: "paperclip_runner",
    });
    expect(blocked).toMatchObject({
      goal: {
        status: "blocked",
        workingNow: false,
        lastReason: "provider_session_goal_recovery_failed",
      },
    });
    const [session] = await db.select({
      desired: agentTaskSessions.goalDesiredState,
    }).from(agentTaskSessions);
    expect(session?.desired).toBe("paused");
  });

  it("routes quiescent goal controls through durable recovery instead of a stale live authority", async () => {
    const binding = await seed();
    let liveDispatches = 0;
    let queuedCommands = 0;
    const offlineControls: string[] = [];
    const service = runnerGoalService(db, {
      dispatchLiveControl: () => {
        liveDispatches += 1;
        return {
          runId: "stale-run",
          completion: Promise.resolve(),
        };
      },
      queueLiveCommand: () => {
        queuedCommands += 1;
        return null;
      },
      enqueueOfflineControl: async ({ requestId }) => {
        offlineControls.push(requestId);
      },
    });
    const requestId = randomUUID();

    const accepted = await service.act(binding.companyId, binding.issueId, {
      requestId,
      agentId: binding.agentId,
      expectedRevision: 0,
      action: "create",
      objective: "Resume this goal through a durable heartbeat",
    });

    expect(accepted.status).toBe("accepted");
    expect(liveDispatches).toBe(0);
    expect(queuedCommands).toBe(0);
    expect(offlineControls).toEqual([requestId]);
    await expect(
      db
        .select({ status: agentSessionGoalActions.status })
        .from(agentSessionGoalActions),
    ).resolves.toEqual([{ status: "pending" }]);
  });
});
