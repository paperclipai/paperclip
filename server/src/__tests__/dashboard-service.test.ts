import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
  });

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

  // ----- issueActivity / recentIssues coverage -----

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("excludes hidden issues from issueActivity and recentIssues", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const today = utcDay(0);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Visible",
        status: "todo",
        priority: "high",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Hidden — should be excluded",
        status: "todo",
        priority: "critical",
        hiddenAt: today,
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.recentIssues).toHaveLength(1);
    expect(summary.recentIssues[0]?.title).toBe("Visible");

    const todayBucket = summary.issueActivity.find((d) => d.date === utcDateKey(today));
    expect(todayBucket?.total).toBe(1);
    expect(todayBucket?.byPriority.high).toBe(1);
    expect(todayBucket?.byPriority.critical).toBe(0); // hidden didn't leak in
    expect(todayBucket?.byStatus.todo).toBe(1);
  });

  it("derives total from byPriority sum (does not double-count byStatus)", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const today = utcDay(0);

    // 3 issues, same day, distinct priorities AND statuses. If status loop
    // accidentally adds to total, we'd see total=6 instead of total=3.
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "A",
        status: "todo",
        priority: "critical",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
      {
        id: randomUUID(),
        companyId,
        title: "B",
        status: "in_progress",
        priority: "high",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
      {
        id: randomUUID(),
        companyId,
        title: "C",
        status: "blocked",
        priority: "low",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    const bucket = summary.issueActivity.find((d) => d.date === utcDateKey(today));

    expect(bucket?.total).toBe(3);
    expect(Object.values(bucket?.byPriority ?? {}).reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.values(bucket?.byStatus ?? {}).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("buckets issueActivity by UTC createdAt day", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);

    // Insert at 23:59 UTC on a day; should bucket into that day, not the next.
    const now = new Date();
    const lateUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 0));
    const earlyNext = new Date(lateUtc.getTime() + 60 * 60 * 1000); // 00:59 UTC next day

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Late today (UTC)",
        status: "todo",
        priority: "medium",
        createdAt: lateUtc,
        updatedAt: lateUtc,
        lastActivityAt: lateUtc,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Early tomorrow (UTC)",
        status: "todo",
        priority: "medium",
        createdAt: earlyNext,
        updatedAt: earlyNext,
        lastActivityAt: earlyNext,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    const todayBucket = summary.issueActivity.find((d) => d.date === utcDateKey(lateUtc));
    expect(todayBucket?.total).toBe(1);
    // Note: we don't assert on the next-day bucket because it may be outside
    // the 14-day window depending on host clock. The point is that 23:59 UTC
    // and 00:59 UTC next day land in DIFFERENT buckets, not same.
    expect(todayBucket?.byPriority.medium).toBe(1);
  });

  it("orders recentIssues by lastActivityAt DESC and caps at 50", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);

    const newest = utcDay(0);
    const middle = utcDay(-3);
    const oldest = utcDay(-10);

    // Build 60 issues with lastActivityAt distributed so we can pin
    // ordering AND verify the limit-50 cap.
    const rows = Array.from({ length: 60 }, (_, i) => {
      // First 5 are "newest", next 5 "middle", rest "oldest". Within each
      // group, vary lastActivityAt by milliseconds so order is deterministic.
      const baseDate = i < 5 ? newest : i < 10 ? middle : oldest;
      const offsetMs = i; // smaller index = more recent within group
      const t = new Date(baseDate.getTime() - offsetMs * 1000);
      return {
        id: randomUUID(),
        companyId,
        title: `issue-${i}`,
        status: "todo" as const,
        priority: "medium" as const,
        createdAt: t,
        updatedAt: t,
        lastActivityAt: t,
      };
    });
    await db.insert(issues).values(rows);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.recentIssues).toHaveLength(50);
    // The newest 5 should appear first.
    expect(summary.recentIssues.slice(0, 5).every((i) => i.title.match(/^issue-[0-4]$/))).toBe(true);
    // The list should be in lastActivityAt DESC order.
    for (let i = 1; i < summary.recentIssues.length; i++) {
      expect(new Date(summary.recentIssues[i - 1].lastActivityAt).getTime())
        .toBeGreaterThanOrEqual(new Date(summary.recentIssues[i].lastActivityAt).getTime());
    }
  });

  it("does not leak issues across companies in issueActivity or recentIssues", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await seedCompany(companyId);
    await seedCompany(otherCompanyId);
    const today = utcDay(0);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "ours",
        status: "todo",
        priority: "high",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        title: "theirs",
        status: "todo",
        priority: "critical",
        createdAt: today,
        updatedAt: today,
        lastActivityAt: today,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    expect(summary.recentIssues.map((i) => i.title)).toEqual(["ours"]);
    const todayBucket = summary.issueActivity.find((d) => d.date === utcDateKey(today));
    expect(todayBucket?.total).toBe(1);
    expect(todayBucket?.byPriority.high).toBe(1);
    expect(todayBucket?.byPriority.critical).toBe(0);
  });

  it("core() omits issueActivity and recentIssues — sidebar-badges path doesn't pay for them", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);

    const result = await dashboardService(db).core(companyId);
    expect(result).not.toHaveProperty("issueActivity");
    expect(result).not.toHaveProperty("recentIssues");
    // But still has the agent / cost fields sidebar-badges consumes.
    expect(result.agents).toMatchObject({ active: 0, running: 0, paused: 0, error: 0 });
    expect(result.costs.monthBudgetCents).toBeDefined();
  });
});
