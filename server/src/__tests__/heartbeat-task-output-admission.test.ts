import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, budgetReservations, companies, companyMemberships, costEvents, createDb,
  heartbeatRuns, issues, taskProviderOutputPolicies,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { heartbeatService } from "../services/heartbeat.js";
import { retainTaskProviderOutputPolicy } from "../services/task-provider-output-policy.js";
import { accountRunCost } from "../services/run-cost-accounting.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("heartbeat task output admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const home = createIsolatedTestHome();
  const priorHome = process.env.PAPERCLIP_HOME;
  const userId = randomUUID();
  beforeAll(async () => {
    process.env.PAPERCLIP_HOME = home.home;
    database = await startEmbeddedPostgresTestDatabase("heartbeat-task-output-admission-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: "task-owner@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterAll(async () => {
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorHome;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    home.cleanup();
  });

  it.each(["process", "http"])("settles a denied %s run without entering the adapter or retaining budget", async adapterType => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), ordinaryId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task output admission", issuePrefix: `OUT${adapterType.toUpperCase()}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType, adapterConfig: { cwd: home.home }, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values([issueId, ordinaryId].map(id => ({ id, companyId, title: "Synthetic task",
      status: "todo", assigneeAgentId: agentId, responsibleUserId: userId })));
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: "forbidden" });
    execute.mockReset();
    execute.mockImplementation(async (input: { context: { issueId: string } }) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Ordinary work completed" };
    });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      const denied = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(denied, JSON.stringify(denied.map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode,
        invocationSource: run.invocationSource, retryOfRunId: run.retryOfRunId, scheduledRetryReason: run.scheduledRetryReason,
        context: run.contextSnapshot })))).toHaveLength(1);
      expect(denied[0]).toMatchObject({ status: "failed", errorCode: "task_provider_output_execution_unqualified",
        error: expect.stringContaining("no confined execution runtime is qualified") });
      expect(denied[0].usageJson?.budgetDispatch).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(denied[0]).toMatchObject({ costAccountingPending: true,
        resultJson: { executionRecovery: { providerWorkStarted: false } } });
      expect(await accountRunCost(db, denied[0].id)).toBe(true);
      expect(await accountRunCost(db, denied[0].id)).toBe(false);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, denied[0].id))).toHaveLength(0);
      expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, denied[0].id)))[0].state).toBe("released");
      expect(await db.select().from(budgetReservations).where(and(eq(budgetReservations.companyId, companyId),
        eq(budgetReservations.state, "held")))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBeNull();
      expect((await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, issueId)))[0].disposition).toBe("forbidden");
    } finally { await heartbeat.drainActiveRunExecutions(); }

    const restarted = heartbeatService(db);
    try {
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      await restarted.invoke(agentId, "on_demand", { issueId: ordinaryId }, "manual");
      await restarted.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledOnce();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs).toHaveLength(2);
      expect(runs.find(run => run.contextSnapshot?.issueId === ordinaryId)?.status).toBe("succeeded");
    } finally { await restarted.drainActiveRunExecutions(); }
  }, 30_000);
});
