import { agents as agentsTable, issues as issuesTable } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { weeklyReviewFixtureRoutes } from "../routes/weekly-review-fixtures.js";

type Actor = Express.Request["actor"];

function app(input: {
  enabled?: boolean;
  actor?: Partial<Actor>;
  db?: { transaction: ReturnType<typeof vi.fn> };
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: true,
      ...input.actor,
    } as Actor;
    next();
  });
  app.use("/api", weeklyReviewFixtureRoutes(input.db as never, { enabled: input.enabled }));
  app.use(errorHandler);
  return app;
}

function createDbMock() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
  };
  const db = {
    transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { db, tx, inserts };
}

describe("weekly review fixture routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is disabled by default and does not touch the database", async () => {
    const { db } = createDbMock();

    const res = await request(app({ enabled: false, db })).post("/api/weekly-review-fixtures/northstar").send({});

    expect(res.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("requires board access before seeding the Northstar fixture", async () => {
    const { db } = createDbMock();

    const res = await request(app({
      enabled: true,
      db,
      actor: {
        type: "agent",
        companyId: "company-1",
        agentId: "agent-1",
        runId: null,
        keyId: "key-1",
      },
    })).post("/api/weekly-review-fixtures/northstar").send({});

    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("seeds an agy_local Northstar research agent pinned to gemini-3.5-flash", async () => {
    const { db, inserts } = createDbMock();

    const res = await request(app({ enabled: true, db })).post("/api/weekly-review-fixtures/northstar").send({});

    expect(res.status).toBe(201);
    expect(res.body.company).toMatchObject({
      id: expect.any(String),
      name: expect.stringMatching(/^Northstar Labs /),
      issuePrefix: expect.stringMatching(/^NS[A-F0-9]{4}$/),
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);

    const agentInsert = inserts.find((insert) => insert.table === agentsTable);
    expect(agentInsert).toBeDefined();
    const agentRows = Array.isArray(agentInsert?.values) ? agentInsert.values : [];
    expect(agentRows.map((row) => row.adapterType)).not.toContain("gemini_local");
    expect(agentRows).toContainEqual(
      expect.objectContaining({
        name: "Research & Insights Lead",
        adapterType: "agy_local",
        adapterConfig: {
          selectedModel: "gemini-3.5-flash",
          requiredModel: "gemini-3.5-flash",
        },
      }),
    );
  });

  it("seeds fixture follow-up work as blocked so heartbeat will not dispatch it before review generation", async () => {
    const { db, inserts } = createDbMock();

    const res = await request(app({ enabled: true, db })).post("/api/weekly-review-fixtures/northstar").send({});

    expect(res.status).toBe(201);
    const issueInsert = inserts.find((insert) => insert.table === issuesTable);
    expect(issueInsert).toBeDefined();
    const issueRows = Array.isArray(issueInsert?.values) ? issueInsert.values : [];
    expect(issueRows).toContainEqual(
      expect.objectContaining({
        title: "Research brief has unsupported customer-segment claim",
        status: "blocked",
        priority: "high",
      }),
    );
    expect(issueRows).toContainEqual(
      expect.objectContaining({
        title: "Operations runbook is stale before limited pilot",
        status: "blocked",
        priority: "medium",
      }),
    );
  });
});
