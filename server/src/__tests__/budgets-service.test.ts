import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import { ACCOUNTING_PENDING_GRACE_MS, budgetService, deliverBudgetEnforcement, hasPendingBudgetEnforcement } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// Budget behavior is exercised against PostgreSQL below and in
// cost-accounting-reliability.test.ts, including transaction and retry paths.

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_BUDGETS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../services/agent-lifecycle.js");
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  async function insertFinishedRunPendingAccounting(input: {
    companyId: string;
    agentId: string;
    finishedAt: Date;
  }) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        status: "failed",
        finishedAt: input.finishedAt,
        costAccountingPending: true,
        runtimeMode: "legacy",
      })
      .returning();
    return run!;
  }

  it("raises one soft incident per window before hard-stopping and preserving safe local audit details", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    const [pendingPolicy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id));
    expect(pendingPolicy.enforcementVersion).toBe(1);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const [afterAdmission] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id));
    expect(afterAdmission.enforcementVersion).toBe(pendingPolicy.enforcementVersion);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    const activityCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(activityCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(activityCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(activityCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of activityCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("distinguishes a company budget pause from a manual company pause", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Budget pause requires a policy or an explicit operator resume.",
    });
    await db.update(companies).set({ pauseReason: null }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company is paused and cannot start new work.",
    });
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({ status: "active", lifecycleHolds: [] });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });

  it("discards stale undelivered enforcement when a budget is raised before dispatch", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 100, windowKind: "lifetime" }, "board");
    await service.evaluateCostEvent(await insertCostEvent({ companyId, agentId, projectId, costCents: 125 }));
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 200, windowKind: "lifetime" }, "board");
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await hasPendingBudgetEnforcement(db)).toBe(false);
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
  });

  it("retains failed cancellation delivery and retries without replaying accounting", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const service = budgetService(db);
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 100, windowKind: "lifetime" }, "board");
    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    const cancelWorkForScope = vi.fn().mockRejectedValueOnce(new Error("Controlled stop delivery failure")).mockResolvedValue(undefined);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0].pauseReason).toBe("budget");
    const [afterFailure] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    expect(afterFailure.enforcementVersion).toBeGreaterThan(afterFailure.enforcementDeliveredVersion);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(await hasPendingBudgetEnforcement(db)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
    expect((await db.select().from(budgetIncidents)).filter(incident => incident.thresholdType === "hard")).toHaveLength(1);
  });

  // JEN-42: a run that finishes with cost_accounting_pending set (receipts
  // exist but have not settled into the ledger yet) must not read as a
  // budget breach, and must not pause an agent before accounting has had a
  // reasonable chance to settle (ACCOUNTING_PENDING_GRACE_MS).
  it("does not pause an agent for a recently finished run still pending accounting", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 50000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const run = await insertFinishedRunPendingAccounting({ companyId, agentId, finishedAt: new Date() });

    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "active", pauseReason: null });
    expect(await db.select().from(budgetIncidents)).toHaveLength(0);
    expect(cancelWorkForScope).not.toHaveBeenCalled();

    // The run is untouched by this check — still pending, visible for anyone
    // reading the ledger, just not treated as a hard block yet.
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]?.costAccountingPending).toBe(true);
  });

  it("pauses with a run-naming reason once pending accounting goes stale — never a false $0 breach", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 50000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const staleFinishedAt = new Date(Date.now() - ACCOUNTING_PENDING_GRACE_MS - 60_000);
    const run = await insertFinishedRunPendingAccounting({ companyId, agentId, finishedAt: staleFinishedAt });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
    expect(block?.reason).toContain(run.id);
    expect(block?.reason).toContain("not a spend breach");

    const [incident] = await db.select().from(budgetIncidents);
    expect(incident).toMatchObject({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "hard",
      amountLimit: 50000,
      amountObserved: 0,
      status: "open",
    });

    const [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "paused", pauseReason: "budget" });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.accounting_pending_blocked",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            reasons: ["accounting_pending"],
            stalePendingRunIds: [run.id],
            stalePendingRunCount: 1,
          }),
        }),
      ]),
    );
  });

  it("still hard-stops a real spend overrun even while an unrelated run has stale pending accounting", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const staleFinishedAt = new Date(Date.now() - ACCOUNTING_PENDING_GRACE_MS - 60_000);
    await insertFinishedRunPendingAccounting({ companyId, agentId, finishedAt: staleFinishedAt });
    const event = await insertCostEvent({ companyId, agentId, costCents: 150 });
    await service.evaluateCostEvent(event);

    const block = await service.getInvocationBlock(companyId, agentId);
    // A real overspend must still read as a spend breach, not get relabeled
    // as "not a spend breach" because a stale pending run also exists.
    expect(block?.reason).toBe("Agent is paused because its budget hard-stop was reached.");

    const [incident] = await db.select().from(budgetIncidents).where(eq(budgetIncidents.thresholdType, "hard"));
    expect(incident).toMatchObject({ amountLimit: 100, amountObserved: 150, status: "open" });
  });

});
