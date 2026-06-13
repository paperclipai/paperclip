import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.js";

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
    // cost_events / heartbeat_runs / issues FK-reference agents + companies,
    // so delete children before parents to avoid FK violations.
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function agentRow(companyId: string, id: string, name: string, status = "active") {
    return {
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

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

  // ----- agentScorecards attribution coverage (BLO-10275 review findings) -----

  it("credits the implementer (returnAssignee), not the reviewer it was reassigned to", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const worker = randomUUID();
    const reviewer = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, worker, "Worker"),
      agentRow(companyId, reviewer, "Reviewer"),
    ]);

    const completedAt = utcDay(-1);
    const evaluatedAt = utcDay(-1).toISOString();

    // Issue implemented by `worker`, reassigned to `reviewer` for approval,
    // now `done` and still assigned to the reviewer (the mutable-assignee
    // trap). executionState.returnAssignee preserves the real implementer.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Reviewed feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: reviewer,
      executionState: { returnAssignee: { type: "agent", agentId: worker, userId: null } },
      completedAt,
      createdAt: completedAt,
      updatedAt: completedAt,
      lastActivityAt: completedAt,
      lastEvidenceVerdict: {
        verdict: "pass",
        missing: [],
        evidenceFound: ["pr"],
        unlabeledFallback: false,
        evaluatedAt,
      },
      lastEvidenceVerdictEvaluatedAt: new Date(evaluatedAt),
    });

    // Cost for the work is recorded against the worker (cost_events.agent_id).
    await db.insert(costEvents).values({
      id: randomUUID(),
      companyId,
      agentId: worker,
      provider: "anthropic",
      model: "claude",
      costCents: 1000,
      occurredAt: completedAt,
    });

    const result = await dashboardService(db).agentScorecards(companyId);
    const byId = new Map(result.agents.map((a) => [a.agentId, a]));
    const w = byId.get(worker)!;
    const r = byId.get(reviewer)!;

    // Implementer gets the done + review + cost/done credit.
    expect(w.doneIssues).toBe(1);
    expect(w.reviewedIssues).toBe(1);
    expect(w.passedReviews).toBe(1);
    expect(w.reviewPassRate).toBe(1);
    expect(w.costUsd).toBe(10);
    expect(w.costPerDoneIssue).toBe(10);

    // Reviewer is NOT credited for work it only reviewed.
    expect(r.doneIssues).toBe(0);
    expect(r.reviewedIssues).toBe(0);
    expect(r.costPerDoneIssue).toBeNull();
  });

  it("falls back to the current assignee for issues with no execution policy", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const solo = randomUUID();
    await db.insert(agents).values([agentRow(companyId, solo, "Solo")]);
    const completedAt = utcDay(-1);

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Direct issue",
      status: "done",
      priority: "medium",
      assigneeAgentId: solo,
      // executionState null — the issue never entered a review stage.
      completedAt,
      createdAt: completedAt,
      updatedAt: completedAt,
      lastActivityAt: completedAt,
    });

    const result = await dashboardService(db).agentScorecards(companyId);
    const s = result.agents.find((a) => a.agentId === solo)!;
    expect(s.doneIssues).toBe(1);
  });

  it("counts only terminal heartbeat runs windowed on started_at, not created_at", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values([agentRow(companyId, agentId, "Runner")]);

    const inWindow = utcDay(-2);
    const outOfWindow = utcDay(-60); // default scorecard window is 30 days
    const run = (status: string, startedAt: Date | null) => ({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status,
      startedAt,
      // created_at is INSIDE the window for every row — including the run
      // whose started_at is out of window — so a created_at filter would
      // wrongly count it. This pins the started_at fix.
      createdAt: inWindow,
    });

    await db.insert(heartbeatRuns).values([
      run("succeeded", inWindow),
      run("succeeded", inWindow),
      run("failed", inWindow),
      run("timed_out", inWindow),
      run("cancelled", inWindow),
      run("running", inWindow), // non-terminal → excluded in SQL
      run("queued", null), // non-terminal, never started → excluded
      run("succeeded", outOfWindow), // terminal but before window → excluded
    ]);

    const result = await dashboardService(db).agentScorecards(companyId);
    const a = result.agents.find((x) => x.agentId === agentId)!;

    // 2 succeeded + 1 failed + 1 timed_out in window. cancelled excluded from
    // completedRuns; running / queued / out-of-window all excluded entirely.
    expect(a.completedRuns).toBe(4);
    expect(a.failedRuns).toBe(2); // failed + timed_out
    expect(a.cancelledRuns).toBe(1);
    expect(a.failureRate).toBe(0.5); // 2 / 4
  });

  it("uses the materialized verdict timestamp index for review scorecards", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const agentId = randomUUID();
    await db.insert(agents).values([agentRow(companyId, agentId, "Reviewer")]);
    const inWindow = utcDay(-2);
    const outOfWindow = utcDay(-60);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Recent evidence",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
        createdAt: inWindow,
        updatedAt: inWindow,
        lastActivityAt: inWindow,
        lastEvidenceVerdict: {
          verdict: "pass",
          missing: [],
          evidenceFound: ["test-output"],
          unlabeledFallback: false,
          evaluatedAt: inWindow.toISOString(),
        },
        lastEvidenceVerdictEvaluatedAt: inWindow,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Old evidence",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
        createdAt: outOfWindow,
        updatedAt: outOfWindow,
        lastActivityAt: outOfWindow,
        lastEvidenceVerdict: {
          verdict: "block",
          missing: ["test-output"],
          evidenceFound: [],
          unlabeledFallback: false,
          evaluatedAt: outOfWindow.toISOString(),
        },
        lastEvidenceVerdictEvaluatedAt: outOfWindow,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Malformed legacy evidence timestamp",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
        createdAt: inWindow,
        updatedAt: inWindow,
        lastActivityAt: inWindow,
        lastEvidenceVerdict: {
          verdict: "warn",
          missing: [],
          evidenceFound: [],
          unlabeledFallback: true,
          evaluatedAt: "not-a-date",
        },
        lastEvidenceVerdictEvaluatedAt: null,
      },
    ]);

    const result = await dashboardService(db).agentScorecards(companyId);
    const scorecard = result.agents.find((x) => x.agentId === agentId)!;
    expect(scorecard.reviewedIssues).toBe(1);
    expect(scorecard.passedReviews).toBe(1);
    expect(scorecard.reviewPassRate).toBe(1);

    await db.execute(sql.raw("SET enable_seqscan = off"));
    const planRows = await db.execute(sql`
      EXPLAIN SELECT count(*)
      FROM issues
      WHERE company_id = ${companyId}
        AND last_evidence_verdict IS NOT NULL
        AND last_evidence_verdict_evaluated_at >= ${result.windowStart}::timestamp with time zone
    `);
    await db.execute(sql.raw("SET enable_seqscan = on"));
    const plan = planRows.map((row) => String((row as { "QUERY PLAN": unknown })["QUERY PLAN"])).join("\n");
    expect(plan).toContain("issues_company_evidence_verdict_evaluated_idx");
  });
});
