import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  activityLog,
  agents,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  projects,
  rt2CaptureDrafts,
  rt2V33DomainEvents,
  rt2V33ExecutionAttempts,
  rt2CaptureDraftRevisions,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  workspaceRuntimeServices,
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
    await db.delete(heartbeatRunEvents);
    await db.delete(rt2V33ExecutionAttempts);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33TaskParticipants);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(agents);
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

  async function createPublicApp() {
    const routePath = "../routes/rt2-tasks.js";
    const routeModule = await vi.importActual<any>(routePath);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
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

  it("preserves mobile quick-capture event context for review drafts", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const response = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "mobile",
        channel: `quick-capture:${fixture.projectId}`,
        externalUserId: fixture.managerUserId,
        eventId: "qc-mobile-1",
        eventTimestamp: "2026-04-30T00:00:00.000Z",
        text: "task: Mobile field note; todo: Review capture; deliverable: Field note; price: 90000",
      })
      .expect(201);

    expect(response.body.inbound).toEqual(expect.objectContaining({
      source: "mobile",
      channel: `quick-capture:${fixture.projectId}`,
      status: "review_required",
      reviewRequired: true,
      sourceEvidence: expect.objectContaining({
        eventId: "qc-mobile-1",
        eventTimestamp: "2026-04-30T00:00:00.000Z",
        signingStatus: "unsigned",
      }),
    }));
  });

  it("persists capture draft revisions and promotes the latest reviewed snapshot", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const created = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "web",
        channel: "daily-work",
        text: "task: Original title; todo: Original todo; deliverable: Original memo; price: 90000",
      })
      .expect(201);

    const draftId = created.body.inbound.id as string;
    expect(created.body.inbound).toEqual(expect.objectContaining({
      status: "review_required",
    }));

    const initialRevisions = await db
      .select()
      .from(rt2CaptureDraftRevisions)
      .where(eq(rt2CaptureDraftRevisions.draftId, draftId));
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toEqual(expect.objectContaining({
      revisionNumber: 1,
      snapshot: expect.objectContaining({
        taskTitle: "Original title",
        deliverableTitle: "Original memo",
      }),
    }));

    const revised = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${draftId}/revisions`)
      .send({
        snapshot: {
          taskTitle: "Reviewed title",
          todoTitle: "Reviewed todo",
          deliverableTitle: "Reviewed memo",
          deliverableType: "artifact",
          basePrice: 125000,
          taskMode: "collab",
          capacity: 2,
          qualityHint: "검토 대기",
          okrCandidate: "매출 KPI",
          operatorNote: "운영자가 수정함",
        },
        changeSummary: "운영자 검수 수정",
      })
      .expect(201);

    expect(revised.body).toEqual(expect.objectContaining({
      status: "revised",
      latestRevision: expect.objectContaining({
        revisionNumber: 2,
        changeSummary: "운영자 검수 수정",
      }),
    }));

    const detail = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${draftId}`)
      .expect(200);
    expect(detail.body.revisions).toHaveLength(2);
    expect(detail.body.latestRevision.snapshot).toEqual(expect.objectContaining({
      taskTitle: "Reviewed title",
      deliverableTitle: "Reviewed memo",
      basePrice: 125000,
    }));

    const held = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${draftId}/transition`)
      .send({ action: "hold", reason: "중복 여부 확인" })
      .expect(200);
    expect(held.body.status).toBe("on_hold");

    const reopened = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${draftId}/transition`)
      .send({ action: "mark_review_required" })
      .expect(200);
    expect(reopened.body.status).toBe("review_required");

    const promoted = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${draftId}/promote`)
      .send({
        target: "task",
        projectId: fixture.projectId,
        taskMode: "solo",
        capacity: 1,
        priority: "medium",
      })
      .expect(200);

    expect(promoted.body).toEqual(expect.objectContaining({
      status: "promoted",
      latestRevision: expect.objectContaining({ revisionNumber: 2 }),
    }));

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, promoted.body.promotedIssueId));
    expect(issue).toEqual(expect.objectContaining({
      title: "Reviewed title",
    }));

    const products = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, promoted.body.promotedIssueId));
    expect(products[0]).toEqual(expect.objectContaining({
      title: "Reviewed memo",
      type: "artifact",
      metadata: expect.objectContaining({
        rt2BasePrice: 125000,
      }),
    }));
  });

  it("filters capture review queue and reports source reliability", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);

    const webCreated = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "web",
        channel: "daily-work",
        text: "task: Promote reviewed draft; todo: Review ops; deliverable: Ops note; price: 90000",
      })
      .expect(201);
    const webDraftId = webCreated.body.inbound.id as string;

    await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${webDraftId}/revisions`)
      .send({
        snapshot: {
          taskTitle: "Promoted reviewed draft",
          todoTitle: "Review ops",
          deliverableTitle: "Ops note",
          deliverableType: "document",
          basePrice: 90000,
          taskMode: "solo",
          capacity: 1,
        },
        changeSummary: "운영 검수 수정",
      })
      .expect(201);

    await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-drafts/${webDraftId}/promote`)
      .send({
        target: "task",
        projectId: fixture.projectId,
        taskMode: "solo",
        capacity: 1,
        priority: "medium",
      })
      .expect(200);

    await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "mobile",
        channel: `quick-capture:${fixture.projectId}`,
        externalUserId: fixture.managerUserId,
        eventId: "retry-mobile-1",
        metadata: { retryCount: 2 },
        text: "task: Mobile retry capture; todo: Retry evidence; deliverable: Retry note; price: 50000",
      })
      .expect(201);

    await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/capture-sources/slack`)
      .send({
        source: "slack",
        label: "Slack Ops",
        installationState: "installed",
        signingStatus: "signed",
        signingSecret: "phase-57-secret",
      })
      .expect(200);

    await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/one-liner/inbound-draft`)
      .send({
        source: "slack",
        channel: "ops",
        externalUserId: "U123",
        eventId: "evt-missing-signature",
        text: "task: Missing signature; deliverable: Blocked note; price: 1000",
      })
      .expect(201);

    const mobileQueue = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-drafts?source=mobile`)
      .expect(200);
    expect(mobileQueue.body.drafts).toHaveLength(1);
    expect(mobileQueue.body.drafts[0]).toEqual(expect.objectContaining({ source: "mobile" }));

    const revisedQueue = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-drafts?evidence=revised`)
      .expect(200);
    expect(revisedQueue.body.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: webDraftId,
        status: "promoted",
        latestRevision: expect.objectContaining({ revisionNumber: 2 }),
      }),
    ]));

    const failedQueue = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-drafts?evidence=failed_sync`)
      .expect(200);
    expect(failedQueue.body.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "slack",
        status: "permission_blocked",
      }),
    ]));

    const report = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-drafts/reliability-report`)
      .expect(200);
    expect(report.body.totals).toEqual(expect.objectContaining({
      draftCount: 3,
      failureCount: 1,
      promotedCount: 1,
      retryCount: 2,
    }));
    expect(report.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "web",
        promotedCount: 1,
        averagePromotionLatencyMinutes: expect.any(Number),
      }),
      expect.objectContaining({
        source: "slack",
        failureCount: 1,
        permissionBlockedCount: 1,
      }),
      expect.objectContaining({
        source: "mobile",
        retryCount: 2,
      }),
    ]));
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

  it("receives signed public Slack inbound payloads without board auth", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const publicApp = await createPublicApp();
    const secret = "phase-56-public-secret";

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

    expect(JSON.stringify(sourceResponse.body)).not.toContain(secret);

    const signedPayload = {
      text: "task: Slack signal; todo: triage ops note; deliverable: Slack summary; price: 120000",
      channel: "C-ops",
      externalUserId: "U123",
      eventId: "evt-public-signed",
      eventTimestamp: "2026-04-30T00:01:00.000Z",
      teamId: "T123",
      permalink: "https://slack.example/archives/C-ops/p1",
    };
    const secretHash = createHash("sha256").update(secret).digest("hex");
    const canonical = JSON.stringify({
      source: "slack",
      text: signedPayload.text,
      channel: signedPayload.channel,
      externalUserId: signedPayload.externalUserId,
      eventId: signedPayload.eventId,
      eventTimestamp: signedPayload.eventTimestamp,
    });
    const signature = createHmac("sha256", secretHash).update(canonical).digest("hex");

    const response = await request(publicApp)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-sources/slack/inbound`)
      .set("x-rt2-signature", signature)
      .send(signedPayload)
      .expect(201);

    expect(response.body.inbound).toEqual(expect.objectContaining({
      source: "slack",
      status: "review_required",
      permissionStatus: "allowed",
      sourceEvidence: expect.objectContaining({
        signingStatus: "signed",
        eventId: "evt-public-signed",
        metadata: expect.objectContaining({
          provider: "slack",
          channel: "C-ops",
          teamId: "T123",
          permalink: "https://slack.example/archives/C-ops/p1",
        }),
      }),
    }));
  });

  it("keeps public messaging signature and malformed failures distinguishable", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const publicApp = await createPublicApp();

    await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/capture-sources/slack`)
      .send({
        source: "slack",
        label: "Slack Ops",
        installationState: "installed",
        signingStatus: "signed",
        signingSecret: "phase-56-block-secret",
      })
      .expect(200);

    const blocked = await request(publicApp)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-sources/slack/inbound`)
      .send({
        text: "task: unsigned Slack; deliverable: blocked note; price: 10",
        channel: "C-ops",
        externalUserId: "U123",
        eventId: "evt-public-missing-signature",
      })
      .expect(201);

    expect(blocked.body.inbound).toEqual(expect.objectContaining({
      status: "permission_blocked",
      permissionStatus: "blocked",
      sourceEvidence: expect.objectContaining({
        signingStatus: "missing",
        reasonCode: "signature_missing",
      }),
    }));

    await request(app)
      .put(`/api/companies/${fixture.companyId}/rt2/capture-sources/webhook`)
      .send({
        source: "webhook",
        label: "Webhook Ops",
        installationState: "installed",
        signingStatus: "unsigned",
      })
      .expect(200);

    const malformed = await request(publicApp)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-sources/webhook/inbound`)
      .send({
        channel: "ops-webhook",
        eventId: "evt-malformed",
        metadata: { providerLabel: "Ops webhook" },
      })
      .expect(201);

    expect(malformed.body.inbound).toEqual(expect.objectContaining({
      source: "webhook",
      status: "failed",
      sourceEvidence: expect.objectContaining({
        reasonCode: "malformed_payload",
        metadata: expect.objectContaining({
          provider: "webhook",
          providerLabel: "Ops webhook",
        }),
      }),
    }));

    const sources = await request(app)
      .get(`/api/companies/${fixture.companyId}/rt2/capture-sources`)
      .expect(200);
    expect(sources.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "webhook", lastErrorCode: "malformed_payload" }),
    ]));
  });

  it("rejects public messaging inbound for sources that are not installed", async () => {
    fixture = await seedFixture();
    const publicApp = await createPublicApp();

    await request(publicApp)
      .post(`/api/companies/${fixture.companyId}/rt2/capture-sources/teams/inbound`)
      .send({
        text: "task: unknown Teams; deliverable: none; price: 1",
      })
      .expect(404);

    const rows = await db
      .select()
      .from(rt2CaptureDrafts)
      .where(eq(rt2CaptureDrafts.companyId, fixture.companyId));
    expect(rows).toHaveLength(0);
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
    expect(response.body.error).toBe("Validation error");
    expect(JSON.stringify(response.body.details)).toContain("deliverableTitle");
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

    const dispatched = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/dispatch`)
      .send({ executorType: "jarvis", executorId: "jarvis-launch" })
      .expect(200);

    expect(dispatched.body).toEqual(expect.objectContaining({
      state: "dispatched",
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
        "rt2.execution.dispatched",
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
      latestTimelineEvent: expect.objectContaining({
        type: "rt2.execution.completed",
      }),
    }));
  });

  it("prevents duplicate execution dispatches", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });

    const queued = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/dispatch`)
      .send({ executorType: "user", executorId: fixture.managerUserId })
      .expect(200);

    const duplicate = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/dispatch`)
      .send({ executorType: "user", executorId: fixture.userAId });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe("RT2_EXECUTION_ALREADY_DISPATCHED");
  });

  it("dispatches queued executions by runtime capacity, exposes heartbeat timeline, and cleans stale active work", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });
    const runtimeServiceId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId: fixture.companyId,
      name: "Runtime Worker",
      role: "operator",
      status: "idle",
    });

    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: fixture.companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: fixture.companyId,
      runId: heartbeatRunId,
      agentId,
      seq: 1,
      eventType: "progress",
      message: "50% complete",
      payload: { tool: "worker" },
    });

    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      scopeType: "project_workspace",
      serviceName: "worker",
      status: "running",
      lifecycle: "shared",
      provider: "local_process",
      healthStatus: "healthy",
      lastUsedAt: new Date(),
    });

    const firstQueued = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    const dispatched = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/executions/dispatch-next`)
      .send({
        executorType: "runtime",
        executorId: "worker-1",
        runtimeServiceId,
        heartbeatRunId,
        capacity: 1,
      })
      .expect(200);

    expect(dispatched.body).toEqual(expect.objectContaining({
      id: firstQueued.body.id,
      state: "dispatched",
      runtimeServiceId,
      heartbeatRunId,
    }));

    const capacityBlocked = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/executions/dispatch-next`)
      .send({
        executorType: "runtime",
        executorId: "worker-1",
        runtimeServiceId,
        capacity: 1,
      });

    expect(capacityBlocked.status).toBe(409);
    expect(capacityBlocked.body.error).toBe("RT2_EXECUTION_RUNTIME_CAPACITY_EXCEEDED");

    const timeline = await request(app)
      .get(`/api/rt2/executions/${dispatched.body.id}/timeline`)
      .expect(200);

    expect(timeline.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "rt2.execution.dispatched" }),
        expect.objectContaining({ source: "heartbeat", kind: "progress", message: "50% complete" }),
      ]),
    );

    const staleBefore = new Date();
    await db
      .update(rt2V33ExecutionAttempts)
      .set({ updatedAt: new Date(staleBefore.getTime() - 60_000) })
      .where(eq(rt2V33ExecutionAttempts.id, dispatched.body.id));

    const cleanup = await request(app)
      .post(`/api/companies/${fixture.companyId}/rt2/executions/cleanup-stale`)
      .send({ staleBefore: staleBefore.toISOString(), reason: "heartbeat stale" })
      .expect(200);

    expect(cleanup.body.cleaned).toEqual([
      expect.objectContaining({
        id: dispatched.body.id,
        state: "failed",
        failureReason: "heartbeat stale",
      }),
    ]);
  });

  it("cancels queued executions with an execution-domain event", async () => {
    fixture = await seedFixture();
    const app = await createApp(fixture.companyId, fixture.managerUserId);
    const task = await createTaskFixture({ capacity: 1, participants: [] });

    const queued = await request(app)
      .post(`/api/rt2/tasks/${task.issueId}/executions`)
      .send({})
      .expect(201);

    const cancelled = await request(app)
      .post(`/api/rt2/executions/${queued.body.id}/cancel`)
      .send({ reason: "operator stopped", cancelledBy: fixture.managerUserId })
      .expect(200);

    expect(cancelled.body).toEqual(expect.objectContaining({
      state: "cancelled",
      failureReason: "operator stopped",
    }));

    const executionEvents = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.entityType, "execution"));

    expect(executionEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["rt2.execution.cancelled"]),
    );
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
      .post(`/api/rt2/executions/${queued.body.id}/dispatch`)
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
