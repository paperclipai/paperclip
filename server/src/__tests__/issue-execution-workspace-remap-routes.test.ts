import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution workspace remap route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue execution workspace remap routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-workspace-remap-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in issue workspace remap route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in issue workspace remap route test");
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
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const sourceProjectId = randomUUID();
    const destinationProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const sourceProjectWorkspaceId = randomUUID();
    const destinationProjectWorkspaceId = randomUUID();
    const otherProjectWorkspaceId = randomUUID();
    const sourceExecutionWorkspaceId = randomUUID();
    const destinationExecutionWorkspaceId = randomUUID();
    const otherExecutionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const historyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Workspace remap company",
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other workspace company",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(projects).values([
      { id: sourceProjectId, companyId, name: "Source project", status: "in_progress" },
      { id: destinationProjectId, companyId, name: "Destination project", status: "in_progress" },
      { id: otherProjectId, companyId: otherCompanyId, name: "Other project", status: "in_progress" },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: sourceProjectWorkspaceId,
        companyId,
        projectId: sourceProjectId,
        name: "Source primary workspace",
        isPrimary: true,
      },
      {
        id: destinationProjectWorkspaceId,
        companyId,
        projectId: destinationProjectId,
        name: "Destination primary workspace",
        isPrimary: true,
      },
      {
        id: otherProjectWorkspaceId,
        companyId: otherCompanyId,
        projectId: otherProjectId,
        name: "Other primary workspace",
        isPrimary: true,
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: sourceExecutionWorkspaceId,
        companyId,
        projectId: sourceProjectId,
        projectWorkspaceId: sourceProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Source execution workspace",
        status: "archived",
        providerType: "local_fs",
      },
      {
        id: destinationExecutionWorkspaceId,
        companyId,
        projectId: destinationProjectId,
        projectWorkspaceId: destinationProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Destination execution workspace",
        status: "archived",
        providerType: "local_fs",
      },
      {
        id: otherExecutionWorkspaceId,
        companyId: otherCompanyId,
        projectId: otherProjectId,
        projectWorkspaceId: otherProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other execution workspace",
        status: "archived",
        providerType: "local_fs",
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId: sourceProjectId,
      title: "Original issue title",
      description: "Keep this description unchanged.",
      status: "todo",
      priority: "high",
      assigneeUserId: "cloud-user-1",
      createdByUserId: "cloud-user-1",
      billingCode: "portfolio-remap",
      executionWorkspaceId: sourceExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "cloud-user-1",
      authorType: "user",
      body: "Preserve this comment and its history.",
    });
    await db.insert(activityLog).values({
      id: historyId,
      companyId,
      actorType: "user",
      actorId: "cloud-user-1",
      action: "issue.seed_history",
      entityType: "issue",
      entityId: issueId,
      details: { marker: "preserve" },
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    return {
      app: createApp(companyId),
      companyId,
      sourceProjectId,
      destinationProjectId,
      sourceExecutionWorkspaceId,
      destinationExecutionWorkspaceId,
      otherExecutionWorkspaceId,
      issueId,
      commentId,
      historyId,
    };
  }

  it("honors explicit null before a later project and title remap when isolated workspaces are disabled", async () => {
    const fixture = await seedFixture();

    const detach = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ executionWorkspaceId: null });

    expect(detach.status, JSON.stringify(detach.body)).toBe(200);
    expect(detach.body.executionWorkspaceId).toBeNull();

    const remap = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.destinationProjectId,
        title: "Remapped issue title",
      });

    expect(remap.status, JSON.stringify(remap.body)).toBe(200);
    expect(remap.body).toMatchObject({
      projectId: fixture.destinationProjectId,
      title: "Remapped issue title",
      executionWorkspaceId: null,
    });

    const retry = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.destinationProjectId,
        title: "Remapped issue title",
      });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);

    const storedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    const storedComment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, fixture.commentId))
      .then((rows) => rows[0]);
    const storedHistory = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, fixture.historyId))
      .then((rows) => rows[0]);

    expect(storedIssue).toMatchObject({
      projectId: fixture.destinationProjectId,
      title: "Remapped issue title",
      description: "Keep this description unchanged.",
      status: "todo",
      priority: "high",
      assigneeUserId: "cloud-user-1",
      billingCode: "portfolio-remap",
      executionWorkspaceId: null,
      executionWorkspacePreference: "reuse_existing",
    });
    expect(storedComment).toMatchObject({
      issueId: fixture.issueId,
      authorUserId: "cloud-user-1",
      body: "Preserve this comment and its history.",
      deletedAt: null,
    });
    expect(storedHistory).toMatchObject({
      id: fixture.historyId,
      companyId: fixture.companyId,
      action: "issue.seed_history",
      entityType: "issue",
      entityId: fixture.issueId,
      details: { marker: "preserve" },
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
  });

  it("atomically accepts a destination workspace and rejects wrong-project or cross-company pointers", async () => {
    const fixture = await seedFixture();

    const remap = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.destinationProjectId,
        title: "Atomic destination remap",
        executionWorkspaceId: fixture.destinationExecutionWorkspaceId,
      });

    expect(remap.status, JSON.stringify(remap.body)).toBe(200);
    expect(remap.body).toMatchObject({
      projectId: fixture.destinationProjectId,
      title: "Atomic destination remap",
      executionWorkspaceId: fixture.destinationExecutionWorkspaceId,
    });

    const retry = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.destinationProjectId,
        title: "Atomic destination remap",
        executionWorkspaceId: fixture.destinationExecutionWorkspaceId,
      });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);

    const wrongProject = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.sourceProjectId,
        title: "Must not persist",
        executionWorkspaceId: fixture.destinationExecutionWorkspaceId,
      });
    expect(wrongProject.status, JSON.stringify(wrongProject.body)).toBe(422);
    expect(wrongProject.body.error).toBe("Execution workspace must belong to the selected project");

    const crossCompany = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ executionWorkspaceId: fixture.otherExecutionWorkspaceId });
    expect(crossCompany.status, JSON.stringify(crossCompany.body)).toBe(422);
    expect(crossCompany.body.error).toBe("Execution workspace must belong to same company");

    const storedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    expect(storedIssue).toMatchObject({
      projectId: fixture.destinationProjectId,
      title: "Atomic destination remap",
      executionWorkspaceId: fixture.destinationExecutionWorkspaceId,
    });
  });

  it("preserves an omitted pointer and rejects an incompatible project move without a partial update", async () => {
    const fixture = await seedFixture();

    const titleOnly = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ title: "Pointer remains attached" });
    expect(titleOnly.status, JSON.stringify(titleOnly.body)).toBe(200);
    expect(titleOnly.body.executionWorkspaceId).toBe(fixture.sourceExecutionWorkspaceId);

    const incompatibleMove = await request(fixture.app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        projectId: fixture.destinationProjectId,
        title: "Must not persist",
      });
    expect(incompatibleMove.status, JSON.stringify(incompatibleMove.body)).toBe(422);
    expect(incompatibleMove.body.error).toBe("Execution workspace must belong to the selected project");

    const storedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    expect(storedIssue).toMatchObject({
      projectId: fixture.sourceProjectId,
      title: "Pointer remains attached",
      description: "Keep this description unchanged.",
      status: "todo",
      priority: "high",
      billingCode: "portfolio-remap",
      executionWorkspaceId: fixture.sourceExecutionWorkspaceId,
    });
  });
});
