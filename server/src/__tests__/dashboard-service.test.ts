import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
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
    await db.delete(issueComments);
    await db.delete(issues);
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

  it("counts override comments and surfaces reasons in the same 30-day window", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "OverrideCo",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "OtherCo",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Ship the feature",
        identifier: "OVR-1",
        status: "done",
      },
      {
        id: otherIssueId,
        companyId: otherCompanyId,
        title: "Other company issue",
        identifier: "OTH-1",
        status: "done",
      },
    ]);

    const recentDate = utcDay(-5);
    const oldDate = utcDay(-35);

    await db.insert(issueComments).values([
      // Recent override comment — must appear in results
      {
        id: randomUUID(),
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "user-1",
        body: "Shipping anyway — deadline is tomorrow",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: { outcomeOverride: true, actorUserId: "user-1" } as any,
        createdAt: recentDate,
      },
      // Older than 30 days — must NOT be counted
      {
        id: randomUUID(),
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "user-1",
        body: "Old override, should not count",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: { outcomeOverride: true, actorUserId: "user-1" } as any,
        createdAt: oldDate,
      },
      // Non-override comment — must not be counted
      {
        id: randomUUID(),
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "user-1",
        body: "Just a regular comment",
        createdAt: recentDate,
      },
      // Different company override — must not leak into companyId results
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        issueId: otherIssueId,
        authorType: "user",
        authorUserId: "user-2",
        body: "Other company override",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: { outcomeOverride: true, actorUserId: "user-2" } as any,
        createdAt: recentDate,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.outcomeOverrides.last30Days).toBe(1);
    expect(summary.outcomeOverrides.recentReasons).toHaveLength(1);
    expect(summary.outcomeOverrides.recentReasons[0]).toMatchObject({
      issueIdentifier: "OVR-1",
      issueTitle: "Ship the feature",
      reason: "Shipping anyway — deadline is tomorrow",
    });
  });
});
