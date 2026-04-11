import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyKpis,
  companyMemberships,
  costEvents,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  instanceSettings,
  issues,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { executiveSummaryService } from "../services/executive-summary.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping executive summary service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function clearSmtpEnv() {
  delete process.env.PAPERCLIP_SMTP_HOST;
  delete process.env.PAPERCLIP_SMTP_PORT;
  delete process.env.PAPERCLIP_SMTP_SECURE;
  delete process.env.PAPERCLIP_SMTP_USER;
  delete process.env.PAPERCLIP_SMTP_PASS;
  delete process.env.PAPERCLIP_SMTP_FROM;
  delete process.env.PAPERCLIP_SMTP_REPLY_TO;
}

describeEmbeddedPostgres("executiveSummaryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-executive-summary-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companyKpis);
    await db.delete(companyMemberships);
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
    clearSmtpEnv();
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 45_000);

  async function createCompany(params: { enabled?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Co",
      issuePrefix: `ES${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      dailyExecutiveSummaryEnabled: params.enabled ?? false,
    });
    return companyId;
  }

  async function addMember(
    companyId: string,
    email: string,
    params: { status?: string; principalType?: "user" | "agent" } = {},
  ) {
    const principalType = params.principalType ?? "user";
    const principalId = principalType === "user" ? `user-${randomUUID()}` : `agent-${randomUUID()}`;
    const now = new Date();
    if (principalType === "user") {
      await db.insert(authUsers).values({
        id: principalId,
        name: principalId,
        email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    await db.insert(companyMemberships).values({
      companyId,
      principalType,
      principalId,
      status: params.status ?? "active",
      membershipRole: "owner",
    });
  }

  function localDate(year: number, monthZeroIndexed: number, day: number, hour: number, minute: number) {
    return new Date(year, monthZeroIndexed, day, hour, minute, 0, 0);
  }

  it("replaces KPIs atomically and preserves stable manual KPI ordering", async () => {
    const companyId = await createCompany();
    const service = executiveSummaryService(db);

    await service.replaceKpis(
      companyId,
      [
        { label: "MRR", value: "$120k", trend: "up", note: "strong upsell quarter" },
        { label: "Net churn", value: "1.2%", trend: "down", note: null },
      ],
      { userId: null, agentId: null },
    );

    const listed = await service.listKpis(companyId);
    expect(listed.map((row) => row.label)).toEqual(["MRR", "Net churn"]);
    expect(listed.map((row) => row.position)).toEqual([0, 1]);

    const summary = await service.buildExecutiveSummary(companyId, new Date("2026-04-11T08:00:00.000Z"));
    expect(summary.manualKpis.map((row) => row.label)).toEqual(["MRR", "Net churn"]);
    expect(summary.manualKpis.map((row) => row.position)).toEqual([0, 1]);
  });

  it("deduplicates recipients case-insensitively and ignores ineligible memberships", async () => {
    const companyId = await createCompany();
    await addMember(companyId, "Exec@paperclip.dev");
    await addMember(companyId, "exec@paperclip.dev");
    await addMember(companyId, "board@paperclip.dev");
    await addMember(companyId, "   ");
    await addMember(companyId, "inactive@paperclip.dev", { status: "invited" });
    await addMember(companyId, "agent@paperclip.dev", { principalType: "agent" });

    const service = executiveSummaryService(db);
    const summary = await service.buildExecutiveSummary(companyId, new Date("2026-04-11T08:00:00.000Z"));

    expect(summary.dispatch.recipients.map((email) => email.toLowerCase()).sort()).toEqual([
      "board@paperclip.dev",
      "exec@paperclip.dev",
    ]);
  });

  it("enforces configured due time and once-per-day idempotency for skipped sends", async () => {
    const companyId = await createCompany({ enabled: true });
    await instanceSettingsService(db).updateGeneral({
      dailyExecutiveSummarySendHour: 8,
      dailyExecutiveSummarySendMinute: 0,
    });

    const service = executiveSummaryService(db);

    const beforeDue = await service.tickDaily(localDate(2026, 3, 11, 7, 59));
    expect(beforeDue).toMatchObject({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });

    const firstDueTick = await service.tickDaily(localDate(2026, 3, 11, 8, 5));
    expect(firstDueTick).toMatchObject({
      processed: 1,
      skipped: 1,
      sent: 0,
      failed: 0,
      alreadyDone: 0,
    });

    const companyAfterFirstTick = await db
      .select({
        lastStatus: companies.dailyExecutiveSummaryLastStatus,
        lastError: companies.dailyExecutiveSummaryLastError,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    expect(companyAfterFirstTick?.lastStatus).toBe("skipped");
    expect(companyAfterFirstTick?.lastError).toContain("No eligible recipient emails");

    const secondDueTick = await service.tickDaily(localDate(2026, 3, 11, 9, 5));
    expect(secondDueTick).toMatchObject({
      processed: 1,
      alreadyDone: 1,
      skipped: 0,
      sent: 0,
      failed: 0,
    });

    const skipEvents = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "executive_summary.skipped_no_recipients"));
    expect(skipEvents).toHaveLength(1);
  });

  it("marks failed status and logs activity when SMTP dispatch fails", async () => {
    process.env.PAPERCLIP_SMTP_HOST = "127.0.0.1";
    process.env.PAPERCLIP_SMTP_PORT = "1";
    process.env.PAPERCLIP_SMTP_SECURE = "false";
    process.env.PAPERCLIP_SMTP_FROM = "paperclip-test@example.com";

    const companyId = await createCompany({ enabled: true });
    await addMember(companyId, "board@paperclip.dev");
    await instanceSettingsService(db).updateGeneral({
      dailyExecutiveSummarySendHour: 8,
      dailyExecutiveSummarySendMinute: 0,
    });

    const service = executiveSummaryService(db);
    const result = await service.tickDaily(new Date("2026-04-11T08:10:00.000Z"));
    expect(result).toMatchObject({
      processed: 1,
      failed: 1,
      sent: 0,
      skipped: 0,
    });

    const companyAfterTick = await db
      .select({
        lastStatus: companies.dailyExecutiveSummaryLastStatus,
        lastError: companies.dailyExecutiveSummaryLastError,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    expect(companyAfterTick?.lastStatus).toBe("failed");
    expect(typeof companyAfterTick?.lastError).toBe("string");
    expect((companyAfterTick?.lastError ?? "").length).toBeGreaterThan(0);

    const failedEvents = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "executive_summary.failed"));
    expect(failedEvents).toHaveLength(1);
  }, 20_000);

  it("ignores non-uuid issue activity entity ids while building top transitions", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-04-11T08:00:00.000Z");
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship dashboard",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "board-user",
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: "PAP-1234",
        details: {
          status: "done",
          _previous: { status: "in_progress" },
        },
        createdAt: new Date("2026-04-11T07:30:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: {
          status: "blocked",
          _previous: { status: "todo" },
        },
        createdAt: new Date("2026-04-11T07:40:00.000Z"),
      },
    ]);

    const service = executiveSummaryService(db);
    const summary = await service.buildExecutiveSummary(companyId, now);

    expect(summary.topChanges.issueTransitions).toHaveLength(2);
    expect(summary.topChanges.issueTransitions[0]?.issueId).toBe(issueId);
    expect(summary.topChanges.issueTransitions[0]?.issueTitle).toBe("Ship dashboard");
    expect(summary.topChanges.issueTransitions[1]?.issueId).toBe("PAP-1234");
    expect(summary.topChanges.issueTransitions[1]?.issueTitle).toBe("PAP-1234");
  });
});
