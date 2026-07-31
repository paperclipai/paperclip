import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService ancestor tenant boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-ancestor-tenancy-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: name.slice(0, 3).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("stops corrupt ancestor walks and hydration at the child company boundary", async () => {
    const foreignCompanyId = await createCompany("Foreign");
    const childCompanyId = await createCompany("Child");
    const foreignGoalId = randomUUID();
    const foreignProjectId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const foreignAncestorId = randomUUID();
    const localParentId = randomUUID();
    const localChildId = randomUUID();

    await db.insert(goals).values({
      id: foreignGoalId,
      companyId: foreignCompanyId,
      title: "Foreign confidential goal",
      level: "company",
      status: "active",
    });
    await db.insert(projects).values({
      id: foreignProjectId,
      companyId: foreignCompanyId,
      goalId: foreignGoalId,
      name: "Foreign confidential project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: foreignWorkspaceId,
      companyId: foreignCompanyId,
      projectId: foreignProjectId,
      name: "Foreign confidential workspace",
      isPrimary: true,
      sharedWorkspaceKey: "foreign-confidential-workspace",
    });
    await db.insert(issues).values([
      {
        id: foreignAncestorId,
        companyId: foreignCompanyId,
        title: "Foreign confidential ancestor",
        description: "Must never cross the tenant boundary",
        status: "in_progress",
        priority: "critical",
      },
      {
        id: localParentId,
        companyId: childCompanyId,
        parentId: foreignAncestorId,
        projectId: foreignProjectId,
        goalId: foreignGoalId,
        title: "Local parent with corrupt foreign references",
        status: "todo",
        priority: "medium",
      },
      {
        id: localChildId,
        companyId: childCompanyId,
        parentId: localParentId,
        title: "Readable local child",
        status: "todo",
        priority: "medium",
      },
    ]);

    const ancestors = await svc.getAncestors(localChildId);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0]).toMatchObject({
      id: localParentId,
      title: "Local parent with corrupt foreign references",
      project: null,
      goal: null,
    });
    expect(JSON.stringify(ancestors)).not.toContain("Foreign confidential");
  });

  it("rejects a cross-company parent on create even when workspace inheritance is skipped", async () => {
    const foreignCompanyId = await createCompany("Foreign");
    const childCompanyId = await createCompany("Child");
    const foreignParentId = randomUUID();
    await db.insert(issues).values({
      id: foreignParentId,
      companyId: foreignCompanyId,
      title: "Foreign parent",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.create(childCompanyId, {
      parentId: foreignParentId,
      title: "Invalid child",
      skipExecutionWorkspaceInheritance: true,
    })).rejects.toMatchObject({
      status: 422,
      message: "Parent issue not found in company",
    });
  });

  it("rejects a cross-company parent on update without changing the issue", async () => {
    const foreignCompanyId = await createCompany("Foreign");
    const childCompanyId = await createCompany("Child");
    const foreignParentId = randomUUID();
    const localIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: foreignParentId,
        companyId: foreignCompanyId,
        title: "Foreign parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: localIssueId,
        companyId: childCompanyId,
        title: "Local issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await expect(svc.update(localIssueId, { parentId: foreignParentId })).rejects.toMatchObject({
      status: 422,
      message: "Parent issue not found in company",
    });
    await expect(svc.getById(localIssueId)).resolves.toMatchObject({ parentId: null });
  });
});
