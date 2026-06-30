import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  goals,
  issues,
  issueWorkProducts,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { THOMAS_BOARD_USER_ID } from "../services/pull-request-assignee.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pull request assignee work-product routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-assignee-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(goals);
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
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCloudTenantMember(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedCompanyWithTree(rootCreatedByUserId: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId, "cloud-user-1");

    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "PR assignment",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      goalId,
      title: "Root human issue",
      status: "in_progress",
      priority: "medium",
      createdByUserId: rootCreatedByUserId,
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      goalId,
      parentId: rootIssueId,
      title: "Agent child issue",
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, childIssueId };
  }

  function prPayload() {
    return {
      type: "pull_request",
      provider: "github",
      title: "feat: implement thing",
      url: "https://github.com/acme/repo/pull/7",
    };
  }

  function branchPayload() {
    return {
      type: "branch",
      provider: "github",
      title: "twx-1109-branch",
    };
  }

  it("stamps the Thomas assignee onto PR work products from Thomas's trees", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree(THOMAS_BOARD_USER_ID);
    await seedCloudTenantMember(companyId, THOMAS_BOARD_USER_ID);
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(prPayload());

    expect(res.status).toBe(201);
    expect(res.body.metadata?.assignee).toMatchObject({
      userId: THOMAS_BOARD_USER_ID,
      source: "issue_tree_root_requester_rule",
      rootRequesterUserId: THOMAS_BOARD_USER_ID,
    });
  });

  it("leaves PR work products untouched for trees initiated by other users", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree("cloud-user-1");
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(prPayload());

    expect(res.status).toBe(201);
    expect(res.body.metadata?.assignee).toBeUndefined();
  });

  it("surfaces pullRequestAssignee in heartbeat-context for Thomas's trees", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree(THOMAS_BOARD_USER_ID);
    await seedCloudTenantMember(companyId, THOMAS_BOARD_USER_ID);
    const app = createApp(companyId);

    const res = await request(app).get(`/api/issues/${childIssueId}/heartbeat-context`);

    expect(res.status).toBe(200);
    expect(res.body.pullRequestAssignee).toMatchObject({
      userId: THOMAS_BOARD_USER_ID,
      source: "issue_tree_root_requester_rule",
    });
  });

  it("stamps the assignee when a branch work product is promoted to a pull_request", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree(THOMAS_BOARD_USER_ID);
    await seedCloudTenantMember(companyId, THOMAS_BOARD_USER_ID);
    const app = createApp(companyId);

    // A branch carries no PR-assignee at creation.
    const created = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(branchPayload());
    expect(created.status).toBe(201);
    expect(created.body.metadata?.assignee).toBeUndefined();

    // Promoting it to a pull_request stamps the instance-wide assignee.
    const updated = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "pull_request", url: "https://github.com/acme/repo/pull/8" });

    expect(updated.status).toBe(200);
    expect(updated.body.type).toBe("pull_request");
    expect(updated.body.metadata?.assignee).toMatchObject({
      userId: THOMAS_BOARD_USER_ID,
      source: "issue_tree_root_requester_rule",
      rootRequesterUserId: THOMAS_BOARD_USER_ID,
    });
  });

  it("re-stamps the assignee when a PR's metadata is replaced without one", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree(THOMAS_BOARD_USER_ID);
    await seedCloudTenantMember(companyId, THOMAS_BOARD_USER_ID);
    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(prPayload());
    expect(created.body.metadata?.assignee?.userId).toBe(THOMAS_BOARD_USER_ID);

    // Replacing metadata wholesale (dropping the assignee) must not strip the
    // invariant — it is re-derived.
    const updated = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ metadata: { note: "edited" } });

    expect(updated.status).toBe(200);
    expect(updated.body.metadata?.note).toBe("edited");
    expect(updated.body.metadata?.assignee).toMatchObject({
      userId: THOMAS_BOARD_USER_ID,
      source: "issue_tree_root_requester_rule",
    });
  });

  it("preserves an explicit assignee supplied on update", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree(THOMAS_BOARD_USER_ID);
    await seedCloudTenantMember(companyId, THOMAS_BOARD_USER_ID);
    // cloud-user-1 is already an active member via seedCompanyWithTree.
    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(branchPayload());

    const explicitAssignee = {
      userId: "cloud-user-1",
      source: "issue_tree_root_requester_rule" as const,
      rootRequesterUserId: "cloud-user-1",
      rootRequesterIssueId: null,
    };
    const updated = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "pull_request", metadata: { assignee: explicitAssignee } });

    expect(updated.status).toBe(200);
    expect(updated.body.metadata?.assignee).toMatchObject({ userId: "cloud-user-1" });
  });

  it("leaves promoted PRs untouched for trees initiated by other users", async () => {
    const { companyId, childIssueId } = await seedCompanyWithTree("cloud-user-1");
    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/issues/${childIssueId}/work-products`)
      .send(branchPayload());

    const updated = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "pull_request", url: "https://github.com/acme/repo/pull/9" });

    expect(updated.status).toBe(200);
    expect(updated.body.metadata?.assignee).toBeUndefined();
  });
});
