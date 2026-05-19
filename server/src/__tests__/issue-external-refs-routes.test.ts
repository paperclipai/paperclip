import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue externalRefs route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue externalRefs routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-external-refs-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("PATCH sets externalRefs.jira and GET returns it", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme Corp",
      issuePrefix: "ACM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "ACM-1",
      title: "Jira link test issue",
      status: "todo",
      priority: "medium",
      createdByUserId: "board-user-1",
    });

    const app = createApp(companyId);

    // PATCH sets jira link
    const patch = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        externalRefs: {
          jira: {
            key: "PD-1234",
            externalUrl: "https://jira.example.com/browse/PD-1234",
            projectKey: "PD",
          },
        },
      });

    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.externalRefs).toMatchObject({
      jira: { key: "PD-1234", externalUrl: "https://jira.example.com/browse/PD-1234", projectKey: "PD" },
    });

    // GET returns the same externalRefs
    const read = await request(app).get(`/api/issues/${issueId}`);
    expect(read.status).toBe(200);
    expect(read.body.externalRefs).toMatchObject({
      jira: { key: "PD-1234", externalUrl: "https://jira.example.com/browse/PD-1234" },
    });
  });

  it("PATCH with jira=null removes the Jira link", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme Corp 2",
      issuePrefix: "ACM2",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 2,
      identifier: "ACM2-2",
      title: "Jira link removal test",
      status: "todo",
      priority: "medium",
      createdByUserId: "board-user-1",
    });

    const app = createApp(companyId);

    // First set a jira link
    await request(app).patch(`/api/issues/${issueId}`).send({
      externalRefs: {
        jira: { key: "PD-9999", externalUrl: "https://jira.example.com/browse/PD-9999" },
      },
    });

    // Then remove it
    const remove = await request(app).patch(`/api/issues/${issueId}`).send({
      externalRefs: { jira: null },
    });
    expect(remove.status, JSON.stringify(remove.body)).toBe(200);
    expect(remove.body.externalRefs).toBeNull();

    // Verify GET also returns null
    const read = await request(app).get(`/api/issues/${issueId}`);
    expect(read.body.externalRefs).toBeNull();
  });

  it("PATCH updates externalRefs.jira when key already exists (upsert)", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme Corp 3",
      issuePrefix: "ACM3",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 3,
      identifier: "ACM3-3",
      title: "Jira upsert test",
      status: "todo",
      priority: "medium",
      createdByUserId: "board-user-1",
    });

    const app = createApp(companyId);

    // First set
    await request(app).patch(`/api/issues/${issueId}`).send({
      externalRefs: {
        jira: { key: "PD-100", externalUrl: "https://jira.example.com/browse/PD-100" },
      },
    });

    // Upsert same key with new URL
    const upsert = await request(app).patch(`/api/issues/${issueId}`).send({
      externalRefs: {
        jira: { key: "PD-100", externalUrl: "https://updated.example.com/browse/PD-100" },
      },
    });
    expect(upsert.status, JSON.stringify(upsert.body)).toBe(200);
    expect(upsert.body.externalRefs?.jira?.externalUrl).toBe("https://updated.example.com/browse/PD-100");
  });
});
