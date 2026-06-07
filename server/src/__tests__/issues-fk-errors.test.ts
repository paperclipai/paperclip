import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres FK issue route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue foreign key constraint error routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-fk-errors-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "FK Error Test tenant",
      issuePrefix: "FK",
      requireBoardApprovalForNewAgents: false,
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in fk error issue route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in fk error issue route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  it("returns 400 when setting a parentId that does not exist", async () => {
    // 1. Create an initial issue
    const res = await request(app)
      .post("/api")
      .send({ title: "Issue to patch", description: "This will have a fake parent" })
      .expect(200);

    const issueId = res.body.id;
    const fakeParentId = randomUUID();

    // 2. Patch with an invalid parentId
    const patchRes = await request(app)
      .patch(`/api/${issueId}`)
      .send({ parentId: fakeParentId });

    expect(patchRes.status).toBe(400);
    expect(patchRes.body).toMatchObject({
      error: expect.stringContaining("parent issue not found"),
    });
  });

  it("returns 400 when setting a goalId that does not exist", async () => {
    // 1. Create an initial issue
    const res = await request(app)
      .post("/api")
      .send({ title: "Issue to patch", description: "This will have a fake goal" })
      .expect(200);

    const issueId = res.body.id;
    const fakeGoalId = randomUUID();

    // 2. Patch with an invalid goalId
    const patchRes = await request(app)
      .patch(`/api/${issueId}`)
      .send({ goalId: fakeGoalId });

    expect(patchRes.status).toBe(400);
    expect(patchRes.body).toMatchObject({
      error: expect.stringContaining("goal not found"),
    });
  });
});
