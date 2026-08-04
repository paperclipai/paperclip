import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, financeEvents, heartbeatRuns, issues, summarySlots } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { portfolioRoutes } from "../routes/portfolio.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres portfolio route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TSMC_COMPANY_ID = "e6361895-a6a4-438d-bb76-b17a0ad026cb";

function makeActor(
  actor: Express.Request["actor"],
  db: ReturnType<typeof createDb>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", portfolioRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("portfolio routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-portfolio-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(summarySlots);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns cross-company rollups for a parent agent with portfolio access", async () => {
    const opcoId = randomUUID();
    const outsiderId = randomUUID();
    const ledgerAgentId = randomUUID();
    const opcoAgentId = randomUUID();
    const outsiderAgentId = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    const runOutsider = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();
    const since = new Date("2026-06-08T00:00:00.000Z");
    const until = new Date("2026-06-15T00:00:00.000Z");

    await db.insert(companies).values([
      {
        id: TSMC_COMPANY_ID,
        name: "TSMC",
        issuePrefix: "TSMC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: opcoId,
        name: "ThinkStack Capital",
        issuePrefix: "TSC",
        parentCompanyId: TSMC_COMPANY_ID,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: outsiderId,
        name: "Outside Co",
        issuePrefix: "OUT",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: ledgerAgentId,
        companyId: TSMC_COMPANY_ID,
        name: "Ledger",
        role: "analyst",
        status: "idle",
        capabilities: "portfolio_metrics:read, finance",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: opcoAgentId,
        companyId: opcoId,
        name: "OpCo Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: outsiderAgentId,
        companyId: outsiderId,
        name: "Outside Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: runA,
        companyId: opcoId,
        agentId: opcoAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-06-10T10:00:00.000Z"),
        finishedAt: new Date("2026-06-10T10:02:00.000Z"),
        contextSnapshot: { issueId: issueA },
      },
      {
        id: runB,
        companyId: opcoId,
        agentId: opcoAgentId,
        invocationSource: "assignment",
        status: "failed",
        startedAt: new Date("2026-06-11T10:00:00.000Z"),
        finishedAt: new Date("2026-06-11T10:03:00.000Z"),
        contextSnapshot: { issueId: issueB },
      },
      {
        id: runOutsider,
        companyId: outsiderId,
        agentId: outsiderAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-06-11T11:00:00.000Z"),
        finishedAt: new Date("2026-06-11T11:05:00.000Z"),
        contextSnapshot: { issueId: randomUUID() },
      },
    ]);

    await db.insert(issues).values([
      {
        id: issueA,
        companyId: opcoId,
        title: "First issue",
        status: "done",
        priority: "medium",
        executionRunId: runA,
      },
      {
        id: issueB,
        companyId: opcoId,
        title: "Second issue",
        status: "done",
        priority: "medium",
        checkoutRunId: runB,
      },
    ]);

    const res = await request(makeActor({
      type: "agent",
      agentId: ledgerAgentId,
      companyId: TSMC_COMPANY_ID,
      source: "agent_key",
    }, db))
      .get("/api/portfolio/runs")
      .query({
        since: since.toISOString(),
        until: until.toISOString(),
        companyIds: opcoId,
      });

    expect(res.status).toBe(200);
    expect(res.body.schema).toEqual({
      version: "v1",
      window: {
        from: since.toISOString(),
        to: until.toISOString(),
      },
      fields: [
        "company_id",
        "agent_id",
        "runs_total",
        "runs_succeeded",
        "runs_failed",
        "seconds_on_task",
        "distinct_issues",
        "heartbeats_avg",
        "cost_cents",
        "priced_cost_event_count",
        "unpriced_cost_event_count",
      ],
    });
    expect(res.body.rows).toEqual([
      {
        company_id: opcoId,
        agent_id: opcoAgentId,
        runs_total: 2,
        runs_succeeded: 1,
        runs_failed: 1,
        seconds_on_task: 300,
        distinct_issues: 2,
        heartbeats_avg: 1,
        cost_cents: 0,
        priced_cost_event_count: 0,
        unpriced_cost_event_count: 0,
      },
    ]);
    expect(Object.keys(res.body.rows[0] ?? {})).toEqual([
      "company_id",
      "agent_id",
      "runs_total",
      "runs_succeeded",
      "runs_failed",
      "seconds_on_task",
      "distinct_issues",
      "heartbeats_avg",
      "cost_cents",
      "priced_cost_event_count",
      "unpriced_cost_event_count",
    ]);
  });

  it("returns only digest-safe issue and summary metadata for a dedicated CEO capability", async () => {
    const opcoId = randomUUID();
    const outsiderId = randomUUID();
    const ceoId = randomUUID();
    await db.insert(companies).values([
      { id: TSMC_COMPANY_ID, name: "TSMC", issuePrefix: "TSMC", requireBoardApprovalForNewAgents: false },
      { id: opcoId, name: "ThinkStack Media", issuePrefix: "TSM", parentCompanyId: TSMC_COMPANY_ID, requireBoardApprovalForNewAgents: false },
      { id: outsiderId, name: "Outside Co", issuePrefix: "OUT", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values({ id: ceoId, companyId: TSMC_COMPANY_ID, name: "CEO", role: "ceo", status: "idle", capabilities: "portfolio_digest:read", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { companyId: opcoId, identifier: "TSM-1", title: "Critical blocker", description: "must not be returned", status: "blocked", priority: "critical" },
      { companyId: opcoId, identifier: "TSM-2", title: "Review needed", status: "in_review", priority: "high" },
      { companyId: outsiderId, identifier: "OUT-1", title: "Outside blocker", status: "blocked", priority: "critical" },
    ]);
    await db.insert(summarySlots).values({ companyId: opcoId, scopeKind: "workspaces_overview", scopeId: null, slotKey: "header", status: "idle" });

    const res = await request(makeActor({ type: "agent", agentId: ceoId, companyId: TSMC_COMPANY_ID, source: "agent_key" }, db))
      .get("/api/portfolio/digest");

    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([expect.objectContaining({ company_id: opcoId, company_name: "ThinkStack Media", summary_status: "idle" })]);
    expect(res.body.issues).toEqual([
      expect.objectContaining({ identifier: "TSM-1", title: "Critical blocker", status: "blocked", priority: "critical" }),
      expect.objectContaining({ identifier: "TSM-2", title: "Review needed", status: "in_review", priority: "high" }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain("must not be returned");
    expect(JSON.stringify(res.body)).not.toContain("Outside blocker");
  });

  it("rejects agents without the dedicated portfolio digest capability", async () => {
    const agentId = randomUUID();
    await db.insert(companies).values({ id: TSMC_COMPANY_ID, name: "TSMC", issuePrefix: "TSMC", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId: TSMC_COMPANY_ID, name: "No digest", role: "engineer", status: "idle", capabilities: "portfolio_metrics:read", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const res = await request(makeActor({ type: "agent", agentId, companyId: TSMC_COMPANY_ID, source: "agent_key" }, db)).get("/api/portfolio/digest");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent lacks portfolio_digest:read");
  });

  it("renders source-attributed run costs while preserving unpriced evidence", async () => {
    const opcoId = randomUUID();
    const ledgerAgentId = randomUUID();
    const opcoAgentId = randomUUID();
    const pricedRunId = randomUUID();
    const unpricedRunId = randomUUID();
    const since = new Date("2026-06-08T00:00:00.000Z");
    const until = new Date("2026-06-15T00:00:00.000Z");

    await db.insert(companies).values([
      {
        id: TSMC_COMPANY_ID,
        name: "TSMC",
        issuePrefix: "TSMC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: opcoId,
        name: "ThinkStack Media",
        issuePrefix: "TSM",
        parentCompanyId: TSMC_COMPANY_ID,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: ledgerAgentId,
        companyId: TSMC_COMPANY_ID,
        name: "Ledger",
        role: "analyst",
        status: "idle",
        capabilities: "portfolio_metrics:read",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: opcoAgentId,
        companyId: opcoId,
        name: "OpCo Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: pricedRunId,
        companyId: opcoId,
        agentId: opcoAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-06-10T10:00:00.000Z"),
        finishedAt: new Date("2026-06-10T10:01:00.000Z"),
      },
      {
        id: unpricedRunId,
        companyId: opcoId,
        agentId: opcoAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-06-11T10:00:00.000Z"),
        finishedAt: new Date("2026-06-11T10:01:00.000Z"),
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId: opcoId,
        agentId: opcoAgentId,
        heartbeatRunId: pricedRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        costStatus: "reported",
        model: "gpt-5.6",
        inputTokens: 100,
        outputTokens: 10,
        costCents: 125,
        occurredAt: new Date("2026-06-10T10:01:00.000Z"),
      },
      {
        companyId: opcoId,
        agentId: opcoAgentId,
        heartbeatRunId: unpricedRunId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        costStatus: "unpriced",
        model: "gpt-5.6",
        inputTokens: 200,
        outputTokens: 20,
        costCents: 0,
        occurredAt: new Date("2026-06-11T10:01:00.000Z"),
      },
    ]);

    const res = await request(makeActor({
      type: "agent",
      agentId: ledgerAgentId,
      companyId: TSMC_COMPANY_ID,
      source: "agent_key",
    }, db))
      .get("/api/portfolio/runs")
      .query({ since: since.toISOString(), until: until.toISOString(), companyIds: opcoId });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({
      company_id: opcoId,
      agent_id: opcoAgentId,
      cost_cents: 125,
      priced_cost_event_count: 1,
      unpriced_cost_event_count: 1,
    })]);
  });

  it("rejects agents without the portfolio capability", async () => {
    const opcoId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values([
      {
        id: TSMC_COMPANY_ID,
        name: "TSMC",
        issuePrefix: "TSMC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: opcoId,
        name: "ThinkStack Media",
        issuePrefix: "TSM",
        parentCompanyId: TSMC_COMPANY_ID,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId: TSMC_COMPANY_ID,
      name: "NoCap",
      role: "engineer",
      status: "idle",
      capabilities: "finance",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const res = await request(makeActor({
      type: "agent",
      agentId,
      companyId: TSMC_COMPANY_ID,
      source: "agent_key",
    }, db))
      .get("/api/portfolio/runs")
      .query({
        since: "2026-06-08T00:00:00.000Z",
        until: "2026-06-15T00:00:00.000Z",
        companyIds: opcoId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent lacks portfolio_metrics:read");
  });

  it("rejects forged company ids outside the caller's portfolio", async () => {
    const opcoId = randomUUID();
    const outsiderId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values([
      {
        id: TSMC_COMPANY_ID,
        name: "TSMC",
        issuePrefix: "TSMC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: opcoId,
        name: "ThinkStack Recruitment",
        issuePrefix: "TSR",
        parentCompanyId: TSMC_COMPANY_ID,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: outsiderId,
        name: "Outside Co",
        issuePrefix: "OUT",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId: TSMC_COMPANY_ID,
      name: "Ledger",
      role: "analyst",
      status: "idle",
      capabilities: "portfolio_metrics:read",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const res = await request(makeActor({
      type: "agent",
      agentId,
      companyId: TSMC_COMPANY_ID,
      source: "agent_key",
    }, db))
      .get("/api/portfolio/runs")
      .query({
        since: "2026-06-08T00:00:00.000Z",
        until: "2026-06-15T00:00:00.000Z",
        companyIds: `${opcoId},${outsiderId}`,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Portfolio company scope denied");
  });

  describe("finance_events", () => {
    it("returns revenue rows for Ledger across a parented OpCo", async () => {
      const opcoId = randomUUID();
      const outsiderId = randomUUID();
      const ledgerId = randomUUID();
      const opcoAgentId = randomUUID();
      const since = new Date("2026-06-08T00:00:00.000Z");
      const until = new Date("2026-06-15T00:00:00.000Z");

      await db.insert(companies).values([
        {
          id: TSMC_COMPANY_ID,
          name: "TSMC",
          issuePrefix: "TSMC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: opcoId,
          name: "ThinkStack Books",
          issuePrefix: "TSB",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: outsiderId,
          name: "Outside Co",
          issuePrefix: "OUT",
          requireBoardApprovalForNewAgents: false,
        },
      ]);

      await db.insert(agents).values([
        {
          id: ledgerId,
          companyId: TSMC_COMPANY_ID,
          name: "Ledger",
          role: "analyst",
          status: "idle",
          capabilities: "portfolio_metrics:read, finance",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: opcoAgentId,
          companyId: opcoId,
          name: "OpCo Agent",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      await db.insert(financeEvents).values([
        {
          companyId: opcoId,
          agentId: opcoAgentId,
          eventKind: "revenue",
          direction: "credit",
          biller: "kdp",
          amountCents: 499,
          currency: "USD",
          occurredAt: new Date("2026-06-10T09:00:00.000Z"),
          externalInvoiceId: "kdp-payout-001",
          metadataJson: { sku: "BOOK-001" },
        },
        {
          companyId: opcoId,
          eventKind: "fee",
          direction: "debit",
          biller: "stripe",
          amountCents: 30,
          currency: "USD",
          occurredAt: new Date("2026-06-11T09:00:00.000Z"),
        },
        // outside the window — must not appear
        {
          companyId: opcoId,
          eventKind: "revenue",
          direction: "credit",
          biller: "kdp",
          amountCents: 100,
          currency: "USD",
          occurredAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        // different (non-parented) company — would only leak if scoping failed
        {
          companyId: outsiderId,
          eventKind: "revenue",
          direction: "credit",
          biller: "kdp",
          amountCents: 999,
          currency: "USD",
          occurredAt: new Date("2026-06-10T09:00:00.000Z"),
        },
      ]);

      const res = await request(makeActor({
        type: "agent",
        agentId: ledgerId,
        companyId: TSMC_COMPANY_ID,
        source: "agent_key",
      }, db))
        .get("/api/portfolio/finance_events")
        .query({
          since: since.toISOString(),
          until: until.toISOString(),
          companyIds: opcoId,
        });

      expect(res.status).toBe(200);
      expect(res.body.schema).toEqual({
        version: "v1",
        window: { from: since.toISOString(), to: until.toISOString() },
        fields: [
          "company_id",
          "event_id",
          "occurred_at",
          "kind",
          "channel",
          "amount_cents",
          "currency",
          "sku",
          "source_ref",
          "agent_id",
        ],
      });
      expect(res.body.rows.length).toBe(2);
      const revenue = res.body.rows.find((r: { kind: string }) => r.kind === "revenue");
      const fee = res.body.rows.find((r: { kind: string }) => r.kind === "fee");
      expect(revenue).toMatchObject({
        company_id: opcoId,
        kind: "revenue",
        channel: "kdp",
        amount_cents: 499,
        currency: "USD",
        sku: "BOOK-001",
        source_ref: "kdp-payout-001",
        agent_id: opcoAgentId,
        occurred_at: "2026-06-10T09:00:00.000Z",
      });
      expect(fee).toMatchObject({
        company_id: opcoId,
        kind: "fee",
        channel: "stripe",
        amount_cents: 30,
        sku: null,
        source_ref: null,
        agent_id: null,
      });
    });

    it("rejects forged companyIds on GET finance_events", async () => {
      const opcoId = randomUUID();
      const outsiderId = randomUUID();
      const ledgerId = randomUUID();

      await db.insert(companies).values([
        {
          id: TSMC_COMPANY_ID,
          name: "TSMC",
          issuePrefix: "TSMC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: opcoId,
          name: "TSR",
          issuePrefix: "TSR",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: outsiderId,
          name: "Outside Co",
          issuePrefix: "OUT",
          requireBoardApprovalForNewAgents: false,
        },
      ]);

      await db.insert(agents).values({
        id: ledgerId,
        companyId: TSMC_COMPANY_ID,
        name: "Ledger",
        role: "analyst",
        status: "idle",
        capabilities: "portfolio_metrics:read",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const res = await request(makeActor({
        type: "agent",
        agentId: ledgerId,
        companyId: TSMC_COMPANY_ID,
        source: "agent_key",
      }, db))
        .get("/api/portfolio/finance_events")
        .query({
          since: "2026-06-08T00:00:00.000Z",
          until: "2026-06-15T00:00:00.000Z",
          companyIds: `${opcoId},${outsiderId}`,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Portfolio company scope denied");
    });

    it("rejects agents without portfolio capability on GET finance_events", async () => {
      const opcoId = randomUUID();
      const agentId = randomUUID();

      await db.insert(companies).values([
        {
          id: TSMC_COMPANY_ID,
          name: "TSMC",
          issuePrefix: "TSMC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: opcoId,
          name: "ThinkStack Media",
          issuePrefix: "TSM",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
      ]);

      await db.insert(agents).values({
        id: agentId,
        companyId: TSMC_COMPANY_ID,
        name: "NoCap",
        role: "engineer",
        status: "idle",
        capabilities: "finance",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const res = await request(makeActor({
        type: "agent",
        agentId,
        companyId: TSMC_COMPANY_ID,
        source: "agent_key",
      }, db))
        .get("/api/portfolio/finance_events")
        .query({
          since: "2026-06-08T00:00:00.000Z",
          until: "2026-06-15T00:00:00.000Z",
          companyIds: opcoId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Agent lacks portfolio_metrics:read");
    });

    it("lets an OpCo agent POST a revenue row to its own company and is idempotent on source_ref", async () => {
      const opcoId = randomUUID();
      const opcoAgentId = randomUUID();

      await db.insert(companies).values([
        {
          id: TSMC_COMPANY_ID,
          name: "TSMC",
          issuePrefix: "TSMC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: opcoId,
          name: "Dastardly Print",
          issuePrefix: "DP",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
      ]);

      await db.insert(agents).values({
        id: opcoAgentId,
        companyId: opcoId,
        name: "Etsy Ingestor",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const app = makeActor({
        type: "agent",
        agentId: opcoAgentId,
        companyId: opcoId,
        source: "agent_key",
      }, db);

      const payload = {
        company_id: opcoId,
        kind: "revenue",
        channel: "etsy",
        amount_cents: 1499,
        currency: "USD",
        occurred_at: "2026-06-14T18:00:00.000Z",
        sku: "PRINT-042",
        source_ref: "etsy-order-1234567890",
        agent_id: opcoAgentId,
        description: "Etsy sale: PRINT-042",
      };

      const first = await request(app).post("/api/portfolio/finance_events").send(payload);
      expect(first.status).toBe(201);
      expect(first.body.created).toBe(true);
      expect(first.body.row).toMatchObject({
        company_id: opcoId,
        kind: "revenue",
        channel: "etsy",
        amount_cents: 1499,
        currency: "USD",
        sku: "PRINT-042",
        source_ref: "etsy-order-1234567890",
        agent_id: opcoAgentId,
      });
      expect(first.body.row.event_id).toEqual(expect.any(String));

      const second = await request(app).post("/api/portfolio/finance_events").send(payload);
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(second.body.row.event_id).toBe(first.body.row.event_id);

      const stored = await db
        .select({ id: financeEvents.id })
        .from(financeEvents)
        .where(eq(financeEvents.companyId, opcoId));
      expect(stored.length).toBe(1);
    });

    it("forbids an OpCo agent from POSTing finance events for another company", async () => {
      const opcoId = randomUUID();
      const otherOpcoId = randomUUID();
      const opcoAgentId = randomUUID();

      await db.insert(companies).values([
        {
          id: TSMC_COMPANY_ID,
          name: "TSMC",
          issuePrefix: "TSMC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: opcoId,
          name: "Dastardly Print",
          issuePrefix: "DP",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: otherOpcoId,
          name: "ThinkStack Media",
          issuePrefix: "TSM",
          parentCompanyId: TSMC_COMPANY_ID,
          requireBoardApprovalForNewAgents: false,
        },
      ]);

      await db.insert(agents).values({
        id: opcoAgentId,
        companyId: opcoId,
        name: "Etsy Ingestor",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const res = await request(makeActor({
        type: "agent",
        agentId: opcoAgentId,
        companyId: opcoId,
        source: "agent_key",
      }, db))
        .post("/api/portfolio/finance_events")
        .send({
          company_id: otherOpcoId,
          kind: "revenue",
          channel: "etsy",
          amount_cents: 1499,
          occurred_at: "2026-06-14T18:00:00.000Z",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Agent can only write finance events for its own company");
    });
  });

  describe("GET /portfolio/companies/:slug (OpCo intake discovery)", () => {
    it("returns intake routing for a known slug to any authenticated agent", async () => {
      await db.insert(companies).values({
        id: randomUUID(),
        name: "ThinkStack Recruitment",
        issuePrefix: "TSR",
        requireBoardApprovalForNewAgents: false,
      });
      const app = makeActor(
        { type: "agent", agentId: randomUUID(), companyId: randomUUID() } as Express.Request["actor"],
        db,
      );

      const res = await request(app).get("/api/portfolio/companies/thiaaa-recruitment");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        slug: "thiaaa-recruitment",
        displayName: "ThinkStack Recruitment",
        intake: {
          triggerPublicId: "badfffb5272d4320ecd24887",
          bearerHandle: "mc-intake-bearer:thiaaa-recruitment",
        },
      });
      expect(res.body.intake.url).toContain(
        "/api/routine-triggers/public/badfffb5272d4320ecd24887/fire",
      );
    });

    it("returns 404 for an unknown slug", async () => {
      const app = makeActor(
        { type: "agent", agentId: randomUUID(), companyId: randomUUID() } as Express.Request["actor"],
        db,
      );
      const res = await request(app).get("/api/portfolio/companies/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 401 for an unauthenticated request", async () => {
      const app = makeActor({ type: "none" } as Express.Request["actor"], db);
      const res = await request(app).get("/api/portfolio/companies/thiaaa-recruitment");
      expect(res.status).toBe(401);
    });
  });
});
