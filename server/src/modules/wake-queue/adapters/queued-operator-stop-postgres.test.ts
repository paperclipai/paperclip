import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("queued operator stop release", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-queued-operator-stop-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seed(input: { activeCycle?: boolean; source?: string; started?: boolean; selected?: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const originId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop regression", issuePrefix: `T${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "operator", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped cycle", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "operator", originKind: "routine_execution", originId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "legacy", contextSnapshot: { issueId }, finishedAt: new Date(),
      ...(input.started ? { startedAt: new Date(), runtimeModeResolvedAt: new Date() } : input.selected ? { runtimeModeResolvedAt: new Date() } : {}),
      resultJson: { ...(!input.started ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        startupCancellation: { requestedAt: new Date().toISOString(), beforeNativeSelection: false } } : {}), cancellation: { source: input.source ?? "operator", expected: input.source !== "provider",
        initiator: { type: input.source === "provider" ? "provider" : "user", id: "operator" },
        reason: "Stopped", recordedAt: new Date().toISOString() } } });
    let activeCycleId: string | null = null;
    let activeRunId: string | null = null;
    if (input.activeCycle) {
      activeCycleId = randomUUID(); activeRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: activeRunId, companyId, agentId, invocationSource: "on_demand", status: "running",
        contextSnapshot: { issueId: activeCycleId }, startedAt: new Date() });
      await db.insert(issues).values({ id: activeCycleId, companyId, title: "Current cycle", status: "in_progress",
        assigneeAgentId: agentId, originKind: "routine_execution", originId, executionRunId: activeRunId });
    } else {
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    }
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_commented",
      status: "deferred_issue_execution", payload: { issueId }, requestedByActorType: "user", requestedByActorId: "operator" }).returning();
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "operator",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => null }),
      recovery: { escalateStrandedAssignedIssue: async () => { throw Error("Unexpected recovery"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw Error("Unexpected recovery"); } },
    });
    return { companyId, agentId, issueId, runId, wakeId: wake.id, activeCycleId, activeRunId, release };
  }

  it.each([false, true])("preserves pending work after a pre-dispatch Stop (active cycle=%s)", async (activeCycle) => {
    const f = await seed({ activeCycle });
    const before = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const result = await f.release({ companyId: f.companyId, runId: f.runId, now: new Date() });
    expect(result).toEqual({ outcome: { kind: "released" }, postCommitEffects: [] });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress",
      statusVersion: before.statusVersion, assigneeAgentId: f.agentId, executionRunId: null, checkoutRunId: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(activeCycle ? 2 : 1);
    if (f.activeCycleId) expect((await db.select().from(issues).where(eq(issues.id, f.activeCycleId)))[0])
      .toMatchObject({ status: "in_progress", executionRunId: f.activeRunId });
    expect(await f.release({ companyId: f.companyId, runId: f.runId, now: new Date() })).toEqual(result);
  });

  it("keeps ordinary provider cancellation promotion", async () => {
    const f = await seed({ source: "provider" });
    expect((await f.release({ companyId: f.companyId, runId: f.runId, now: new Date() })).outcome.kind).toBe("promoted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId)))[0].status).toBe("queued");
  });

  it("does not replace stop acknowledgement for a dispatched run", async () => {
    const f = await seed({ started: true });
    expect((await f.release({ companyId: f.companyId, runId: f.runId, now: new Date() })).outcome.kind).toBe("released");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("keeps the existing release path when runtime selection has occurred", async () => {
    const f = await seed({ selected: true });
    expect((await f.release({ companyId: f.companyId, runId: f.runId, now: new Date() })).outcome.kind).toBe("promoted");
  });
});
