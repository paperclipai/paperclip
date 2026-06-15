import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
      },
      {
        id: runB,
        companyId: opcoId,
        agentId: opcoAgentId,
        invocationSource: "assignment",
        status: "failed",
        startedAt: new Date("2026-06-11T10:00:00.000Z"),
        finishedAt: new Date("2026-06-11T10:03:00.000Z"),
      },
      {
        id: runOutsider,
        companyId: outsiderId,
        agentId: outsiderAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-06-11T11:00:00.000Z"),
        finishedAt: new Date("2026-06-11T11:05:00.000Z"),
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
    ]);
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
});
