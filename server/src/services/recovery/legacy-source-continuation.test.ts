import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../heartbeat/queue.js";
import { mergeCoalescedContextSnapshot } from "../heartbeat/run-preparation.js";
import { filterZombieCoalesceTarget } from "../heartbeat.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("legacy disposition repair source hand-back", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-source-continuation-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("queues one ordinary task-bound turn after a comment/status-only repair", async () => {
    const [company] = await db.insert(companies).values({ name: "Source hand-back fixture", issuePrefix: "SHF" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Source owner", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: "Implement code and tests", description: "The source fix is still pending",
      status: "todo", assigneeAgentId: agent.id,
    }).returning();
    const [repair] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "legacy",
      livenessState: "advanced", contextSnapshot: {
        issueId: issue.id, source: "issue.deliberate_wait_disposition_repair",
        legacyDispositionEpisode: { id: "same-episode", attempt: 2, maxAttempts: 2 },
      },
    }).returning();
    const enqueueWakeup = vi.fn(async (agentId: string, options?: { idempotencyKey?: string | null; contextSnapshot?: Record<string, unknown> }) => {
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId: company.id, agentId, source: "automation", status: "queued",
        idempotencyKey: options?.idempotencyKey, payload: options?.contextSnapshot,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: company.id, agentId, status: "queued", runtimeMode: "legacy",
        wakeupRequestId: wake.id, contextSnapshot: options?.contextSnapshot,
      }).returning();
      await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      return run;
    });
    const service = recoveryService(db, { enqueueWakeup });

    expect(await service.reconcileLegacyContinuation(repair.id)).toBe("queued");
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    const [, options] = enqueueWakeup.mock.calls[0]!;
    expect(options).toMatchObject({
      idempotencyKey: expect.stringContaining(":source_continuation"),
      contextSnapshot: {
        issueId: issue.id, taskId: issue.id, source: "issue.disposition_repair_source_continuation",
        legacyDispositionSourceContinuation: true, retryOfRunId: repair.id,
      },
    });
    expect(options?.contextSnapshot?.legacyDispositionEpisode).toBeUndefined();
    expect(await service.reconcileLegacyContinuation(repair.id)).toBe("skipped");
    expect(enqueueWakeup).toHaveBeenCalledOnce();
  });

  it("admits one real queued turn and rejects a stale owner after concurrent reconciliation", async () => {
    const [company] = await db.insert(companies).values({ name: "Queue admission fixture", issuePrefix: "QAF" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Source owner", status: "idle", adapterType: "process" }).returning();
    const [other] = await db.insert(agents).values({ companyId: company.id, name: "Other owner", status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Implement source fix", status: "todo", assigneeAgentId: agent.id, responsibleUserId: "queue-test-user" }).returning();
    const [repair] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "legacy",
      contextSnapshot: { issueId: issue.id, source: "issue.deliberate_wait_disposition_repair",
        legacyDispositionEpisode: { id: "queue-episode", attempt: 2, maxAttempts: 2 } },
    }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => id === other.id ? other : agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false } as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "queue-test-user",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {
        filterZombieCoalesceTarget,
        mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue,
        shouldQueueFollowupForRunningIssueWake,
      },
      recovery: {
        escalateStrandedAssignedIssue: async () => undefined,
        escalateStrandedRecoveryIssueInPlace: async () => undefined,
      },
    });
    const queue = createHeartbeatQueue(db, { ...deps, wakeQueue });
    const service = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup });

    const results = await Promise.all([service.reconcileLegacyContinuation(repair.id), service.reconcileLegacyContinuation(repair.id)]);
    expect(results.filter(result => result === "queued")).toHaveLength(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued", runId: expect.any(String) });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakes[0]!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: issue.id, source: "issue.disposition_repair_source_continuation" });

    expect(runs[0]!.status).toBe("running");
    expect(deps.executeRun).toHaveBeenCalledExactlyOnceWith(runs[0]!.id);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.executionRunId).toBe(runs[0]!.id);

    // An ordinary successor can finish a useful source turn while its issue
    // remains open. It must not consume another repair attempt or block it.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runs[0]!.id));
    expect(await service.reconcileLegacyContinuation(runs[0]!.id)).toBe("skipped");
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: "todo", assigneeAgentId: agent.id });

    await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, issue.id));
    expect(await service.reconcileLegacyContinuation(repair.id)).toBe("skipped");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id))).toHaveLength(1);
  });
});
