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
  goals,
  issues,
  issueWorkProducts,
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
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(goals);
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
    const missionId = randomUUID();
    const objectiveId = randomUUID();
    const goalId = randomUUID();
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
      goalId,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "owner",
    });

    await db.insert(goals).values([
      {
        id: missionId,
        companyId,
        title: "Build RealTycoon2 operating rhythm",
        level: "mission",
        status: "active",
      },
      {
        id: objectiveId,
        companyId,
        title: "Improve daily operating cadence",
        level: "objective",
        status: "active",
        parentId: missionId,
      },
      {
        id: goalId,
        companyId,
        title: "Ship daily cockpit proof",
        level: "key_result",
        status: "active",
        parentId: objectiveId,
      },
    ]);

    await db.insert(issues).values({
      id: taskIssueId,
      companyId,
      projectId,
      goalId,
      title: "Launch daily report flow",
      status: "in_progress",
      priority: "medium",
      createdByUserId: boardUserId,
    });

    await db.insert(rt2V33TaskProfiles).values({
      issueId: taskIssueId,
      companyId,
      projectId,
      goalId,
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

    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId: todoIssueId,
      type: "document",
      provider: "paperclip",
      title: "Daily report cockpit note",
      status: "draft",
      reviewState: "none",
      summary: "Daily report evidence",
      metadata: {
        rt2Deliverable: true,
        rt2State: "defined",
        rt2Type: "document",
        rt2Owner: "todo",
        rt2Required: true,
        rt2BasePrice: 1000,
      },
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
        lane: "todo",
        progressPercent: 100,
        status: "done",
        deliverableCount: 1,
        basePriceTotal: 1000,
        okrContextStatus: "connected",
      }),
    );
    expect(boardResponse.body.cockpit).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          tasksWorked: 1,
          todosCompleted: 1,
          deliverablesDefined: 1,
          goldImpact: 10,
        }),
        traceRows: expect.arrayContaining([
          expect.objectContaining({
            todoIssueId: fixture.todoIssueId,
            goalPath: expect.arrayContaining([
              expect.objectContaining({ title: "Improve daily operating cadence" }),
              expect.objectContaining({ title: "Ship daily cockpit proof" }),
            ]),
          }),
        ]),
        hierarchyRows: expect.arrayContaining([
          expect.objectContaining({
            todoIssueId: fixture.todoIssueId,
            path: expect.arrayContaining([
              expect.objectContaining({ kind: "mission", title: "Build RealTycoon2 operating rhythm" }),
              expect.objectContaining({ kind: "objective", title: "Improve daily operating cadence" }),
              expect.objectContaining({ kind: "key_result", title: "Ship daily cockpit proof" }),
              expect.objectContaining({ kind: "project", title: "Daily Report Project" }),
              expect.objectContaining({ kind: "task", title: "Launch daily report flow" }),
              expect.objectContaining({ kind: "todo", title: "Seed daily board card" }),
            ]),
            rollup: expect.objectContaining({
              progressPercent: 100,
              deliverableCount: 1,
              goldImpact: 10,
            }),
          }),
        ]),
      }),
    );

    const saveResponse = await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        lane: "doing",
        bucketLabel: "blocked on copy",
        progressPercent: 65,
        note: "Drafted the daily report loop and wired the board read path.",
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toEqual(
      expect.objectContaining({
        card: expect.objectContaining({
          todoIssueId: fixture.todoIssueId,
          lane: "doing",
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
        lane: "doing",
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
        lane: "doing",
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
        lane: "done",
        bucketLabel: "waiting on review",
        progressPercent: 90,
        note: "Refreshed the report after the first pass and updated the summary.",
      });

    expect(secondSaveResponse.status).toBe(200);
    expect(secondSaveResponse.body).toEqual(
      expect.objectContaining({
        card: expect.objectContaining({
          todoIssueId: fixture.todoIssueId,
          lane: "done",
          progressPercent: 90,
          note: "Refreshed the report after the first pass and updated the summary.",
        }),
        wikiPage: expect.objectContaining({
          history: expect.arrayContaining([
            expect.objectContaining({
              todoIssueId: fixture.todoIssueId,
              lane: "done",
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
        lane: "done",
        progressPercent: 90,
        evidenceTag: "EXTRACTED",
      }),
    );
    expect(wikiResponse.body.shortSummary).toEqual(
      expect.arrayContaining([
        expect.stringContaining("done"),
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
        lane: "done",
        progressPercent: 90,
        evidenceTag: "EXTRACTED",
      }),
    );
    expect(queryResponse.body.answerLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("done"),
        expect.stringContaining("90%"),
        expect.stringContaining("Refreshed the report after the first pass"),
      ]),
    );
  });

  it("returns enriched card fields for Phase 50 quick edit controls and composable board filters", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.boardUserId);

    const response = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/daily-report`)
      .query({ projectId: fixture.projectId, reportDate: "2026-04-30" })
      .expect(200);

    expect(response.body.cards[0]).toEqual(
      expect.objectContaining({
        deliverableTitle: "Daily report cockpit note",
        deliverableType: "document",
        deliverableRequired: true,
        deliverableOwner: "todo",
        qualityStatus: "none",
        qualityLabel: "없음",
        approvalWaiting: false,
        approvalWaitingSource: "deliverable_review",
        okrSource: "direct_task",
        directGoalId: expect.any(String),
        directGoalTitle: "Improve daily operating cadence",
        inheritedGoalId: null,
        inheritedGoalTitle: null,
        assigneeDisplayName: "board-user",
        searchText: expect.stringContaining("Daily report cockpit note"),
        dueDate: null,
      }),
    );
  });

  it("keeps title, deliverable, quality, and OKR quick edits on narrow board-owned routes", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.boardUserId);
    const reportDate = "2026-04-30";

    await request(app)
      .patch(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/title`)
      .send({ projectId: fixture.projectId, reportDate, title: "고객 리포트 정리" })
      .expect(200)
      .expect((response) => {
        expect(response.body.card).toEqual(
          expect.objectContaining({
            todoIssueId: fixture.todoIssueId,
            todoTitle: "고객 리포트 정리",
          }),
        );
      });

    await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/deliverable`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        title: "고객 리포트",
        type: "document",
        required: true,
        basePrice: 50000,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.card).toEqual(
          expect.objectContaining({
            deliverableTitle: "고객 리포트",
            deliverableType: "document",
            deliverableRequired: true,
            basePriceTotal: 50000,
          }),
        );
      });

    await request(app)
      .patch(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/quality`)
      .send({ projectId: fixture.projectId, reportDate, qualityStatus: "needs_work" })
      .expect(200)
      .expect((response) => {
        expect(response.body.card).toEqual(
          expect.objectContaining({
            qualityStatus: "needs_work",
            qualityLabel: "수정 필요",
            approvalWaiting: true,
            approvalWaitingSource: "deliverable_review",
          }),
        );
      });

    await request(app)
      .patch(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/okr`)
      .send({ projectId: fixture.projectId, reportDate, goalId: null })
      .expect(200)
      .expect((response) => {
        expect(response.body.card).toEqual(
          expect.objectContaining({
            okrSource: "inherited_project",
            directGoalId: null,
          }),
        );
      });
  });

  it("preserves daily report activity and wiki materialization when lane/status is edited", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.boardUserId);
    const reportDate = "2026-04-30";

    const saveResponse = await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}`)
      .send({
        projectId: fixture.projectId,
        reportDate,
        lane: "doing",
        bucketLabel: "검토 대기",
        progressPercent: 50,
        note: "상태만 보드에서 수정",
      })
      .expect(200);

    expect(saveResponse.body.wikiPage).toEqual(
      expect.objectContaining({
        reportDate,
        history: expect.arrayContaining([
          expect.objectContaining({
            todoIssueId: fixture.todoIssueId,
            lane: "doing",
            evidenceTag: "EXTRACTED",
          }),
        ]),
      }),
    );

    const [activityRow] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityType, "rt2_daily_report"));

    expect(activityRow).toEqual(
      expect.objectContaining({
        action: expect.any(String),
        details: expect.objectContaining({
          lane: "doing",
          todoIssueId: fixture.todoIssueId,
        }),
      }),
    );
  });

  it("rejects cross-company and wrong-assignee mutations on new daily quick-edit paths", async () => {
    fixture = await seedFixture();
    const reportDate = "2026-04-30";
    const crossCompanyApp = await createApp(randomUUID(), fixture.boardUserId);
    const wrongAssigneeApp = await createApp(fixture.companyId, "someone-else");

    await request(crossCompanyApp)
      .patch(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/title`)
      .send({ projectId: fixture.projectId, reportDate, title: "권한 없는 수정" })
      .expect(403);

    await request(wrongAssigneeApp)
      .patch(`/api/companies/${fixture.companyId}/rt2/daily-report/cards/${fixture.todoIssueId}/quality`)
      .send({ projectId: fixture.projectId, reportDate, qualityStatus: "reviewed" })
      .expect(403);
  });
});
