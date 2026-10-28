import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, projects, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, computeObservedSpend, policyBlocks } from "../services/budgets.js";
import { costService } from "../services/costs.js";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { verifiedSubscriptionIncludedRun } from "../services/subscription-dollar-exposure.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("subscription pending accounting and dollar budgets", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-subscription-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE companies CASCADE`);
    });
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(billingType = "subscription_included") {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Subscription budgets", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Provider", status: "idle", adapterType: "codex_local" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Subscription project" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", usageJson: { ledgerScope: { projectId } } });
    const policies = await db.insert(budgetPolicies).values([
      { scopeType: "company", scopeId: companyId }, { scopeType: "agent", scopeId: agentId }, { scopeType: "project", scopeId: projectId },
    ].map(scope => ({ ...scope, companyId, metric: "billed_cents", windowKind: "lifetime", amount: 100, hardStopEnabled: true, notifyEnabled: false }))).returning();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "budget-subscription-"));
    directories.push(directory);
    const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "codex_local" }, directory);
    await recorder.capture({ billingType, provider: "openai", model: "unsupported", usageBasis: "per_run", complete: false,
      usage: { inputTokens: 500, outputTokens: 100 }, costStatus: "unpriced" });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    return { companyId, agentId, projectId, runId, policies, recorder, readRun };
  }

  it("admits verified subscription work in every scope while retaining unresolved accounting", async () => {
    const f = await fixture();
    const before = await f.readRun();
    const receipts = await db.select().from(runUsageReceipts);
    expect(before).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      usageJson: { billingType: "subscription_included", accountingReceiptReady: false, inputTokens: 500, outputTokens: 100 } });
    for (const policy of f.policies) {
      expect(await computeObservedSpend(db, policy)).toMatchObject({ pendingRunCount: 0, recoveringRunCount: 0, total: 0 });
      expect(await policyBlocks(db, policy)).toBe(false);
    }
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).toBeNull();
    expect(await costService(db).summary(f.companyId)).toMatchObject({ pendingRunCount: 1, pricingComplete: false });
    expect(await f.readRun()).toEqual(before);
    expect(await db.select().from(runUsageReceipts)).toEqual(receipts);
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("fails closed for a subscription flag without durable matching evidence", async () => {
    const f = await fixture();
    await db.delete(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId));
    expect(await policyBlocks(db, f.policies[0])).toBe(true);
    expect((await computeObservedSpend(db, f.policies[0])).pendingRunCount).toBe(1);
  });

  it("recognizes legacy subscription receipts normalized by the real recorder", async () => {
    const f = await fixture("subscription");
    expect((await f.readRun()).usageJson?.billingType).toBe("subscription_included");
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId));
    expect(receipt.receiptJson.receipt).toMatchObject({ billingType: "subscription" });
    for (const policy of f.policies) expect(await policyBlocks(db, policy)).toBe(false);
    expect(await costService(db).summary(f.companyId)).toMatchObject({ pendingRunCount: 1, pricingComplete: false });
  });

  it("keeps a failed later checkpoint pending despite an older subscription receipt", async () => {
    const f = await fixture();
    const before = await f.readRun();
    const receipts = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId));
    await expect(f.recorder.capture({ billingType: "subscription_included", complete: false,
      usage: { inputTokens: -1, outputTokens: 0 } })).rejects.toThrow();
    expect(await f.readRun()).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      accountingLastError: "usage_capture_failed", usageJson: {
        billingType: "subscription_included", accountingCaptureFailed: true, accountingReceiptReady: false,
        accountingReceiptId: before.usageJson?.accountingReceiptId,
        accountingReceiptSourceId: before.usageJson?.accountingReceiptSourceId,
        accountingReceiptSequence: before.usageJson?.accountingReceiptSequence,
      } });
    for (const policy of f.policies) {
      expect((await computeObservedSpend(db, policy)).pendingRunCount).toBe(1);
      expect(await policyBlocks(db, policy)).toBe(true);
    }
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toEqual(receipts);
    expect(await costService(db).summary(f.companyId)).toMatchObject({ pendingRunCount: 1, pricingComplete: false });
  });

  it.each([
    { marker: false, blocked: false },
    { marker: null, blocked: true },
    { marker: "false", blocked: true },
    { marker: 0, blocked: true },
    { marker: {}, blocked: true },
  ])("validates capture-failure marker $marker with blocked=$blocked", async ({ marker, blocked }) => {
    const f = await fixture();
    const run = await f.readRun();
    await db.update(heartbeatRuns).set({ usageJson: { ...run.usageJson, accountingCaptureFailed: marker } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await policyBlocks(db, f.policies[0])).toBe(blocked);
    expect((await f.readRun()).costAccountingPending).toBe(true);
  });

  it.each(["accountingReceiptId", "accountingReceiptSourceId", "accountingReceiptSequence"])("rejects a mismatched %s", async field => {
    const f = await fixture();
    const run = await f.readRun();
    await db.update(heartbeatRuns).set({ usageJson: { ...run.usageJson, [field]: field === "accountingReceiptSequence" ? 999 : randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await policyBlocks(db, f.policies[0])).toBe(true);
  });

  it.each(["metered_api", "unknown"])("keeps incomplete %s work fail closed", async billingType => {
    const f = await fixture(billingType);
    for (const policy of f.policies) expect(await policyBlocks(db, policy)).toBe(true);
  });

  it.each(["metered_api", "unknown"])("rejects contradictory %s journal history", async billingType => {
    const f = await fixture(billingType);
    // A replacement recorder may report subscription while older charge evidence survives.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "budget-subscription-replacement-"));
    directories.push(directory);
    const replacement = await createRunUsageRecorder(db, { companyId: f.companyId, runId: f.runId, adapterType: "codex_local" }, directory);
    await replacement.capture({ billingType: "subscription_included", complete: false, usageBasis: "per_run", usage: { inputTokens: 20, outputTokens: 10 } });
    expect((await f.readRun()).usageJson?.billingType).toBe("subscription_included");
    expect(await policyBlocks(db, f.policies[0])).toBe(true);
  });

  it("rejects positive monetary evidence even with subscription classification", async () => {
    const f = await fixture();
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId));
    await db.update(runUsageReceipts).set({ receiptJson: { ...receipt.receiptJson, liveCostCents: "1.0000000" } })
      .where(eq(runUsageReceipts.id, receipt.id));
    expect(await policyBlocks(db, f.policies[0])).toBe(true);
  });

  it("accepts older subscription journals without a monetary projection", async () => {
    const f = await fixture();
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId));
    const { liveCostCents: _projection, ...legacy } = receipt.receiptJson;
    await db.update(runUsageReceipts).set({ receiptJson: legacy }).where(eq(runUsageReceipts.id, receipt.id));
    expect(await policyBlocks(db, f.policies[0])).toBe(false);
  });

  it("keeps real charges above the cap blocked alongside a verified subscription run", async () => {
    const f = await fixture();
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, projectId: f.projectId,
      provider: "openai", model: "test", billingType: "metered_api", inputTokens: 1, outputTokens: 1, costCents: 101, occurredAt: new Date() });
    for (const policy of f.policies) {
      expect(await computeObservedSpend(db, policy)).toMatchObject({ total: 101, pendingRunCount: 0 });
      expect(await policyBlocks(db, policy)).toBe(true);
    }
  });

  it("isolates other companies, agents and projects with unresolved metered work", async () => {
    const subscription = await fixture();
    const metered = await fixture("metered_api");
    for (const policy of subscription.policies) expect(await policyBlocks(db, policy)).toBe(false);
    for (const policy of metered.policies) expect(await policyBlocks(db, policy)).toBe(true);
    const otherAgentId = randomUUID(), otherProjectId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: subscription.companyId, name: "Other", adapterType: "process" });
    await db.insert(projects).values({ id: otherProjectId, companyId: subscription.companyId, name: "Other" });
    await db.insert(heartbeatRuns).values({ companyId: subscription.companyId, agentId: otherAgentId, status: "cancelled", finishedAt: new Date(),
      costAccountingPending: true, usageJson: { billingType: "metered_api", ledgerScope: { projectId: otherProjectId } } });
    for (const policy of subscription.policies) expect(await policyBlocks(db, policy)).toBe(policy.scopeType === "company");
  });

  it("verifies receipt history through the company/run index with unrelated journal growth", async () => {
    const target = await fixture();
    const unrelated = await fixture("metered_api");
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, unrelated.runId));
    const unrelatedRunIds = Array.from({ length: 2_000 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(unrelatedRunIds.map(id => ({
      id, companyId: unrelated.companyId, agentId: unrelated.agentId, status: "cancelled",
    })));
    await db.insert(runUsageReceipts).values(unrelatedRunIds.map(runId => ({
      ...receipt, id: randomUUID(), sourceId: randomUUID(), runId,
    })));
    await db.execute(sql`ANALYZE run_usage_receipts`);
    const plan = JSON.stringify(await db.execute(sql`EXPLAIN (FORMAT JSON)
      SELECT ${heartbeatRuns.id} FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.id} = ${target.runId} AND ${verifiedSubscriptionIncludedRun()}`));
    expect(plan).toMatch(/run_usage_receipts_(run_latest|source_sequence)_idx/);
    expect(plan).toContain("Index Cond");
    expect(plan).toContain("company_id");
    expect(plan).toContain("run_id");
    expect(plan).not.toContain("hashed SubPlan");
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(await policyBlocks(db, target.policies[0])).toBe(false);
  });
});
