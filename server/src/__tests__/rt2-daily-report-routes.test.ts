import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issues,
  projects,
  rt2V33DailyReportCards,
  rt2V33DailyWikiPages,
  rt2V33TaskProfiles,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Fixture = {
  companyId: string;
  projectId: string;
  boardUserId: string;
  taskIssueId: string;
  todoIssueId: string;
};

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 daily report route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 daily report routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let fixture!: Fixture;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-daily-report-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(rt2V33DailyReportCards);
    await db.delete(rt2V33DailyWikiPages);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(companyId: string, actorUserId: string) {
    const routeModule = await vi.importActual<any>("../routes/rt2-daily-report.js");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: actorUserId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", routeModule.rt2DailyReportRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture(): Promise<Fixture> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const boardUserId = "board-user";
    const taskIssueId = randomUUID();
    const todoIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Corp",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Daily Report Project",
      status: "in_progress",
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "owner",
    });

    await db.insert(issues).values({
      id: taskIssueId,
      companyId,
      projectId,
      title: "Launch daily report flow",
      status: "in_progress",
      priority: "medium",
      createdByUserId: boardUserId,
    });

    await db.insert(rt2V33TaskProfiles).values({
      issueId: taskIssueId,
      companyId,
      projectId,
      taskMode: "collab",
      capacity: 1,
    });

    await db.insert(issues).values({
      id: todoIssueId,
      companyId,
      projectId,
      parentId: taskIssueId,
      title: "Seed daily board card",
      status: "done",
      priority: "medium",
      assigneeUserId: boardUserId,
      createdByUserId: boardUserId,
    });

    return {
      companyId,
      projectId,
      boardUserId,
      taskIssueId,
      todoIssueId,
    };
  }

  it("matches the approved M1.4 demo flow from daily board update to wiki answer", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.boardUserId);
    const reportDate = "2026-04-17";

    const boardResponse = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/daily-report`)
      .query({ projectId: fixture.projectId, reportDate });

    expect(boardResponse.status).toBe(200);
    expect(boardResponse.body.cards).toHaveLength(1);
    expect(boardResponse.body.cards[0]).toEqual(
      expect.objectContaining({
        todoIssueId: fixture.todoIssueId,
        taskIssueId: fixture.taskIssueId,
        reportDate,
        lane: "today",
        progressPercent: 100,
        status: "done",
      }),
    );

    const saveResponse = await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        lane: "support_1",
        bucketLabel: "blocked on copy",
        progressPercent: 65,
        note: "Drafted the daily report loop and wired the board read path.",
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toEqual(
      expect.objectContaining({
        card: expect.objectContaining({
          todoIssueId: fixture.todoIssueId,
          lane: "support_1",
          progressPercent: 65,
        }),
        wikiPage: expect.objectContaining({
          projectId: fixture.projectId,
          reportDate,
          history: expect.arrayContaining([expect.objectContaining({ todoIssueId: fixture.todoIssueId })]),
        }),
      }),
    );

    const [cardRow] = await db
      .select()
      .from(rt2V33DailyReportCards)
      .where(eq(rt2V33DailyReportCards.todoIssueId, fixture.todoIssueId));

    expect(cardRow).toEqual(
      expect.objectContaining({
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        userId: fixture.boardUserId,
        reportDate,
        lane: "support_1",
        bucketLabel: "blocked on copy",
        progressPercent: 65,
        note: "Drafted the daily report loop and wired the board read path.",
      }),
    );

    const [activityRow] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityType, "rt2_daily_report"));

    expect(activityRow).toEqual(
      expect.objectContaining({
        companyId: fixture.companyId,
        entityId: expect.stringContaining(fixture.projectId),
        action: expect.any(String),
      }),
    );

    const boardAfterSave = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/daily-report`)
      .query({ projectId: fixture.projectId, reportDate });

    expect(boardAfterSave.body.cards[0]).toEqual(
      expect.objectContaining({
        todoIssueId: fixture.todoIssueId,
        lane: "support_1",
        bucketLabel: "blocked on copy",
        progressPercent: 65,
        note: "Drafted the daily report loop and wired the board read path.",
      }),
    );

    const secondSaveResponse = await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        lane: "support_2",
        bucketLabel: "waiting on review",
        progressPercent: 90,
        note: "Refreshed the report after the first pass and updated the summary.",
      });

    expect(secondSaveResponse.status).toBe(200);
    expect(secondSaveResponse.body).toEqual(
      expect.objectContaining({
        card: expect.objectContaining({
          todoIssueId: fixture.todoIssueId,
          lane: "support_2",
          progressPercent: 90,
          note: "Refreshed the report after the first pass and updated the summary.",
        }),
        wikiPage: expect.objectContaining({
          history: expect.arrayContaining([
            expect.objectContaining({
              todoIssueId: fixture.todoIssueId,
              lane: "support_2",
              progressPercent: 90,
            }),
          ]),
        }),
      }),
    );

    const wikiResponse = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/daily-wiki`)
      .query({ projectId: fixture.projectId, reportDate });

    expect(wikiResponse.status).toBe(200);
    expect(wikiResponse.body).toEqual(
      expect.objectContaining({
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        reportDate,
        shortSummary: expect.arrayContaining([expect.any(String)]),
      }),
    );
    expect(wikiResponse.body.history).toHaveLength(2);
    expect(wikiResponse.body.history[1]).toEqual(
      expect.objectContaining({
        todoIssueId: fixture.todoIssueId,
        lane: "support_2",
        progressPercent: 90,
        evidenceTag: "EXTRACTED",
      }),
    );
    expect(wikiResponse.body.shortSummary).toEqual(
      expect.arrayContaining([
        expect.stringContaining("support_2"),
        expect.stringContaining("90%"),
        expect.stringContaining("Refreshed the report after the first pass"),
      ]),
    );

    const queryResponse = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/daily-wiki/query`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        question: "오늘 뭐 했지?",
      });

    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body).toEqual(
      expect.objectContaining({
        question: "오늘 뭐 했지?",
        answerLines: expect.arrayContaining([expect.any(String)]),
      }),
    );
    expect(queryResponse.body.evidence).toHaveLength(2);
    expect(queryResponse.body.evidence[1]).toEqual(
      expect.objectContaining({
        todoIssueId: fixture.todoIssueId,
        lane: "support_2",
        progressPercent: 90,
        evidenceTag: "EXTRACTED",
      }),
    );
    expect(queryResponse.body.answerLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("support_2"),
        expect.stringContaining("90%"),
        expect.stringContaining("Refreshed the report after the first pass"),
      ]),
    );
  });
});
