import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertCanManageExecutionWorkspaceRuntimeServices,
  assertCanManageProjectWorkspaceRuntimeServices,
} from "../routes/workspace-runtime-service-authz.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace runtime auth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workspace runtime service authz helper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-runtime-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProjectWorkspace(companyId: string) {
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace authz",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-authz-project",
      isPrimary: true,
    });
    return { projectId, projectWorkspaceId };
  }

  async function seedExecutionWorkspace(companyId: string, projectId: string, projectWorkspaceId: string) {
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/paperclip-authz-execution",
    });
    return executionWorkspaceId;
  }

  async function seedAgent(
    companyId: string,
    input: { role?: string; reportsTo?: string | null; name?: string } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input.name ?? "Agent",
      role: input.role ?? "engineer",
      reportsTo: input.reportsTo ?? null,
    });
    return agentId;
  }

  it("allows board actors to manage project workspace runtime services", async () => {
    const companyId = await seedCompany();
    const { projectWorkspaceId } = await seedProjectWorkspace(companyId);

    await expect(assertCanManageProjectWorkspaceRuntimeServices(db, {
      actor: {
        type: "board",
        userId: "board-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      },
    } as any, {
      companyId,
      projectWorkspaceId,
    })).resolves.toBeUndefined();
  });

  it("allows CEO agents to manage any project workspace runtime services in their company", async () => {
    const companyId = await seedCompany();
    const { projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const ceoAgentId = await seedAgent(companyId, { role: "ceo", name: "CEO" });

    await expect(assertCanManageProjectWorkspaceRuntimeServices(db, {
      actor: {
        type: "agent",
        agentId: ceoAgentId,
        companyId,
        source: "agent_key",
      },
    } as any, {
      companyId,
      projectWorkspaceId,
    })).resolves.toBeUndefined();
  });

  it("allows agents with a non-terminal assigned issue in the target project workspace", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const agentId = await seedAgent(companyId, { name: "Engineer" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Use this workspace",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await expect(assertCanManageProjectWorkspaceRuntimeServices(db, {
      actor: {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
      },
    } as any, {
      companyId,
      projectWorkspaceId,
    })).resolves.toBeUndefined();
  });

  it("allows managers to manage execution workspace runtime services for their reporting subtree", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const executionWorkspaceId = await seedExecutionWorkspace(companyId, projectId, projectWorkspaceId);
    const managerId = await seedAgent(companyId, { role: "cto", name: "Manager" });
    const reportId = await seedAgent(companyId, { reportsTo: managerId, name: "Report" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      title: "Use execution workspace",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: reportId,
    });

    await expect(assertCanManageExecutionWorkspaceRuntimeServices(db, {
      actor: {
        type: "agent",
        agentId: managerId,
        companyId,
        source: "agent_key",
      },
    } as any, {
      companyId,
      executionWorkspaceId,
    })).resolves.toBeUndefined();
  });

  it("rejects unrelated same-company agents without matching workspace assignments", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const executionWorkspaceId = await seedExecutionWorkspace(companyId, projectId, projectWorkspaceId);
    const assignedAgentId = await seedAgent(companyId, { name: "Assigned" });
    const unrelatedAgentId = await seedAgent(companyId, { name: "Unrelated" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      title: "Assigned issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: assignedAgentId,
    });

    await expect(assertCanManageExecutionWorkspaceRuntimeServices(db, {
      actor: {
        type: "agent",
        agentId: unrelatedAgentId,
        companyId,
        source: "agent_key",
      },
    } as any, {
      companyId,
      executionWorkspaceId,
    })).rejects.toMatchObject({
      status: 403,
      message: "Missing permission to manage workspace runtime services",
    });
  });

  it("rejects completed workspace assignments so stale issues do not keep access alive", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const agentId = await seedAgent(companyId, { name: "Engineer" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Completed issue",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await expect(assertCanManageProjectWorkspaceRuntimeServices(db, {
      actor: {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
      },
    } as any, {
      companyId,
      projectWorkspaceId,
    })).rejects.toMatchObject({
      status: 403,
      message: "Missing permission to manage workspace runtime services",
    });
  });
});
