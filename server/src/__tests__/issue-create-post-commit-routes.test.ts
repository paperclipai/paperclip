import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const postCommitFailures = vi.hoisted(() => ({
  issueReferenceSync: false,
  activityAction: null as string | null,
  activityPublicationAction: null as string | null,
}));

vi.mock("../services/activity-log.js", async () => {
  const actual = await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js");
  return {
    ...actual,
    persistActivity: async (...args: Parameters<typeof actual.persistActivity>) => {
      if (args[1].action === postCommitFailures.activityAction) {
        throw new Error("activity database unavailable");
      }
      return actual.persistActivity(...args);
    },
  };
});

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    issueReferenceService: (db: Parameters<typeof actual.issueReferenceService>[0]) => {
      const service = actual.issueReferenceService(db);
      return {
        ...service,
        syncIssue: async (issueId: string, dbOrTx?: Parameters<typeof service.syncIssue>[1]) => {
          if (postCommitFailures.issueReferenceSync) throw new Error("reference index unavailable");
          return service.syncIssue(issueId, dbOrTx);
        },
      };
    },
    publishActivity: (publication: Parameters<typeof actual.publishActivity>[0]) => {
      if (publication.payload.action === postCommitFailures.activityPublicationAction) {
        throw new Error("live activity unavailable");
      }
      return actual.publishActivity(publication);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue create post-commit failures", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-post-commit-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    postCommitFailures.issueReferenceSync = false;
    postCommitFailures.activityAction = null;
    postCommitFailures.activityPublicationAction = null;
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db
      .insert(issues)
      .values({ companyId, title: "Parent issue", status: "todo", priority: "medium" })
      .returning();
    return parent;
  }

  it("rolls back issue creation when reference indexing fails", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    postCommitFailures.issueReferenceSync = true;

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Investigate the incident", idempotencyKey: "incident-42" })
      .expect(500);

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("records resolved issue references in the durable create activity", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const [referencedIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Existing incident",
        identifier: "PAP-42",
        status: "todo",
        priority: "medium",
      })
      .returning();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Follow up on PAP-42" })
      .expect(201);

    expect(created.body.referencedIssueIdentifiers).toEqual(["PAP-42"]);
    const createActivity = (await db.select().from(activityLog))
      .find((row) => row.entityId === created.body.id && row.action === "issue.created");
    expect(createActivity?.details).toMatchObject({
      addedReferencedIssues: [{
        id: referencedIssue.id,
        identifier: "PAP-42",
        title: "Existing incident",
      }],
      currentReferencedIssues: [{
        id: referencedIssue.id,
        identifier: "PAP-42",
        title: "Existing incident",
      }],
    });
  });

  it("rolls back issue creation when its required activity write fails", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    postCommitFailures.activityAction = "issue.created";

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Ship the launch" })
      .expect(500);

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("rolls back child creation when its required activity write fails", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    postCommitFailures.activityAction = "issue.child_created";

    await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Investigate a child incident" })
      .expect(500);

    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("keeps the durable activity and warns when only live publication fails", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    postCommitFailures.activityPublicationAction = "issue.created";

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Publish the launch" })
      .expect(201);

    expect(created.body.postCommitWarnings).toContainEqual({
      code: "issue_activity_publication_failed",
      message: "The issue was created and its activity was recorded, but a live update could not be published.",
    });
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await db.select().from(activityLog)).map((row) => row.action)).toContain("issue.created");
  });
});
