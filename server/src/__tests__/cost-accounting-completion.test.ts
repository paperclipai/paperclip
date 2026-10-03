import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecrets,
  costEvents,
  financeEvents,
  heartbeatRuns,
  providerBillingSnapshots,
  createDb,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { financeService } from "../services/finance.js";
import {
  applyProviderDailyCosts,
  importProviderDailyCosts,
} from "../services/provider-billing-import.js";
import * as secretsModule from "../services/secrets.js";
import {
  createRunUsageRecorder,
  persistUsageReceipt,
} from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { costService, getMonthlySpendTotal } from "../services/costs.js";
import { budgetService } from "../services/budgets.js";
import type { ImportProviderCosts } from "@paperclipai/shared";

describe("completed cost reporting paths (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let spool: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase(
      "accounting-completion-",
    );
    db = createDb(database.connectionString);
    spool = await mkdtemp(join(tmpdir(), "completion-spool-"));
  }, 90000);
  afterAll(async () => {
    await database?.cleanup();
    if (spool) await rm(spool, { recursive: true, force: true });
  });
  afterEach(() => vi.restoreAllMocks());
  const company = async () =>
    (
      await db
        .insert(companies)
        .values({
          name: "Completion",
          issuePrefix: `C${randomUUID().slice(0, 7)}`,
        })
        .returning()
    )[0];
  it("reads monthly spend from the ledger with company, agent and UTC month boundaries", async () => {
    const c = await company();
    const other = await company();
    const [first, second] = await db.insert(agents).values([
      { companyId: c.id, name: "First", spentMonthlyCents: 9999 },
      { companyId: c.id, name: "Second", spentMonthlyCents: 9999 },
    ]).returning();
    const [outsider] = await db.insert(agents).values({ companyId: other.id, name: "Other" }).returning();
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const base = { companyId: c.id, agentId: first.id, provider: "test", model: "test", costCents: 1.125, occurredAt: start };
    await db.insert(costEvents).values([
      base,
      { ...base, agentId: second.id, costCents: 2.25, occurredAt: new Date(end.getTime() - 1) },
      { ...base, costCents: 500, occurredAt: new Date(start.getTime() - 1) },
      { ...base, costCents: 600, occurredAt: end },
      { ...base, companyId: other.id, agentId: outsider.id, costCents: 700 },
    ]);
    expect(await getMonthlySpendTotal(db, { companyId: c.id })).toBe(3.375);
    expect(await getMonthlySpendTotal(db, { companyId: c.id, agentId: first.id })).toBe(1.125);
    expect(await getMonthlySpendTotal(db, { companyId: c.id, agentId: second.id })).toBe(2.25);
    expect(await getMonthlySpendTotal(db, { companyId: c.id, agentId: outsider.id })).toBe(0);
    expect(await getMonthlySpendTotal(db, { companyId: randomUUID() })).toBe(0);
  });

  it("scopes agent and model estimate counts to the company and selected period", async () => {
    const c = await company();
    const other = await company();
    const [codie, bender] = await db.insert(agents).values([
      { companyId: c.id, name: "Codie", adapterType: "paperclip_runner" },
      { companyId: c.id, name: "Bender", adapterType: "claude_local" },
    ]).returning();
    const [outsider] = await db.insert(agents).values({ companyId: other.id, name: "Other", adapterType: "process" }).returning();
    const base = { companyId: c.id, agentId: codie.id, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", costCents: 100, occurredAt: new Date("2026-09-10T12:00:00Z") };
    await db.insert(costEvents).values([
      { ...base, costStatus: "estimated" },
      { ...base, costStatus: "estimated" },
      { ...base, model: "gpt-6-sol", costStatus: "reported" },
      { ...base, costStatus: "reported", occurredAt: new Date("2026-08-31T23:59:59Z") },
      { ...base, costStatus: "estimated", occurredAt: new Date("2026-10-01T00:00:00Z") },
      { ...base, agentId: bender.id, costStatus: "reported" },
      { ...base, companyId: other.id, agentId: outsider.id, costStatus: "estimated" },
    ]);
    const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") };
    const service = costService(db);
    const totals = await service.byAgent(c.id, range);
    expect(totals).toHaveLength(2);
    expect(totals.find(row => row.agentId === codie.id)).toMatchObject({ costCents: 300, eventCount: 3, estimatedEventCount: 2, apiRunCount: 0 });
    expect(totals.find(row => row.agentId === bender.id)).toMatchObject({ eventCount: 1, estimatedEventCount: 0 });
    const models = (await service.byAgentModel(c.id, range)).filter(row => row.agentId === codie.id);
    expect(models).toHaveLength(2);
    expect(models.find(row => row.model === "gpt-6-astra")).toMatchObject({ eventCount: 2, estimatedEventCount: 2 });
    expect(models.find(row => row.model === "gpt-6-sol")).toMatchObject({ eventCount: 1, estimatedEventCount: 0 });
  });
  it("imports inference, fees and credits atomically into the timeline, without duplicating on retry", async () => {
    const c = await company();
    const service = billingReconciliationService(db);
    const invoice = {
      biller: "openai",
      externalId: "invoice-1",
      currency: "USD",
      lines: [
        {
          externalId: "usage",
          kind: "inference" as const,
          amountCents: "10.0000001",
          occurredAt: "2026-09-01T00:00:00Z",
        },
        {
          externalId: "subscription",
          kind: "fee" as const,
          amountCents: "2000",
          occurredAt: "2026-09-01T00:00:00Z",
        },
        {
          externalId: "refund",
          kind: "credit" as const,
          amountCents: "100",
          occurredAt: "2026-09-01T00:00:00Z",
        },
      ],
    };
    const imports = await Promise.all([
      service.importInvoice(c.id, invoice, "board"),
      service.importInvoice(c.id, invoice, "board"),
    ]);
    expect(imports[0].id).toBe(imports[1].id);
    expect(
      await financeService(db).list(c.id, {
        from: new Date("2026-09-01"),
        to: new Date("2026-09-30"),
      }),
    ).toHaveLength(3);
    expect(
      (
        await financeService(db).summary(c.id, {
          from: new Date("2026-09-01"),
          to: new Date("2026-09-30"),
        })
      ).netCentsExact,
    ).toBe("1910.0000001");
    expect(
      await db.select().from(costEvents).where(eq(costEvents.companyId, c.id)),
    ).toHaveLength(0);
    await expect(
      service.importInvoice(
        c.id,
        { ...invoice, lines: [{ ...invoice.lines[0], amountCents: "99" }] },
        "board",
      ),
    ).rejects.toThrow("different contents");
    expect(
      await db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.companyId, c.id)),
    ).toHaveLength(3);
  });
  it("records provider report corrections as deltas, including decreases and returns to an earlier total", async () => {
    const c = await company();
    const input: ImportProviderCosts = {
      provider: "openai",
      accountId: "org_test",
      secretId: randomUUID(),
      scopeIds: ["project"],
      from: "2026-09-01",
      to: "2026-09-02",
    };
    const update = (amountCents: string) =>
      applyProviderDailyCosts(
        db,
        c.id,
        input,
        [{ day: "2026-09-01", scopeId: "project", amountCents }],
        "board",
      );
    await update("100");
    await update("100");
    await update("120");
    await update("90");
    await update("100");
    const rows = await financeService(db).list(c.id, {
      from: new Date("2026-09-01"),
      to: new Date("2026-09-30"),
    });
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.direction === "credit")).toHaveLength(1);
    const summary = await financeService(db).summary(c.id, { allTime: true });
    expect(summary).toMatchObject({
      netCentsExact: "0.0000000",
      providerReportedCentsExact: "100.0000000",
    });
    expect(await financeService(db).byBiller(c.id, { allTime: true })).toEqual(
      [],
    );
    expect(await financeService(db).byKind(c.id, { allTime: true })).toEqual(
      [],
    );
    const [snapshot] = await db
      .select()
      .from(providerBillingSnapshots)
      .where(eq(providerBillingSnapshots.companyId, c.id));
    expect(snapshot.amountCents).toBe("100.0000000");
    expect(snapshot.revision).toBe(4);
    await expect(
      applyProviderDailyCosts(
        db,
        c.id,
        input,
        [{ day: "2026-09-01", scopeId: "project", amountCents: "80" }],
        "board",
        new Map([["2026-09-01:project", 0]]),
      ),
    ).rejects.toThrow("newer provider report");
    const other = await company();
    await applyProviderDailyCosts(
      db,
      other.id,
      input,
      [{ day: "2026-09-01", scopeId: "project", amountCents: "1" }],
      "board",
    );
    expect(
      await db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.companyId, c.id)),
    ).toHaveLength(4);
  });
  it("fetches with a company credential and keeps provider reports separate from invoice charges", async () => {
    const c = await company();
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId: c.id, key: "billing", name: "Billing admin" })
      .returning();
    const resolveSecretValue = vi.fn().mockResolvedValue("fixture-admin-key");
    vi.spyOn(secretsModule, "secretService").mockReturnValue({
      resolveSecretValue,
    } as unknown as ReturnType<typeof secretsModule.secretService>);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        data: [
          {
            start_time: Date.parse("2026-09-01") / 1000,
            end_time: Date.parse("2026-09-02") / 1000,
            results: [
              {
                project_id: "project",
                amount: { value: 0.06, currency: "usd" },
              },
            ],
          },
        ],
        has_more: false,
      }),
    );
    const input: ImportProviderCosts = {
      provider: "openai",
      accountId: "org_test",
      secretId: secret.id,
      scopeIds: ["project"],
      from: "2026-09-01",
      to: "2026-09-02",
    };
    expect(
      await importProviderDailyCosts(db, c.id, input, "board", fetcher),
    ).toEqual({ daysRead: 1, eventsCreated: 1 });
    expect(resolveSecretValue).toHaveBeenCalledWith(
      c.id,
      secret.id,
      "latest",
      expect.objectContaining({
        accessContext: expect.objectContaining({
          actorId: "board",
          consumerId: "provider-billing-import",
        }),
      }),
    );
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer fixture-admin-key",
      "OpenAI-Organization": "org_test",
    });
    expect(
      await importProviderDailyCosts(db, c.id, input, "board", fetcher),
    ).toEqual({ daysRead: 1, eventsCreated: 0 });
    await billingReconciliationService(db).importInvoice(
      c.id,
      {
        biller: "openai",
        externalId: "separate-invoice",
        currency: "USD",
        lines: [
          {
            externalId: "usage",
            amountCents: "6",
            kind: "inference",
            occurredAt: "2026-09-01T00:00:00Z",
          },
        ],
      },
      "board",
    );
    expect(
      await financeService(db).summary(c.id, { allTime: true }),
    ).toMatchObject({
      netCentsExact: "6.0000000",
      providerReportedCentsExact: "6.0000000",
      eventCount: 2,
    });
    expect(await financeService(db).byBiller(c.id, { allTime: true })).toEqual([
      expect.objectContaining({
        biller: "openai",
        netCentsExact: "6.0000000",
        eventCount: 1,
      }),
    ]);
    const other = await company();
    await expect(
      importProviderDailyCosts(db, other.id, input, "board", fetcher),
    ).rejects.toThrow("company billing credential");
    expect(resolveSecretValue).toHaveBeenCalledTimes(2);
  });
  it("rejects a slow report when another importer changes the same provider snapshot", async () => {
    const c = await company();
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId: c.id, key: "billing-race", name: "Billing admin" })
      .returning();
    vi.spyOn(secretsModule, "secretService").mockReturnValue({
      resolveSecretValue: vi.fn().mockResolvedValue("fixture-admin-key"),
    } as unknown as ReturnType<typeof secretsModule.secretService>);
    const input: ImportProviderCosts = {
      provider: "openai",
      accountId: "org_test",
      secretId: secret.id,
      scopeIds: ["project"],
      from: "2026-09-01",
      to: "2026-09-02",
    };
    const report = (value: number) =>
      Response.json({
        data: [
          {
            start_time: Date.parse(input.from) / 1000,
            end_time: Date.parse(input.to) / 1000,
            results: [
              { project_id: "project", amount: { currency: "usd", value } },
            ],
          },
        ],
        has_more: false,
      });
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const slowResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slowImport = importProviderDailyCosts(
      db,
      c.id,
      input,
      "board",
      async () => {
        markStarted();
        return slowResponse;
      },
    );
    await started;
    await importProviderDailyCosts(db, c.id, input, "board", async () =>
      report(2),
    );
    release(report(1));
    await expect(slowImport).rejects.toThrow("newer provider report");
    expect(
      await financeService(db).summary(c.id, { allTime: true }),
    ).toMatchObject({
      providerReportedCentsExact: "200.0000000",
      eventCount: 1,
    });
  });
  it("rolls back an entire provider import when a later snapshot is invalid", async () => {
    const c = await company();
    const input: ImportProviderCosts = {
      provider: "openai",
      accountId: "org_test",
      secretId: randomUUID(),
      scopeIds: ["project"],
      from: "2026-09-01",
      to: "2026-09-03",
    };
    await expect(
      applyProviderDailyCosts(
        db,
        c.id,
        input,
        [
          { day: "2026-09-01", scopeId: "project", amountCents: "5" },
          { day: "2026-09-02", scopeId: "project", amountCents: "-1" },
        ],
        "board",
      ),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(providerBillingSnapshots)
        .where(eq(providerBillingSnapshots.companyId, c.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.companyId, c.id)),
    ).toEqual([]);
  });
  it("stores an explicit zero report and credits an amended report down to zero only once", async () => {
    const c = await company();
    const input: ImportProviderCosts = {
      provider: "anthropic",
      accountId: "org_test",
      secretId: randomUUID(),
      scopeIds: ["default"],
      from: "2026-09-01",
      to: "2026-09-02",
    };
    const update = (amountCents: string) =>
      applyProviderDailyCosts(
        db,
        c.id,
        input,
        [{ day: input.from, scopeId: "default", amountCents }],
        "board",
      );
    expect((await update("0")).eventsCreated).toBe(0);
    expect((await update("0")).eventsCreated).toBe(0);
    expect((await update("1.0000001")).eventsCreated).toBe(1);
    expect((await update("0")).eventsCreated).toBe(1);
    expect((await update("0")).eventsCreated).toBe(0);
    expect(
      await financeService(db).summary(c.id, { allTime: true }),
    ).toMatchObject({
      providerReportedCentsExact: "0.0000000",
      netCentsExact: "0.0000000",
      eventCount: 2,
    });
  });
  it("freezes estimated dollars before finalization and persists them exactly once into costs and budgets", async () => {
    const c = await company();
    const budgets = budgetService(db);
    await budgets.upsertPolicy(c.id, { scopeType: "company", scopeId: c.id, amount: 100 }, "board");
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: c.id,
        name: "Codie",
        adapterType: "paperclip_runner",
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: c.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "running",
      })
      .returning();
    const recorder = await createRunUsageRecorder(
      db,
      { companyId: c.id, runId: run.id, adapterType: "paperclip_runner" },
      spool,
    );
    const captured = await recorder.capture({
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-6-astra",
      usageBasis: "per_run",
      complete: true,
      costUsd: null,
      usage: {
        inputTokens: 123536,
        cachedInputTokens: 1567209,
        outputTokens: 6625,
      },
    });
    expect(captured.costUsdExact).toBe("3.133819000");
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await accountRunCost(db, run.id);
    await accountRunCost(db, run.id);
    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, run.id));
    expect(event.costStatus).toBe("estimated");
    expect(event.pricingProvenance).toMatchObject({
      source: "rate_card",
      version: "openai-standard-2026-09-30",
    });
    const summary = await costService(db).summary(c.id);
    expect(summary.spendCentsExact).toBe("313.3819000");
    expect(summary.estimatedEventCount).toBe(1);
    expect(await budgets.getInvocationBlock(c.id, agent.id)).not.toBeNull();
  });
  it("preserves cache-write evidence and pricing across multiple provider attempts", async () => {
    const c = await company();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: c.id,
        name: "Retry",
        adapterType: "paperclip_runner",
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: c.id, agentId: agent.id, status: "running" })
      .returning();
    const recorder = await createRunUsageRecorder(
      db,
      { companyId: c.id, runId: run.id, adapterType: "paperclip_runner" },
      spool,
    );
    await recorder.capture({
      attemptId: randomUUID(),
      complete: true,
      provider: "openai",
      biller: "openai",
      billingType: "api",
      model: "gpt-6-astra",
      usageBasis: "per_run",
      usage: { inputTokens: 10, cacheWriteTokens: 4, outputTokens: 2 },
    });
    const result = await recorder.capture({
      attemptId: randomUUID(),
      complete: true,
      provider: "openai",
      biller: "openai",
      billingType: "api",
      costUsd: 2,
    });
    expect(result).toMatchObject({
      complete: true,
      costUsdExact: "2.000210000",
      costStatus: "estimated",
      pricingProvenance: { source: "rate_card", version: "per-attempt/v1" },
      usage: {
        inputTokens: 10,
        cacheWriteTokens: 4,
        cachedInputTokens: 0,
        outputTokens: 2,
      },
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await accountRunCost(db, run.id);
    expect(await costService(db).summary(c.id)).toMatchObject({
      spendCentsExact: "200.0210000",
      estimatedEventCount: 1,
    });
  });
  it("recovers older durable receipts without pricing metadata while preserving explicit zero", async () => {
    const c = await company();
    const sourceId = randomUUID();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: c.id,
        name: "Legacy receipt",
        adapterType: "process",
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: c.id,
        agentId: agent.id,
        status: "running",
        usageJson: { accountingReceiptSourceId: sourceId },
      })
      .returning();
    const cases = [
      { costUsd: null },
      { costUsd: 0 },
      { costUsdExact: "0.000000001" },
    ];
    for (const [index, receipt] of cases.entries()) {
      await persistUsageReceipt(db, {
        schema: "paperclip/accounting-receipt/v1",
        id: randomUUID(),
        companyId: c.id,
        runId: run.id,
        adapterType: "process",
        sourceId,
        sequence: index + 1,
        receivedAt: new Date().toISOString(),
        receipt: { ...receipt, complete: true },
      });
      const [stored] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id));
      expect(stored.usageJson?.pricingProvenance).toEqual({
        source: index === 0 ? "unknown" : "provider_reported",
        version: "accounting-receipt/v1",
      });
    }
  });
});
