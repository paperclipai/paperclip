import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  issueComments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { apiCompression } from "../middleware/api-compression.js";
import { issueRoutes } from "../routes/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { workProductService } from "../services/work-products.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue CAS routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-cas-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(instanceSettings);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use("/api", apiCompression());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{
          companyId,
          membershipRole: "owner",
          status: "active",
          principalId: "cloud-user-1",
        }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
    return app;
  }

  async function seedIssue(version = 1) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const prefix = `P${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "CAS route issue",
      status: "todo",
      priority: "medium",
      version,
    });
    return { app: createApp(companyId), companyId, issueId };
  }

  it("returns a strong issue ETag and no-transform on GET", async () => {
    const { app, issueId } = await seedIssue(7);

    const res = await request(app).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.etag).toBe("\"issue-v7\"");
    expect(res.headers["cache-control"]).toBe("no-transform");
    expect(res.body.version).toBe(7);
  });

  it("preserves the strong ETag when the client accepts gzip", async () => {
    const { app, issueId } = await seedIssue(7);

    const res = await request(app)
      .get(`/api/issues/${issueId}`)
      .set("Accept-Encoding", "gzip");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.etag).toBe("\"issue-v7\"");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("advances the issue representation version for work product mutations", async () => {
    const { app, companyId, issueId } = await seedIssue();
    const products = workProductService(db);

    const created = await products.createForIssue(issueId, companyId, {
      type: "artifact",
      provider: "paperclip",
      title: "Evidence bundle",
      status: "open",
      reviewState: "draft",
      isPrimary: false,
    });

    expect(created).not.toBeNull();
    const afterCreate = await request(app).get(`/api/issues/${issueId}`);
    expect(afterCreate.status, JSON.stringify(afterCreate.body)).toBe(200);
    expect(afterCreate.headers.etag).toBe("\"issue-v2\"");
    expect(afterCreate.body.workProducts).toHaveLength(1);

    const updated = await products.update(created!.id, { reviewState: "ready_for_review" });
    expect(updated?.reviewState).toBe("ready_for_review");
    const afterUpdate = await request(app).get(`/api/issues/${issueId}`);
    expect(afterUpdate.headers.etag).toBe("\"issue-v3\"");

    expect(await products.remove(created!.id)).not.toBeNull();
    const afterDelete = await request(app).get(`/api/issues/${issueId}`);
    expect(afterDelete.headers.etag).toBe("\"issue-v4\"");
    expect(afterDelete.body.workProducts).toEqual([]);
  });

  it("accepts PATCH with the current ETag and returns a fresh ETag", async () => {
    const { app, issueId } = await seedIssue(7);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("If-Match", "\"issue-v7\"")
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: issueId, priority: "high", version: 8 });
    expect(res.headers["cache-control"], JSON.stringify(res.headers)).toBe("no-transform");
    expect(res.headers.etag, JSON.stringify(res.headers)).toBe("\"issue-v8\"");
  });

  it("returns 412 with zero writes for a stale PATCH", async () => {
    const { app, issueId } = await seedIssue(7);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("If-Match", "\"issue-v6\"")
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(412);
    expect(res.body).toEqual({ error: "Issue version conflict" });
    expect(res.headers.etag).toBe("\"issue-v7\"");
    expect(res.headers["cache-control"]).toBe("no-transform");
    expect(
      await db
        .select({ priority: issues.priority, version: issues.version })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]),
    ).toEqual({ priority: "medium", version: 7 });
    expect(await db.select({ id: instanceSettings.id }).from(instanceSettings)).toEqual([]);
    expect(await db.select({ id: activityLog.id }).from(activityLog)).toEqual([]);
  });

  it("returns 400 for weak and multi-value If-Match", async () => {
    const { app, issueId } = await seedIssue(7);

    for (const value of ["W/\"issue-v7\"", "\"issue-v7\", \"issue-v6\""]) {
      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .set("If-Match", value)
        .send({ priority: "high" });
      expect(res.status, value).toBe(400);
      expect(res.body).toEqual({ error: "Invalid If-Match issue ETag" });
    }
  });

  it("keeps unheadered PATCH compatible and increments once", async () => {
    const { app, issueId } = await seedIssue();

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.headers["cache-control"], JSON.stringify(res.headers)).toBe("no-transform");
    expect(res.headers.etag, JSON.stringify(res.headers)).toBe("\"issue-v2\"");
  });

  it("advances the parent once for a current comment If-Match", async () => {
    const { app, issueId } = await seedIssue();

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("If-Match", "\"issue-v1\"")
      .send({ body: "Versioned comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers.etag).toBe("\"issue-v2\"");
    expect(res.headers["cache-control"]).toBe("no-transform");
    expect(
      await db
        .select({ version: issues.version })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]),
    ).toEqual({ version: 2 });
    expect(await db.select({ id: issueComments.id }).from(issueComments)).toHaveLength(1);
  });

  it("expires superseded interactions within the comment's single parent version", async () => {
    const { app, companyId, issueId } = await seedIssue();
    const interaction = await issueThreadInteractionService(db).create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "cloud-user-1",
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("If-Match", "\"issue-v2\"")
      .send({ body: "Proceed with phase 1" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers.etag).toBe("\"issue-v3\"");
    expect(
      await db
        .select({ version: issues.version })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]),
    ).toEqual({ version: 3 });
    expect(
      await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id))
        .then((rows) => rows[0]),
    ).toEqual({ status: "expired" });
  });

  it("returns 412 and inserts no comment for stale comment If-Match", async () => {
    const { app, issueId } = await seedIssue(3);

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("If-Match", "\"issue-v2\"")
      .send({ body: "Stale comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(412);
    expect(res.headers.etag).toBe("\"issue-v3\"");
    expect(await db.select({ id: issueComments.id }).from(issueComments)).toEqual([]);
    expect(await db.select({ id: instanceSettings.id }).from(instanceSettings)).toEqual([]);
    expect(await db.select({ id: activityLog.id }).from(activityLog)).toEqual([]);
  });

  it("advances once for PATCH with an inline comment", async () => {
    const { app, issueId } = await seedIssue();

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("If-Match", "\"issue-v1\"")
      .send({ priority: "high", comment: "Compound comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      priority: "high",
      version: 2,
      comment: expect.objectContaining({ body: "Compound comment" }),
    });
    expect(res.headers.etag).toBe("\"issue-v2\"");
    expect(await db.select({ id: issueComments.id }).from(issueComments)).toHaveLength(1);
  });

  it("advances once for reopen plus comment", async () => {
    const { app, issueId } = await seedIssue();
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, issueId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("If-Match", "\"issue-v1\"")
      .send({ body: "Please resume", reopen: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers.etag).toBe("\"issue-v2\"");
    expect(
      await db
        .select({ status: issues.status, version: issues.version })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]),
    ).toEqual({ status: "todo", version: 2 });
    expect(await db.select({ id: issueComments.id }).from(issueComments)).toHaveLength(1);
  });

  it("advances once when tombstoning a comment", async () => {
    const { app, companyId, issueId } = await seedIssue();
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "cloud-user-1",
      body: "Delete me",
    }).returning();

    const res = await request(app)
      .delete(`/api/issues/${issueId}/comments/${comment.id}`)
      .set("If-Match", "\"issue-v1\"");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.etag).toBe("\"issue-v2\"");
    expect(res.body).toMatchObject({ id: comment.id, deletedAt: expect.any(String) });
    expect(
      await db
        .select({ version: issues.version })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]),
    ).toEqual({ version: 2 });
  });

  it("returns 412 and preserves a comment for stale delete If-Match", async () => {
    const { app, companyId, issueId } = await seedIssue(2);
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "cloud-user-1",
      body: "Keep me",
    }).returning();

    const res = await request(app)
      .delete(`/api/issues/${issueId}/comments/${comment.id}`)
      .set("If-Match", "\"issue-v1\"");

    expect(res.status, JSON.stringify(res.body)).toBe(412);
    expect(res.headers.etag).toBe("\"issue-v2\"");
    expect(
      await db
        .select({ body: issueComments.body, deletedAt: issueComments.deletedAt })
        .from(issueComments)
        .where(eq(issueComments.id, comment.id))
        .then((rows) => rows[0]),
    ).toEqual({ body: "Keep me", deletedAt: null });
  });
});
