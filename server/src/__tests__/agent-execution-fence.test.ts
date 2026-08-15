import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentExecutionFenceService } from "../services/agent-execution-fence.js";
import { agentService } from "../services/agents.js";
import { budgetService } from "../services/budgets.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("agent execution fence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-execution-fence-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedAgent(status = "idle") {
    const company = await db
      .insert(companies)
      .values({
        name: "Fence Test Company",
        issuePrefix: `FT${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Fence Test Agent",
        role: "engineer",
        status,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, agent };
  }

  async function expectExecutionFenceRejection(operation: Promise<unknown>) {
    let rejection: unknown;
    try {
      await operation;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeDefined();

    const messages: string[] = [];
    let current = rejection;
    const seen = new Set<unknown>();
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join("\n")).toMatch(/execution fence/i);
  }

  it("refuses acquisition while queued work exists without changing the agent", async () => {
    const { company, agent } = await seedAgent("idle");
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "queued",
    });

    await expect(
      agentExecutionFenceService(db).acquire({
        agentId: agent.id,
        companyId: company.id,
        actorUserId: "board-user",
        reason: "maintenance",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const current = await db.select().from(agents).where(eq(agents.id, agent.id)).then((rows) => rows[0]!);
    expect(current.status).toBe("idle");
    expect(current.executionFenceId).toBeNull();
  });

  it("refuses acquisition while scheduled retries or deferred issue wakes exist", async () => {
    const { company, agent } = await seedAgent("idle");
    const scheduledRetry = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "scheduled_retry",
        scheduledRetryAt: new Date(0),
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(
      agentExecutionFenceService(db).acquire({
        agentId: agent.id,
        companyId: company.id,
        actorUserId: "board-user",
        reason: "maintenance",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, scheduledRetry.id));
    const deferredWake = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        status: "deferred_issue_execution",
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(
      agentExecutionFenceService(db).acquire({
        agentId: agent.id,
        companyId: company.id,
        actorUserId: "board-user",
        reason: "maintenance",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const current = await db.select().from(agents).where(eq(agents.id, agent.id)).then((rows) => rows[0]!);
    expect(current).toMatchObject({ status: "idle", executionFenceId: null });
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredWake.id));
  });

  it("blocks normal wake, queue, claim, and retry promotion after atomic acquisition", async () => {
    const { company, agent } = await seedAgent("idle");

    const fence = await agentExecutionFenceService(db).acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    expect(fence.drained).toBe(true);

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await expect(
      heartbeat.wakeup(agent.id, {
        source: "on_demand",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(heartbeat.promoteDueScheduledRetries(new Date())).resolves.toEqual({
      promoted: 0,
      runIds: [],
    });
    await expect(heartbeat.cancelActiveForAgent(agent.id)).rejects.toMatchObject({ status: 409 });

    const agentsService = agentService(db);
    await expect(agentsService.update(agent.id, { status: "idle" })).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.pause(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.resume(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.terminate(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.remove(agent.id)).rejects.toMatchObject({ status: 409 });

    await expectExecutionFenceRejection(
      db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: agent.id,
        status: "queued",
      }),
    );
    await expectExecutionFenceRejection(
      db
        .insert(heartbeatRuns)
        .values({ companyId: company.id, agentId: agent.id, status: "scheduled_retry" }),
    );
    await expectExecutionFenceRejection(
      db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        status: "deferred_issue_execution",
      }),
    );
    await expectExecutionFenceRejection(
      db.delete(agents).where(eq(agents.id, agent.id)),
    );

    const queuedAfterFence = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "queued")))
      .then((rows) => rows[0]?.count ?? 0);
    expect(queuedAfterFence).toBe(0);
    await agentExecutionFenceService(db).release(agent.id, fence.fenceId);
  });

  it("suppresses non-user wakeups cleanly while fenced without writing a skipped request", async () => {
    const { company, agent } = await seedAgent("idle");
    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await expect(
      heartbeat.wakeup(agent.id, {
        source: "timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
      }),
    ).resolves.toBeNull();

    const wakeupCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agent.id))
      .then((rows) => rows[0]?.count ?? 0);
    expect(wakeupCount).toBe(0);
    await service.release(agent.id, acquired.fenceId);
  });

  it("treats budget cancellation as already contained while an agent fence is active", async () => {
    const { company, agent } = await seedAgent("idle");
    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await expect(
      heartbeat.cancelBudgetScopeWork({
        companyId: company.id,
        scopeType: "agent",
        scopeId: agent.id,
      }),
    ).resolves.toBeUndefined();
    await expect(service.get(agent.id, acquired.fenceId)).resolves.toMatchObject({ drained: true });
    await service.release(agent.id, acquired.fenceId);
  });

  it("cancels unfenced company peers without disturbing fenced work", async () => {
    const { company, agent: fencedAgent } = await seedAgent("running");
    const siblingAgent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Unfenced Sibling Agent",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const [fencedRun, siblingRun] = await Promise.all([
      db
        .insert(heartbeatRuns)
        .values({
          companyId: company.id,
          agentId: fencedAgent.id,
          status: "running",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!),
      db
        .insert(heartbeatRuns)
        .values({
          companyId: company.id,
          agentId: siblingAgent.id,
          status: "running",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!),
    ]);

    const fences = agentExecutionFenceService(db);
    const acquired = await fences.acquire({
      agentId: fencedAgent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await expect(
      heartbeat.cancelBudgetScopeWork({
        companyId: company.id,
        scopeType: "company",
        scopeId: company.id,
      }),
    ).resolves.toBeUndefined();

    const [currentFencedRun, currentSiblingRun] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fencedRun.id)).then((rows) => rows[0]!),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, siblingRun.id)).then((rows) => rows[0]!),
    ]);
    expect(currentFencedRun.status).toBe("running");
    expect(currentSiblingRun).toMatchObject({
      status: "cancelled",
      executionFinalizedAt: expect.any(Date),
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fencedRun.id));
    await fences.markRunFinalizerCompleted(fencedRun.id);
    await fences.acknowledgeRunFinalization(fencedRun.id);
    await fences.release(fencedAgent.id, acquired.fenceId);
  });

  it("restores an agent to idle when a pre-fence budget pause is resumed", async () => {
    const priorPausedAt = new Date("2026-08-15T12:00:00.000Z");
    const { company, agent } = await seedAgent("paused");
    await db
      .update(agents)
      .set({ pauseReason: "budget", pausedAt: priorPausedAt })
      .where(eq(agents.id, agent.id));

    const fences = agentExecutionFenceService(db);
    const acquired = await fences.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    await budgetService(db).upsertPolicy(company.id, {
      scopeType: "agent",
      scopeId: agent.id,
      amount: 0,
    }, "board-user");

    const released = await fences.release(agent.id, acquired.fenceId);
    expect(released).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
  });

  it("does not wait on terminal work that never started", async () => {
    const { company, agent } = await seedAgent("idle");
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "cancelled",
      finishedAt: new Date(),
    });

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    expect(acquired.drained).toBe(true);
    expect(acquired.pendingRunIds).toEqual([]);
    await expect(service.release(agent.id, acquired.fenceId)).resolves.toMatchObject({ status: "idle" });
  });

  it("serializes concurrent fence acquisition against queue admission", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { company, agent } = await seedAgent("idle");
      const service = agentExecutionFenceService(db);
      const [acquisition, admission] = await Promise.allSettled([
        service.acquire({
          agentId: agent.id,
          companyId: company.id,
          actorUserId: "board-user",
          reason: `race ${attempt}`,
        }),
        db
          .insert(heartbeatRuns)
          .values({
            companyId: company.id,
            agentId: agent.id,
            status: "queued",
          })
          .returning(),
      ]);

      expect([acquisition, admission].filter((result) => result.status === "fulfilled")).toHaveLength(1);
      if (acquisition.status === "fulfilled") {
        expect(admission.status).toBe("rejected");
        await service.release(agent.id, acquisition.value.fenceId);
      } else {
        expect(admission.status).toBe("fulfilled");
        const currentAgent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, agent.id))
          .then((rows) => rows[0]!);
        expect(currentAgent.executionFenceId).toBeNull();
      }
    }
  });

  it("serializes concurrent fence acquisition against scheduled retry promotion", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { company, agent } = await seedAgent("idle");
      const scheduledRetry = await db
        .insert(heartbeatRuns)
        .values({
          companyId: company.id,
          agentId: agent.id,
          status: "scheduled_retry",
          scheduledRetryAt: new Date(0),
        })
        .returning()
        .then((rows) => rows[0]!);
      const service = agentExecutionFenceService(db);
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });

      const [acquisition, promotion] = await Promise.allSettled([
        service.acquire({
          agentId: agent.id,
          companyId: company.id,
          actorUserId: "board-user",
          reason: `scheduled retry race ${attempt}`,
        }),
        heartbeat.promoteDueScheduledRetries(new Date()),
      ]);

      expect(promotion.status).toBe("fulfilled");
      expect(acquisition.status).toBe("rejected");
      if (acquisition.status === "rejected") {
        expect(acquisition.reason).toMatchObject({ status: 409 });
      }
      expect(promotion).toMatchObject({
        status: "fulfilled",
        value: { promoted: 1, runIds: [scheduledRetry.id] },
      });
      const currentRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduledRetry.id))
        .then((rows) => rows[0]!);
      expect(currentRun.status).toBe("queued");
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, scheduledRetry.id));
    }
  });

  it("serializes concurrent status mutation against fence acquisition", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { company, agent } = await seedAgent("idle");
      const service = agentExecutionFenceService(db);
      const [acquisition, pause] = await Promise.allSettled([
        service.acquire({
          agentId: agent.id,
          companyId: company.id,
          actorUserId: "board-user",
          reason: `status race ${attempt}`,
        }),
        agentService(db).pause(agent.id),
      ]);

      expect([acquisition, pause].filter((result) => result.status === "fulfilled")).toHaveLength(1);
      if (acquisition.status === "fulfilled") {
        expect(pause.status).toBe("rejected");
        await service.release(agent.id, acquisition.value.fenceId);
      } else {
        expect(pause.status).toBe("fulfilled");
        expect(acquisition.reason).toMatchObject({ status: 409 });
      }
    }
  });

  it("waits for a durable finalization acknowledgement from pre-fence running work", async () => {
    const { company, agent } = await seedAgent("running");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    expect(acquired.drained).toBe(false);
    expect(acquired.pendingRunIds).toEqual([run.id]);

    await expectExecutionFenceRejection(
      db
        .update(heartbeatRuns)
        .set({ executionFinalizedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.id)),
    );
    await expectExecutionFenceRejection(
      db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          executionFinalizedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id)),
    );

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    expect((await service.get(agent.id, acquired.fenceId)).drained).toBe(false);

    await expect(service.acknowledgeRunFinalization(run.id)).rejects.toMatchObject({ status: 409 });
    await service.markRunFinalizerCompleted(run.id);
    await service.acknowledgeRunFinalization(run.id);
    const drained = await service.get(agent.id, acquired.fenceId);
    expect(drained.drained).toBe(true);
    expect(drained.pendingRunIds).toEqual([]);
    await service.release(agent.id, acquired.fenceId);
  });

  it("refuses a finalization acknowledgement while the exact linked wakeup is still claimed", async () => {
    const { company, agent } = await seedAgent("running");
    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        status: "claimed",
        claimedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        wakeupRequestId: wakeup.id,
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id })
      .where(eq(agentWakeupRequests.id, wakeup.id));

    const service = agentExecutionFenceService(db);
    await expect(service.markRunFinalizerCompleted(run.id)).rejects.toMatchObject({ status: 409 });
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeup.id));
    await expect(service.markRunFinalizerCompleted(run.id)).resolves.toMatchObject({
      id: run.id,
      executionFinalizerCompletedAt: expect.any(Date),
    });
    await expect(service.acknowledgeRunFinalization(run.id)).resolves.toMatchObject({
      id: run.id,
      executionFinalizedAt: expect.any(Date),
    });
  });

  it("terminalizes the linked wakeup before acknowledging forced lease-release finalization", async () => {
    const { company, agent } = await seedAgent("running");
    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        status: "claimed",
        claimedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        wakeupRequestId: wakeup.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id })
      .where(eq(agentWakeupRequests.id, wakeup.id));

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    const heartbeat = heartbeatService(db);
    await expect(heartbeat.terminalizeRunOnLeaseRelease(run)).resolves.toMatchObject({
      status: "interrupted",
    });
    const finalizedWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeup.id))
      .then((rows) => rows[0]!);
    expect(finalizedWakeup.status).toBe("interrupted");
    await service.markRunFinalizerCompleted(run.id);
    await expect(service.acknowledgeRunFinalization(run.id)).resolves.toMatchObject({
      executionFinalizedAt: expect.any(Date),
    });
    await expect(service.get(agent.id, acquired.fenceId)).resolves.toMatchObject({ drained: true });
    await service.release(agent.id, acquired.fenceId);
  });

  it("keeps a shutdown run undrained until cleanup finishes and suppresses a racing retry", async () => {
    const { company, agent } = await seedAgent("running");
    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        status: "claimed",
        claimedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        wakeupRequestId: wakeup.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id })
      .where(eq(agentWakeupRequests.id, wakeup.id));

    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted!: () => void;
    const cleanupStart = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const runtime = environmentRuntimeService(db);
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      environmentRuntime: {
        ...runtime,
        releaseRunLeases: async (...args) => {
          cleanupStarted();
          await cleanupBlocked;
          return runtime.releaseRunLeases(...args);
        },
      },
    });
    const drain = heartbeat.drainRunningRunsForShutdown("SIGTERM");
    await cleanupStart;

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    await expect(service.get(agent.id, acquired.fenceId)).resolves.toMatchObject({
      drained: false,
      pendingRunIds: [run.id],
    });
    await expect(service.release(agent.id, acquired.fenceId)).rejects.toMatchObject({ status: 409 });

    releaseCleanup();
    await expect(drain).resolves.toMatchObject({
      interrupted: 1,
      interruptedRunIds: [run.id],
      retryRunIds: [],
    });

    const [finalizedRun, finalizedWakeup] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]!),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup.id)).then((rows) => rows[0]!),
    ]);
    expect(finalizedRun).toMatchObject({
      status: "interrupted",
      executionFinalizedAt: expect.any(Date),
    });
    expect(finalizedWakeup.status).toBe("interrupted");
    await expect(service.get(agent.id, acquired.fenceId)).resolves.toMatchObject({ drained: true });
    await service.release(agent.id, acquired.fenceId);
  });

  it("acknowledges unfenced shutdown finalization before a later fence", async () => {
    const { company, agent } = await seedAgent("running");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { responsibleUserId: "board-user" },
      })
      .returning()
      .then((rows) => rows[0]!);

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const drained = await heartbeat.drainRunningRunsForShutdown("SIGTERM");
    expect(drained).toMatchObject({
      interrupted: 1,
      interruptedRunIds: [run.id],
    });
    const finalized = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(finalized).toMatchObject({
      status: "interrupted",
      executionFinalizedAt: expect.any(Date),
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.retryOfRunId, run.id));
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.agentId, agent.id));

    const fences = agentExecutionFenceService(db);
    const acquired = await fences.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "later maintenance",
    });
    await expect(fences.release(agent.id, acquired.fenceId)).resolves.toMatchObject({
      executionFenceId: null,
    });
  });

  it("does not certify a bare terminal row during orphan reconciliation", async () => {
    const { company, agent } = await seedAgent("idle");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "failed",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(heartbeatService(db, { runtimeEnv: {} }).reapOrphanedRuns()).resolves.toMatchObject({
      reaped: 0,
    });
    const reconciled = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(reconciled.executionFinalizedAt).toBeNull();

    await agentExecutionFenceService(db).markRunFinalizerCompleted(run.id);
    await heartbeatService(db, { runtimeEnv: {} }).reapOrphanedRuns();
    const certified = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(certified.executionFinalizedAt).toEqual(expect.any(Date));
  });

  it("refuses durable finalizer completion while a run still owns an issue or active lease", async () => {
    const { company, agent } = await seedAgent("idle");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "failed",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
      })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Finalizer ownership test",
        executionRunId: run.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    const service = agentExecutionFenceService(db);

    await expect(service.markRunFinalizerCompleted(run.id)).rejects.toMatchObject({ status: 409 });
    await db
      .update(issues)
      .set({ executionRunId: null })
      .where(eq(issues.id, issue.id));

    const environment = await db
      .insert(environments)
      .values({
        name: `Fence Finalizer ${randomUUID()}`,
        driver: `test-${randomUUID()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const lease = await db
      .insert(environmentLeases)
      .values({
        companyId: company.id,
        environmentId: environment.id,
        heartbeatRunId: run.id,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(service.markRunFinalizerCompleted(run.id)).rejects.toMatchObject({ status: 409 });
    await db
      .update(environmentLeases)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, lease.id));
    await expect(service.markRunFinalizerCompleted(run.id)).resolves.toMatchObject({
      executionFinalizerCompletedAt: expect.any(Date),
    });
  });

  it("allows durable finalizer completion after issue execution transfers to a retry", async () => {
    const { company, agent } = await seedAgent("idle");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "failed",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
      })
      .returning()
      .then((rows) => rows[0]!);
    const retry = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "scheduled_retry",
        retryOfRunId: run.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issues).values({
      companyId: company.id,
      title: "Transferred retry ownership test",
      checkoutRunId: run.id,
      executionRunId: retry.id,
    });

    await expect(agentExecutionFenceService(db).markRunFinalizerCompleted(run.id)).resolves.toMatchObject({
      executionFinalizerCompletedAt: expect.any(Date),
    });
  });

  it("allows terminal wakeup finalization but rejects requeue for pre-fence running work", async () => {
    const { company, agent } = await seedAgent("running");
    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        status: "claimed",
        claimedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        wakeupRequestId: wakeup.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id })
      .where(eq(agentWakeupRequests.id, wakeup.id));

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    await expectExecutionFenceRejection(
      db
        .update(agentWakeupRequests)
        .set({ status: "queued", claimedAt: null })
        .where(eq(agentWakeupRequests.id, wakeup.id)),
    );
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await expect(
      db
        .update(agentWakeupRequests)
        .set({ status: "completed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wakeup.id)),
    ).resolves.toBeDefined();

    await service.markRunFinalizerCompleted(run.id);
    await service.acknowledgeRunFinalization(run.id);
    await service.release(agent.id, acquired.fenceId);
  });

  it("refuses fencing until an in-flight run claim finishes its linked wakeup metadata", async () => {
    const { company, agent } = await seedAgent("idle");
    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        status: "queued",
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        wakeupRequestId: wakeup.id,
        status: "queued",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id })
      .where(eq(agentWakeupRequests.id, wakeup.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));

    const service = agentExecutionFenceService(db);
    await expect(
      service.acquire({
        agentId: agent.id,
        companyId: company.id,
        actorUserId: "board-user",
        reason: "maintenance",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db
        .update(agentWakeupRequests)
        .set({ status: "claimed", claimedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wakeup.id)),
    ).resolves.toBeDefined();

    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    await expectExecutionFenceRejection(
      db
        .update(agentWakeupRequests)
        .set({ status: "queued", claimedAt: null })
        .where(eq(agentWakeupRequests.id, wakeup.id)),
    );

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeup.id));
    await service.markRunFinalizerCompleted(run.id);
    await service.acknowledgeRunFinalization(run.id);
    await service.release(agent.id, acquired.fenceId);
  });

  it("lets an already-claimed pre-fence run start without unpausing the agent", async () => {
    const { company, agent } = await seedAgent("idle");
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    const authorized = await service.authorizeClaimedRunStart(agent.id, run.id);
    expect(authorized).toMatchObject({
      id: agent.id,
      status: "paused",
      executionFenceId: acquired.fenceId,
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await service.markRunFinalizerCompleted(run.id);
    await service.acknowledgeRunFinalization(run.id);
    await service.release(agent.id, acquired.fenceId);
  });

  it("requires the exact token and a drained fence before restoring the recorded status", async () => {
    const { company, agent } = await seedAgent("active");
    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    await expect(service.release(agent.id, randomUUID())).rejects.toMatchObject({ status: 409 });
    const released = await service.release(agent.id, acquired.fenceId);
    expect(released.status).toBe("active");
    expect(released.executionFenceId).toBeNull();
  });

  it("records atomic audit evidence and restores an existing pause exactly", async () => {
    const priorPausedAt = new Date("2026-08-11T10:00:00.000Z");
    const { company, agent } = await seedAgent("paused");
    await db
      .update(agents)
      .set({ pauseReason: "manual", pausedAt: priorPausedAt })
      .where(eq(agents.id, agent.id));

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    const acquiredAudit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, agent.id));
    expect(acquiredAudit).toEqual([
      expect.objectContaining({
        action: "agent.execution_fence_acquired",
        details: expect.objectContaining({ fenceId: acquired.fenceId }),
      }),
    ]);

    const released = await service.release(agent.id, acquired.fenceId, {
      actorUserId: "board-user",
    });
    expect(released).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      pausedAt: priorPausedAt,
    });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, agent.id))
      .orderBy(asc(activityLog.createdAt));
    expect(audit.map((entry) => entry.action)).toEqual([
      "agent.execution_fence_acquired",
      "agent.execution_fence_released",
    ]);
  });

  it("rolls back fence acquisition when its audit evidence cannot persist", async () => {
    const { company, agent } = await seedAgent("idle");
    await db.execute(sql.raw(`
      CREATE FUNCTION reject_execution_fence_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'agent.execution_fence_acquired' THEN
          RAISE EXCEPTION 'forced execution fence audit failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER reject_execution_fence_audit
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_execution_fence_audit()
    `));

    try {
      await expect(
        agentExecutionFenceService(db).acquire({
          agentId: agent.id,
          companyId: company.id,
          actorUserId: "board-user",
          reason: "maintenance",
        }),
      ).rejects.toBeDefined();

      const current = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .then((rows) => rows[0]!);
      expect(current).toMatchObject({
        status: "idle",
        executionFenceId: null,
      });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER reject_execution_fence_audit ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION reject_execution_fence_audit()"));
    }
  });

  it("keeps the agent fenced when release audit evidence cannot persist", async () => {
    const { company, agent } = await seedAgent("idle");
    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });
    await db.execute(sql.raw(`
      CREATE FUNCTION reject_execution_fence_release_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'agent.execution_fence_released' THEN
          RAISE EXCEPTION 'forced execution fence release audit failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER reject_execution_fence_release_audit
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_execution_fence_release_audit()
    `));

    try {
      await expect(
        service.release(agent.id, acquired.fenceId, { actorUserId: "board-user" }),
      ).rejects.toBeDefined();

      const current = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .then((rows) => rows[0]!);
      expect(current).toMatchObject({
        status: "paused",
        executionFenceId: acquired.fenceId,
      });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER reject_execution_fence_release_audit ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION reject_execution_fence_release_audit()"));
      await service.release(agent.id, acquired.fenceId, { actorUserId: "board-user" });
    }
  });

  it("blocks execution records from being reassigned into a fenced agent", async () => {
    const { company, agent } = await seedAgent("idle");
    const otherAgent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Other Fence Test Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const terminalRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: otherAgent.id,
        status: "cancelled",
        finishedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const terminalWakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: otherAgent.id,
        source: "on_demand",
        status: "failed",
        finishedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);

    const service = agentExecutionFenceService(db);
    const acquired = await service.acquire({
      agentId: agent.id,
      companyId: company.id,
      actorUserId: "board-user",
      reason: "maintenance",
    });

    try {
      await expectExecutionFenceRejection(
        db
          .update(heartbeatRuns)
          .set({ agentId: agent.id })
          .where(eq(heartbeatRuns.id, terminalRun.id)),
      );
      await expectExecutionFenceRejection(
        db
          .update(agentWakeupRequests)
          .set({ agentId: agent.id })
          .where(eq(agentWakeupRequests.id, terminalWakeup.id)),
      );
    } finally {
      await service.release(agent.id, acquired.fenceId);
    }
  });
});
