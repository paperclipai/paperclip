import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";
import { dashboardRoutes } from "../routes/dashboard.ts";
import { errorHandler } from "../middleware/error-handler.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      other: 0,
      total: 105,
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      other: 1,
      total: 3,
    });
  });

  it("resolves company issue prefixes and returns issue activity from backend aggregation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const today = utcDay(0);
    const yesterday = utcDay(-1);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "HA Santeny",
        issuePrefix: "HAS",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        identifier: "HAS-1",
        title: "Critical blocker",
        status: "blocked",
        priority: "critical",
        createdAt: today,
        updatedAt: today,
      },
      {
        id: randomUUID(),
        companyId,
        identifier: "HAS-2",
        title: "Review work",
        status: "in_review",
        priority: "high",
        createdAt: yesterday,
        updatedAt: yesterday,
      },
      {
        id: randomUUID(),
        companyId,
        identifier: "HAS-hidden",
        title: "Hidden work",
        status: "todo",
        priority: "medium",
        hiddenAt: today,
        createdAt: today,
        updatedAt: today,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        identifier: "OTH-1",
        title: "Other tenant work",
        status: "blocked",
        priority: "critical",
        createdAt: today,
        updatedAt: today,
      },
    ]);

    const summary = await dashboardService(db).summary("has");

    expect(summary.companyId).toBe(companyId);
    expect(summary.sourceStatus).toBe("complete");
    expect(summary.partialErrors).toEqual([]);
    expect(new Date(summary.generatedAt).toString()).not.toBe("Invalid Date");
    expect(summary.tasks).toMatchObject({ open: 2, blocked: 1, done: 0 });
    expect(summary.recentIssues.map((issue) => issue.identifier)).toEqual(["HAS-1", "HAS-2"]);

    const todayBucket = summary.issueActivity.find((bucket) => bucket.date === utcDateKey(today));
    const yesterdayBucket = summary.issueActivity.find((bucket) => bucket.date === utcDateKey(yesterday));

    expect(todayBucket).toMatchObject({
      byPriority: { critical: 1, high: 0, medium: 0, low: 0 },
      byStatus: { blocked: 1 },
      total: 1,
    });
    expect(yesterdayBucket).toMatchObject({
      byPriority: { critical: 0, high: 1, medium: 0, low: 0 },
      byStatus: { in_review: 1 },
      total: 1,
    });
  });

  it("serves dashboard routes by company prefix without leaking a UUID parse failure", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "HA Santeny",
      issuePrefix: "HAS",
      requireBoardApprovalForNewAgents: false,
    });

    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "board",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/HAS/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.sourceStatus).toBe("complete");
  });
});
