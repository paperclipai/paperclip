import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";

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

function utcDate(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
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

  it("aggregates token usage for all agents and one selected agent in daily range", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const now = utcDate(2026, 5, 15, 12, 0);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent A",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Agent B",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 15, 8, 0),
        usageJson: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 14, 22, 0),
        usageJson: { input_tokens: 50, output_tokens: 15, cached_input_tokens: 10 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId: agentBId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: utcDate(2026, 5, 15, 5, 0),
        usageJson: { inputTokens: 200, outputTokens: 40, cache_read_input_tokens: 30 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 15, 9, 0),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 1, 9, 0),
        usageJson: { inputTokens: 999, outputTokens: 0, cachedInputTokens: 0 },
      },
    ]);

    const allUsage = await dashboardService(db).tokenUsage(companyId, { range: "daily", now });
    const agentUsage = await dashboardService(db).tokenUsage(companyId, { range: "daily", agentId: agentAId, now });

    expect(allUsage.scope).toMatchObject({ type: "all_agents", agentId: null, agentName: null, label: "All agents" });
    expect(allUsage.buckets).toHaveLength(7);
    expect(allUsage.totals).toMatchObject({
      inputTokens: 350,
      cachedInputTokens: 45,
      outputTokens: 75,
      totalTokens: 470,
      runCount: 3,
    });
    expect(allUsage.buckets.find((bucket) => bucket.key === "2026-05-15")).toMatchObject({
      totalTokens: 395,
      runCount: 2,
    });
    expect(allUsage.buckets.find((bucket) => bucket.key === "2026-05-14")).toMatchObject({
      totalTokens: 75,
      runCount: 1,
    });

    expect(agentUsage.scope).toMatchObject({ type: "single_agent", agentId: agentAId, agentName: "Agent A", label: "Agent A" });
    expect(agentUsage.totals).toMatchObject({
      inputTokens: 150,
      cachedInputTokens: 15,
      outputTokens: 35,
      totalTokens: 200,
      runCount: 2,
    });
    expect(agentUsage.buckets.find((bucket) => bucket.key === "2026-05-15")).toMatchObject({
      totalTokens: 125,
      runCount: 1,
    });
  });

  it("uses stable weekly and monthly UTC boundaries for token usage buckets", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = utcDate(2026, 5, 15, 12, 0);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Weekly Agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 10, 23, 59),
        usageJson: { inputTokens: 11 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 5, 11, 0, 1),
        usageJson: { inputTokens: 22 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2025, 12, 31, 12, 0),
        usageJson: { inputTokens: 33 },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDate(2026, 1, 1, 12, 0),
        usageJson: { inputTokens: 44 },
      },
    ]);

    const weekly = await dashboardService(db).tokenUsage(companyId, { range: "weekly", now });
    const monthly = await dashboardService(db).tokenUsage(companyId, { range: "monthly", now });

    expect(weekly.buckets).toHaveLength(8);
    expect(weekly.buckets.find((bucket) => bucket.key === "2026-05-04")).toMatchObject({
      totalTokens: 11,
      runCount: 1,
      label: "05/04-05/10",
    });
    expect(weekly.buckets.find((bucket) => bucket.key === "2026-05-11")).toMatchObject({
      totalTokens: 22,
      runCount: 1,
      label: "05/11-05/15",
    });

    expect(monthly.buckets).toHaveLength(6);
    expect(monthly.buckets.find((bucket) => bucket.key === "2025-12-01")).toMatchObject({
      totalTokens: 33,
      runCount: 1,
      label: "2025/12",
    });
    expect(monthly.buckets.find((bucket) => bucket.key === "2026-01-01")).toMatchObject({
      totalTokens: 44,
      runCount: 1,
      label: "2026/01",
    });
    expect(monthly.buckets.find((bucket) => bucket.key === "2026-05-01")).toMatchObject({
      totalTokens: 33,
      runCount: 2,
      label: "2026/05",
    });
  });
});
