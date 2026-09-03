import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres child-parent attach route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BRO-1313: a direct-child assignee may attach a deliverable to its DIRECT
// parent by proving liveness via its OWN checkout, without weakening the
// parent's issue:mutate ownership boundary (status/assignee/title mutations by a
// non-assignee stay denied). These route tests exercise that exception end to
// end against a real database. Evidence: BRO-1241.
describeEmbeddedPostgres("issue child-parent attachment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-parent-attach-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorageService(): StorageService {
    return {
      provider: "local_disk",
      putFile: async (input) => ({
        provider: "local_disk",
        objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha256-sample",
        originalFilename: input.originalFilename,
      }),
      getObject: async () => {
        throw new Error("not implemented in test");
      },
      headObject: async () => {
        throw new Error("not implemented in test");
      },
      deleteObject: async () => undefined,
    } as unknown as StorageService;
  }

  function createApp(companyId: string, actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, createStorageService(), { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `A${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: uniqueIssuePrefix(),
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
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Task",
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      assigneeAgentId: overrides.assigneeAgentId,
      parentId: overrides.parentId,
      checkoutRunId: overrides.checkoutRunId,
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedRunningRun(companyId: string, agentId: string, id = randomUUID()) {
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
    return id;
  }

  function agentActor(companyId: string, agentId: string, runId: string | null) {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function attachTo(app: express.Express, companyId: string, issueId: string) {
    return request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("deliverable"), {
        filename: "report.txt",
        contentType: "text/plain",
      });
  }

  it("lets a direct-child assignee attach to its DIRECT parent when it owns the child's live checkout", async () => {
    const companyId = await seedCompany();
    const parentAgent = await seedAgent(companyId, "Parent Agent");
    const childAgent = await seedAgent(companyId, "Child Agent");
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      assigneeAgentId: parentAgent,
    });
    const childRunId = await seedRunningRun(companyId, childAgent);
    await seedIssue(companyId, {
      title: "Child",
      status: "in_progress",
      parentId,
      assigneeAgentId: childAgent,
      checkoutRunId: childRunId,
    });

    const app = createApp(companyId, agentActor(companyId, childAgent, childRunId));
    const res = await attachTo(app, companyId, parentId);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, parentId)));
    expect(stored).toHaveLength(1);
  });

  it("still denies the same child assignee from MUTATING the parent (status/title stays board-only)", async () => {
    const companyId = await seedCompany();
    const parentAgent = await seedAgent(companyId, "Parent Agent");
    const childAgent = await seedAgent(companyId, "Child Agent");
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      assigneeAgentId: parentAgent,
    });
    const childRunId = await seedRunningRun(companyId, childAgent);
    await seedIssue(companyId, {
      title: "Child",
      status: "in_progress",
      parentId,
      assigneeAgentId: childAgent,
      checkoutRunId: childRunId,
    });

    const app = createApp(companyId, agentActor(companyId, childAgent, childRunId));
    const res = await request(app)
      .patch(`/api/issues/${parentId}`)
      .send({ title: "Child tries to rename the parent" });

    // The attach exception does NOT relax the parent's issue:mutate boundary.
    expect([403, 409]).toContain(res.status);
    const parent = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, parentId))
      .then((rows) => rows[0]);
    expect(parent?.title).toBe("Parent");
  });

  it("denies an agent that does not assign a direct child of the parent", async () => {
    const companyId = await seedCompany();
    const parentAgent = await seedAgent(companyId, "Parent Agent");
    const strangerAgent = await seedAgent(companyId, "Stranger Agent");
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      assigneeAgentId: parentAgent,
    });
    // Stranger has a live checkout, but on an unrelated issue — not a child of parent.
    const strangerRunId = await seedRunningRun(companyId, strangerAgent);
    await seedIssue(companyId, {
      title: "Unrelated",
      status: "in_progress",
      assigneeAgentId: strangerAgent,
      checkoutRunId: strangerRunId,
    });

    const app = createApp(companyId, agentActor(companyId, strangerAgent, strangerRunId));
    const res = await attachTo(app, companyId, parentId);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const stored = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, parentId));
    expect(stored).toHaveLength(0);
  });

  it("does not extend the attach grant beyond the DIRECT parent (single hop only)", async () => {
    const companyId = await seedCompany();
    const topAgent = await seedAgent(companyId, "Top Agent");
    const midAgent = await seedAgent(companyId, "Mid Agent");
    const leafAgent = await seedAgent(companyId, "Leaf Agent");
    const grandparentId = await seedIssue(companyId, {
      title: "Grandparent",
      status: "in_progress",
      assigneeAgentId: topAgent,
    });
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      parentId: grandparentId,
      assigneeAgentId: midAgent,
    });
    const leafRunId = await seedRunningRun(companyId, leafAgent);
    await seedIssue(companyId, {
      title: "Leaf",
      status: "in_progress",
      parentId,
      assigneeAgentId: leafAgent,
      checkoutRunId: leafRunId,
    });

    const app = createApp(companyId, agentActor(companyId, leafAgent, leafRunId));

    // Direct parent: allowed.
    const allowed = await attachTo(app, companyId, parentId);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    // Grandparent (two hops up): denied — the exception is a single direct hop.
    const denied = await attachTo(app, companyId, grandparentId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const grandparentAttachments = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, grandparentId));
    expect(grandparentAttachments).toHaveLength(0);
  });

  it("denies a direct-child assignee whose child is not checked out by its own live run", async () => {
    const companyId = await seedCompany();
    const parentAgent = await seedAgent(companyId, "Parent Agent");
    const childAgent = await seedAgent(companyId, "Child Agent");
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      assigneeAgentId: parentAgent,
    });
    // The child is in_progress but held by a DIFFERENT still-running checkout,
    // so the actor's run cannot prove liveness on it.
    const otherRunId = await seedRunningRun(companyId, childAgent);
    await seedIssue(companyId, {
      title: "Child",
      status: "in_progress",
      parentId,
      assigneeAgentId: childAgent,
      checkoutRunId: otherRunId,
    });
    const actorRunId = await seedRunningRun(companyId, childAgent);

    const app = createApp(companyId, agentActor(companyId, childAgent, actorRunId));
    const res = await attachTo(app, companyId, parentId);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const stored = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, parentId));
    expect(stored).toHaveLength(0);
  });

  it("denies a direct-child assignee whose child is not currently in progress", async () => {
    const companyId = await seedCompany();
    const parentAgent = await seedAgent(companyId, "Parent Agent");
    const childAgent = await seedAgent(companyId, "Child Agent");
    const parentId = await seedIssue(companyId, {
      title: "Parent",
      status: "in_progress",
      assigneeAgentId: parentAgent,
    });
    // Child is assigned but idle (todo) — no live checkout to anchor on.
    await seedIssue(companyId, {
      title: "Child",
      status: "todo",
      parentId,
      assigneeAgentId: childAgent,
    });
    const actorRunId = await seedRunningRun(companyId, childAgent);

    const app = createApp(companyId, agentActor(companyId, childAgent, actorRunId));
    const res = await attachTo(app, companyId, parentId);

    // Falls through to the standard mutation boundary, which denies.
    expect([403, 409]).toContain(res.status);
    const stored = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, parentId));
    expect(stored).toHaveLength(0);
  });
});
