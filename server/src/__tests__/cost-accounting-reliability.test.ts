import { upsertBudgetPolicySchema } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentRuntimeState, agentWakeupRequests, agents, approvals, budgetIncidents, budgetPolicies, companies, completionContracts, costEvents, createDb, financeEvents, goals, heartbeatRuns, issues, nativeRunResults, projects } from "@paperclipai/db";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { costService, createCostEventInTransaction } from "../services/costs.js";
import { budgetService, withCurrentBudgetEnforcement, type BudgetEnforcementScope } from "../services/budgets.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { financeService } from "../services/finance.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseDescribe = support.supported ? describe : describe.skip;

databaseDescribe("cost accounting reliability (PostgreSQL)", () => {
  const services = hoistModuleGraph(() => {}, async () => {
    const [agentModule, companyModule, approvalModule] = await Promise.all([
      import("../services/agents.js"), import("../services/companies.js"), import("../services/approvals.js"),
    ]);
    return { agentService: agentModule.agentService, companyService: companyModule.companyService, approvalService: approvalModule.approvalService };
  });
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-cost-reliability-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Accounting", issuePrefix: `T${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project", status: "in_progress" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Work" }).returning();
    const [goal] = await db.insert(goals).values({ companyId: company.id, title: "Goal" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "on_demand" }).returning();
    const receipt = { agentId: agent.id, provider: "test", model: "test", billingType: "metered_api", costCents: 100, occurredAt: new Date() };
    return { company, agent, project, issue, goal, run, receipt };
  }

  it.each([false, true])("deletes linked accounting records before company runs (concurrent writer: %s)", async (concurrentWriter) => {
    const f = await fixture();
    const other = await fixture();
    await costService(db).createEvent(other.company.id, other.receipt);
    const charge = await costService(db).createEvent(f.company.id, { ...f.receipt, heartbeatRunId: f.run.id, issueId: f.issue.id });
    await financeService(db).createEvent(f.company.id, {
      eventKind: "platform_fee", direction: "debit", biller: "paperclip", amountCents: 5, currency: "USD", occurredAt: new Date(),
      heartbeatRunId: f.run.id, costEventId: charge.id,
    });
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.company.id, scopeType: "company", scopeId: f.company.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1000 }).returning();
    await db.insert(budgetIncidents).values({ companyId: f.company.id, policyId: policy.id, scopeType: "company", scopeId: f.company.id,
      metric: policy.metric, windowKind: policy.windowKind, windowStart: new Date(), windowEnd: new Date(),
      thresholdType: "warning", amountLimit: 1000, amountObserved: 100 });
    let removing: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      if (concurrentWriter) {
        await db.transaction(async tx => {
          await tx.select().from(companies).where(eq(companies.id, f.company.id)).for("no key update");
          removing = services.value.companyService(db).remove(f.company.id).then(value => ({ value }), error => ({ error }));
          await vi.waitFor(async () => {
            const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
              and wait_event_type = 'Lock' and query like '%companies%for no key update%'`);
            expect(waiting.length).toBeGreaterThan(0);
          }, { timeout: 3000 });
          await createCostEventInTransaction(tx as unknown as ReturnType<typeof createDb>, f.company.id, { ...f.receipt, heartbeatRunId: f.run.id }, []);
        });
        expect(await removing!).toMatchObject({ value: { id: f.company.id } });
      } else expect(await services.value.companyService(db).remove(f.company.id)).toMatchObject({ id: f.company.id });
      expect(await db.select().from(companies).where(eq(companies.id, f.company.id))).toHaveLength(0);
      for (const table of [heartbeatRuns, costEvents, financeEvents, budgetPolicies, budgetIncidents]) {
        expect(await db.select().from(table).where(eq(table.companyId, f.company.id))).toHaveLength(0);
      }
      expect((await costService(db).summary(other.company.id)).spendCents).toBe(100);
      expect(await services.value.companyService(db).remove(f.company.id)).toBeNull();
    } finally { await removing; }
  });

  it("serializes agent deletion before child locks and preserves a concurrent settled charge", async () => {
    const f = await fixture();
    let removing: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.select().from(companies).where(eq(companies.id, f.company.id)).for("no key update");
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
        removing = services.value.agentService(db).remove(f.agent.id).then(value => ({ value }), error => ({ error }));
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select query from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and (query like '%companies%for no key update%' or query like 'delete from "heartbeat_runs"%')`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 3000 });
        await createCostEventInTransaction(tx as unknown as ReturnType<typeof createDb>, f.company.id,
          { ...f.receipt, heartbeatRunId: f.run.id }, []);
      });
      // Existing charge FKs prohibit hard deletion. Preserve the settled charge
      // and the atomic deletion failure, rather than deadlocking its writer.
      expect(await removing!).toMatchObject({ error: { cause: { code: "23503" } } });
      expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
      expect(await db.select().from(agents).where(eq(agents.id, f.agent.id))).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toHaveLength(1);
    } finally { await removing; }
  });

  it("preserves an in-flight native result when company deletion reaches its existing foreign-key restriction", async () => {
    const f = await fixture();
    await costService(db).createEvent(f.company.id, { ...f.receipt, heartbeatRunId: f.run.id });
    const contractHash = randomUUID();
    const [contract] = await db.insert(completionContracts).values({ companyId: f.company.id, issueId: f.issue.id,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractHash, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id,
      completionContractId: contract.id, completionContractSha256: contractHash }).where(eq(heartbeatRuns.id, f.run.id));
    let removing: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
        removing = services.value.companyService(db).remove(f.company.id).then(value => ({ value }), error => ({ error }));
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query like 'delete from "heartbeat_runs"%'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 3000 });
        const store = new NativeRunCoordinatorStore(tx as unknown as ReturnType<typeof createDb>, {
          companyId: f.company.id, issueId: f.issue.id, runId: f.run.id, agentId: f.agent.id,
          normalizedSessionId: randomUUID(), runnerSourceInstanceId: randomUUID(),
          completionContractId: contract.id, completionContractSha256: contractHash,
          completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
          completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(c => c.criterionId),
        });
        expect(await store.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL }))
          .toMatchObject({ disposition: "committed" });
      });
      // Native artifacts already prevent hard deletion via restrictive FKs.
      // Preserve that atomic failure; the accounting lock must not introduce a
      // deadlock that aborts the native result instead (Postgres 40P01).
      expect(await removing!).toMatchObject({ error: { cause: { code: "23503" } } });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.company.id))).toHaveLength(1);
      expect(await db.select().from(companies).where(eq(companies.id, f.company.id))).toHaveLength(1);
      expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
    } finally { await removing; }
  });

  it("counts cache reads once across mixed historical and receipt-backed reports without changing charges", async () => {
    const f = await fixture();
    const costs = costService(db);
    const scope = { agentId: f.agent.id, issueId: f.issue.id, projectId: f.project.id, heartbeatRunId: f.run.id,
      provider: "openai", biller: "openai", model: "gpt-test", occurredAt: new Date() };
    // These two layouts both describe 100 input (80 cached) and 10 output.
    for (const billingType of ["metered_api", "subscription_included"]) {
      await db.insert(costEvents).values({ companyId: f.company.id, ...scope, billingType,
        inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, costCents: 7 });
      await costs.createEvent(f.company.id, { ...scope, billingType,
        inputTokens: 20, cachedInputTokens: 80, outputTokens: 10, costCents: 11 });
    }
    const [provider, models] = await Promise.all([costs.byProvider(f.company.id), costs.byAgentModel(f.company.id)]);
    for (const rows of [provider, models]) {
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ inputTokens: 40, cachedInputTokens: 160, outputTokens: 20, costCents: 18 });
        expect(row.inputTokens + row.cachedInputTokens + row.outputTokens).toBe(220);
      }
    }
    const [agent] = await costs.byAgent(f.company.id);
    const [biller] = await costs.byBiller(f.company.id);
    const [project] = await costs.byProject(f.company.id);
    const issue = await costs.issueTreeSummary(f.company.id, f.issue.id);
    const windows = await costs.windowSpend(f.company.id);
    expect(windows).toHaveLength(3);
    for (const row of [agent, biller, project, issue, ...windows]) {
      expect(row).toMatchObject({ inputTokens: 80, cachedInputTokens: 320, outputTokens: 40, costCents: 36 });
      expect(row.inputTokens + row.cachedInputTokens + row.outputTokens).toBe(440);
    }
    for (const row of [agent, biller, provider.find(row => row.billingType === "subscription_included")!]) {
      expect(row).toMatchObject({ subscriptionInputTokens: 40, subscriptionCachedInputTokens: 160, subscriptionOutputTokens: 20 });
    }
    // Reading reports never rewrites historical evidence or retroactively bills.
    const stored = await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id));
    expect(stored.filter(row => row.receiptHash === null).map(row => row.inputTokens)).toEqual([100, 100]);
    expect((await costs.summary(f.company.id)).spendCents).toBe(36);
    // Legacy Anthropic input was already exclusive; retain its cache semantics.
    await db.insert(costEvents).values({ companyId: f.company.id, ...scope, provider: "anthropic", billingType: "metered_api",
      inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, costCents: 0 });
    expect((await costs.byProvider(f.company.id)).find(row => row.provider === "anthropic")).toMatchObject({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 });
  });

  it.each([
    ["openai/gpt-test", 100], ["openai/vendor/model", 100],
    ["gpt-test", 20], ["different/model", 20], ["openai/", 20],
  ] as const)("preserves historical input semantics for %s", async (model, inputTokens) => {
    const f = await fixture(), costs = costService(db);
    await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.issue.id, projectId: f.project.id, heartbeatRunId: f.run.id,
      provider: "openai", biller: "openai", model, occurredAt: new Date(),
      inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, costCents: 7 });
    const rows = [
      ...await costs.byAgent(f.company.id), ...await costs.byProvider(f.company.id),
      ...await costs.byAgentModel(f.company.id), ...await costs.byBiller(f.company.id),
      ...await costs.byProject(f.company.id), ...await costs.windowSpend(f.company.id),
      await costs.issueTreeSummary(f.company.id, f.issue.id),
      ...(await costs.byUser(f.company.id)).rows,
    ];
    for (const row of rows) expect(row).toMatchObject({ inputTokens, cachedInputTokens: 80, outputTokens: 10, costCents: 7 });
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id)))[0].inputTokens).toBe(100);
  });

  it.each((["company", "agent", "project"] as const).flatMap(scopeType => [0, 500].map(previousAmount => ({ scopeType, previousAmount }))))("edits $scopeType limits without confusing saved zero and disabled positive amounts ($previousAmount)", async ({ scopeType, previousAmount }) => {
    const f = await fixture(), cancel = vi.fn(async () => {});
    const budgets = budgetService(db, { cancelWorkForScope: cancel });
    const scopeId = scopeType === "company" ? f.company.id : scopeType === "agent" ? f.agent.id : f.project.id;
    await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: previousAmount, isActive: false }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, projectId: f.project.id, costCents: 100 });
    expect((await budgets.overview(f.company.id)).policies[0]).toMatchObject({ amount: 0, isActive: false });
    const updated = await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 50 }, "board");
    expect(updated).toMatchObject({ isActive: previousAmount === 0, paused: previousAmount === 0 });
    expect(cancel).toHaveBeenCalledTimes(previousAmount === 0 ? 1 : 0);
    expect((await budgets.overview(f.company.id)).activeIncidents).toHaveLength(previousAmount === 0 ? 1 : 0);
  });

  it.each(["issueId", "projectId", "goalId", "heartbeatRunId"] as const)("rejects a foreign-company %s without writing anything", async (field) => {
    const a = await fixture(); const b = await fixture();
    const foreignIds = { issueId: b.issue.id, projectId: b.project.id, goalId: b.goal.id, heartbeatRunId: b.run.id };
    await expect(costService(db).createEvent(a.company.id, { ...a.receipt, [field]: foreignIds[field] })).rejects.toThrow(/company/);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, a.company.id))).toHaveLength(0);
  });

  it("allows admission inside a caller transaction holding a company foreign-key lock", async () => {
    const f = await fixture();
    // The recovery service dispatches through another connection while its
    // transaction still owns FK KEY SHARE locks on the company. Accounting
    // must serialize without requesting the conflicting FOR UPDATE mode.
    await db.transaction(async (tx) => {
      await tx.insert(issues).values({ companyId: f.company.id, title: "Concurrent recovery" });
      expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    });
  }, 5000);

  it.each([false, true])("takes the attributed issue lock before the run during native recovery (attribution changes: %s)", async (changeAttribution) => {
    const f = await fixture();
    const [nextIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "New attribution" }).returning();
    const usage = { provider: "openai", billingType: "metered_api", costUsd: 0.5, inputTokens: 10, outputTokens: 2,
      accountingReceiptReady: true, ledgerScope: { issueId: f.issue.id } };
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id, status: "failed", finishedAt: new Date(),
      costAccountingPending: true, usageJson: usage }).where(eq(heartbeatRuns.id, f.run.id));
    let accounting: Promise<{ value?: boolean; error?: unknown }> | undefined;
    try {
      await db.transaction(async tx => {
        // recordRetryableFailure holds the issue while updating its run.
        await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
        accounting = accountRunCost(db, f.run.id).then(value => ({ value }), error => ({ error }));
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query like '%issues%for key share%'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 3000 });
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update", { noWait: true });
        await tx.update(heartbeatRuns).set({ resultJson: { prpRunTerminalState: "failed" },
          ...(changeAttribution ? { usageJson: { ...usage, ledgerScope: { issueId: nextIssue.id } } } : {}),
        }).where(eq(heartbeatRuns.id, f.run.id));
      });
      if (changeAttribution) {
        expect((await accounting!).error).toMatchObject({ status: 409, message: "Run cost attribution changed. Retry accounting." });
        expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
        expect(await accountRunCost(db, f.run.id)).toBe(true);
      } else expect(await accounting!).toEqual({ value: true });
      const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({ issueId: changeAttribution ? nextIssue.id : f.issue.id, costCents: 50 });
    } finally { await accounting; }
  });

  it("takes the company lock before retry issue/run locks during an attributed cost write", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.agent.id }).where(eq(issues.id, f.issue.id));
    await db.update(heartbeatRuns).set({ status: "scheduled_retry", scheduledRetryAt: new Date(0), scheduledRetryReason: "workspace_busy",
      contextSnapshot: { issueId: f.issue.id, projectId: f.project.id },
    }).where(eq(heartbeatRuns.id, f.run.id));
    let promotion: ReturnType<ReturnType<typeof createRunDispatch>["promoteScheduledRetry"]> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for("no key update");
      promotion = createRunDispatch(db).promoteScheduledRetry({ companyId: f.company.id, runId: f.run.id });
      // Observe the actual blocked company-lock query before checking the issue;
      // no timing guess or timeout is used as proof of lock ordering.
      await vi.waitFor(async () => {
        const result = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%companies%for no key update%'`);
        expect(result.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
      await tx.execute(sql`select id from issues where id = ${f.issue.id} for key share nowait`);
      await createCostEventInTransaction(tx as unknown as ReturnType<typeof createDb>, f.company.id,
        { ...f.receipt, issueId: f.issue.id, projectId: f.project.id }, []);
    });
    expect((await promotion)?.outcome).toBe("promoted");
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
  }, 10000);

  it("locks company before activating an approved hire while a receipt writer is active", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, f.agent.id));
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "hire_agent", status: "pending",
      payload: { agentId: f.agent.id, budgetMonthlyCents: 1000 } }).returning();
    let approving: Promise<unknown> | undefined;
    await db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for("no key update");
      approving = services.value.approvalService(db).approve(approval.id, "board");
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%companies%for no key update%'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
      await tx.execute(sql`select id from agents where id = ${f.agent.id} for no key update nowait`);
      await createCostEventInTransaction(tx as unknown as ReturnType<typeof createDb>, f.company.id, f.receipt, []);
    });
    await expect(approving).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("idle");
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
  }, 10000);

  it("deduplicates concurrent retries and rejects changed receipt content", async () => {
    const f = await fixture();
    const receipt = { ...f.receipt, idempotencyKey: "provider-receipt-1" };
    const events = await Promise.all(Array.from({ length: 8 }, () => costService(db).createEvent(f.company.id, receipt)));
    expect(new Set(events.map((event) => event.id)).size).toBe(1);
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
    await expect(costService(db).createEvent(f.company.id, { ...receipt, costCents: 200 })).rejects.toThrow(/different|conflict/i);
    // Keys are scoped to the reporting company.
    const other = await fixture();
    await expect(costService(db).createEvent(other.company.id, { ...other.receipt, idempotencyKey: receipt.idempotencyKey })).resolves.toBeTruthy();
  });

  it("retains sub-cent spend and enforces the sum, not rounded individual receipts", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1 }, "board");
    for (let i = 0; i < 3; i++) await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 0.4 });
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(1.2);
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("conserves project totals when a run touches multiple projects and includes unallocated spend", async () => {
    const f = await fixture();
    const [otherProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Other" }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: f.company.id, projectId: otherProject.id, title: "Other" }).returning();
    await db.insert(activityLog).values([f.issue, otherIssue].map((issue) => ({ companyId: f.company.id, actorType: "agent", actorId: f.agent.id, action: "issue.updated", entityType: "issue", entityId: issue.id, runId: f.run.id })));
    await costService(db).createEvent(f.company.id, { ...f.receipt, heartbeatRunId: f.run.id, projectId: f.project.id });
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 30 });
    const rows = await costService(db).byProject(f.company.id);
    expect(rows.reduce((sum, row) => sum + row.costCents, 0)).toBe(130);
    expect(rows.find((row) => row.projectId === f.project.id)?.costCents).toBe(100);
    expect(rows.find((row) => row.projectId === null)?.costCents).toBe(30);
  });

  it("does not enforce inactive policies, and checks both monthly and lifetime limits", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await costService(db).createEvent(f.company.id, f.receipt);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1, isActive: false }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1000, windowKind: "calendar_month_utc" }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50, windowKind: "lifetime" }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 2000, windowKind: "calendar_month_utc" }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("creates one approval under concurrent evaluation and opens a new incident after a raised budget is reached", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    const event = await costService(db).createEvent(f.company.id, f.receipt);
    await Promise.all(Array.from({ length: 8 }, () => budgets.evaluateCostEvent(event)));
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(1);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 150 }, "board");
    await costService(db).createEvent(f.company.id, f.receipt);
    expect(await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard"), eq(budgetIncidents.status, "open")))).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(2);
  });

  it("commits accounting despite cancellation delivery failure and retries delivery safely", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    const cancel = vi.fn().mockRejectedValueOnce(new Error("injected cancellation transport failure")).mockResolvedValue(undefined);
    const costs = costService(db, { cancelWorkForScope: cancel });
    const receipt = { ...f.receipt, idempotencyKey: "retry-after-cancel" };
    await expect(costs.createEvent(f.company.id, receipt)).resolves.toBeTruthy();
    await costs.createEvent(f.company.id, receipt);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect((await costs.summary(f.company.id)).spendCents).toBe(100);
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("recovers live scopes despite deleted agent and project policies and an isolated transaction failure", async () => {
    const f = await fixture(); const other = await fixture(); const budgets = budgetService(db);
    const [removedAgent] = await db.insert(agents).values({ companyId: f.company.id, name: "Removed", adapterType: "process" }).returning();
    const [removedProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Removed" }).returning();
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: removedAgent.id, amount: 100 }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "project", scopeId: removedProject.id, amount: 100 }, "board");
    await db.delete(agents).where(eq(agents.id, removedAgent.id));
    await db.delete(projects).where(eq(projects.id, removedProject.id));
    for (const live of [f, other]) {
      await budgets.upsertPolicy(live.company.id, { scopeType: "agent", scopeId: live.agent.id, amount: 100 }, "board");
      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, live.agent.id));
    }
    // Restrict the scanned scope list so the injected first transaction fails
    // on the stale scope, ahead of both live policies in this real database.
    const query = vi.spyOn(db, "selectDistinct").mockReturnValueOnce({ from: () => ({ orderBy: async () => [
      { companyId: f.company.id, scopeType: "project", scopeId: removedProject.id },
      { companyId: f.company.id, scopeType: "agent", scopeId: removedAgent.id },
      ...[f, other].map(live => ({ companyId: live.company.id, scopeType: "agent", scopeId: live.agent.id })),
    ] }) } as never);
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Injected scope recovery failure"));
    try { await budgets.reconcilePolicies(); } finally { query.mockRestore(); transaction.mockRestore(); }
    for (const live of [f, other]) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, live.agent.id));
      expect(agent).toMatchObject({ status: "idle", pauseReason: null });
    }
    // A subsequent sweep uses actual policy discovery and skips both deleted scopes.
    await expect(budgets.reconcilePolicies()).resolves.toBeUndefined();
  });

  it("recovers terminal run accounting exactly once across simultaneous live and recovery workers", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "timed_out", finishedAt: new Date(), costAccountingPending: true,
      usageJson: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10, costUsd: 0.004, provider: "test", model: "test", billingType: "metered_api", ledgerScope: { issueId: f.issue.id, projectId: f.project.id } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await Promise.all([accountRunCost(db, f.run.id), accountRunCost(db, f.run.id), reconcileRunCosts(db)]);
    const [totals] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(totals).toMatchObject({ totalInputTokens: 20, totalCachedInputTokens: 100, totalOutputTokens: 10, totalCostCents: 0.4 });
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ costCents: 0.4, projectId: f.project.id });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.costAccountingPending).toBe(false);
    expect(run.costAccountedAt).toBeInstanceOf(Date);
    // Late terminal metadata may re-arm the pending flag. The durable
    // acknowledgement, not the delivery flag, owns exactly-once totals.
    await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    expect((await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id)))[0].totalCostCents).toBe(0.4);
  });

  it("rolls back the ledger and counters on accounting failure, retaining a retryable run", async () => {
    const f = await fixture(); const other = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true, usageJson: {
      inputTokens: 10, costUsd: 1, provider: "test", model: "test", ledgerScope: { projectId: other.project.id },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(accountRunCost(db, f.run.id)).rejects.toThrow(/company/);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
    expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountingPending).toBe(true);
  });

  it("rolls back a receipt, counters, and budget incidents if a later runtime write fails", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50 }, "board");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), costAccountingPending: true, usageJson: {
      inputTokens: 10, costUsd: 1, provider: "test", billingType: "metered_api", model: "test",
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.execute(sql`create function reject_runtime_accounting() returns trigger language plpgsql as $$ begin raise exception 'injected runtime write failure'; end $$`);
    await db.execute(sql`create trigger reject_runtime_accounting before insert on agent_runtime_state for each row execute function reject_runtime_accounting()`);
    try {
      await expect(accountRunCost(db, f.run.id)).rejects.toThrow();
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
      expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.company.id))).toHaveLength(0);
      expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(0);
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ spentMonthlyCents: 0, status: "active" });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    } finally {
      await db.execute(sql`drop trigger reject_runtime_accounting on agent_runtime_state`);
      await db.execute(sql`drop function reject_runtime_accounting()`);
    }
    await accountRunCost(db, f.run.id);
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
  });

  it("releases an expired monthly budget pause while preserving manual pauses", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50 }, "board");
    const event = await costService(db).createEvent(f.company.id, f.receipt);
    const now = new Date();
    await db.update(costEvents).set({ occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)) }).where(eq(costEvents.id, event.id));
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ status: "idle", pauseReason: null });
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agent.id));
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 200 }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("uses live observed spend for incident resolution and synchronizes company budgets", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 50 }, "board");
    await costService(db).createEvent(f.company.id, f.receipt);
    const [incident] = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard")));
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 25 });
    await expect(budgets.resolveIncident(f.company.id, incident.id, { action: "raise_budget_and_resume", amount: 125 }, "board")).rejects.toThrow("New budget must exceed current observed spend");
    await budgets.resolveIncident(f.company.id, incident.id, { action: "raise_budget_and_resume", amount: 175 }, "board");
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0]).toMatchObject({ budgetMonthlyCents: 175, status: "active", pauseReason: null });
  });

  it("exposes missing prices and blocks strict budgets until explicitly allowed", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, inputTokens: 500, costCents: 0, costStatus: "unpriced" });
    expect(await costService(db).summary(f.company.id)).toMatchObject({ spendCents: 0, unpricedEventCount: 1, pricingComplete: false });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ reason: "Agent cannot start work because recorded usage has no reliable price." });
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, unpricedUsagePolicy: "allow" }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await budgets.overview(f.company.id)).policies[0]).toMatchObject({ unpricedEventCount: 1, unpricedUsagePolicy: "allow" });
  });

  it("keeps subscription-included usage outside monetary pricing gaps", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, inputTokens: 500, costCents: 0, costStatus: "unpriced", billingType: "subscription_included" });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: true });
  });

  it("defaults reports to the UTC month and excludes future events from rolling spend", async () => {
    const f = await fixture(); const costs = costService(db); const now = new Date();
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)) });
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: new Date(now.getTime() + 86_400_000) });
    expect((await costs.summary(f.company.id)).spendCents).toBe(0);
    expect((await costs.summary(f.company.id, { allTime: true })).spendCents).toBe(200);
    expect(await costs.windowSpend(f.company.id)).toEqual([]);
  });

  it("keeps finance currencies separate and deduplicates invoice-line retries", async () => {
    const f = await fixture(); const finance = financeService(db);
    const usd = { biller: "vendor", eventKind: "platform_fee", amountCents: 100, currency: "usd", occurredAt: new Date(), idempotencyKey: "invoice:line:1", metadataJson: { a: 1, b: 2 } };
    await Promise.all(Array.from({ length: 6 }, () => finance.createEvent(f.company.id, usd)));
    await finance.createEvent(f.company.id, { ...usd, metadataJson: { b: 2, a: 1 } });
    await finance.createEvent(f.company.id, { ...usd, currency: "EUR", idempotencyKey: "invoice:line:2" });
    const summary = await finance.summary(f.company.id);
    expect(summary).toMatchObject({ currency: "USD", debitCents: 100, netCents: 100 });
    expect(summary.currencies).toEqual(expect.arrayContaining([expect.objectContaining({ currency: "USD", netCents: 100 }), expect.objectContaining({ currency: "EUR", netCents: 100 })]));
    expect(await finance.byBiller(f.company.id)).toHaveLength(2);
    expect(await finance.byKind(f.company.id)).toHaveLength(2);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, f.company.id))).toHaveLength(2);
    await expect(finance.createEvent(f.company.id, { ...usd, amountCents: 200 })).rejects.toThrow(/different/);
  });

  it("synchronizes budgets through generic agent and company updates", async () => {
    const f = await fixture();
    const { agentService, companyService } = services.value;
    await agentService(db).update(f.agent.id, { budgetMonthlyCents: 50 });
    await companyService(db).update(f.company.id, { budgetMonthlyCents: 75 });
    await costService(db).createEvent(f.company.id, f.receipt);
    const policies = await budgetService(db).listPolicies(f.company.id);
    expect(policies).toEqual(expect.arrayContaining([expect.objectContaining({ scopeType: "agent", amount: 50 }), expect.objectContaining({ scopeType: "company", amount: 75 })]));
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "company" });
  });

  it("delivers cancellation after generic budget updates commit", async () => {
    const f = await fixture();
    await costService(db).createEvent(f.company.id, f.receipt);
    const cancelWorkForScope = vi.fn(async (scope) => {
      const policies = await budgetService(db).listPolicies(f.company.id);
      expect(policies.some(policy => policy.scopeType === scope.scopeType && policy.amount < 100)).toBe(true);
    });
    await services.value.agentService(db, { cancelWorkForScope }).update(f.agent.id, { budgetMonthlyCents: 50 });
    await services.value.companyService(db, { cancelWorkForScope }).update(f.company.id, { budgetMonthlyCents: 75 });
    expect(cancelWorkForScope).toHaveBeenCalledWith(expect.objectContaining({ scopeType: "agent", scopeId: f.agent.id }));
    expect(cancelWorkForScope).toHaveBeenCalledWith(expect.objectContaining({ scopeType: "company", scopeId: f.company.id }));
    const rows = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, f.company.id));
    expect(rows.every(row => row.enforcementVersion === row.enforcementDeliveredVersion)).toBe(true);
  });

  it("merges partial policy edits with current settings under the accounting lock", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    const identity = { scopeType: "agent" as const, scopeId: f.agent.id };
    await budgets.upsertPolicy(f.company.id, { ...identity, amount: 100, hardStopEnabled: true }, "board");
    await budgets.upsertPolicy(f.company.id, { ...identity, amount: 200, hardStopEnabled: false, warnPercent: 60, notifyEnabled: false }, "other-operator");
    const saved = await budgets.upsertPolicy(f.company.id, upsertBudgetPolicySchema.parse({ ...identity, reservationCents: "10" }), "board");
    expect(saved).toMatchObject({ amount: 200, hardStopEnabled: false, warnPercent: 60, notifyEnabled: false, reservationCents: "10.0000000" });
    await budgets.upsertPolicy(f.company.id, { ...identity, isActive: false }, "other-operator");
    const disabled = await budgets.upsertPolicy(f.company.id, upsertBudgetPolicySchema.parse({ ...identity, amount: 300 }), "board");
    expect(await db.select({ amount: budgetPolicies.amount, isActive: budgetPolicies.isActive }).from(budgetPolicies).where(eq(budgetPolicies.id, disabled.policyId))).toEqual([{ amount: 300, isActive: false }]);
    expect(disabled).toMatchObject({ amount: 0, isActive: false, hardStopEnabled: false, warnPercent: 60, notifyEnabled: false, reservationCents: "10.0000000" });
    await expect(budgets.upsertPolicy(f.company.id, { scopeType: "project", scopeId: f.project.id, reservationCents: "1" }, "board")).rejects.toThrow("Amount is required");
  });

  it("conserves both spend and tokens across complete per-model receipts", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), costAccountingPending: true, usageJson: {
      provider: "anthropic", billingType: "metered_api", model: "mixed", costUsd: 0.007,
      inputTokens: 30, outputTokens: 4, cachedInputTokens: 100,
      usageByModel: [
        { model: "large", costUsd: 0.005, usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 100 } },
        { model: "small", costUsd: 0.002, usage: { inputTokens: 10, outputTokens: 1 } },
      ],
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    const rows = await costService(db).byProvider(f.company.id);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ model: "large", costCents: 0.5, inputTokens: 20 }), expect.objectContaining({ model: "small", costCents: 0.2, inputTokens: 10 })]));
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(0.7);
    const [totals] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(totals).toMatchObject({ totalInputTokens: 30, totalCachedInputTokens: 100, totalOutputTokens: 4, totalCostCents: 0.7 });
  });
  it("blocks admission while a terminal run awaits accounting, even under an allow-unpriced policy", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1000, unpricedUsagePolicy: "allow" }, "board");
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ reason: expect.stringContaining("await accounting") });
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: false, pendingRunCount: 1 });
    await accountRunCost(db, f.run.id);
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: false, pendingRunCount: 0, unpricedEventCount: 1 });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
  });

  it("waits for a late provider receipt after cancellation instead of acknowledging a zero charge", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", costAccountingPending: true, usageJson: { accountingReceiptReady: false } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
    await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptReady: true, costUsd: 0.25, inputTokens: 10 } }).where(eq(heartbeatRuns.id, f.run.id));
    await Promise.all([accountRunCost(db, f.run.id), accountRunCost(db, f.run.id)]);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id)))[0]).toMatchObject({ costCents: 25, inputTokens: 10 });
    expect((await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id)))[0].totalCostCents).toBe(25);
  });

  it("acknowledges proven pre-provider failures without inventing a charge", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true,
      resultJson: { executionRecovery: { providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
  });

  it("records spend after attribution targets are deleted", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true, usageJson: {
      costUsd: 0.01, ledgerScope: { projectId: f.project.id, issueId: f.issue.id },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(issues).where(eq(issues.id, f.issue.id));
    await db.delete(projects).where(eq(projects.id, f.project.id));
    await accountRunCost(db, f.run.id);
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id)))[0]).toMatchObject({ costCents: 1, issueId: null, projectId: null });
  });

  it("preserves dismissed incidents and warning incidents during admission checks", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 80 });
    for (let i = 0; i < 3; i++) expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await budgets.overview(f.company.id)).activeIncidents).toHaveLength(1);
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 20 });
    const [incident] = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard")));
    await budgets.resolveIncident(f.company.id, incident.id, { action: "keep_paused" }, "board");
    for (let i = 0; i < 3; i++) expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeTruthy();
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(1);
  });

  it("does not revive terminated agents or archived companies during budget reconciliation", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await db.update(agents).set({ status: "terminated", pauseReason: "budget" }).where(eq(agents.id, f.agent.id));
    await db.update(companies).set({ status: "archived", pauseReason: "budget" }).where(eq(companies.id, f.company.id));
    for (const [scopeType, scopeId] of [["agent", f.agent.id], ["company", f.company.id]] as const) {
      await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 1000 }, "board");
    }
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 2000 });
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("terminated");
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].status).toBe("archived");
  });

  it.each(["agent", "company", "project"] as const)("limits delayed %s budget cancellation to work that preceded the policy check", async (scopeType) => {
    const f = await fixture();
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db);
    const scopeId = scopeType === "agent" ? f.agent.id : scopeType === "company" ? f.company.id : f.project.id;
    const cutoff = new Date();
    await db.update(heartbeatRuns).set({ status: "queued", createdAt: new Date(cutoff.getTime() - 1000), contextSnapshot: { projectId: f.project.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const [newRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "scheduled_retry",
      scheduledRetryAt: new Date(cutoff.getTime() + 60000), createdAt: new Date(cutoff.getTime() + 1000), contextSnapshot: { projectId: f.project.id },
    }).returning();
    await heartbeat.cancelBudgetScopeWork({ companyId: f.company.id, scopeType, scopeId, createdBefore: cutoff });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("cancelled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newRun.id)))[0].status).toBe("scheduled_retry");
  });

  it.each(["agent", "company", "project"] as const)("rechecks delayed %s enforcement after a grant admits an old queued run", async (scopeType) => {
    const f = await fixture();
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db);
    const budgets = budgetService(db);
    const scopeId = scopeType === "agent" ? f.agent.id : scopeType === "company" ? f.company.id : f.project.id;
    const policyInput = { scopeType, scopeId, amount: 1 };
    await db.update(heartbeatRuns).set({ status: "queued", contextSnapshot: { projectId: f.project.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "automation", payload: { projectId: f.project.id } }).returning();
    await budgets.upsertPolicy(f.company.id, policyInput, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, projectId: f.project.id, costCents: 2 });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let snapshotReady!: (scope: BudgetEnforcementScope) => void;
    const snapshot = new Promise<BudgetEnforcementScope>(resolve => { snapshotReady = resolve; });
    const delivery = budgetService(db, { cancelWorkForScope: async (scope) => {
      snapshotReady(scope); await paused; await heartbeat.cancelBudgetScopeWork(scope);
    } }).deliverPendingEnforcement(f.company.id);
    try {
      expect((await snapshot).enforcement).toMatchObject({ policyId: expect.any(String), version: expect.any(Number) });
      await budgets.upsertPolicy(f.company.id, { ...policyInput, amount: 100 }, "board");
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
      await reserveRunBudget(db, f.company.id, f.run.id, f.project.id);
    } finally { release(); }
    await delivery;
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ status: "running", resultJson: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("queued");
  });

  it("keeps a durably claimed budget stop fenced after a later grant", async () => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 1 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 2 });
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, f.company.id));
    const scope: BudgetEnforcementScope = { companyId: f.company.id, scopeType: "company", scopeId: f.company.id,
      enforcement: { policyId: policy.id, version: policy.enforcementVersion } };
    expect(await withCurrentBudgetEnforcement(db, scope, async (tx) => {
      await tx.update(heartbeatRuns).set({ status: "running", resultJson: { cancellation: { reason: "Budget stop" } } }).where(eq(heartbeatRuns.id, f.run.id));
      return true;
    })).toBe(true);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 100 }, "board");
    await expect(reserveRunBudget(db, f.company.id, f.run.id, null)).rejects.toThrow("cancellation already requested");
    const effect = vi.fn(async () => true);
    for (const invalid of [
      scope,
      { ...scope, enforcement: { ...scope.enforcement!, policyId: randomUUID() } },
      { ...scope, scopeId: randomUUID() },
      { ...scope, scopeType: "agent" as const },
      { ...scope, enforcement: { ...scope.enforcement!, version: policy.enforcementVersion + 1 } },
    ]) expect(await withCurrentBudgetEnforcement(db, invalid, effect)).toBeNull();
    expect(effect).not.toHaveBeenCalled();
  });

});
