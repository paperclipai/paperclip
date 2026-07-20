import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, resources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resourceRoutes } from "../routes/resources.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resource routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lets same-company agent actors manage resources and blocks cross-company access", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Resource API Co",
        issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `B${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Resource Agent" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId };
      next();
    });
    app.use("/api", resourceRoutes(db));

    const created = await request(app).post(`/api/companies/${companyId}/resources`).send({
      key: "briefs",
      repository: "/tmp/briefs",
      mountPath: "briefs",
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("briefs");

    expect((await request(app).get(`/api/companies/${otherCompanyId}/resources`)).status).toBe(403);
    const otherResourceId = randomUUID();
    await db.insert(resources).values({
      id: otherResourceId,
      companyId: otherCompanyId,
      key: "other-briefs",
      type: "git",
      repository: "/tmp/other-briefs",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "other-briefs",
      credentialRef: null,
      labels: {},
      status: "active",
    });
    expect((await request(app).get(`/api/resources/${otherResourceId}`)).status).toBe(404);
    expect((await request(app).patch(`/api/resources/${otherResourceId}`).send({ defaultRef: "develop" })).status).toBe(404);
    expect((await request(app).delete(`/api/resources/${otherResourceId}`)).status).toBe(404);
    expect((await request(app).patch(`/api/resources/${created.body.id}`).send({ defaultRef: "develop" })).status).toBe(200);
    expect((await request(app).delete(`/api/resources/${created.body.id}`)).body.status).toBe("archived");
    const archiveActivities = async () => db.select().from(activityLog).where(eq(activityLog.action, "resource.archived"));
    expect((await archiveActivities()).length).toBe(1);
    expect((await request(app).delete(`/api/resources/${created.body.id}`)).body.status).toBe("archived");
    expect((await archiveActivities()).length).toBe(1);

    await db.delete(resources);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });
});
