import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { scorecardService } from "../services/scorecard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scorecard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function daysAgo(now: Date, days: number): Date {
  return hoursAgo(now, days * 24);
}

async function seedCompany(db: ReturnType<typeof createDb>, suffix: string) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `Scorecard ${suffix}`,
    issuePrefix: `SC${suffix.slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

async function seedAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  status: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(agents).values({
    id,
    companyId,
    name: `agent-${status}-${id.slice(0, 4)}`,
    role: "engineer",
    status,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return id;
}

describeEmbeddedPostgres("scorecard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scorecard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates issue counters by status and 7-day done window", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "issues");
    await db.insert(issues).values([
      { companyId, title: "t1", status: "todo" },
      { companyId, title: "t2", status: "todo" },
      { companyId, title: "ip1", status: "in_progress" },
      { companyId, title: "ir1", status: "in_review" },
      { companyId, title: "ir2", status: "in_review" },
      { companyId, title: "ir3", status: "in_review" },
      { companyId, title: "b1", status: "blocked" },
      { companyId, title: "d-recent", status: "done", completedAt: daysAgo(now, 2) },
      { companyId, title: "d-old", status: "done", completedAt: daysAgo(now, 30) },
      { companyId, title: "backlog-ignored", status: "backlog" },
      { companyId, title: "cancelled-ignored", status: "cancelled" },
    ]);

    const card = await scorecardService(db).get(companyId, now);

    expect(card.counters.issues).toEqual({
      todo: 2,
      inProgress: 1,
      inReview: 3,
      blocked: 1,
      done7d: 1,
    });
  });

  it("buckets agents into active/idle/paused with running→active and error→paused", async () => {
    const companyId = await seedCompany(db, "agents");
    await Promise.all([
      seedAgent(db, companyId, "active"),
      seedAgent(db, companyId, "running"),
      seedAgent(db, companyId, "running"),
      seedAgent(db, companyId, "idle"),
      seedAgent(db, companyId, "paused"),
      seedAgent(db, companyId, "error"),
    ]);

    const card = await scorecardService(db).get(companyId);

    expect(card.counters.agents).toEqual({ active: 3, idle: 1, paused: 2 });
  });

  it("counts runs in the last 24h grouped by succeeded/failed/other", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "runs");
    const agentId = await seedAgent(db, companyId, "active");
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", createdAt: hoursAgo(now, 1) },
      { companyId, agentId, status: "succeeded", createdAt: hoursAgo(now, 3) },
      { companyId, agentId, status: "failed", createdAt: hoursAgo(now, 5) },
      { companyId, agentId, status: "timed_out", createdAt: hoursAgo(now, 7) },
      { companyId, agentId, status: "cancelled", createdAt: hoursAgo(now, 9) },
      { companyId, agentId, status: "queued", createdAt: hoursAgo(now, 11) },
      { companyId, agentId, status: "succeeded", createdAt: hoursAgo(now, 30) },
    ]);

    const card = await scorecardService(db).get(companyId, now);

    expect(card.counters.runs24h).toEqual({ succeeded: 2, failed: 2, other: 2 });
  });

  it("classifies attention items by reason and orders by updatedAt desc", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "atten");
    await db.insert(issues).values([
      { companyId, title: "blocked-now", status: "blocked", updatedAt: hoursAgo(now, 2) },
      { companyId, title: "review-old", status: "in_review", updatedAt: hoursAgo(now, 48) },
      { companyId, title: "review-fresh", status: "in_review", updatedAt: hoursAgo(now, 6) },
      { companyId, title: "stalled-todo", status: "todo", updatedAt: daysAgo(now, 10) },
      { companyId, title: "fresh-todo", status: "todo", updatedAt: hoursAgo(now, 3) },
      { companyId, title: "done-ignored", status: "done", updatedAt: daysAgo(now, 30) },
    ]);

    const card = await scorecardService(db).get(companyId, now);

    expect(card.attention.map((a) => [a.title, a.reason])).toEqual([
      ["blocked-now", "blocked"],
      ["review-old", "in_review_waiting"],
      ["stalled-todo", "stalled"],
    ]);
  });

  it("limits attention to 10 items", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "limit");
    await db.insert(issues).values(
      Array.from({ length: 15 }, (_, i) => ({
        companyId,
        title: `blocked-${i}`,
        status: "blocked",
        updatedAt: hoursAgo(now, i),
      })),
    );

    const card = await scorecardService(db).get(companyId, now);
    expect(card.attention).toHaveLength(10);
  });

  it("maps activity_log actions to scorecard activity kinds", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "activ");
    const issueRows = await db
      .insert(issues)
      .values({ companyId, title: "act-issue", status: "todo", identifier: "SC-1" })
      .returning();
    const issueId = issueRows[0]!.id;
    const agentId = await seedAgent(db, companyId, "active");

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        agentId,
        createdAt: hoursAgo(now, 1),
      },
      {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        agentId,
        createdAt: hoursAgo(now, 2),
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "heartbeat.invoked",
        entityType: "heartbeat_run",
        entityId: randomUUID(),
        agentId,
        createdAt: hoursAgo(now, 3),
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: randomUUID(),
        agentId,
        createdAt: hoursAgo(now, 4),
      },
      {
        companyId,
        actorType: "system",
        actorId: "sys",
        action: "board_api_key.created",
        entityType: "api_key",
        entityId: randomUUID(),
        agentId: null,
        createdAt: hoursAgo(now, 5),
      },
    ]);

    const card = await scorecardService(db).get(companyId, now);

    expect(card.activity.map((a) => a.kind)).toEqual([
      "comment",
      "status_change",
      "run_started",
      "run_finished",
    ]);
    expect(card.activity[0]!.issueId).toBe(issueId);
    expect(card.activity[0]!.issueIdentifier).toBe("SC-1");
    expect(card.activity[0]!.agentId).toBe(agentId);
    expect(card.activity[0]!.agentName).toMatch(/^agent-active-/);
  });

  it("derives pulse=red when any issue is blocked", async () => {
    const companyId = await seedCompany(db, "redb");
    await db.insert(issues).values({ companyId, title: "b", status: "blocked" });
    const card = await scorecardService(db).get(companyId);
    expect(card.pulse).toBe("red");
  });

  it("derives pulse=red when a run failed in the last 24h", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "redf");
    const agentId = await seedAgent(db, companyId, "active");
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "failed",
      createdAt: hoursAgo(now, 2),
    });
    const card = await scorecardService(db).get(companyId, now);
    expect(card.pulse).toBe("red");
  });

  it("derives pulse=amber when attention list has 3+ items but nothing is red", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "amber");
    await db.insert(issues).values([
      { companyId, title: "a1", status: "in_review", updatedAt: daysAgo(now, 2) },
      { companyId, title: "a2", status: "in_review", updatedAt: daysAgo(now, 2) },
      { companyId, title: "a3", status: "in_review", updatedAt: daysAgo(now, 2) },
    ]);
    const card = await scorecardService(db).get(companyId, now);
    expect(card.pulse).toBe("amber");
  });

  it("derives pulse=grey when there is no activity or runs", async () => {
    const companyId = await seedCompany(db, "grey");
    const card = await scorecardService(db).get(companyId);
    expect(card.pulse).toBe("grey");
  });

  it("derives pulse=green when healthy with activity", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "green");
    const agentId = await seedAgent(db, companyId, "active");
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      createdAt: hoursAgo(now, 1),
    });
    await db.insert(issues).values({ companyId, title: "ok", status: "in_progress" });
    const card = await scorecardService(db).get(companyId, now);
    expect(card.pulse).toBe("green");
  });

  it("returns companyId and an ISO computedAt timestamp", async () => {
    const companyId = await seedCompany(db, "meta");
    const card = await scorecardService(db).get(companyId);
    expect(card.companyId).toBe(companyId);
    expect(new Date(card.computedAt).toISOString()).toBe(card.computedAt);
  });

  it("scopes all counts to the requested companyId", async () => {
    const now = new Date();
    const companyId = await seedCompany(db, "scopa");
    const otherCompanyId = await seedCompany(db, "scopb");
    await db.insert(issues).values([
      { companyId, title: "mine", status: "blocked" },
      { companyId: otherCompanyId, title: "theirs-1", status: "blocked" },
      { companyId: otherCompanyId, title: "theirs-2", status: "todo" },
    ]);
    const otherAgentId = await seedAgent(db, otherCompanyId, "active");
    await db.insert(heartbeatRuns).values({
      companyId: otherCompanyId,
      agentId: otherAgentId,
      status: "failed",
      createdAt: hoursAgo(now, 1),
    });

    const card = await scorecardService(db).get(companyId, now);
    expect(card.counters.issues.blocked).toBe(1);
    expect(card.counters.issues.todo).toBe(0);
    expect(card.counters.runs24h.failed).toBe(0);
  });
});
