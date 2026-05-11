import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, approvals, companies, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
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
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
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

  it("counts only dashboard-visible issues in task totals", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();

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

    await db.insert(issues).values([
      {
        companyId,
        title: "Visible backlog issue",
        status: "backlog",
        originKind: "manual",
      },
      {
        companyId,
        title: "Visible blocked issue",
        status: "blocked",
        originKind: "manual",
      },
      {
        companyId,
        title: "Visible done issue",
        status: "done",
        originKind: "manual",
      },
      {
        companyId,
        title: "Hidden todo issue",
        status: "todo",
        originKind: "manual",
        hiddenAt: new Date(),
      },
      {
        companyId,
        title: "Plugin operation issue",
        status: "in_progress",
        originKind: "plugin:acpx:operation",
      },
      {
        companyId: otherCompanyId,
        title: "Other company issue",
        status: "blocked",
        originKind: "manual",
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.tasks).toEqual({
      open: 2,
      inProgress: 0,
      blocked: 1,
      done: 1,
    });
  });

  it("surfaces pending approvals and issue interactions for board attention", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const hiddenIssueId = randomUUID();

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

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Choose launch path",
        status: "in_review",
        originKind: "manual",
        identifier: "PAP-101",
      },
      {
        id: hiddenIssueId,
        companyId,
        title: "Hidden question",
        status: "in_review",
        originKind: "manual",
        hiddenAt: new Date(),
      },
    ]);

    await db.insert(approvals).values([
      {
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "pending",
        payload: {
          title: "Approve customer reply",
          summary: "Agent wants approval before sending the note.",
          recommendedAction: "Approve if the tone is right.",
        },
      },
      {
        companyId,
        type: "request_board_approval",
        status: "approved",
        payload: { title: "Already handled" },
      },
      {
        companyId: otherCompanyId,
        type: "request_board_approval",
        status: "pending",
        payload: { title: "Other company" },
      },
    ]);

    await db.insert(issueThreadInteractions).values([
      {
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        title: "Pick the launch scope",
        summary: "Needs board input before continuing.",
        createdByAgentId: agentId,
        payload: {
          version: 1,
          questions: [{
            id: "scope",
            prompt: "Which launch scope should we use?",
            selectionMode: "single",
            required: true,
            options: [{ id: "small", label: "Small" }],
          }],
        },
      },
      {
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        payload: { version: 1, prompt: "Already answered" },
      },
      {
        companyId,
        issueId: hiddenIssueId,
        kind: "ask_user_questions",
        status: "pending",
        payload: {
          version: 1,
          questions: [{
            id: "hidden",
            prompt: "Hidden?",
            selectionMode: "single",
            options: [{ id: "yes", label: "Yes" }],
          }],
        },
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.pendingApprovals).toBe(1);
    expect(summary.attention.total).toBe(2);
    expect(summary.attention.approvals).toEqual([
      expect.objectContaining({
        type: "request_board_approval",
        title: "Approve customer reply",
        summary: "Agent wants approval before sending the note.",
        requestedByAgentId: agentId,
      }),
    ]);
    expect(summary.attention.interactions).toEqual([
      expect.objectContaining({
        interactionKind: "ask_user_questions",
        title: "Pick the launch scope",
        summary: "Needs board input before continuing.",
        issueIdentifier: "PAP-101",
        issueTitle: "Choose launch path",
        createdByAgentId: agentId,
      }),
    ]);
  });
});
