import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  activityLog,
  companyMemberships,
  createDb,
  issueWorkProducts,
  issues,
  projects,
  rt2V33DomainEvents,
  rt2V33ExecutionAttempts,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type SeededFixture = {
  companyId: string;
  projectId: string;
  managerUserId: string;
  userAId: string;
  userBId: string;
  userCId: string;
};

type TaskFixture = {
  issueId: string;
  companyId: string;
  projectId: string;
};

type TodoFixture = {
  issueId: string;
  taskIssueId: string;
};

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 task route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 task routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let fixture!: SeededFixture;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-task-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33ProjectorEvents);
    await db.delete(rt2V33ProjectorState);
    await db.delete(rt2V33DomainEvents);
    await db.delete(activityLog);
    await db.delete(rt2V33ExecutionAttempts);
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33TaskParticipants);
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
    const routePath = "../routes/rt2-tasks.js";
    const routeModule = await vi.importActual<any>(routePath);

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
    app.use("/api", routeModule.rt2TaskRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture(): Promise<SeededFixture> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const managerUserId = "local-board";
    const userAId = "user-a";
    const userBId = "user-b";
    const userCId = "user-c";

    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Corp",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Task Engine Project",
      status: "in_progress",
    });

    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: managerUserId,
        status: "active",
        membershipRole: "owner",
      },
      {
        companyId,
        principalType: "user",
        principalId: userAId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId,
        principalType: "user",
        principalId: userBId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId,
        principalType: "user",
        principalId: userCId,
        status: "active",
        membershipRole: "member",
      },
    ]);

    return {
      companyId,
      projectId,
      managerUserId,
      userAId,
      userBId,
      userCId,
    };
  }

  async function createTaskFixture(input: {
    capacity: number;
    participants: string[];
  }): Promise<TaskFixture> {
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      title: "Collab task",
      status: "todo",
      priority: "medium",
      createdByUserId: fixture.managerUserId,
    });

    await db.insert(rt2V33TaskProfiles).values({
      issueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      taskMode: "collab",
      capacity: input.capacity,
    });

    if (input.participants.length > 0) {
      await db.insert(rt2V33TaskParticipants).values(
        input.participants.map((userId) => ({
          companyId: fixture.companyId,
          taskIssueId: issueId,
          userId,
          state: "active",
          joinedByUserId: fixture.managerUserId,
        })),
      );
    }

    return {
      issueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
    };
  }

  async function createTodoFixture(input: {
    taskIssueId: string;
    assigneeUserId: string;
    status?: "todo" | "in_progress";
  }): Promise<TodoFixture> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      parentId: input.taskIssueId,
      title: "Child to-do",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeUserId: input.assigneeUserId,
      createdByUserId: fixture.managerUserId,
    });

    return {
      issueId,
      taskIssueId: input.taskIssueId,
    };
  }

  it("creates a collab task profile and deliverable definitions", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const response = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/tasks`)
      .send({
        projectId: fixture.projectId,
        title: "Prepare investor update",
        taskMode: "collab",
        capacity: 2,
        deliverables: [{ title: "Investor memo", type: "document", basePrice: 250000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.issueId).toEqual(expect.any(String));
    expect(response.body.rewardEvidence).toEqual(expect.objectContaining({
      earnedGold: 2500,
      xp: 1250,
      settlementState: "proposed",
    }));
    expect(response.body.deliverables).toEqual([
      expect.objectContaining({
        title: "Investor memo",
        type: "document",
        basePrice: 250000,
      }),
    ]);

    const [taskProfile] = await db
      .select()
      .from(rt2V33TaskProfiles)
      .where(eq(rt2V33TaskProfiles.issueId, response.body.issueId));

    expect(taskProfile?.taskMode).toBe("collab");
    expect(taskProfile?.capacity).toBe(2);

    const deliverables = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, response.body.issueId));

    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toEqual(
      expect.objectContaining({
        type: "document",
        provider: "paperclip",
        status: "draft",
        reviewState: "none",
        title: "Investor memo",
        metadata: expect.objectContaining({
          rt2Deliverable: true,
          rt2State: "defined",
          rt2Type: "document",
          rt2Owner: "task",
          rt2Required: true,
          rt2BasePrice: 250000,
        }),
      }),
    );

    const events = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.companyId, fixture.companyId));

    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["rt2.task.created", "rt2.deliverable.defined"]),
    );
    expect(events.find((event) => event.eventType === "rt2.task.created")).toEqual(
      expect.objectContaining({
        actorId: fixture.managerUserId,
        entityType: "task",
        entityId: response.body.issueId,
      }),
    );
  });

  it("creates a reviewed One-Liner draft from messenger-style inbound text", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const response = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "slack",
        channel: "daily-work",
        externalUserId: "U123",
        text: "task: Review B2B quote; todo: Check discount line; deliverable: Quote review note; price: 90000",
      })
      .expect(201);

    expect(response.body).toEqual({
      draft: expect.objectContaining({
        rawInput: expect.stringContaining("Review B2B quote"),
        taskTitle: "Review B2B quote",
        todoTitle: "Check discount line",
        deliverableTitle: "Quote review note",
        basePrice: 90000,
        taskMode: "solo",
        capacity: 1,
        warnings: [],
      }),
      inbound: expect.objectContaining({
        source: "slack",
        channel: "daily-work",
        externalUserId: "U123",
        reviewRequired: true,
      }),
    });
  });

  it("records signed capture source evidence and blocks missing signatures", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const secret = "phase-41-secret";

    const sourceResponse = await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/capture-sources/slack`)
      .send({
        source: "slack",
        label: "Slack Ops",
        installationState: "installed",
        signingStatus: "signed",
        signingSecret: secret,
      })
      .expect(200);

    expect(sourceResponse.body).toEqual(expect.objectContaining({
      source: "slack",
      installationState: "installed",
      signingStatus: "signed",
    }));

    const unsigned = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "slack",
        channel: "daily-work",
        externalUserId: "U123",
        eventId: "evt-missing",
        eventTimestamp: "2026-04-29T00:00:00.000Z",
        text: "task: Missing signature; deliverable: Blocked note; price: 10",
      })
      .expect(201);

    expect(unsigned.body.inbound).toEqual(expect.objectContaining({
      status: "permission_blocked",
      sourceEvidence: expect.objectContaining({ signingStatus: "missing", reasonCode: "signature_missing" }),
    }));

    const signedPayload = {
      source: "slack" as const,
      channel: "daily-work",
      externalUserId: "U123",
      eventId: "evt-signed",
      eventTimestamp: "2026-04-29T00:01:00.000Z",
      text: "task: Signed capture; todo: Review signal; deliverable: Signed note; price: 90000",
    };
    const secretHash = createHash("sha256").update(secret).digest("hex");
    const canonical = JSON.stringify({
      source: signedPayload.source,
      text: signedPayload.text,
      channel: signedPayload.channel,
      externalUserId: signedPayload.externalUserId,
      eventId: signedPayload.eventId,
      eventTimestamp: signedPayload.eventTimestamp,
    });
    const signature = createHmac("sha256", secretHash).update(canonical).digest("hex");

    const signed = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({ ...signedPayload, signature })
      .expect(201);

    expect(signed.body.inbound).toEqual(expect.objectContaining({
      status: "review_required",
      sourceEvidence: expect.objectContaining({ signingStatus: "signed", eventId: "evt-signed" }),
      semanticContext: expect.any(Array),
    }));
  });

  it("preserves artifact deliverable types when creating task definitions", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const response = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/tasks`)
      .send({
        projectId: fixture.projectId,
        title: "Prepare launch kit",
        taskMode: "collab",
        capacity: 2,
        deliverables: [{ title: "Prototype asset pack", type: "artifact", basePrice: 540000 }],
      });

    expect(response.status).toBe(201);

    const deliverables = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, response.body.issueId));

    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toEqual(
      expect.objectContaining({
        type: "artifact",
        metadata: expect.objectContaining({
          rt2Type: "artifact",
          rt2BasePrice: 540000,
        }),
      }),
    );
  });

  it("reuses work-board quality metadata for Phase 50 daily-card quality edits", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });
    const todo = await createTodoFixture({
      taskIssueId: task.issueId,
      assigneeUserId: fixture.userAId,
      status: "todo",
    });

    const update = await request(app)
      .patch(`/api/companies/${fixture.companyId}/rt2/work-board/cards/${todo.issueId}`)
      .send({
        qualityStatus: "needs_work",
        priceGold: 90000,
        detailNotes: "품질 이슈 먼저 정렬 대상",
      })
      .expect(200);

    expect(update.body).toEqual(
      expect.objectContaining({
        issueId: todo.issueId,
        qualityStatus: "needs_work",
        priceGold: 90000,
        detailNotes: "품질 이슈 먼저 정렬 대상",
      }),
    );

    const overview = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/work-board`)
      .query({ issueIds: todo.issueId })
      .expect(200);

    expect(overview.body.filters.qualityStatuses).toEqual(expect.arrayContaining(["needs_work"]));
    expect(overview.body.cards[0]).toEqual(
      expect.objectContaining({
        issueId: todo.issueId,
        qualityStatus: "needs_work",
        priceGold: 90000,
      }),
    );
  });

  it("does not accept deliverable title or base-price edits through the broad work-board card metadata route", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });

    const response = await request(app)
      .patch(`/api/companies/${fixture.companyId}/rt2/work-board/cards/${task.issueId}`)
      .send({
        deliverableTitle: "",
        deliverableType: "spreadsheet",
        basePrice: -100,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual(expect.stringContaining("deliverable"));
  });

  it("rejects capacity shrink without explicitly ending overflow participants", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({
      capacity: 3,
      participants: [fixture.userAId, fixture.userBId, fixture.userCId],
    });

    const response = await request(app)
      .patch(`/api/rt2/tasks/${task.issueId}/capacity`)
      .send({ capacity: 1, endedUserIds: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("RT2_CAPACITY_REQUIRES_EXPLICIT_REMOVALS");
  });

  it("unassigns active to-dos when a participant is ended", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({
      capacity: 2,
      participants: [fixture.userAId, fixture.userBId],
    });
    const todo = await createTodoFixture({
      taskIssueId: task.issueId,
      assigneeUserId: fixture.userBId,
      status: "in_progress",
    });

    const response = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/participants/${encodeURIComponent(fixture.userBId)}/end`)
      .send({ reason: "manager_removed" });

    expect(response.status).toBe(200);

    const updatedTodo = await issueService(db).getById(todo.issueId);
    expect(updatedTodo?.assigneeUserId).toBeNull();
    expect(updatedTodo?.status).toBe("todo");

    const [endedParticipant] = await db
      .select()
      .from(rt2V33TaskParticipants)
      .where(
        and(
          eq(rt2V33TaskParticipants.taskIssueId, task.issueId),
          eq(rt2V33TaskParticipants.userId, fixture.userBId),
        ),
      );

    expect(endedParticipant?.state).toBe("ended");
    expect(endedParticipant?.endedReason).toBe("manager_removed");
  });

  it("lets a manager directly assign an active company member as a participant", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({
      capacity: 2,
      participants: [],
    });

    const response = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/participants`)
      .send({ userId: fixture.userAId });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        taskIssueId: task.issueId,
        userId: fixture.userAId,
        state: "active",
        joinedByUserId: fixture.managerUserId,
      }),
    );

    const detail = await request(app)
      .get(`/api/rt2/tasks/${task.issueId}`)
      .expect(200);

    expect(detail.body.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: fixture.userAId,
          state: "active",
          endedReason: null,
        }),
      ]),
    );
  });

  it("moves the parent task to in_progress when the first todo starts", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({
      capacity: 1,
      participants: [fixture.userAId],
    });
    const todo = await createTodoFixture({
      taskIssueId: task.issueId,
      assigneeUserId: fixture.userAId,
      status: "todo",
    });

    const response = await request(app)
      .post(`/api/rt2/todos/${todo.issueId}/start`)
      .send({});

    expect(response.status).toBe(200);

    const parentIssue = await issueService(db).getById(task.issueId);
    expect(parentIssue?.status).toBe("in_progress");

    const startedTodo = await issueService(db).getById(todo.issueId);
    expect(startedTodo?.status).toBe("in_progress");
  });

  it("runs the RT2 execution lifecycle and exposes the latest attempt on task detail", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const created = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/tasks`)
      .send({
        projectId: fixture.projectId,
        title: "Execute store launch package",
        taskMode: "solo",
        capacity: 1,
        deliverables: [{ title: "Launch package", type: "artifact", basePrice: 420000 }],
      })
      .expect(201);

    const [deliverable] = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, created.body.issueId));

    const queued = await request(app)
      .post(`/api/rt2/tasks/${created.body.issueId}/executions`)
      .send({ deliverableWorkProductId: deliverable.id })
      .expect(201);

    expect(queued.body).toEqual(expect.objectContaining({
      taskIssueId: created.body.issueId,
      deliverableWorkProductId: deliverable.id,
      state: "queued",
    }));

    const claimed = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/claim`)
      .send({ executorType: "jarvis", executorId: "jarvis-launch" })
      .expect(200);

    expect(claimed.body).toEqual(expect.objectContaining({
      state: "claimed",
      executorType: "jarvis",
      executorId: "jarvis-launch",
    }));

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/start`)
      .send({})
      .expect(200)
      .expect((response) => {
        expect(response.body.state).toBe("running");
      });

    const completed = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/complete`)
      .send({ resultWorkProductId: deliverable.id })
      .expect(200);

    expect(completed.body).toEqual(expect.objectContaining({
      state: "completed",
      resultWorkProductId: deliverable.id,
    }));

    const executionEvents = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.entityType, "execution"));

    expect(executionEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "rt2.execution.enqueued",
        "rt2.execution.claimed",
        "rt2.execution.started",
        "rt2.execution.completed",
      ]),
    );
    expect(executionEvents.every((event) => event.companyId === fixture.companyId)).toBe(true);

    const detail = await request(app)
      .get(`/api/rt2/tasks/${created.body.issueId}`)
      .expect(200);

    expect(detail.body.execution).toEqual(expect.objectContaining({
      id: queued.body.id,
      state: "completed",
      executorId: "jarvis-launch",
    }));
  });

  it("prevents duplicate execution claims", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });

    const queued = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/claim`)
      .send({ executorType: "user", executorId: fixture.managerUserId })
      .expect(200);

    const duplicate = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/claim`)
      .send({ executorType: "user", executorId: fixture.userAId });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe("RT2_EXECUTION_ALREADY_CLAIMED");
  });

  it("creates a retry attempt after a failed execution", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });

    const queued = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/claim`)
      .send({ executorType: "runtime", executorId: "worker-1" })
      .expect(200);

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/start`)
      .send({})
      .expect(200);

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/fail`)
      .send({ failureReason: "runtime exited" })
      .expect(200);

    const retry = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/retry`)
      .send({})
      .expect(201);

    expect(retry.body).toEqual(expect.objectContaining({
      state: "queued",
      retryOfAttemptId: queued.body.id,
      taskIssueId: task.issueId,
    }));
  });

  it("covers the full M1.3 demo flow", async () => {
    fixture = await seedFixture();
    const managerApp = await createApp(fixture.companyId, fixture.managerUserId);
    const userAApp = await createApp(fixture.companyId, fixture.userAId);
    const userBApp = await createApp(fixture.companyId, fixture.userBId);

    const created = await request(managerApp)
      .post(`/api/companies/${fixture.companyId}/rt2/tasks`)
      .send({
        projectId: fixture.projectId,
        title: "Store opening launch",
        taskMode: "collab",
        capacity: 2,
        deliverables: [{ title: "Opening report", type: "document", basePrice: 320000 }],
      })
      .expect(201);

    await request(userAApp)
      .post(`/api/rt2/tasks/${created.body.issueId}/join`)
      .send({})
      .expect(201);

    await request(userBApp)
      .post(`/api/rt2/tasks/${created.body.issueId}/join`)
      .send({})
      .expect(201);

    const todo = await request(managerApp)
      .post(`/api/rt2/tasks/${created.body.issueId}/todos`)
      .send({
        taskIssueId: created.body.issueId,
        title: "Confirm inventory",
        assigneeUserId: fixture.userAId,
        deliverables: [{ title: "Inventory checklist", type: "document", basePrice: 180000 }],
      })
      .expect(201);

    await request(userAApp)
      .post(`/api/rt2/todos/${todo.body.id}/start`)
      .send({})
      .expect(200);

    await request(managerApp)
      .patch(`/api/rt2/tasks/${created.body.issueId}/capacity`)
      .send({ capacity: 1, endedUserIds: [fixture.userBId] })
      .expect(200);

    const detail = await request(managerApp)
      .get(`/api/rt2/tasks/${created.body.issueId}`)
      .expect(200);

    expect(detail.body).toEqual(
      expect.objectContaining({
        issueId: created.body.issueId,
        projectId: fixture.projectId,
        status: "in_progress",
        capacity: 1,
        activeParticipantCount: 1,
        deliverableCount: 1,
        todoCount: 1,
        todoInProgressCount: 1,
      }),
    );
    expect(detail.body.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: fixture.userAId,
          state: "active",
          endedReason: null,
        }),
        expect.objectContaining({
          userId: fixture.userBId,
          state: "ended",
          endedReason: "capacity_reduced",
        }),
      ]),
    );
    expect(detail.body.todos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: todo.body.id,
          title: "Confirm inventory",
          status: "in_progress",
          assigneeUserId: fixture.userAId,
          deliverableCount: 1,
          submittedDeliverableCount: 0,
        }),
      ]),
    );

    const list = await request(managerApp)
      .get(`/api/companies/${fixture.companyId}/rt2/tasks`)
      .query({ projectId: fixture.projectId })
      .expect(200);

    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: created.body.issueId,
          status: "in_progress",
          capacity: 1,
          activeParticipantCount: 1,
          deliverableCount: 1,
          todoCount: 1,
          todoInProgressCount: 1,
        }),
      ]),
    );
  });
});
