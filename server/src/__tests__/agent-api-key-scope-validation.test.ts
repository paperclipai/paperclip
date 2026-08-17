import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent API-key scope validation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent API-key scope reference validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-key-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  it("accepts same-company references and rejects invalid or cross-company scope IDs", async () => {
    const companyId = await seedCompany("Bridge company");
    const otherCompanyId = await seedCompany("Other company");

    const [bridgeAgent, specialistAgent, otherAgent, terminatedAgent] = await db
      .insert(agents)
      .values([
        { companyId, name: "Bridge", role: "manager", status: "idle" },
        { companyId, name: "Specialist", role: "researcher", status: "idle" },
        { companyId: otherCompanyId, name: "Other", role: "researcher", status: "idle" },
        { companyId, name: "Former", role: "researcher", status: "terminated" },
      ])
      .returning();

    const [project, conflictingProject, otherProject] = await db
      .insert(projects)
      .values([
        { companyId, name: "Bridge project" },
        { companyId, name: "Conflicting project" },
        { companyId: otherCompanyId, name: "Other project" },
      ])
      .returning();

    const [
      parentIssue,
      conflictingParentIssue,
      unassignedParentIssue,
      otherIssue,
    ] = await db
      .insert(issues)
      .values([
        { companyId, projectId: project.id, title: "Bridge root" },
        {
          companyId,
          projectId: conflictingProject.id,
          title: "Conflicting root",
        },
        {
          companyId,
          projectId: null,
          title: "Unassigned root",
        },
        {
          companyId: otherCompanyId,
          projectId: otherProject.id,
          title: "Other root",
        },
      ])
      .returning();

    const service = agentService(db);
    const valid = await service.createApiKey(bridgeAgent.id, "valid bridge", {
      kind: "task_bridge",
      projectId: project.id,
      parentIssueId: parentIssue.id,
      allowedAssigneeAgentIds: [specialistAgent.id],
    });
    expect(valid).toMatchObject({
      name: "valid bridge",
      scope: {
        kind: "task_bridge",
        projectId: project.id,
        parentIssueId: parentIssue.id,
        allowedAssigneeAgentIds: [specialistAgent.id],
      },
    });
    expect(valid.token).toMatch(/^pcp_[a-f0-9]{48}$/);

    await expect(
      service.createApiKey(bridgeAgent.id, "conflicting boundaries", {
        kind: "task_bridge",
        projectIds: [project.id],
        parentIssueIds: [parentIssue.id, conflictingParentIssue.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_conflicting_boundaries",
        projectIds: [project.id],
        parentIssueIds: [conflictingParentIssue.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "unassigned parent boundary", {
        kind: "task_bridge",
        projectIds: [project.id],
        parentIssueIds: [parentIssue.id, unassignedParentIssue.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_conflicting_boundaries",
        projectIds: [project.id],
        parentIssueIds: [unassignedParentIssue.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "cross-company project", {
        kind: "task_bridge",
        projectIds: [project.id, otherProject.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_invalid_projects",
        projectIds: [otherProject.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "cross-company parent", {
        kind: "task_bridge",
        parentIssueIds: [parentIssue.id, otherIssue.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_invalid_parent_issues",
        parentIssueIds: [otherIssue.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "cross-company assignee", {
        kind: "task_bridge",
        projectId: project.id,
        allowedAssigneeAgentIds: [specialistAgent.id, otherAgent.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_invalid_assignees",
        agentIds: [otherAgent.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "terminated assignee", {
        kind: "task_bridge",
        projectId: project.id,
        allowedAssigneeAgentIds: [terminatedAgent.id],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_invalid_assignees",
        agentIds: [terminatedAgent.id],
      },
    });

    await expect(
      service.createApiKey(bridgeAgent.id, "cross-company skill test", {
        kind: "skill_test",
        issueId: otherIssue.id,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "agent_api_key_scope_invalid_issue",
        issueId: otherIssue.id,
      },
    });

    await expect(
      service.createApiKey(
        bridgeAgent.id,
        "missing boundary",
        { kind: "task_bridge" } as never,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "agent_api_key_scope_missing_boundary" },
    });

    const keys = await service.listKeys(bridgeAgent.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      id: valid.id,
      scope: valid.scope,
    });
  });
});
