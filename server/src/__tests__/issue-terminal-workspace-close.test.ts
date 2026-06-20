import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue terminal workspace close tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue terminal status stamps execution workspace cleanup-eligible", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-terminal-workspace-close-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stamps workspace as idle/closed when the only issue transitions to done", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "directory",
      name: "Test workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: workspaceId,
    });

    await svc.update(issueId, { status: "done" });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws.status).toBe("idle");
    expect(ws.closedAt).not.toBeNull();
    expect(ws.cleanupEligibleAt).not.toBeNull();
    expect(ws.cleanupReason).toBe("issue_terminal");
  });

  it("stamps workspace as idle/closed when the only issue transitions to cancelled", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "directory",
      name: "Test workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: workspaceId,
    });

    await svc.update(issueId, { status: "cancelled" });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws.status).toBe("idle");
    expect(ws.closedAt).not.toBeNull();
    expect(ws.cleanupEligibleAt).not.toBeNull();
    expect(ws.cleanupReason).toBe("issue_terminal");
  });

  it("does not stamp workspace when another non-terminal issue shares it", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "directory",
      name: "Shared workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values([
      {
        id: issueId1,
        companyId,
        projectId,
        title: "Issue 1",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: workspaceId,
      },
      {
        id: issueId2,
        companyId,
        projectId,
        title: "Issue 2",
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId: workspaceId,
      },
    ]);

    await svc.update(issueId1, { status: "done" });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws.status).toBe("active");
    expect(ws.closedAt).toBeNull();
    expect(ws.cleanupEligibleAt).toBeNull();
  });

  it("does not stamp shared_workspace mode rows", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared session",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: workspaceId,
    });

    await svc.update(issueId, { status: "done" });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws.status).toBe("active");
    expect(ws.closedAt).toBeNull();
    expect(ws.cleanupEligibleAt).toBeNull();
  });

  it("does not stamp workspace that is already closed", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "directory",
      name: "Already closed workspace",
      status: "idle",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
      closedAt: now,
      cleanupEligibleAt: now,
      cleanupReason: "manual_archive",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: workspaceId,
    });

    await svc.update(issueId, { status: "done" });

    const [ws] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));

    expect(ws.status).toBe("idle");
    expect(ws.closedAt).not.toBeNull();
    expect(ws.cleanupReason).toBe("manual_archive");
  });
});
