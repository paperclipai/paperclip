import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessionGoalActions,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  applyRunnerGoalPrpEvent,
  blockRunnerGoalRecovery,
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
      projection: { revision: 1 },
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
    const first = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.updated",
      sourceInstanceId: "durable-runner",
      sourceRunId: "heartbeat-run-a",
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
      sourceInstanceId: "durable-runner",
      sourceRunId: "heartbeat-run-a",
      sourceSeq: 10,
      payload: { goal: null },
    })).resolves.toBeNull();
    await expect(runnerGoalService(db).projection(
      binding.companyId,
      binding.issueId,
      binding.agentId,
    )).resolves.toMatchObject({ revision: 1, goal: { status: "complete" } });

    const successor = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.updated",
      sourceInstanceId: "durable-runner",
      sourceRunId: "heartbeat-run-b",
      sourceSeq: 1,
      payload: {
        goal: {
          objective: "Successor heartbeat objective",
          status: "active",
        },
      },
    });
    expect(successor).toMatchObject({
      goal: { objective: "Successor heartbeat objective", status: "active" },
    });

    const duplicate = await applyRunnerGoalPrpEvent(db, {
      ...binding,
      adapterType: "paperclip_runner",
    }, {
      eventType: "session.goal.cleared",
      sourceInstanceId: "durable-runner",
      sourceRunId: "heartbeat-run-b",
      sourceSeq: 1,
      payload: { goal: null },
    });
    expect(duplicate).toBeNull();
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
      revision: 2,
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
      sourceCursor: agentTaskSessions.goalSourceCursor,
      desiredState: agentTaskSessions.goalDesiredState,
      goal: agentTaskSessions.goalJson,
    }).from(agentTaskSessions);
    expect(session).toMatchObject({
      revision: 2,
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
      revision: 1,
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
      revision: 2,
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
      sourceCursor: agentTaskSessions.goalSourceCursor,
      capability: agentTaskSessions.goalCapabilityJson,
      goal: agentTaskSessions.goalJson,
    }).from(agentTaskSessions);
    expect(session).toMatchObject({
      revision: 2,
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
